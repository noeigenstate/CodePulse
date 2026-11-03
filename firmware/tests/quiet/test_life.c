#define main legacy_dashboard_main
#include "test_dashboard.c"
#undef main
#include "../../main/life_assets.generated.h"
static codepulse_ambient_t card={
  .id="life-stock",.source="元宝搜索",.text="Life text fallback",.layout=CODEPULSE_AMBIENT_LAYOUT_LIFE,
  .life={
    .version=1,.kind=LIFE_STOCK,.data.stock={
      .direction=LIFE_UP,.state=1,.name="苹果",.symbol="AAPL.US",
      .hero="341.24",.percent="0.98%",.change="+3.39",.low="339.61",.high="343.78",.open="342.67",.previous="344.63",.source="腾讯自选股"
    }
  }
};
static uint8_t original_black[EPD_CANVAS_BUFFER_SIZE],original_red[EPD_CANVAS_BUFFER_SIZE];
static bool any_red(void){
  for(unsigned i=0;i<sizeof(red);i++){
    if(red[i]!=255){
      return true;
    }
  }
  return false;
}
static void pigments(void){
  for(unsigned i=0;i<sizeof(red);i++){
    CHECK((black[i]|red[i])==255);
  }
}
int main(void){
  CHECK(display_text_init());
  epd_canvas_t canvas={
    black,red
  };
  codepulse_ui_model_t model={
    .ambient=&card
  };
  card.life.data.stock.direction=LIFE_DOWN;
  quiet_dashboard_render(&canvas,&model);
  CHECK(!any_red());
  pigments();
  memcpy(original_black,black,sizeof(black));
  memcpy(original_red,red,sizeof(red));
  card.life.data.stock.direction=LIFE_UP;
  card.life.data.stock.state=2;
  quiet_dashboard_render(&canvas,&model);
  CHECK(!any_red());
  pigments();
  card.life.data.stock.state=1;
  quiet_dashboard_render(&canvas,&model);
  CHECK(any_red());
  pigments();
  for(unsigned y=0;y<300;y++){
    if(y<31 || y>262){
      for(unsigned x=0;x<50;x++){
        CHECK(black[y*50+x]==original_black[y*50+x]);
        CHECK(red[y*50+x]==original_red[y*50+x]);
      }
    }
  }
  card.layout=CODEPULSE_AMBIENT_LAYOUT_LEGACY;
  quiet_dashboard_render(&canvas,&model);
  memcpy(original_black,black,sizeof(black));
  memcpy(original_red,red,sizeof(red));
  card.layout=CODEPULSE_AMBIENT_LAYOUT_LIFE;
  card.life.version=2;
  quiet_dashboard_render(&canvas,&model);
  CHECK(!memcmp(original_black,black,sizeof(black)) && !memcmp(original_red,red,sizeof(red)));
  card.life.version=1;
  strcpy(card.life.data.stock.name,"😀");
  quiet_dashboard_render(&canvas,&model);
  CHECK(!memcmp(original_black,black,sizeof(black)) && !memcmp(original_red,red,sizeof(red)));
  strcpy(card.life.data.stock.name,"苹果");
  strcpy(card.life.data.stock.hero,"1234567890123");
  quiet_dashboard_render(&canvas,&model);
  CHECK(!memcmp(original_black,black,sizeof(black)) && !memcmp(original_red,red,sizeof(red)));
  strcpy(card.life.data.stock.hero,"341.24");
  quiet_dashboard_t state={
    0
  };
  quiet_dashboard_result_t result;
  CHECK(quiet_dashboard_update(&state,&canvas,&model,0,&result)==ESP_OK && result.full && any_red());
  card.life.data.stock.direction=LIFE_DOWN;
  CHECK(quiet_dashboard_update(&state,&canvas,&model,1,&result)==ESP_OK && result.red_full && !any_red());
  int64_t completed=state.last_full_ms;
  card.life.data.stock.direction=LIFE_UP;
  CHECK(quiet_dashboard_update(&state,&canvas,&model,completed+1,&result)==ESP_OK && !result.red_full && !any_red());
  CHECK(quiet_dashboard_update(&state,&canvas,&model,completed+120000,&result)==ESP_OK && result.red_full && any_red());
  pigments();
  printf("PASS life renderer: colors, unchanged chrome, invalid/unsupported/oversize fallback, 120s red cooldown; assets=%zu bytes\n",
  sizeof(life_icon_pixels)+sizeof(life_icons)+sizeof(life_font_codes)+sizeof(life_font_rows));
  return 0;
}
