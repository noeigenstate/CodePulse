#include "codepulse_protocol.h"
#include "cJSON.h"
#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
static codepulse_remote_status_t remote;
static unsigned checks, accepted;
static const char *directory;
static cJSON *fixture(const char *name){
  char path[1024],input[8192];
  snprintf(path,sizeof(path),"%s/life-%s.json",directory,name);
  FILE *f=fopen(path,"rb");
  assert(f);
  size_t n=fread(input,1,sizeof(input)-1,f);
  fclose(f);
  input[n]=0;
  cJSON *root=cJSON_Parse(input);
  assert(root);
  return root;
}
static cJSON *ambient(cJSON *root){
  return cJSON_GetObjectItemCaseSensitive(root,"ambient");
}
static cJSON *life(cJSON *root){
  return cJSON_GetObjectItemCaseSensitive(ambient(root),"life");
}
static void check(cJSON *root,bool good){
  char *json=cJSON_PrintUnformatted(root);
  assert(json);
  assert(codepulse_protocol_parse(json,strlen(json),&remote)==ESP_OK && remote.valid);
  assert(remote.ambient.layout==(good?CODEPULSE_AMBIENT_LAYOUT_LIFE:CODEPULSE_AMBIENT_LAYOUT_LEGACY));
  assert(!remote.ambient.has_image && !remote.ambient.has_red && remote.ambient.text[0]);
  if(!good){
    const codepulse_life_t empty={
      0
    };
    assert(!memcmp(&remote.ambient.life,&empty,sizeof(empty)));
  } else {
    assert(remote.ambient.life.version==1 && remote.ambient.life.kind>=LIFE_WEATHER && remote.ambient.life.kind<=LIFE_HOLIDAY);
  }
  codepulse_ui_model_t model={
    0
  };
  codepulse_remote_apply(&remote,&model);
  assert(model.ambient==&remote.ambient);
  checks++;
  accepted+=good;
  cJSON_free(json);
  cJSON_Delete(root);
}
static void replace(cJSON *root,const char *key,cJSON *value){
  assert(cJSON_ReplaceItemInObjectCaseSensitive(life(root),key,value));
}
int main(int argc,char **argv){
  assert(argc==2);
  directory=argv[1];
  const char *names[]={
    "weather","gold","stock-down","stock-up","stock-closed","tool-codex","tool-claude","news","holiday-yes","holiday-none"
  };
  for(unsigned i=0;i<10;i++){
    check(fixture(names[i]),true);
  }
  for(unsigned i=0;i<10;i++){
    cJSON *root=fixture(names[i]);
    cJSON_DeleteItemFromObjectCaseSensitive(life(root),"v");
    check(root,false);
    root=fixture(names[i]);
    replace(root,"v",cJSON_CreateNumber(2));
    check(root,false);
    root=fixture(names[i]);
    replace(root,"kind",cJSON_CreateString("future"));
    check(root,false);
    root=fixture(names[i]);
    assert(cJSON_ReplaceItemInObjectCaseSensitive(ambient(root),"layout",cJSON_CreateString("future")));
    check(root,false);
  }
  for(unsigned i=0;i<6;i++){
    cJSON *root=fixture("weather"),*bad=i==0?cJSON_CreateNull():i==1?cJSON_CreateArray():i==2?cJSON_CreateNumber(1):i==3?cJSON_CreateBool(true):i==4?cJSON_CreateString("life"):cJSON_CreateObject();
    assert(cJSON_ReplaceItemInObjectCaseSensitive(ambient(root),"life",bad));
    check(root,false);
  }
  const char *stock_keys[]={
    "name","symbol","hero","direction","state","percent","change","low","high","open","previous","source"
  };
  for(unsigned i=0;i<12;i++){
    cJSON *root=fixture("stock-up");
    cJSON_DeleteItemFromObjectCaseSensitive(life(root),stock_keys[i]);
    check(root,false);
    root=fixture("stock-up");
    replace(root,stock_keys[i],cJSON_CreateArray());
    check(root,false);
  }
  for(unsigned i=0;i<5;i++){
    const char *values[]={
      "aapl.us","AAPL.UNKNOWN",".US","AAPL","AAPL..US"
    };
    cJSON *root=fixture("stock-down");
    replace(root,"symbol",cJSON_CreateString(values[i]));
    check(root,false);
  }
  const char *numeric[]={
    "NaN","Infinity","12%","+","1.",".5","1e10","12345678901","1.1234567","１２"
  };
  for(unsigned i=0;i<10;i++){
    cJSON *root=fixture("gold");
    replace(root,"hero",cJSON_CreateString(numeric[i]));
    check(root,false);
  }
  for(unsigned i=0;i<2;i++){
    cJSON *root=fixture("weather");
    replace(root,"sunset",cJSON_CreateString(i?"99:99":"24:00"));
    check(root,false);
  }
  const char *tomorrow_keys[]={
    "icon","condition","low","high"
  };
  for(unsigned i=0;i<4;i++){
    cJSON *root=fixture("weather");
    cJSON_DeleteItemFromObjectCaseSensitive(cJSON_GetObjectItemCaseSensitive(life(root),"tomorrow"),tomorrow_keys[i]);
    check(root,false);
  }
  {
    cJSON *root=fixture("weather");
    cJSON_DeleteItemFromObjectCaseSensitive(life(root),"tomorrow");
    check(root,true);
  }
  for(unsigned count=0;count<=5;count+=5){
    cJSON *root=fixture("news"),*items=cJSON_CreateArray();
    for(unsigned i=0;i<count;i++){
      cJSON_AddItemToArray(items,cJSON_Duplicate(cJSON_GetArrayItem(cJSON_GetObjectItemCaseSensitive(life(root),"headlines"),0),1));
    }
    replace(root,"headlines",items);
    check(root,false);
  }
  for(unsigned i=0;i<3;i++){
    cJSON *root=fixture("news"),*item=cJSON_GetArrayItem(cJSON_GetObjectItemCaseSensitive(life(root),"headlines"),0);
    assert(cJSON_ReplaceItemInObjectCaseSensitive(item,i==2?"source":"title",cJSON_CreateString(i==0?"":i==1?"12345678901234567890123456789":"一二三四五六七八九")));
    check(root,false);
  }
  for(unsigned i=0;i<3;i++){
    cJSON *root=fixture("tool-codex");
    replace(root,i==2?"command":"name",cJSON_CreateString(i==0?"x\x1f":"123456789012345678901234567"));
    check(root,false);
  }
  {
    cJSON *root=fixture("tool-codex");
    replace(root,"name",cJSON_CreateString("x\xc2\x85"));
    check(root,false);
  }
  for(unsigned i=0;i<3;i++){
    cJSON *root=fixture("holiday-yes"),*r=cJSON_GetObjectItemCaseSensitive(life(root),"range");
    assert(cJSON_ReplaceItemInObjectCaseSensitive(r,i==0?"days":"end",i==0?cJSON_CreateNumber(4):cJSON_CreateString(i==1?"2027-02-30":"2026-12-01")));
    check(root,false);
  }
  {
    cJSON *root=fixture("holiday-none");
    cJSON *r=cJSON_CreateObject();
    cJSON_AddItemToObject(life(root),"range",r);
    check(root,false);
  }
  {
    cJSON *root=fixture("holiday-yes"),*r=cJSON_GetObjectItemCaseSensitive(life(root),"range");
    assert(cJSON_ReplaceItemInObjectCaseSensitive(r,"start",cJSON_CreateString("2026-01-01")));
    assert(cJSON_ReplaceItemInObjectCaseSensitive(r,"end",cJSON_CreateString("2026-01-03")));
    check(root,false);
  }
  printf("PASS life protocol: %u cases (%u valid, %u text fallbacks); host life=%zu ambient=%zu remote=%zu bytes\n",checks,accepted,checks-accepted,sizeof(codepulse_life_t),sizeof(codepulse_ambient_t),sizeof(codepulse_remote_status_t));
  return 0;
}
