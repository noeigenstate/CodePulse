/* Default-off .43 variant. One manual erase operation has two bounded passes:
 * clear changed pixels, then write only new black letters. No recovery loops.
 * .44 adds clear-then-color (failed: target red was black).
 * .45 preserves the known red tail's alternating groups, still optically
 * unqualified on held surroundings. .46 keeps all red phases with reduced
 * conditioning, then clears local white glyphs. No automatic retries. */
#include "red_mask_probe.h"

esp_err_t epd_red_mask_refresh(const epd_canvas_t *c,
    const uint8_t *old_black,const uint8_t *old_red,size_t size,
    unsigned x,unsigned y,unsigned width,unsigned height,epd_quiet_metrics_t *m) {
  if(m) memset(m,0,sizeof(*m));
  red_mask_plan_t plan;
  if(!m || !s_spi ||
      red_mask_prepare(&plan,c,old_black,old_red,size,x,y,width,height)!=ESP_OK)
    return ESP_ERR_INVALID_ARG;
  if(!s_epd_baseline_valid) return ESP_ERR_INVALID_STATE;
  s_epd_baseline_valid=false;
  if(gpio_get_level(PIN_EPD_BUSY)==0) return ESP_ERR_INVALID_STATE;
  _Static_assert(BOARD_EPD_WIDTH==400 && BOARD_EPD_HEIGHT==300,"Board1 only");
  const int64_t started=esp_timer_get_time();
  int64_t phase=started;
  bool entered=false;
  m->x=x;m->width=width;
  const uint8_t boost[]={0x17,0x17,0x17}, psr=0x2f,cdi=0xf7,pll=0x3a;
  const uint8_t resolution[]={1,144,1,44};
  const unsigned last_x=x+width-1u,last_y=y+height-1u;
  const uint8_t window[]={(uint8_t)(x>>8),(uint8_t)x,(uint8_t)(last_x>>8),(uint8_t)last_x,
      (uint8_t)(y>>8),(uint8_t)y,(uint8_t)(last_y>>8),(uint8_t)last_y,0};
  esp_err_t result=epd_command_data(0x06,boost,sizeof(boost));
  if(result==ESP_OK) result=epd_command(0x04);
  if(result==ESP_OK) result=epd_wait_ready(EPD_INIT_TIMEOUT_MS);
  if(result==ESP_OK) result=epd_command_data(0x00,&psr,1);
  if(result==ESP_OK) result=epd_command_data(0x30,&pll,1);
  if(result==ESP_OK) result=epd_command_data(0x50,&cdi,1);
  if(result==ESP_OK) result=epd_command_data(0x61,resolution,sizeof(resolution));
  m->init_ms=quiet_elapsed_ms(phase);
  const unsigned passes=red_black_pass_count(&plan);
  for(unsigned pass=0;result==ESP_OK && pass<passes;++pass) {
    phase=esp_timer_get_time();
    result=epd_command(0x92);
#if defined(CODEPULSE_EPD_RED_MASK_FAST) || defined(CODEPULSE_EPD_RED_MASK_SPLIT)
    if(result==ESP_OK && plan.operation==RED_MASK_PAINT) {
      const unsigned hz=red_black_pass_hz(&plan,pass);
      const unsigned previous_hz=pass?red_black_pass_hz(&plan,pass-1u):100u;
      if(hz!=previous_hz) {
        const uint8_t phase_pll=hz==200u?0x39:0x3a;
        result=epd_command_data(0x30,&phase_pll,1);
      }
    }
#endif
    uint8_t block[256];
    for(unsigned plane=0;result==ESP_OK && plane<2;++plane) {
      result=epd_command(plane?0x13:0x10);
      for(size_t offset=0;result==ESP_OK && offset<size;offset+=sizeof(block)) {
        const size_t length=size-offset<sizeof(block)?size-offset:sizeof(block);
        for(size_t i=0;i<length;++i) {
          uint8_t mb,mr;
#ifdef CODEPULSE_EPD_RED_MASK_ACTIVATE
          if(plan.operation==RED_MASK_PAINT) {
            const size_t index=offset+i,row=index/50u,column=index%50u;
            const bool inside=row>=y && row<y+height && column>=x/8u && column<(x+width)/8u;
#ifdef CODEPULSE_EPD_RED_MASK_STAGGER
            red_stagger_encode(pass,inside,(row&1u)!=0,c->black[index],c->red[index],
                old_black[index],old_red[index],&mb,&mr);
#else
            red_activation_encode(pass,inside,c->black[index],c->red[index],
                old_black[index],old_red[index],&mb,&mr);
#endif
          } else
#endif
          red_black_encode(&plan,pass,c->black[offset+i],c->red[offset+i],
              old_black[offset+i],old_red[offset+i],&mb,&mr);
          block[i]=plane?mr:mb;
        }
        result=epd_transmit(block,length,1);
      }
    }
    uint8_t lut[44];
    for(unsigned table=0;result==ESP_OK && table<5;++table) {
      const size_t length=red_black_make_lut(table,&plan,pass,lut);
      if(length!=(table?42u:44u)) {result=ESP_ERR_INVALID_ARG;break;}
      result=epd_command_data((uint8_t)(0x20u+table),lut,length);
    }
    if(result==ESP_OK) {result=epd_command(0x91);entered=result==ESP_OK;}
    if(result==ESP_OK) result=epd_command_data(0x90,window,sizeof(window));
    m->upload_ms+=quiet_elapsed_ms(phase);
    phase=esp_timer_get_time();
    epd_quiet_metrics_t measured={0};
    if(result==ESP_OK) result=epd_command(0x12);
    if(result==ESP_OK) result=quiet_wait_refresh(&measured);
    const uint32_t driven_ms=quiet_elapsed_ms(phase);
    m->refresh_ms+=driven_ms;
    m->busy_seen|=measured.busy_seen;
    m->busy_low_ms+=measured.busy_low_ms;
    if(pass==0) m->busy_assert_ms=measured.busy_assert_ms;
    ESP_LOGI("red_mask_probe","pass=%u/%u phase=%s hz=%u frames=%u refresh=%lu busy=%u result=%s",
        pass+1,passes,plan.operation==RED_MASK_PAINT?RED_MASK_PAINT_PHASE(pass):(pass==0?"CLEAR_CHANGED":"BLACK_ONLY"),
        red_black_pass_hz(&plan,pass),red_black_pass_frames(&plan,pass),
        (unsigned long)driven_ms,measured.busy_seen,esp_err_to_name(result));
    /* Never proceed into the next phase if the current drive exceeded its
     * bound. A second planned phase is not a retry or recovery exposure. */
    if(result==ESP_OK && driven_ms >= (plan.operation==RED_MASK_PAINT?RED_MASK_PAINT_PASS_GATE_MS(pass):3500u))
      result=ESP_ERR_INVALID_RESPONSE;
#ifdef CODEPULSE_EPD_RED_MASK_SPLIT
    if(result==ESP_OK && plan.operation==RED_MASK_PAINT && pass<2u &&
        m->refresh_ms>=RED_MASK_SPLIT_RED_GATE_MS)
      result=ESP_ERR_INVALID_RESPONSE;
#endif
    if(entered && gpio_get_level(PIN_EPD_BUSY)!=0) {
      const esp_err_t exit_error=epd_command(0x92);
      if(result==ESP_OK) result=exit_error;
      entered=false;
    }
  }
  phase=esp_timer_get_time();
  const esp_err_t off_error=epd_power_off();
  if(result==ESP_OK) result=off_error;
  /* Only a completely finished operation can establish the new canonical
   * frame. Failures leave the session invalid; no extra refresh is attempted. */
  if(result==ESP_OK) result=epd_command_data(0x10,c->black,size);
  if(result==ESP_OK) result=epd_command_data(0x13,c->red,size);
  m->off_ms=quiet_elapsed_ms(phase);
  m->total_ms=quiet_elapsed_ms(started);
  s_epd_baseline_valid=result==ESP_OK;
  return result;
}
