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
#ifdef CODEPULSE_EPD_RED_MASK_ACTIVATE
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
  if(plan->operation==RED_MASK_PAINT) return 2u;
#endif
  return plan->operation==RED_MASK_ERASE && plan->black_pixels ? 2u:1u;
}
unsigned red_black_pass_frames(const red_mask_plan_t *plan,unsigned pass) {
  if(pass>=red_black_pass_count(plan)) return 0;
  if(plan->operation==RED_MASK_PAINT) {
#ifdef CODEPULSE_EPD_RED_MASK_COLOR
#ifdef CODEPULSE_EPD_RED_MASK_ACTIVATE
    return pass==0?RED_MASK_RED_ACTIVATE_FRAMES:RED_MASK_BW_FRAMES+1u;
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
#ifdef CODEPULSE_EPD_RED_MASK_FAST
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
    if(pass==0) {
      /* Complete phase order of .39; only groups 1/2/3 repeat counts reduce
       * to one. Red-only pixels get the entire sequence, NOT just its tail.
       * Numeric data attribution is the same as the retained .45 tail below.
       * Remaining selectors retain level 00 with synchronized durations. */
#ifdef CODEPULSE_EPD_RED_MASK_FAST
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
        out[group*6]=table==2?conditioned[group][0]:0;
        memcpy(out+group*6+1,conditioned[group]+1,5);
      }
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
  if(!in_window || pass>1u) return;
  if(pass==0) {
    const uint8_t changed=(uint8_t)((b^ob)|(r^or_));
    *mr=(uint8_t)~(changed & (uint8_t)~r);
  } else {
    /* Intentional local redraw of target white, including unchanged glyph
     * holes. This must never be applied to the surrounding full-frame white. */
    *mb=(uint8_t)~(b&r);
  }
}
#endif
