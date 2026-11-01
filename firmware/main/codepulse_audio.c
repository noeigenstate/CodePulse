#include "codepulse_audio.h"

#ifndef CODEPULSE_AUDIO_ENABLED
esp_err_t codepulse_audio_start(void) { return ESP_OK; }
void codepulse_audio_stop(void) {}
#else
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include "audio_board_config.h"
#include "audio_pin_policy.h"
#include "device_config.h"
#include "device_identity.h"
#include "wifi_manager.h"
#include "cJSON.h"
#include "driver/gpio.h"
#include "driver/i2s_std.h"
#if CODEPULSE_AUDIO_INPUT_ENABLED
#include "driver/i2s_pdm.h"
#endif
#include "esp_heap_caps.h"
#include "esp_check.h"
#include "esp_http_client.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

static const char *TAG = "codepulse_audio";
static volatile bool s_stopped = true;
static TaskHandle_t s_task;
static i2s_chan_handle_t s_tx;
#if CODEPULSE_AUDIO_INPUT_ENABLED
static i2s_chan_handle_t s_rx;
#endif
static bool s_amp_ready;
static char s_device_id[CODEPULSE_DEVICE_ID_MAX_BYTES + 1];
static char s_last_announcement[81];
static uint64_t gpio_mask(int pin) { return pin<0||pin>48?0:UINT64_C(1)<<((unsigned)pin&63U); }
#if defined(CODEPULSE_AUDIO_COMPILE_TEST)
static volatile const bool s_compile_only = true;
#endif

static void amp(bool on) {
  if (s_amp_ready && CODEPULSE_AUDIO_AMP_EN >= 0)
    gpio_set_level(CODEPULSE_AUDIO_AMP_EN, on && !s_stopped ? CODEPULSE_AUDIO_AMP_ACTIVE_HIGH : !CODEPULSE_AUDIO_AMP_ACTIVE_HIGH);
}

typedef struct {
  char *json;
  size_t capacity, length, audio_length;
  bool audio, audio_type, failed;
  uint8_t odd_byte;
  bool has_odd_byte;
} audio_response_t;

/* Same simplex design as Xiaozhi's NoAudioCodecSimplexPdm: PDM on I2S0, speaker on I2S1.
 * MIT attribution is included in THIRD-PARTY-NOTICES-AUDIO.txt. No wake model or OTA stack is copied. */
static esp_err_t initialize_i2s(void) {
  const codepulse_audio_pins_t pins = {
    CODEPULSE_AUDIO_BCLK,CODEPULSE_AUDIO_WS,CODEPULSE_AUDIO_DOUT,CODEPULSE_AUDIO_AMP_EN,
    CODEPULSE_AUDIO_INPUT_ENABLED,CODEPULSE_AUDIO_MIC_CLK,CODEPULSE_AUDIO_MIC_DATA,CODEPULSE_AUDIO_TALK_BUTTON};
  if (!codepulse_audio_pins_valid(&pins)) return ESP_ERR_INVALID_ARG;
  if (CODEPULSE_AUDIO_AMP_EN >= 0) {
    gpio_config_t cfg = {.pin_bit_mask=gpio_mask(CODEPULSE_AUDIO_AMP_EN),.mode=GPIO_MODE_OUTPUT};
    ESP_RETURN_ON_ERROR(gpio_config(&cfg),TAG,"amp config failed");
    s_amp_ready=true; amp(false);
  }
  i2s_chan_config_t tx = I2S_CHANNEL_DEFAULT_CONFIG(I2S_NUM_1,I2S_ROLE_MASTER);
  tx.auto_clear_after_cb=true;
  esp_err_t err=i2s_new_channel(&tx,&s_tx,NULL);
  if(err!=ESP_OK)return err;
  i2s_std_config_t std = {
    .clk_cfg=I2S_STD_CLK_DEFAULT_CONFIG(CODEPULSE_AUDIO_RATE),
    .slot_cfg=I2S_STD_PHILIPS_SLOT_DEFAULT_CONFIG(I2S_DATA_BIT_WIDTH_16BIT,I2S_SLOT_MODE_STEREO),
    .gpio_cfg={.mclk=I2S_GPIO_UNUSED,.bclk=CODEPULSE_AUDIO_BCLK,.ws=CODEPULSE_AUDIO_WS,.dout=CODEPULSE_AUDIO_DOUT,.din=I2S_GPIO_UNUSED}};
  std.slot_cfg.bit_shift=true; /* MAX98357A Philips I2S, both output slots. */
  err=i2s_channel_init_std_mode(s_tx,&std);
  if(err!=ESP_OK)return err;
#if CODEPULSE_AUDIO_INPUT_ENABLED
  i2s_chan_config_t rx=I2S_CHANNEL_DEFAULT_CONFIG(I2S_NUM_0,I2S_ROLE_MASTER);
  err=i2s_new_channel(&rx,NULL,&s_rx);
  if(err!=ESP_OK)return err;
  i2s_pdm_rx_config_t pdm={
    .clk_cfg=I2S_PDM_RX_CLK_DEFAULT_CONFIG(CODEPULSE_AUDIO_RATE),
    .slot_cfg=I2S_PDM_RX_SLOT_DEFAULT_CONFIG(I2S_DATA_BIT_WIDTH_16BIT,I2S_SLOT_MODE_MONO),
    .gpio_cfg={.clk=CODEPULSE_AUDIO_MIC_CLK,.din=CODEPULSE_AUDIO_MIC_DATA}};
  err=i2s_channel_init_pdm_rx_mode(s_rx,&pdm);
  if(err!=ESP_OK)return err;
  gpio_config_t button={.pin_bit_mask=gpio_mask(CODEPULSE_AUDIO_TALK_BUTTON),.mode=GPIO_MODE_INPUT,.pull_up_en=GPIO_PULLUP_ENABLE};
  err=gpio_config(&button);
#endif
  return err;
}

static esp_err_t pcm_write(const uint8_t *data,size_t size) {
  int16_t stereo[512];
  while(size>=2&&!s_stopped) {
    size_t samples=size/2;if(samples>256)samples=256;
    for(size_t i=0;i<samples;++i){
      int16_t mono=(int16_t)((uint16_t)data[i*2]|((uint16_t)data[i*2+1]<<8));
      mono=(int16_t)(mono/2);stereo[i*2]=mono;stereo[i*2+1]=mono;
    }
    size_t written=0,bytes=samples*4;
    esp_err_t err=i2s_channel_write(s_tx,stereo,bytes,&written,250);
    if(err!=ESP_OK||written!=bytes)return err==ESP_OK?ESP_ERR_TIMEOUT:err;
    data+=samples*2;size-=samples*2;
  }
  return s_stopped?ESP_ERR_INVALID_STATE:ESP_OK;
}
static esp_err_t on_http(esp_http_client_event_t *event) {
  audio_response_t *r=event->user_data;
  if(s_stopped)return ESP_FAIL;
  if(event->event_id==HTTP_EVENT_ON_HEADER&&event->header_key&&event->header_value&&strcasecmp(event->header_key,"Content-Type")==0)
    r->audio_type=strncasecmp(event->header_value,"application/octet-stream",24)==0;
  if(event->event_id!=HTTP_EVENT_ON_DATA||event->data_len<=0)return ESP_OK;
  size_t size=(size_t)event->data_len;const uint8_t *data=event->data;
  if(r->audio){
    if(!r->audio_type||esp_http_client_get_status_code(event->client)!=200||r->audio_length+size>1920000){r->failed=true;return ESP_FAIL;}
    r->audio_length+=size;
    if(r->has_odd_byte){uint8_t pair[]={r->odd_byte,data[0]};if(pcm_write(pair,2)!=ESP_OK){r->failed=true;return ESP_FAIL;}data++;size--;r->has_odd_byte=false;}
    if(size&1){r->odd_byte=data[size-1];r->has_odd_byte=true;size--;}
    if(size&&pcm_write(data,size)!=ESP_OK){r->failed=true;return ESP_FAIL;}
  }else{
    if(r->length+size>r->capacity){r->failed=true;return ESP_FAIL;}
    memcpy(r->json+r->length,data,size);r->length+=size;r->json[r->length]=0;
  }
  return ESP_OK;
}
static esp_err_t request(const char *path,const void *body,size_t length,const char *content_type,audio_response_t *response) {
  if(s_stopped||!wifi_manager_is_connected())return ESP_ERR_INVALID_STATE;
  codepulse_device_config_t config;
  esp_err_t err=codepulse_device_config_load(&config);
  if(err!=ESP_OK)return err;
  char url[256];
  int n=snprintf(url,sizeof(url),"http://%s:%u/api/v1/device/assistant/%s",config.server_host,(unsigned)config.server_port,path);
  if(n<=0||(size_t)n>=sizeof(url))return ESP_ERR_INVALID_SIZE;
  esp_http_client_config_t cfg={.url=url,.timeout_ms=65000,.event_handler=on_http,.user_data=response,.disable_auto_redirect=true,.buffer_size=2048,.buffer_size_tx=1024};
  esp_http_client_handle_t http=esp_http_client_init(&cfg);
  if(!http)return ESP_ERR_NO_MEM;
  err=esp_http_client_set_header(http,"X-CodePulse-Device-Token",config.device_token);
  if(err==ESP_OK)err=esp_http_client_set_header(http,"X-CodePulse-Device-Id",s_device_id);
  if(err==ESP_OK&&body){
    err=esp_http_client_set_method(http,HTTP_METHOD_POST);
    if(err==ESP_OK)err=esp_http_client_set_header(http,"Content-Type",content_type);
    if(err==ESP_OK)err=esp_http_client_set_post_field(http,body,(int)length);
  }
  if(err==ESP_OK&&!s_stopped)err=esp_http_client_perform(http);
  int status=esp_http_client_get_status_code(http);esp_http_client_cleanup(http);
  memset(&config,0,sizeof(config));
  if(err==ESP_OK&&(status!=200||response->failed||response->has_odd_byte))err=ESP_ERR_INVALID_RESPONSE;
  return err;
}
static esp_err_t speak(const char *text) {
  if(s_stopped||!text||!text[0])return ESP_ERR_INVALID_STATE;
  cJSON *json=cJSON_CreateObject();if(!json)return ESP_ERR_NO_MEM;
  cJSON_AddStringToObject(json,"text",text);char *body=cJSON_PrintUnformatted(json);cJSON_Delete(json);
  if(!body)return ESP_ERR_NO_MEM;
  audio_response_t response={.audio=true};
  esp_err_t err=i2s_channel_enable(s_tx);
  if(err==ESP_OK){
    amp(true);err=request("speech",body,strlen(body),"application/json",&response);
    /* Drain the bounded DMA queue before muting; never prolong a shutdown request. */
    if(err==ESP_OK)for(unsigned i=0;i<12&&!s_stopped;i++)vTaskDelay(pdMS_TO_TICKS(10));
    amp(false);i2s_channel_disable(s_tx);
  }
  free(body);
  if(err==ESP_OK&&response.audio_length==0)err=ESP_ERR_INVALID_RESPONSE;
  return err;
}
#if CODEPULSE_AUDIO_INPUT_ENABLED
static void capture_and_respond(void) {
  const size_t max=CODEPULSE_AUDIO_RATE*2*CODEPULSE_AUDIO_MAX_SECONDS;
  uint8_t *pcm=heap_caps_malloc(max,MALLOC_CAP_SPIRAM|MALLOC_CAP_8BIT);
  if(!pcm)return;
  size_t total=0;int64_t until=esp_timer_get_time()+CODEPULSE_AUDIO_MAX_SECONDS*1000000LL;
  amp(false);
  esp_err_t err=i2s_channel_enable(s_rx);
  if(err==ESP_OK){
    while(!s_stopped&&gpio_get_level(CODEPULSE_AUDIO_TALK_BUTTON)==0&&esp_timer_get_time()<until&&total<max){
      size_t size=0,want=max-total;if(want>2048)want=2048;
      err=i2s_channel_read(s_rx,pcm+total,want,&size,100);
      if(err!=ESP_OK&&err!=ESP_ERR_TIMEOUT)break;
      total+=size;
    }
    i2s_channel_disable(s_rx);
  }
  if(!s_stopped&&total>=3200&&(err==ESP_OK||err==ESP_ERR_TIMEOUT)){
    char json[8193]={0};audio_response_t response={.json=json,.capacity=sizeof(json)-1};
    err=request("voice",pcm,total,"application/octet-stream",&response);
    if(err==ESP_OK){cJSON *result=cJSON_Parse(json);cJSON *reply=cJSON_GetObjectItemCaseSensitive(result,"reply");if(cJSON_IsString(reply))speak(reply->valuestring);cJSON_Delete(result);}
  }
  memset(pcm,0,total);heap_caps_free(pcm);
  while(!s_stopped&&gpio_get_level(CODEPULSE_AUDIO_TALK_BUTTON)==0)vTaskDelay(pdMS_TO_TICKS(25));
}
#endif
static void poll_announcement(void) {
  char body[2049]={0};audio_response_t response={.json=body,.capacity=sizeof(body)-1};
  if(request("announcement",NULL,0,NULL,&response)!=ESP_OK)return;
  cJSON *root=cJSON_Parse(body),*item=cJSON_GetObjectItemCaseSensitive(root,"announcement");
  cJSON *title=cJSON_GetObjectItemCaseSensitive(item,"text"),*id=cJSON_GetObjectItemCaseSensitive(item,"id");
  if(cJSON_IsString(title)&&cJSON_IsString(id)&&strlen(id->valuestring)<sizeof(s_last_announcement)&&
      (!strcmp(s_last_announcement,id->valuestring)||speak(title->valuestring)==ESP_OK)&&!s_stopped){
    snprintf(s_last_announcement,sizeof(s_last_announcement),"%s",id->valuestring);
    cJSON *ack=cJSON_CreateObject();cJSON_AddStringToObject(ack,"id",id->valuestring);char *json=cJSON_PrintUnformatted(ack);cJSON_Delete(ack);
    if(json){char out[129]={0};audio_response_t r={.json=out,.capacity=sizeof(out)-1};request("announcement/ack",json,strlen(json),"application/json",&r);free(json);}
  }
  cJSON_Delete(root);
}
static void audio_task(void *arg) {
  (void)arg;int64_t poll_at=0;
  while(!s_stopped){
#if CODEPULSE_AUDIO_INPUT_ENABLED
    if(gpio_get_level(CODEPULSE_AUDIO_TALK_BUTTON)==0){vTaskDelay(pdMS_TO_TICKS(35));if(!s_stopped&&gpio_get_level(CODEPULSE_AUDIO_TALK_BUTTON)==0)capture_and_respond();}
#endif
    if(!s_stopped&&esp_timer_get_time()>=poll_at){poll_announcement();poll_at=esp_timer_get_time()+5000000;}
    vTaskDelay(pdMS_TO_TICKS(25));
  }
  amp(false);s_task=NULL;vTaskDelete(NULL);
}
esp_err_t codepulse_audio_start(void) {
#if defined(CODEPULSE_AUDIO_COMPILE_TEST)
  /* Build-only images can never drive an unverified PCB, even if flashed by mistake. */
  if (s_compile_only) return ESP_ERR_NOT_SUPPORTED;
#endif
  if(s_task)return ESP_OK;
  esp_err_t err=initialize_i2s();
  if(err!=ESP_OK){amp(false);return err;}
  codepulse_device_identity_t identity;
  err=codepulse_device_identity_read(&identity);
  if(err!=ESP_OK){amp(false);return err;}
  memcpy(s_device_id,identity.device_id,sizeof(s_device_id));s_stopped=false;
  if(xTaskCreate(audio_task,"desk_audio",20480,NULL,2,&s_task)!=pdPASS){s_stopped=true;amp(false);return ESP_ERR_NO_MEM;}
  ESP_LOGI(TAG,"optional audio ready; capture requires dedicated talk button");return ESP_OK;
}
void codepulse_audio_stop(void) {s_stopped=true;amp(false);}
#endif
