/* Offline replay of frozen render/mask/LUT code. No SPI, GPIO or serial API. */
#include <stdio.h>
#include <string.h>
#include "red_mask_probe.h"

static uint8_t black[EPD_CANVAS_BUFFER_SIZE],red[EPD_CANVAS_BUFFER_SIZE];
static uint8_t old_black[EPD_CANVAS_BUFFER_SIZE],old_red[EPD_CANVAS_BUFFER_SIZE];
static epd_canvas_t canvas={.black=black,.red=red};

static unsigned color(uint8_t b,uint8_t r,unsigned mask) {
  return !(r&mask)?2u:(!(b&mask)?1u:0u);
}
int main(void) {
  if(!red_mask_draw(&canvas,1)) return 2;
  memcpy(old_black,black,sizeof(black));memcpy(old_red,red,sizeof(red));
  if(!red_mask_draw(&canvas,2)) return 3;
  red_mask_plan_t plan;
  if(red_mask_prepare(&plan,&canvas,old_black,old_red,sizeof(black),
       RED_MASK_X,RED_MASK_Y,RED_MASK_WIDTH,RED_MASK_HEIGHT)!=ESP_OK) return 4;
  unsigned transitions[3][3]={{0}};
  for(unsigned y=RED_MASK_Y;y<RED_MASK_Y+RED_MASK_HEIGHT;++y)
    for(unsigned x=RED_MASK_X;x<RED_MASK_X+RED_MASK_WIDTH;++x) {
      const unsigned i=y*50u+x/8u,mask=0x80u>>(x%8u);
      ++transitions[color(old_black[i],old_red[i],mask)][color(black[i],red[i],mask)];
    }
  printf("{\"windowTransitionMatrixWhiteBlackRed\":[");
  for(unsigned a=0;a<3;++a) {
    printf("%s[",a?",":"");
    for(unsigned b=0;b<3;++b) printf("%s%u",b?",":"",transitions[a][b]);
    printf("]");
  }
  printf("],\"passes\":[");
  for(unsigned pass=0;pass<red_black_pass_count(&plan);++pass) {
    unsigned selected[5]={0},outside_active=0,old_black_to_white_held=0;
    for(unsigned i=0;i<EPD_CANVAS_BUFFER_SIZE;++i) {
      const unsigned row=i/50u,column=i%50u;
      const bool inside=row>=RED_MASK_Y && row<RED_MASK_Y+RED_MASK_HEIGHT &&
        column>=RED_MASK_X/8u && column<(RED_MASK_X+RED_MASK_WIDTH)/8u;
      uint8_t mb,mr;
#ifdef CODEPULSE_EPD_RED_MASK_STAGGER
      red_stagger_encode(pass,inside,(row&1u)!=0,black[i],red[i],old_black[i],old_red[i],&mb,&mr);
#else
      red_activation_encode(pass,inside,black[i],red[i],old_black[i],old_red[i],&mb,&mr);
#endif
      for(unsigned bit=0;bit<8;++bit) {
        const unsigned mask=0x80u>>bit;
        /* Independent DDX=11 mapping from the manufacturer table, R50. */
        const unsigned table=!(mr&mask)?2u:(!(mb&mask)?4u:3u);
        ++selected[table];
        outside_active+=!inside && table!=3u;
        old_black_to_white_held+=inside && table==3u &&
          color(old_black[i],old_red[i],mask)==1u && color(black[i],red[i],mask)==0u;
      }
    }
    printf("%s{\"pass\":%u,\"hz\":%u,\"declaredFrames\":%u,\"selectedPixelsR22R23R24\":[%u,%u,%u],\"outsideActive\":%u,\"oldBlackToWhiteHeld\":%u,\"tables\":[",
      pass?",":"",pass+1u,red_black_pass_hz(&plan,pass),red_black_pass_frames(&plan,pass),
      selected[2],selected[3],selected[4],outside_active,old_black_to_white_held);
    for(unsigned table=0;table<5;++table) {
      uint8_t lut[44]; const size_t count=red_black_make_lut(table,&plan,pass,lut);
      if(count!=(table?42u:44u)) return 5;
      printf("%s[",table?",":"");
      for(size_t j=0;j<count;++j) printf("%s%u",j?",":"",lut[j]);
      printf("]");
    }
    printf("]}");
  }
  printf("],\"hardwareAccessed\":false}\n");
  return 0;
}
