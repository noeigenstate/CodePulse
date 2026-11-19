#include "red_mask_probe.h"
#include <string.h>

esp_err_t red_mask_prepare(red_mask_plan_t *plan, const epd_canvas_t *c,
    const uint8_t *old_black, const uint8_t *old_red, size_t size,
    unsigned x, unsigned y, unsigned width, unsigned height) {
  if (plan) memset(plan,0,sizeof(*plan));
  if (!plan || !c || !c->black || !c->red || !old_black || !old_red ||
      c->black==c->red || old_black==old_red ||
      c->black==old_black || c->black==old_red ||
      c->red==old_black || c->red==old_red ||
      size!=EPD_CANVAS_BUFFER_SIZE || height<2 || width<16 ||
      x>=BOARD_EPD_WIDTH || width>BOARD_EPD_WIDTH-x ||
      y>=BOARD_EPD_HEIGHT || height>BOARD_EPD_HEIGHT-y || x%8 || width%8)
    return ESP_ERR_INVALID_ARG;
  red_mask_plan_t selected={0};
  for (size_t i=0;i<size;++i) {
    if (((uint8_t)~c->black[i] & (uint8_t)~c->red[i]) ||
        ((uint8_t)~old_black[i] & (uint8_t)~old_red[i])) return ESP_ERR_INVALID_ARG;
    const size_t row=i/50u, column=i%50u;
    const bool inside=row>=y && row<y+height && column>=x/8u && column<(x+width)/8u;
    if (!inside && (c->black[i]!=old_black[i] || c->red[i]!=old_red[i]))
      return ESP_ERR_INVALID_ARG;
    for (unsigned bit=0;bit<8;++bit) {
      const uint8_t mask=(uint8_t)(0x80u>>bit);
      const unsigned before=!(old_red[i]&mask)?2u:(!(old_black[i]&mask)?1u:0u);
      const unsigned after=!(c->red[i]&mask)?2u:(!(c->black[i]&mask)?1u:0u);
      if(before==after) { ++selected.hold_pixels; continue; }
      if(after==0) ++selected.white_pixels;
      else if(after==1) ++selected.black_pixels;
      else ++selected.red_pixels;
      if(before==2) ++selected.red_removed;
      if(after==2) ++selected.red_added;
    }
  }
  /* BWR exposes three selectors. Reserve one for HOLD, one for WHITE, and
   * one for either BLACK or RED. Reject an unsupported mixed target before
   * any panel write; do not silently drop a color or perform an extra pass. */
  if ((!selected.red_removed && !selected.red_added) ||
      (selected.black_pixels && selected.red_pixels)) return ESP_ERR_INVALID_ARG;
  selected.operation=selected.red_pixels?RED_MASK_PAINT:RED_MASK_ERASE;
  *plan=selected;
  return ESP_OK;
}

void red_mask_encode(uint8_t b, uint8_t r, uint8_t ob, uint8_t or_,
    uint8_t *mb, uint8_t *mr) {
  const uint8_t changed=(uint8_t)((b^ob)|(r^or_));
  const uint8_t white=(uint8_t)(b&r);
  /* F7/DDX11 selects {R,B}:11->0x23 HOLD, 10->0x24 WHITE,
   * 01->0x22 BLACK/RED. These RAM values are drive masks, not an image. */
  *mb=(uint8_t)~(changed&white);
  *mr=(uint8_t)~(changed&(uint8_t)~white);
}

unsigned red_mask_frames(const red_mask_plan_t *plan) {
  if(!plan || (plan->operation!=RED_MASK_ERASE && plan->operation!=RED_MASK_PAINT)) return 0;
#ifdef CODEPULSE_EPD_RED_MASK_BLACK
  if(plan->operation==RED_MASK_ERASE && plan->black_pixels)
    return RED_MASK_BW_FRAMES+1u+RED_MASK_BLACK_FRAMES+1u;
#endif
#ifdef CODEPULSE_EPD_RED_MASK_COLOR
  if(plan->operation==RED_MASK_PAINT) {
#if defined(CODEPULSE_EPD_RED_MASK_SINGLE_AB)
    return plan->group_b?RED_MASK_SINGLE_B_FRAMES:RED_MASK_SINGLE_A_FRAMES;
#elif defined(CODEPULSE_EPD_RED_MASK_ACTIVATE)
    return RED_MASK_RED_ACTIVATE_FRAMES+RED_MASK_BW_FRAMES+1u;
#elif defined(CODEPULSE_EPD_RED_MASK_PULSE)
    return RED_MASK_BW_FRAMES+1u+RED_MASK_RED_PULSE_FRAMES;
#else
    return 2u*(RED_MASK_BW_FRAMES+1u);
#endif
  }
#endif
  return RED_MASK_BW_FRAMES+(plan->operation==RED_MASK_PAINT?RED_MASK_RED_FRAMES:0u)+1u;
}

unsigned red_mask_nominal_ms(const red_mask_plan_t *plan) {
#ifdef CODEPULSE_EPD_RED_MASK_BLACK
  unsigned duration=0;
  for(unsigned pass=0;pass<red_black_pass_count(plan);++pass)
    duration+=red_black_pass_frames(plan,pass)*1000u/red_black_pass_hz(plan,pass);
  return duration;
#else
  return red_mask_frames(plan)*10u;
#endif
}

size_t red_mask_make_lut(unsigned slot, const red_mask_plan_t *plan, uint8_t out[44]) {
  if(slot>=5 || !out || !red_mask_frames(plan)) return 0;
  memset(out,0,44);
  /* No common conditioning/inversion. Hold slot (0x23), WW and VCOM retain
   * level code 00. White gets VDL only. Black gets VDH only. New red gets
   * VDL then VDHR. Only changed pixels select nonzero source levels.
   * Do not claim charge-balanced or long-term qualified; two manual steps
   * only. No voltage/VCOM_DC writes and no shortened cooldown. */
  if(slot==2) out[0]=plan->operation==RED_MASK_PAINT?0xb0:0x40;
  if(slot==4) out[0]=0x80;
  out[1]=RED_MASK_BW_FRAMES;
  out[2]=plan->operation==RED_MASK_PAINT?RED_MASK_RED_FRAMES:0;
  out[3]=1; out[5]=1;
  return slot?42:44;
}

#ifdef CODEPULSE_EPD_RED_MASK_BLACK
unsigned red_black_pass_count(const red_mask_plan_t *plan) {
  if(!red_mask_frames(plan)) return 0;
#ifdef CODEPULSE_EPD_RED_MASK_COLOR
  if(plan->operation==RED_MASK_PAINT) {
#if defined(CODEPULSE_EPD_RED_MASK_SINGLE_AB)
    return 1u;
#elif defined(CODEPULSE_EPD_RED_MASK_SPLIT)
    return 3u;
#else
    return 2u;
#endif
  }
#endif
  return plan->operation==RED_MASK_ERASE && plan->black_pixels ? 2u:1u;
}
unsigned red_black_pass_frames(const red_mask_plan_t *plan,unsigned pass) {
  if(pass>=red_black_pass_count(plan)) return 0;
  if(plan->operation==RED_MASK_PAINT) {
#ifdef CODEPULSE_EPD_RED_MASK_COLOR
#ifdef CODEPULSE_EPD_RED_MASK_ACTIVATE
#if defined(CODEPULSE_EPD_RED_MASK_SINGLE_AB)
    return red_mask_frames(plan);
#elif defined(CODEPULSE_EPD_RED_MASK_SPLIT)
    return pass==0?122u:(pass==1?610u:RED_MASK_BW_FRAMES+1u);
#else
    return pass==0?RED_MASK_RED_ACTIVATE_FRAMES:RED_MASK_BW_FRAMES+1u;
#endif
#elif defined(CODEPULSE_EPD_RED_MASK_PULSE)
    return pass==0?RED_MASK_BW_FRAMES+1u:RED_MASK_RED_PULSE_FRAMES;
#else
    return RED_MASK_BW_FRAMES+1u;
#endif
#else
    return RED_MASK_BW_FRAMES+RED_MASK_RED_FRAMES+1u;
#endif
  }
  return (pass==0?RED_MASK_BW_FRAMES:RED_MASK_BLACK_FRAMES)+1u;
}
unsigned red_black_pass_hz(const red_mask_plan_t *plan,unsigned pass) {
  if(pass>=red_black_pass_count(plan)) return 0;
#if defined(CODEPULSE_EPD_RED_MASK_FREQ_AB) && !defined(CODEPULSE_EPD_RED_MASK_RICH_AB)
  if(plan->operation==RED_MASK_PAINT && plan->group_b) return 200u;
#elif defined(CODEPULSE_EPD_RED_MASK_SPLIT)
  if(plan->operation==RED_MASK_PAINT && pass==1) return 200u;
#elif defined(CODEPULSE_EPD_RED_MASK_FAST)
  if(plan->operation==RED_MASK_PAINT && pass==0) return 200u;
#endif
  return 100u;
}
void red_black_encode(const red_mask_plan_t *plan,unsigned pass,
    uint8_t b,uint8_t r,uint8_t ob,uint8_t or_,uint8_t *mb,uint8_t *mr) {
  if(plan->operation==RED_MASK_PAINT) {
#ifdef CODEPULSE_EPD_RED_MASK_COLOR
    const uint8_t changed=(uint8_t)((b^ob)|(r^or_));
    /* Clear via the optically exercised B selector first. Then route ONLY
     * new red pixels to R22. New white and unchanged pixels remain HOLD. */
    if(pass==0) { *mb=(uint8_t)~changed; *mr=0xff; }
    else { *mb=0xff; *mr=(uint8_t)~(changed & (uint8_t)~r); }
#else
    red_mask_encode(b,r,ob,or_,mb,mr);
#endif
    return;
  }
  const uint8_t changed=(uint8_t)((b^ob)|(r^or_));
  /* Pass 0 clears ALL changed pixels, including future black letters.
   * Pass 1 drives only those new letters through the canonical B selector.
   * Background and unchanged pixels retain the .42 HOLD selector (0x23).
   * No target black pixel is routed through the red selector (0x22). */
  const uint8_t active=pass==0 ? changed : (uint8_t)(changed & r & (uint8_t)~b);
  *mb=(uint8_t)~active; *mr=0xff;
}
size_t red_black_make_lut(unsigned table,const red_mask_plan_t *plan,
    unsigned pass,uint8_t out[44]) {
  if(table>=5 || !out || !red_black_pass_frames(plan,pass)) return 0;
  if(plan->operation==RED_MASK_PAINT) {
#ifdef CODEPULSE_EPD_RED_MASK_COLOR
    memset(out,0,44);
#ifdef CODEPULSE_EPD_RED_MASK_ACTIVATE
    if(pass<RED_MASK_RED_PASS_COUNT) {
      /* Complete phase order of .39; only groups 1/2/3 repeat counts reduce
       * to one. Red-only pixels get the entire sequence, NOT just its tail.
       * Numeric data attribution is the same as the retained .45 tail below.
       * Remaining selectors retain level 00 with synchronized durations. */
#if defined(CODEPULSE_EPD_RED_MASK_SPLIT)
      /* Preserve .46's 100Hz prefix and .47's 200Hz tail separately.
       * The extra display-refresh boundary/upload interval is a physical
       * change; equal nominal sequences do not establish equivalence. */
      static const uint8_t prefix[4][6]={
        {0xa0,26,26,0,0,1}, {0x00,10,10,0,0,1},
        {0x84,14,1,14,1,1}, {0x90,10,10,0,0,1}
      };
      static const uint8_t tail[4][6]={
        {0xb0,1,4,0,0,40}, {0xb0,1,4,0,0,20},
        {0xb0,1,5,0,0,40}, {0xc0,70,0,0,0,1}
      };
      for(unsigned group=0;group<4;++group) {
        const uint8_t *data=pass==0?prefix[group]:tail[group];
        out[group*6]=table==2?data[0]:0;
        memcpy(out+group*6+1,data+1,5);
      }
#else
#if defined(CODEPULSE_EPD_RED_MASK_SINGLE_AB)
#if defined(CODEPULSE_EPD_RED_MASK_CRISP_AB)
      /* Single-pass 100Hz R22 + R24 bisecting .65 B (780ms hold, slightly white) and
       * .66 A (960ms hold, slightly dark) while preserving 18.2-20Hz low-flicker rhythm.
       * Group A uses 32 tail VDL + 860ms final VDHR hold (300 frames / 3.00s, 7.06:1).
       * Group B uses 30 tail VDL (15x 0xbb) + 830ms final VDHR hold (290 frames / 2.90s, 7.27:1). */
      static const uint8_t single_a[7][6]={
        {0xa0,14,14,2,0,1}, {0x90,5,6,1,0,1}, {0xb0,1,4,0,0,8},
        {0xbb,1,4,1,5,6}, {0xbb,1,4,1,5,6}, {0xc0,50,0,0,0,1},
        {0xc0,36,0,0,0,1}
      };
      static const uint8_t white_a[7]={0xa0,0xa0,0x80,0x00,0xaa,0x80,0x80};
      static const uint8_t single_b[7][6]={
        {0xa0,14,14,2,0,1}, {0x90,5,6,1,0,1}, {0xbb,1,4,1,5,3},
        {0xbb,1,4,1,5,6}, {0xbb,1,4,1,5,6}, {0xc0,50,0,0,0,1},
        {0xc0,33,0,0,0,1}
      };
      static const uint8_t white_b[7]={0xa0,0xa0,0x88,0x00,0xaa,0x80,0x80};
#elif defined(CODEPULSE_EPD_RED_MASK_VIVID_AB)
      /* Single-pass 100Hz R22 + R24 keeping .65 A/B low-flicker 20->18.2Hz envelope
       * while eliminating the whitish TiO2 surface veil.
       * Group A cuts tail VDL to 30 and extends final VDHR hold to 960ms (300 frames / 3.00s).
       * Group B boosts prefix VDH release to 110ms with 28 tail VDL + 960ms hold (290 frames / 2.90s). */
      static const uint8_t single_a[7][6]={
        {0xa0,14,14,2,0,1}, {0x90,5,6,1,0,1}, {0xb0,1,4,0,0,6},
        {0xbb,1,4,1,5,6}, {0xbb,1,4,1,5,6}, {0xc0,56,0,0,0,1},
        {0xc0,40,0,0,0,1}
      };
      static const uint8_t white_a[7]={0xa0,0xa0,0x80,0x00,0xaa,0x80,0x80};
      static const uint8_t single_b[7][6]={
        {0xa0,13,13,2,0,1}, {0x90,4,11,1,0,1}, {0xb0,1,4,0,0,8},
        {0xbb,1,4,1,5,5}, {0xbb,1,4,1,5,5}, {0xc0,56,0,0,0,1},
        {0xc0,40,0,0,0,1}
      };
      static const uint8_t white_b[7]={0xa0,0xa0,0x80,0x00,0xaa,0x80,0x80};
#elif defined(CODEPULSE_EPD_RED_MASK_SMOOTH_AB)
      /* Single-pass 100Hz R22 + R24 keeping .64 A color purity and .64 B smoothness.
       * Group A replaces consecutive 16.7Hz (1:5) with 18.2Hz (0xbb 1:4/1:5 alternating)
       * + 660ms VDHR (300 frames / 3.00s).
       * Group B stays purely at 20.0Hz (1:4 x 34) + 780ms VDHR hold (290 frames / 2.90s). */
      static const uint8_t single_a[7][6]={
        {0xa0,14,14,2,0,1}, {0x90,5,6,1,0,1}, {0xb0,1,4,0,0,12},
        {0xbb,1,4,1,5,6}, {0xbb,1,4,1,5,6}, {0xc0,36,0,0,0,1},
        {0xc0,30,0,0,0,1}
      };
      static const uint8_t white_a[7]={0xa0,0xa0,0x80,0x00,0xaa,0x80,0x80};
      static const uint8_t single_b[7][6]={
        {0xa0,14,14,2,0,1}, {0x90,5,6,1,0,1}, {0xb0,1,4,0,0,12},
        {0xb0,1,4,0,0,12}, {0xb0,1,4,0,0,10}, {0xc0,48,0,0,0,1},
        {0xc0,30,0,0,0,1}
      };
      static const uint8_t white_b[7]={0xa0,0xa0,0x80,0x00,0xa0,0x80,0x80};
#elif defined(CODEPULSE_EPD_RED_MASK_RICH_AB)
      /* Single-pass 100Hz R22 + R24 keeping .63 A smoothness while restoring red depth.
       * Group A steps 1:4 (20.0Hz x 12) -> 1:5 (16.7Hz x 24) + 540ms final VDHR (300 frames / 3.00s).
       * Group B stays at 20.0Hz (1:4 x 24) + 1280ms zero-flicker VDHR fade-in (290 frames / 2.90s). */
      static const uint8_t single_a[7][6]={
        {0xa0,14,14,2,0,1}, {0x90,5,6,1,0,1}, {0xb0,1,4,0,0,12},
        {0xb0,1,5,0,0,10}, {0xb0,1,5,0,0,8}, {0xb0,1,5,0,0,6},
        {0xc0,54,0,0,0,1}
      };
      static const uint8_t white_a[7]={0xa0,0xa0,0x80,0x00,0xa0,0xa0,0x80};
      static const uint8_t single_b[7][6]={
        {0xa0,14,14,2,0,1}, {0x90,5,6,1,0,1}, {0xb0,1,4,0,0,12},
        {0xb0,1,4,0,0,12}, {0xc0,50,0,0,0,1}, {0xc0,50,0,0,0,1},
        {0xc0,28,0,0,0,1}
      };
      static const uint8_t white_b[7]={0xa0,0xa0,0x80,0x00,0x80,0x80,0x80};
#elif defined(CODEPULSE_EPD_RED_MASK_FREQ_AB)
      /* Single-pass high-frequency R22 + R24 with VDH-ending prefix and PT_SCAN=1.
       * Group A tightens 100Hz to 1:4 (50ms / 20.0Hz x 48) + 180ms final VDHR (300 frames / 3.00s).
       * Group B switches R30=0x39 (200Hz / 5ms frames): half-width 5ms VDL pulses with 30-35ms
       * VDHR pushes (1:6 x 40, 1:7 x 25 = 25.0-28.6Hz) + 170ms final hold (590 frames / 2.95s). */
      static const uint8_t single_a[7][6]={
        {0xa0,14,14,2,0,1}, {0x90,5,6,1,0,1}, {0xb0,1,4,0,0,12},
        {0xb0,1,4,0,0,12}, {0xb0,1,4,0,0,12}, {0xb0,1,4,0,0,12},
        {0xc0,18,0,0,0,1}
      };
      static const uint8_t white_a[7]={0xa0,0xa0,0x80,0x00,0xa0,0xa0,0x80};
      static const uint8_t single_b[7][6]={
        {0xa0,28,28,4,0,1}, {0x90,10,12,2,0,1}, {0xb0,1,6,0,0,26},
        {0xb0,1,6,0,0,14}, {0xb0,1,7,0,0,15}, {0xb0,1,7,0,0,9},
        {0xc0,34,0,0,0,1}
      };
      static const uint8_t white_b[7]={0xa0,0xa0,0x80,0x00,0xa0,0xa0,0x80};
#elif defined(CODEPULSE_EPD_RED_MASK_WAVE_AB)
      /* Single-pass R22 + R24 with VDH-ending prefix (0x90) and short final VDHR hold.
       * Group A uses 10 factory-OTP-style wide-VDL slow-wave cycles (2-3 VDL, 1 0V,
       * 18-20 VDHR, 0-2 0V) + 16-frame final hold (300 frames / 3.00s).
       * Group B uses 36 dense 1:5 and 1:6 cycles (5.89:1 ratio) + 18-frame final hold
       * (290 frames / 2.90s). */
      static const uint8_t single_a[7][6]={
        {0xa0,14,14,2,0,1}, {0x90,5,6,1,0,1}, {0x8c,3,1,18,2,3},
        {0x8c,3,1,20,2,3}, {0x8c,2,1,20,1,2}, {0x8c,2,1,19,0,2},
        {0xc0,16,0,0,0,1}
      };
      static const uint8_t white_a[7]={0xa0,0xa0,0x80,0x00,0xaa,0xa8,0x80};
      static const uint8_t single_b[7][6]={
        {0xa0,14,14,2,0,1}, {0x90,5,6,1,0,1}, {0xb0,1,5,0,0,12},
        {0xb0,1,5,0,0,10}, {0xb0,1,6,0,0,8}, {0xb0,1,6,0,0,6},
        {0xc0,18,0,0,0,1}
      };
      static const uint8_t white_b[7]={0xa0,0xa0,0x80,0x00,0xa0,0xa0,0x80};
#elif defined(CODEPULSE_EPD_RED_MASK_BRAKE_AB)
      /* Single-pass immediate-brake R22 + R24 with zero tail 0V coast and PT_SCAN=1.
       * Deepens prefix separation to 42 frames (33 VDL, 6 VDH, 3 0V), eliminates all
       * 0x8c 0V coast frames in the tail (using 0xb0 so +7V VDHR immediately brakes
       * each 10ms VDL pulse), and caps final uninterrupted VDHR at 450-480ms. */
      static const uint8_t single_a[7][6]={
        {0xa0,14,12,2,0,1}, {0x98,2,6,5,1,1}, {0xb0,1,7,0,0,6},
        {0xb0,1,8,0,0,5}, {0xb0,1,9,0,0,5}, {0xb0,1,9,0,0,5},
        {0xc0,45,0,0,0,1}
      };
      static const uint8_t white_a[7]={0xa0,0xa8,0x80,0x00,0xa0,0xa0,0x80};
      static const uint8_t single_b[7][6]={
        {0xa0,14,12,2,0,1}, {0x98,2,6,5,1,1}, {0xb0,1,8,0,0,4},
        {0xb0,1,9,0,0,4}, {0xb0,1,10,0,0,4}, {0xb0,1,10,0,0,5},
        {0xc0,48,0,0,0,1}
      };
      static const uint8_t white_b[7]={0xa0,0xa8,0x80,0x00,0xa0,0xa0,0x80};
#elif defined(CODEPULSE_EPD_RED_MASK_PURE_AB)
      /* Single-pass 0V-buffered R22 + R24 with capped final VDHR hold and PT_SCAN=1.
       * Both groups keep .59A's 36-frame prefix (29 VDL, 4 VDH, 3 0V), use 0x8c
       * (1 VDL : 1 0V : 6..7 VDHR) across all tail cycles to suppress black rise
       * and hard-edge strobing, and cap uninterrupted final VDHR to 350-380ms. */
      static const uint8_t single_a[7][6]={
        {0xa0,12,10,2,0,1}, {0x98,2,4,5,1,1}, {0x8c,1,1,6,0,6},
        {0x8c,1,1,7,0,7}, {0x8c,1,1,7,0,6}, {0x8c,1,1,7,0,6},
        {0xc0,35,0,0,0,1}
      };
      static const uint8_t white_a[7]={0xa0,0xa8,0x80,0x00,0xa8,0xa8,0x80};
      static const uint8_t single_b[7][6]={
        {0xa0,12,10,2,0,1}, {0x98,2,4,5,1,1}, {0x8c,1,1,6,0,4},
        {0x8c,1,1,7,0,6}, {0x8c,1,1,7,0,6}, {0x8c,1,1,7,0,6},
        {0xc0,38,0,0,0,1}
      };
      static const uint8_t white_b[7]={0xa0,0xa8,0x80,0x00,0xa8,0xa8,0x80};
#elif defined(CODEPULSE_EPD_RED_MASK_GLIDE_AB)
      /* Single-pass synchronized progressive R22 + R24 glide with PT_SCAN=1.
       * Group A uses a de-strobed 40ms micro-agitation prefix and 20 escalating tail
       * cycles finishing with a 640ms uninterrupted VDHR glide (280 frames / 2.80s).
       * Group B uses a zero-black-strobe white prefix and 15 high-ratio escalating tail
       * cycles finishing with a 680ms uninterrupted VDHR glide (230 frames / 2.30s). */
      static const uint8_t single_a[7][6]={
        {0xa0,12,10,2,0,1}, {0x98,2,4,5,1,1}, {0x8c,1,1,6,0,6},
        {0xb0,1,7,0,0,7}, {0xb0,1,9,0,0,4}, {0xb0,1,11,0,0,3},
        {0xc0,64,0,0,0,1}
      };
      static const uint8_t white_a[7]={0xa0,0xa8,0x80,0x00,0xa0,0xa0,0x80};
      static const uint8_t single_b[7][6]={
        {0xa0,12,12,2,0,1}, {0x8c,1,1,5,0,5}, {0xb0,1,7,0,0,4},
        {0xb0,1,9,0,0,3}, {0xb0,1,11,0,0,2}, {0xb0,1,14,0,0,1},
        {0xc0,68,0,0,0,1}
      };
      static const uint8_t white_b[7]={0xa0,0x88,0x00,0xa0,0xa0,0xa0,0x80};
#else
      /* Single-pass synchronized R22 (red) + R24 (white glyphs) with PT_SCAN=1.
       * Group A preserves .55/.57 R22 while erasing READY early and polishing ERROR late.
       * Group B compacts prefix conditioning and uses an escalating 0V-buffered red tail. */
      static const uint8_t single_a[7][6]={
        {0xa0,26,26,10,0,1}, {0x84,14,1,14,1,1}, {0x90,10,10,0,0,1},
        {0xb0,1,4,0,0,30}, {0x8c,1,1,5,0,10}, {0x8c,1,2,5,0,10},
        {0xc0,35,0,0,0,1}
      };
      static const uint8_t white_a[7]={0xa0,0x88,0x80,0x00,0x00,0x88,0x80};
      static const uint8_t single_b[7][6]={
        {0xa0,12,12,4,0,1}, {0x84,8,1,8,1,1}, {0x90,8,6,2,0,1},
        {0x8c,1,1,5,0,16}, {0x8c,1,1,6,0,12}, {0x8c,1,1,7,0,8},
        {0xc0,38,0,0,0,1}
      };
      static const uint8_t white_b[7]={0xa0,0x88,0xa0,0x80,0x00,0x88,0x80};
#endif
      const uint8_t (*const seq)[6]=plan->group_b?single_b:single_a;
      const uint8_t *const wlevels=plan->group_b?white_b:white_a;
      for(unsigned group=0;group<7;++group) {
        out[group*6]=table==2?seq[group][0]:(table==4?wlevels[group]:0);
        memcpy(out+group*6+1,seq[group]+1,5);
      }
#else
#if defined(CODEPULSE_EPD_RED_MASK_GAP_SHIFT)
      /* Fold the remaining 100ms conditioning gap into the first group.
       * Spend the other ten zero frames between reverse and red in the
       * final ten repeats. All Gap52 active pulse widths and counts remain. */
      static const uint8_t conditioned[7][6]={
        {0xa0,26,26,10,0,1}, {0x84,14,1,14,1,1}, {0x90,10,10,0,0,1},
        {0xb0,1,4,0,0,30}, {0x8c,1,1,5,0,10}, {0x8c,1,2,5,0,10},
        {0xc0,35,0,0,0,1}
      };
#elif defined(CODEPULSE_EPD_RED_MASK_TAIL100)
      /* .48 keeps .46's clock and prefix, redistributing the tail into
       * 10/40ms and 10/50ms pairs: 500ms VDL + 2200ms VDHR, then 350ms
       * VDHR. The explicit NEUTRAL variant below changes that VDL budget.
       * Equal totals do not establish equivalent pigment response. */
      static const uint8_t conditioned[7][6]={
        {0xa0,26,26,0,0,1}, {0x00,10,10,0,0,1},
        {0x84,14,1,14,1,1}, {0x90,10,10,0,0,1},
#if defined(CODEPULSE_EPD_RED_MASK_STAGGER)
        /* Same .48 per-pixel drive budgets. Group B's reverse is shifted
         * within the synchronized four-phase grid; never reverse A and B
         * together in the tail. Prefix/final hold remain simultaneous. */
        {0xbf,1,1,1,2,30}, {0xbf,1,2,1,2,20},
#elif defined(CODEPULSE_EPD_RED_MASK_NEUTRAL)
        /* Keep .48's red pulses and timing, replacing only the 500ms tail
         * VDL budget with level 00 pauses. Charge balance/red purity are
         * unqualified; supplies and VCOM registers remain unchanged. */
        {0x30,1,4,0,0,30}, {0x30,1,5,0,0,20},
#elif defined(CODEPULSE_EPD_RED_MASK_GAP)
#ifdef CODEPULSE_EPD_RED_MASK_TAIL_PAIR
        /* Merge pairs of 50ms cycles in group 4. Keep its 30 reverse
         * frames and 120 red frames in the same 150-frame budget. */
        {0xb0,2,8,0,0,15},
#else
        {0xb0,1,4,0,0,30},
#endif
        /* Gap52 inserts one code-zero frame between codes 2 and 3
         * in each repeat of group 5. */
#ifdef CODEPULSE_EPD_RED_MASK_TAIL_FINISH
        {0x8c,1,1,5,0,12},
#else
        {0x8c,1,1,5,0,20},
#endif
#else
        {0xb0,1,4,0,0,30}, {0xb0,1,5,0,0,20},
#endif
#ifdef CODEPULSE_EPD_RED_MASK_TAIL_FINISH
        /* Move the last eight repeats' 40 red frames into the final
         * dwell. Drop those repeats' eight reverse and eight zero frames. */
        {0xc0,75,0,0,0,1}
#else
        {0xc0,35,0,0,0,1}
#endif
      };
#elif defined(CODEPULSE_EPD_RED_MASK_FAST)
      /* UC8176 R30=39 selects 200Hz (M=7,N=1); .46 was 3A/100Hz.
       * The prefix is IDENTICAL in nominal milliseconds: two 26-frame
       * white dwells + 20 neutral frames merge into one group at 2x counts.
       * Only the red tail's 40/160ms and 30/140ms pulses are redistributed
       * into 5/20ms and 5/25ms pulses. Preserve 500ms negative + 2550ms red
       * in that tail, including its final 350ms red hold. This is NOT proof
       * of equivalent pigment response. No voltage or VCOM changes. */
      static const uint8_t conditioned[7][6]={
        {0xa0,52,52,40,0,1}, {0x84,28,2,28,2,1}, {0x90,20,20,0,0,1},
        {0xb0,1,4,0,0,40}, {0xb0,1,4,0,0,20}, {0xb0,1,5,0,0,40},
        {0xc0,70,0,0,0,1}
      };
#else
      static const uint8_t conditioned[7][6]={
        {0xa0,26,26,0,0,1}, {0x00,10,10,0,0,1},
        {0x84,14,1,14,1,1}, {0x90,10,10,0,0,1},
        {0xb0,4,16,0,0,5}, {0xb0,3,14,0,0,10}, {0xc0,35,0,0,0,1}
      };
#endif
      for(unsigned group=0;group<7;++group) {
#ifdef CODEPULSE_EPD_RED_MASK_STAGGER
        out[group*6]=(table==2 || table==4)?conditioned[group][0]:0;
        if(table==4 && (group==4 || group==5)) out[group*6]=0xfb;
#else
        out[group*6]=table==2?conditioned[group][0]:0;
#endif
        memcpy(out+group*6+1,conditioned[group]+1,5);
      }
#endif
#endif
    } else {
      /* Clean all 352 white glyph pixels AFTER red has been driven. Black
       * baseline strokes that turn white must not remain under ERROR text. */
      if(table==4) out[0]=0x80;
      out[1]=RED_MASK_BW_FRAMES;out[3]=1;out[5]=1;
    }
    return table?42:44;
#else
#ifdef CODEPULSE_EPD_RED_MASK_PULSE
    if(pass==1) {
      /* Preserve groups 4..6 of the .39 FULL/SHORT red table exactly.
       * Numeric reference published by beee (2018-03-03), GDEW042Z15:
       * https://forum.arduino.cc/t/waveshare-e-paper-displays-with-spi/467865?page=22
       * .39 produced red on this panel; this isolated tail has NOT yet passed.
       * In particular, do not coalesce its repeated opposing pulses into DC.
       * Non-red selectors/VCOM keep 00 throughout, with identical timing. */
      static const uint8_t tail[3][6]={
        {0xb0,4,16,0,0,5}, {0xb0,3,14,0,0,10}, {0xc0,35,0,0,0,1}
      };
      for(unsigned group=0;group<3;++group) {
        out[group*6]=table==2?tail[group][0]:0;
        memcpy(out+group*6+1,tail[group]+1,5);
      }
      /* Explicit neutral termination, one frame; remaining groups zero. */
      out[19]=1;out[23]=1;
      return table?42:44;
    }
#endif
    if(pass==0 && table==4) out[0]=0x80;
    /* Retained .44 control, NOT a working red recipe: R22/40 from a cleared
     * white state produced BLACK. .42's red letters over a formerly red area
     * did not prove this pulse could create red from white. */
    if(pass==1 && table==2) out[0]=0x40;
    out[1]=RED_MASK_BW_FRAMES;out[3]=1;out[5]=1;
    return table?42:44;
#endif /* CODEPULSE_EPD_RED_MASK_ACTIVATE */
#else
    return red_mask_make_lut(table,plan,out);
#endif
  }
  memset(out,0,44);
  /* Keep .42's white-clear pulse and HOLD slot exactly. The black-only pass
   * uses R24/VDH, not R22; no source or VCOM supply voltages are reprogrammed. */
  if(table==4) out[0]=pass==0?0x80:0x40;
  out[1]=pass==0?RED_MASK_BW_FRAMES:RED_MASK_BLACK_FRAMES;
  out[3]=1;out[5]=1;
  return table?42:44;
}
#endif

#ifdef CODEPULSE_EPD_RED_MASK_ACTIVATE
void red_activation_encode(unsigned pass,bool in_window,
    uint8_t b,uint8_t r,uint8_t ob,uint8_t or_,uint8_t *mb,uint8_t *mr) {
  *mb=*mr=0xff;
#ifdef CODEPULSE_EPD_RED_MASK_SINGLE_AB
  if(!in_window || pass>=RED_MASK_RED_PASS_COUNT) return;
  const uint8_t changed=(uint8_t)((b^ob)|(r^or_));
  *mr=(uint8_t)~(changed & (uint8_t)~r);
  *mb=(uint8_t)~(b&r);
#else
  if(!in_window || pass>RED_MASK_RED_PASS_COUNT) return;
  if(pass<RED_MASK_RED_PASS_COUNT) {
    const uint8_t changed=(uint8_t)((b^ob)|(r^or_));
    *mr=(uint8_t)~(changed & (uint8_t)~r);
  } else {
    /* Intentional local redraw of target white, including unchanged glyph
     * holes. This must never be applied to the surrounding full-frame white. */
    *mb=(uint8_t)~(b&r);
  }
#endif
}
#ifdef CODEPULSE_EPD_RED_MASK_STAGGER
void red_stagger_encode(unsigned pass,bool in_window,bool odd_row,
    uint8_t b,uint8_t r,uint8_t ob,uint8_t or_,uint8_t *mb,uint8_t *mr) {
  if(pass!=0 || !in_window) {
    red_activation_encode(pass,in_window,b,r,ob,or_,mb,mr);
    return;
  }
  const uint8_t target=(uint8_t)(((b^ob)|(r^or_)) & (uint8_t)~r);
  const uint8_t group_a=odd_row?0x55:0xaa;
  *mb=(uint8_t)~(target & (uint8_t)~group_a); /* Group B selects R24. */
  *mr=(uint8_t)~(target & group_a);          /* Group A selects R22. */
}
#endif
#endif
