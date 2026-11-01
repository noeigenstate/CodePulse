/* Replay noisy work through the real renderer/policy, not a timer-only mock. */
#define main legacy_dashboard_main
#include "test_dashboard.c"
#undef main

static unsigned update(display_sync_policy_t *p, quiet_dashboard_t *screen,
                       codepulse_ui_model_t *m, int64_t now) {
  if(display_sync_evaluate(p,now,m)==DISPLAY_SYNC_NONE)return 0;
  codepulse_ui_model_t out;display_sync_project(p,now,m,false,&out);
  epd_canvas_t c={black,red};quiet_dashboard_result_t result;
  assert(quiet_dashboard_update(screen,&c,&out,now,&result)==ESP_OK);
  display_sync_record_attempt(p,now,&out,true);
  return result.changed?1:0;
}
int main(void) {
  epd_canvas_t c={black,red};quiet_dashboard_t screen={0};quiet_dashboard_result_t r;
  codepulse_ui_model_t m=model(1);display_sync_policy_t p={0};
  m.threads[0].state=CODEPULSE_UI_AGENT_RUNNING;m.threads[0].level=CODEPULSE_LEVEL_ACTIVE;
  strcpy(m.threads[0].state_reason,"thinking");strcpy(m.threads[0].detail,"正在思考");
  assert(quiet_dashboard_update(&screen,&c,&m,0,&r)==ESP_OK);
  display_sync_record_attempt(&p,0,&m,true);
  unsigned drives=0;
  for(unsigned i=1;i<=120;i++) {
    strcpy(m.threads[0].state_reason,i%2?"thinking":"tool_running");
    snprintf(m.threads[0].detail,sizeof(m.threads[0].detail),"tool step %u",i);
    m.agents[0].five_hour_percent=30+(int)(i/10);
    m.temperature_c=30.9f+(float)i/30;
    drives+=update(&p,&screen,&m,(int64_t)i*1000);
  }
  assert(drives==1); /* one paced quota refresh; 120 stage changes do not drive */
  assert(p.displayed.temperature_c==30.9f);
  m.threads[0].state=CODEPULSE_UI_AGENT_WAITING;m.threads[0].level=CODEPULSE_LEVEL_ACTION;
  strcpy(m.threads[0].state_reason,"waiting_permission");
  assert(display_sync_evaluate(&p,121000,&m)==DISPLAY_SYNC_ATTENTION);
  assert(update(&p,&screen,&m,121000)==1);
  m.threads[0].state=CODEPULSE_UI_AGENT_RUNNING;m.threads[0].level=CODEPULSE_LEVEL_ACTIVE;
  strcpy(m.threads[0].state_reason,"thinking");assert(update(&p,&screen,&m,122000)==1);
  m.threads[0].state=CODEPULSE_UI_AGENT_DONE;m.threads[0].level=CODEPULSE_LEVEL_NOTICE;
  strcpy(m.threads[0].state_reason,"done");assert(update(&p,&screen,&m,123000)==1);
  m.threads[0].level=CODEPULSE_LEVEL_QUIET;assert(update(&p,&screen,&m,124000)==1);
  assert(p.displayed.thread_count==1);

  static codepulse_ambient_t note={.id="note1",.source="我的便签",.text="留住安静的一页"};
  m.ambient=&note;strcpy(m.ambient_id,"note1");assert(update(&p,&screen,&m,125000)==1);
  const unsigned before=partial_calls;
  for(unsigned i=1;i<=600;i++) {
    m.agents[0].five_hour_percent=(int)(i%99);m.temperature_c=20+(float)(i%20);
    m.battery_percent=(uint8_t)(i%100);m.wifi_connected=i%2;
    m.threads[0].state=i%2?CODEPULSE_UI_AGENT_IDLE:CODEPULSE_UI_AGENT_RUNNING;
    assert(!update(&p,&screen,&m,125000+(int64_t)i*1000));
  }
  assert(partial_calls==before);
  codepulse_ui_model_t manual;display_sync_project(&p,726000,&m,true,&manual);
  assert(manual.temperature_c==m.temperature_c);
  m.ambient=NULL;m.ambient_id[0]=0;m.threads[0].state=CODEPULSE_UI_AGENT_WAITING;
  m.threads[0].level=CODEPULSE_LEVEL_ACTION;strcpy(m.threads[0].state_reason,"waiting_user_input");
  assert(update(&p,&screen,&m,727000)==1);
  assert(p.displayed.threads[0].level==CODEPULSE_LEVEL_ACTION);

  m=model(1);p=(display_sync_policy_t){0};m.agents[0].five_hour_percent=-1;
  display_sync_record_attempt(&p,0,&m,true);m.agents[0].five_hour_percent=27;
  assert(display_sync_evaluate(&p,10,&m)==DISPLAY_SYNC_QUOTA);
  display_sync_record_attempt(&p,10,&m,true);m.agents[0].five_hour_percent=100;
  assert(display_sync_evaluate(&p,20,&m)==DISPLAY_SYNC_QUOTA);
  /* The actual dense-card update occupies only the status region. */
  quiet_dashboard_t dense={0};m=model(6);assert(quiet_dashboard_update(&dense,&c,&m,727000,&r)==ESP_OK);
  uint8_t old[EPD_CANVAS_BUFFER_SIZE];memcpy(old,black,sizeof(old));
  m.threads[0].state=CODEPULSE_UI_AGENT_DONE;m.threads[0].level=CODEPULSE_LEVEL_NOTICE;
  quiet_dashboard_render(&c,&m);
  unsigned first=50,end=0,top=300,bottom=0;
  for(unsigned y=0;y<300;y++)for(unsigned b=0;b<50;b++)if(old[y*50+b]!=black[y*50+b]) {
    if(b<first)first=b;if(b+1>end)end=b+1;if(y<top)top=y;if(y+1>bottom)bottom=y+1;
  }
  assert((end-first)*8<=64 && top>=85 && bottom<=108);
  FILE *f=fopen("paced-evidence.json","wb");assert(f);
  fprintf(f,"{\"stageChanges\":120,\"workDrives\":%u,\"heldContentUpdates\":600,\"heldContentDrives\":0,\"urgentBypass\":true,\"denseWidth\":%u,\"denseHeight\":%u,\"legacyWidth\":400}\n",drives,(end-first)*8,bottom-top);fclose(f);
  puts("PASS: 120 noisy stages -> one quota drive; held content 600 updates -> zero drives; urgent entry/exit/read preserved; narrow dense bounds measured");
  return 0;
}
