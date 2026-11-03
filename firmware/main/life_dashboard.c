#include "life_dashboard.h"
#include "life_assets.generated.h"
#include "display_text.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
/* Approved B: body only (31..262). Existing header/footer and refresh policy stay shared. */
typedef enum {
  C14, C16, SMALL, MID, HERO
}
role_t;
typedef struct {
  role_t role;
  const char *text;
  epd_color_t color;
}
part_t;
static display_font_t native(role_t r) {
  return r == C14 ? DISPLAY_BODY : r == SMALL ? DISPLAY_SUMMARY : DISPLAY_TITLE;
}
static void pixel(epd_canvas_t *c, int x, int y, epd_color_t color) {
  if (x >= 12 && x <= 387 && y >= 31 && y <= 262) {
    epd_canvas_pixel(c,x,y,color);
  }
}
static void rect(epd_canvas_t *c, int x, int y, int w, int h, epd_color_t color) {
  for (int row=0;row<h;row++) {
    for(int col=0;col<w;col++) {
      pixel(c,x+col,y+row,color);
    }
  }
}
static void hline(epd_canvas_t *c,int x,int end,int y) {
  rect(c,x,y,end-x+1,1,EPD_COLOR_BLACK);
}
static void vline(epd_canvas_t *c,int x,int y,int end) {
  rect(c,x,y,1,end-y+1,EPD_COLOR_BLACK);
}
static void frame(epd_canvas_t *c,int x,int y,int w,int h) {
  rect(c,x,y,w,1,EPD_COLOR_BLACK);
  rect(c,x,y+h-1,w,1,EPD_COLOR_BLACK);
  rect(c,x,y,1,h,EPD_COLOR_BLACK);
  rect(c,x+w-1,y,1,h,EPD_COLOR_BLACK);
}
static unsigned next(const char **text, char bytes[5]) {
  const unsigned char *p=(const unsigned char *)*text, *start=p;
  unsigned cp=*p++, n=0;
  if(cp>=0xc2 && cp<=0xdf){
    cp&=31;
    n=1;
  } else if(cp>=0xe0 && cp<=0xef){
    cp&=15;
    n=2;
  } else if(cp>=0xf0 && cp<=0xf4){
    cp&=7;
    n=3;
  }
  for(unsigned i=0;i<n && *p;i++){
    cp=(cp<<6)|(*p++&63);
  }
  size_t len=(size_t)(p-start);
  memcpy(bytes,start,len);
  bytes[len]=0;
  *text=(const char *)p;
  return cp;
}
static int font_index(unsigned cp) {
  if(cp==0x2013 || cp==0x2212){
    cp='-';
  }
  for(unsigned i=0;i<LIFE_FONT_GLYPHS;i++){
    if(life_font_codes[i]==cp){
      return (int)i;
    }
  }
  return -1;
}
static display_text_bounds_t bounds(role_t role,const char *text) {
  if(role<MID){
    return display_font_bounds(native(role),text);
  }
  display_text_bounds_t b={
    0
  };
  int pen=0,scale=role==HERO?2:1;
  bool ink=false;
  while(*text){
    char utf8[5];
    unsigned cp=next(&text,utf8);
    int index=font_index(cp),dx=0,advance=LIFE_FONT_ADVANCE*scale;
    if(cp=='.'){
      dx=role==HERO?-9:-4;
      advance=role==HERO?14:9;
    }
    if(cp==':'){
      dx=role==HERO?-7:-3;
      advance=role==HERO?18:9;
    }
    if(index<0){
      const display_text_bounds_t g=display_font_bounds(DISPLAY_TITLE,utf8);
      if(g.right>g.left){
        int left=pen+g.left,right=pen+g.right;
        if(!ink || left<b.left){
          b.left=left;
        }
        if(!ink || right>b.right){
          b.right=right;
        }
        if(!ink || g.top<b.top){
          b.top=g.top;
        }
        if(!ink || g.bottom>b.bottom){
          b.bottom=g.bottom;
        }
        ink=true;
      }
      pen+=g.advance;
      continue;
    }
    for(int y=0;y<32;y++){
      for(int x=0;x<16;x++){
        if(life_font_rows[index][y]&(0x8000u>>x)){
          int left=pen+dx+x*scale,right=left+scale,top=(LIFE_FONT_TOP+y)*scale,bottom=top+scale;
          if(!ink || left<b.left){
            b.left=left;
          }
          if(!ink || right>b.right){
            b.right=right;
          }
          if(!ink || top<b.top){
            b.top=top;
          }
          if(!ink || bottom>b.bottom){
            b.bottom=bottom;
          }
          ink=true;
        }
      }
    }
    pen+=advance;
  }
  b.advance=pen;
  return b;
}
static void positioned(epd_canvas_t *c,role_t role,int x,int base,const char *text,epd_color_t color){
  if(role<MID){
    display_text_bounds_t b=bounds(role,text);
    display_font_run(c,native(role),x+b.left,base,text,DISPLAY_LEFT,color);
    return;
  }
  int pen=0,scale=role==HERO?2:1;
  while(*text){
    char utf8[5];
    unsigned cp=next(&text,utf8);
    int index=font_index(cp),dx=0,advance=LIFE_FONT_ADVANCE*scale;
    if(cp=='.'){
      dx=role==HERO?-9:-4;
      advance=role==HERO?14:9;
    }
    if(cp==':'){
      dx=role==HERO?-7:-3;
      advance=role==HERO?18:9;
    }
    if(index<0){
      display_text_bounds_t b=display_font_bounds(DISPLAY_TITLE,utf8);
      display_font_run(c,DISPLAY_TITLE,x+pen+b.left,base,utf8,DISPLAY_LEFT,color);
      pen+=b.advance;
      continue;
    }
    for(int row=0;row<32;row++){
      for(int col=0;col<16;col++){
        if(life_font_rows[index][row]&(0x8000u>>col))
        {
          rect(c,x+pen+dx+col*scale,base+(LIFE_FONT_TOP+row)*scale,scale,scale,color);
        }
      }
    }
    pen+=advance;
  }
}
static int text(epd_canvas_t *c,role_t role,int x,int base,const char *s,display_align_t align,epd_color_t color){
  display_text_bounds_t b=bounds(role,s);
  if(align==DISPLAY_RIGHT){
    x-=b.right;
  } else if(align==DISPLAY_CENTER){
    x-=(b.left+b.right)/2;
  } else {
    x-=b.left;
  }
  positioned(c,role,x,base,s,color);
  return x+b.right;
}
static int runs(epd_canvas_t *c,int x,int base,const part_t *parts,unsigned count,display_align_t align){
  if(count==1 && align==DISPLAY_CENTER){
    return text(c,parts[0].role,x,base,parts[0].text,align,parts[0].color);
  }
  if(align!=DISPLAY_LEFT){
    int advance=0;
    for(unsigned i=0;i<count;i++){
      advance+=bounds(parts[i].role,parts[i].text).advance;
    }
    x-=align==DISPLAY_RIGHT?advance:advance/2;
  } else {
    x-=bounds(parts[0].role,parts[0].text).left;
  }
  for(unsigned i=0;i<count;i++){
    positioned(c,parts[i].role,x,base,parts[i].text,parts[i].color);
    x+=bounds(parts[i].role,parts[i].text).advance;
  }
  return x;
}
#define K EPD_COLOR_BLACK
#define R EPD_COLOR_RED
#define W EPD_COLOR_WHITE
#define P(role,s,color) (part_t){role,s,color}
static void fit(role_t role,const char *s,int width,char out[512]){
  size_t n=0;
  bool cut=false;
  while(*s){
    char utf8[5];
    next(&s,utf8);
    size_t size=strlen(utf8);
    if(n+size>=508){
      cut=true;
      break;
    }
    memcpy(out+n,utf8,size+1);
    if(display_font_width(native(role),out)>width){
      out[n]=0;
      cut=true;
      break;
    }
    n+=size;
  }
  out[n]=0;
  if(cut){
    while(n){
      strcpy(out+n,"…");
      if(display_font_width(native(role),out)<=width){
        return;
      }
      do{
        n--;
      }
      while(n && ((unsigned char)out[n]&0xc0)==0x80);
    }
    strcpy(out,"…");
  }
}
static int label(epd_canvas_t *c,role_t role,int x,int base,const char *s,display_align_t align,int width){
  char clipped[512];
  fit(role,s,width,clipped);
  return text(c,role,x,base,clipped,align,K);
}
static void icon(epd_canvas_t *c,unsigned id,int x,int y,bool black_only){
  if(id>=LIFE_ICON_COUNT){
    return;
  }
  const life_icon_info_t a=life_icons[id];
  for(unsigned row=0;row<a.size;row++){
    for(unsigned col=0;col<a.size;col++){
      unsigned bit=row*a.size+col,v=(life_icon_pixels[a.offset+bit/4]>>(6-2*(bit%4)))&3u;
      if(v){
        pixel(c,x+(int)col,y+(int)row,v==1?K:v==2?(black_only?K:R):W);
      }
    }
  }
}
static void label_row(epd_canvas_t *c,unsigned id,const char *name,const char *right,bool black_only){
  icon(c,id,12,38,black_only);
  text(c,C14,34,50,name,DISPLAY_LEFT,K);
  if(right && *right){
    label(c,C14,387,50,right,DISPLAY_RIGHT,200);
  }
  hline(c,12,387,58);
}
static void badge(epd_canvas_t *c,int x,int y,int w,int h,const char *s){
  static const int cuts[]={
    3,1,1,0
  };
  for(int row=0;row<h;row++){
    int edge=row<h-row-1?row:h-row-1,cut=edge<4?cuts[edge]:0;
    rect(c,x+cut,y+row,w-2*cut,1,R);
  }
  text(c,C16,x+w/2,y+h-8,s,DISPLAY_CENTER,W);
}
static void delta(epd_canvas_t *c,int y,int base,codepulse_life_direction_t direction,const char *percent,const char *change,epd_color_t color){
  if(!*percent && !*change){
    return;
  }
  unsigned id=direction==LIFE_DOWN?LIFE_ICON_INLINE16_DOWN:LIFE_ICON_INLINE16_UP;
  if(direction!=LIFE_FLAT){
    icon(c,id,12,y,color!=R);
  } else {
    text(c,C16,12,base,"→",DISPLAY_LEFT,K);
  }
  char value[40];
  snprintf(value,sizeof(value),"  %s%s",change[0]=='-'?"−":"",change[0]=='-'?change+1:change);
  part_t p[]={
    P(MID,percent,color),P(SMALL,value,color)
  };
  runs(c,34,base,p,2,DISPLAY_LEFT);
}
static void gauge(epd_canvas_t *c,const char *low,const char *high,const char *hero,int y,bool rising,bool gold){
  if(!*low || !*high){
    return;
  }
  double a=strtod(low,NULL),b=strtod(high,NULL),price=strtod(hero,NULL);
  part_t left[]={
    P(C14,gold?"最低 ":"低 ",K),P(SMALL,low,K)
  },right[]={
    P(C14,gold?"最高 ":"高 ",K),P(SMALL,high,K)
  };
  runs(c,12,y,left,2,DISPLAY_LEFT);
  runs(c,387,y,right,2,DISPLAY_RIGHT);
  int by=y+12;
  hline(c,12,387,by+1);
  vline(c,12,by-4,by+6);
  vline(c,387,by-4,by+6);
  if(b<=a){
    return;
  }
  double ratio=(price-a)/(b-a);
  if(ratio<0){
    ratio=0;
  }
  if(ratio>1){
    ratio=1;
  }
  int mx=12+(int)(ratio*375+0.5);
  rect(c,12,by,mx-12+1,3,K);
  rect(c,mx-3,by-6,7,15,rising?R:K);
}
static void weather(epd_canvas_t *c,const codepulse_life_weather_t *w){
  static const unsigned hero_icons[]={
    LIFE_ICON_HERO48_SUN,LIFE_ICON_HERO48_CLOUDSUN,LIFE_ICON_HERO48_CLOUD,LIFE_ICON_HERO48_RAIN,LIFE_ICON_HERO48_SNOW,LIFE_ICON_HERO48_THUNDER,LIFE_ICON_HERO48_FOG
  };
  static const unsigned inline_icons[]={
    LIFE_ICON_INLINE16_SUN,LIFE_ICON_INLINE16_CLOUDSUN,LIFE_ICON_INLINE16_CLOUD,LIFE_ICON_INLINE16_RAIN,LIFE_ICON_INLINE16_SNOW,LIFE_ICON_INLINE16_THUNDER,LIFE_ICON_INLINE16_FOG
  };
  char right[112],hero[40],detail[112],value[112];
  snprintf(right,sizeof(right),"%s%s今天",w->place,w->place[0]?" · ":"");
  label_row(c,inline_icons[w->icon],"元宝搜索 · 天气",right,false);
  icon(c,hero_icons[w->icon],12,72,false);
  snprintf(hero,sizeof(hero),"%s-%s",w->low,w->high);
  part_t main[]={
    P(HERO,hero,K),P(C16,"℃",K)
  };
  runs(c,72,116,main,2,DISPLAY_LEFT);
  snprintf(detail,sizeof(detail),"%s%s%s%s",w->condition,w->feels[0]?" · 体感 ":"",w->feels,w->feels[0]?"℃":"");
  label(c,C16,72,138,detail,DISPLAY_LEFT,172);
  const unsigned icons[]={
    LIFE_ICON_INLINE16_WIND,LIFE_ICON_INLINE16_DROP,LIFE_ICON_INLINE16_LEAF
  };
  for(unsigned i=0;i<3;i++){
    if(i==0){
      snprintf(value,sizeof(value),"%s",w->wind);
    }
    if(i==1){
      snprintf(value,sizeof(value),"%s%s%s",w->humidity[0]?"湿度 ":"",w->humidity,w->humidity[0]?"%":"");
    }
    if(i==2){
      snprintf(value,sizeof(value),"%s%s",w->air[0]?"空气 ":"",w->air);
    }
    if(*value){
      icon(c,icons[i],252,68+(int)i*28,false);
      label(c,C16,276,82+(int)i*28,value,DISPLAY_LEFT,112);
    }
  }
  hline(c,12,387,149);
  if(w->restriction[0]){
    snprintf(value,sizeof(value),"限行 %s",w->restriction);
    badge(c,12,160,120,30,value);
  }
  if(w->sunset[0]){
    icon(c,LIFE_ICON_INLINE16_SUNSET,252,167,false);
    part_t p[]={
      P(C16,"日落 ",K),P(MID,w->sunset,K)
    };
    runs(c,276,182,p,2,DISPLAY_LEFT);
  }
  hline(c,12,387,200);
  text(c,C16,12,237,"明天",DISPLAY_LEFT,K);
  if(w->has_tomorrow){
    icon(c,inline_icons[w->tomorrow_icon],62,223,false);
    label(c,C16,84,237,w->tomorrow_condition,DISPLAY_LEFT,116);
    snprintf(hero,sizeof(hero),"%s-%s",w->tomorrow_low,w->tomorrow_high);
    part_t p[]={
      P(MID,hero,K),P(C16,"℃",K)
    };
    runs(c,387,239,p,2,DISPLAY_RIGHT);
  } else {
    label(c,C14,84,237,"暂无预报",DISPLAY_LEFT,276);
  }
}
static void gold(epd_canvas_t *c,const codepulse_life_gold_t *g){
  bool up=g->direction==LIFE_UP;
  epd_color_t color=up?R:K;
  label_row(c,LIFE_ICON_INLINE16_INGOT,"元宝搜索 · 金价",g->source,false);
  icon(c,LIFE_ICON_HERO48_INGOT,339,68,false);
  part_t price[]={
    P(HERO,g->hero,color),P(C16,"  元/克",K)
  };
  runs(c,12,118,price,2,DISPLAY_LEFT);
  delta(c,137,152,g->direction,g->percent,g->change,color);
  gauge(c,g->low,g->high,g->hero,181,up,true);
  hline(c,12,387,206);
  if(g->international[0]){
    text(c,C14,12,226,"国际 · 美元/盎司",DISPLAY_LEFT,K);
    char pct[24];
    snprintf(pct,sizeof(pct),"  %s",g->international_percent);
    part_t p[]={
      P(SMALL,g->international,K),P(SMALL,pct,g->international_percent[0]=='+'?R:K)
    };
    runs(c,12,248,p,2,DISPLAY_LEFT);
  }
  if(g->brand[0] && g->brand_price[0]){
    vline(c,200,213,250);
    char title[80];
    snprintf(title,sizeof(title),"%s · 元/克",g->brand);
    label(c,C14,212,226,title,DISPLAY_LEFT,175);
    text(c,SMALL,212,248,g->brand_price,DISPLAY_LEFT,K);
  }
}
static void stock(epd_canvas_t *c,const codepulse_life_stock_t *s){
  bool up=s->direction==LIFE_UP && s->state!=2;
  epd_color_t color=up?R:K;
  label_row(c,LIFE_ICON_INLINE16_CHART,"元宝搜索 · 股票",s->source,!up);
  int code_width=bounds(SMALL,s->symbol).advance;
  int end=label(c,C16,12,85,s->name,DISPLAY_LEFT,264-code_width-8);
  part_t symbol[]={
    P(SMALL,s->symbol,K)
  };
  runs(c,s->name[0]?end+8:12,85,symbol,1,DISPLAY_LEFT);
  frame(c,296,67,91,24);
  if(s->state==2){
    icon(c,LIFE_ICON_INLINE16_MOON,302,71,true);
    text(c,C14,324,84,"休市",DISPLAY_LEFT,K);
  } else if(s->state==1){
    for(int y=-4;y<4;y++){
      for(int x=-4;x<4;x++){
        if((2*x+1)*(2*x+1)+(2*y+1)*(2*y+1)<=64){
          pixel(c,308+x,79+y,up?R:K);
        }
      }
    }
    text(c,C14,320,84,"交易中",DISPLAY_LEFT,K);
  } else {
    text(c,C14,341,84,"状态未知",DISPLAY_CENTER,K);
  }
  part_t price[]={
    P(HERO,s->hero,color)
  };
  runs(c,12,140,price,1,DISPLAY_LEFT);
  delta(c,158,173,s->direction,s->percent,s->change,color);
  gauge(c,s->low,s->high,s->hero,197,up,false);
  if(s->open[0]){
    part_t p[]={
      P(C14,"今开 ",K),P(SMALL,s->open,K)
    };
    runs(c,12,246,p,2,DISPLAY_LEFT);
  }
  if(s->previous[0]){
    vline(c,200,227,250);
    part_t p[]={
      P(C14,"昨收 ",K),P(SMALL,s->previous,K)
    };
    runs(c,212,246,p,2,DISPLAY_LEFT);
  }
}
/* Reserve all three UTF-8 bytes of the ellipsis plus NUL before copying the prefix. */
static void copy_ellipsis(char *out, size_t capacity, const char *prefix) {
  const char suffix[] = "…";
  const size_t suffix_bytes = sizeof(suffix) - 1;
  if (capacity == 0) {
    return;
  }
  if (capacity <= suffix_bytes) {
    out[0] = 0;
    return;
  }
  size_t n = strlen(prefix);
  const size_t limit = capacity - suffix_bytes - 1;
  if (n > limit) {
    n = limit;
  }
  while (n > 0 && ((unsigned char)prefix[n] & 0xc0) == 0x80) {
    n--;
  }
  memmove(out, prefix, n);
  memcpy(out + n, suffix, sizeof(suffix));
}
/* Greedy codepoint wrapping, with a bounded last-line ellipsis. No runtime font scaling of CJK. */
static unsigned wrap(const char *s,int width,char lines[3][385],unsigned limit){
  unsigned count=0;
  size_t n=0;
  char current[385]={
    0
  };
  bool overflow=false;
  while(*s){
    char utf8[5];
    next(&s,utf8);
    size_t bytes=strlen(utf8);
    if(n+bytes>=sizeof(current)){
      break;
    }
    memcpy(current+n,utf8,bytes+1);
    if(n && display_font_width(DISPLAY_TITLE,current)>width){
      current[n]=0;
      if(count<limit && lines){
        strcpy(lines[count],current);
      }
      count++;
      n=0;
      if(count>=limit){
        overflow=true;
        break;
      }
      strcpy(current,utf8);
      n=bytes;
    } else {
      n+=bytes;
    }
  }
  if(n && !overflow){
    if(count<limit && lines){
      strcpy(lines[count],current);
    }
    count++;
  }
  if(overflow && lines && limit){
    char out[512];
    fit(C16,lines[limit-1],width-16,out);
    copy_ellipsis(lines[limit-1],sizeof(lines[limit-1]),out);
  }
  return count>limit?limit:count;
}
static void tool(epd_canvas_t *c,const codepulse_life_tool_t *t){
  label_row(c,LIFE_ICON_INLINE16_TOOL,"元宝搜索 · 工具更新",t->date,false);
  const char *description=t->summary[0]?t->summary:t->title;
  unsigned count=wrap(description,352,NULL,4);
  if(count>3){
    count=3;
  }
  if(!count){
    count=1;
  }
  int lo=40,hi=352;
  while(lo<hi){
    int mid=(lo+hi)/2;
    if(wrap(description,mid,NULL,4)<=count){
      hi=mid;
    } else {
      lo=mid+1;
    }
  }
  char lines[3][385]={
    {
      0
    }
  };
  count=wrap(description,hi,lines,3);
  int desc_h=(int)count*26-4,total=48+12+30+16+desc_h,ideal=(192-total)/2,gap=8;
  const int choices[]={
    8,12,16,20,24
  };
  for(unsigned i=1;i<5;i++){
    if(abs(choices[i]-ideal)<abs(gap-ideal)){
      gap=choices[i];
    }
  }
  int y=59+gap;
  icon(c,LIFE_ICON_HERO48_TOOL,12,y,false);
  if(bounds(MID,t->name).advance<=178){
    part_t p[]={
      P(MID,t->name,K)
    };
    runs(c,72,y+36,p,1,DISPLAY_LEFT);
  } else {
    label(c,C16,72,y+36,t->name,DISPLAY_LEFT,178);
  }
  int tw=display_font_width(DISPLAY_BODY,t->source)+16;
  frame(c,387-tw,y+12,tw,24);
  text(c,C14,387-tw/2,y+29,t->source,DISPLAY_CENTER,K);
  int cy=y+60;
  rect(c,12,cy,32,30,R);
  text(c,MID,28,cy+26,">",DISPLAY_CENTER,W);
  rect(c,44,cy,343,30,K);
  if(t->command[0]){
    text(c,MID,56,cy+26,t->command,DISPLAY_LEFT,W);
  } else {
    char title[512];
    fit(C16,t->title,319,title);
    text(c,C16,56,cy+23,title,DISPLAY_LEFT,W);
  }
  int dy=cy+46;
  rect(c,12,dy,4,desc_h,R);
  for(unsigned i=0;i<count;i++){
    text(c,C16,26,dy+16+(int)i*26,lines[i],DISPLAY_LEFT,K);
  }
}
static void news(epd_canvas_t *c,const codepulse_life_news_t *n){
  label_row(c,LIFE_ICON_INLINE16_NEWS,"元宝搜索 · 今日要闻",NULL,false);
  for(unsigned i=0;i<n->count;i++){
    int y=67+(int)i*46;
    char number[4];
    snprintf(number,sizeof(number),"%u",i+1);
    rect(c,12,y+8,26,26,R);
    part_t p[]={
      P(MID,number,W)
    };
    runs(c,25,y+31,p,1,DISPLAY_CENTER);
    const char *source=n->headlines[i].source;
    int source_width=display_font_width(DISPLAY_BODY,source);
    label(c,C16,50,y+26,n->headlines[i].title,DISPLAY_LEFT,source[0]?325-source_width:337);
    if(source[0]){
      text(c,C14,387,y+26,source,DISPLAY_RIGHT,K);
    }
    if(i+1<n->count){
      hline(c,50,387,y+45);
    }
  }
}
static void holiday(epd_canvas_t *c,const codepulse_life_holiday_t *h){
  char year[8],days[8],a[8],b[8],m[8],n[8];
  snprintf(year,sizeof(year),"%u",h->year);
  if(!h->has_range){
    label_row(c,LIFE_ICON_INLINE16_CALENDAR,"元宝搜索 · 节假日",year,false);
    icon(c,LIFE_ICON_HERO48_CALENDAR,12,74,false);
    part_t hero[]={
      P(HERO,year,K),P(C16," 年",K)
    };
    runs(c,72,116,hero,2,DISPLAY_LEFT);
    text(c,C16,72,138,"节假日安排",DISPLAY_LEFT,K);
    badge(c,252,118,135,30,h->published?"已发布":"尚未发布");
    hline(c,12,387,154);
    snprintf(year,sizeof(year),"%u",h->next.year);
    snprintf(days,sizeof(days),"%u",h->next_days);
    char name[64];
    snprintf(name,sizeof(name)," %s ",h->next_name);
    part_t countdown[]={
      P(C16,"距 ",K),P(SMALL,year,K),P(C16,name,K),P(MID,days,K),P(C16," 天",K)
    };
    runs(c,12,198,countdown,5,DISPLAY_LEFT);
    text(c,C14,12,232,h->published?"日历将在数据源更新后自动同步":"放假安排通常于 11–12 月公布",DISPLAY_LEFT,K);
    return;
  }
  label_row(c,LIFE_ICON_INLINE16_LANTERN,"元宝搜索 · 节假日",h->label[0]?h->label:year,false);
  icon(c,LIFE_ICON_HERO48_LANTERN,12,82,false);
  text(c,C16,72,100,h->name,DISPLAY_LEFT,K);
  text(c,C16,387,100,"放假",DISPLAY_RIGHT,K);
  snprintf(a,sizeof(a),"%u",h->start.month);
  snprintf(b,sizeof(b),"%u",h->start.day);
  snprintf(m,sizeof(m),"%u",h->end.month);
  snprintf(n,sizeof(n),"%u",h->end.day);
  part_t range[]={
    P(MID,a,K),P(C16,"月",K),P(MID,b,K),P(C16,"日 — ",K),P(MID,m,K),P(C16,"月",K),P(MID,n,K),P(C16,"日",K)
  };
  runs(c,72,138,range,8,DISPLAY_LEFT);
  snprintf(days,sizeof(days),"%u",h->days);
  part_t length[]={
    P(HERO,days,R),P(C16," 天",K)
  };
  runs(c,387,156,length,2,DISPLAY_RIGHT);
  hline(c,12,387,165);
  static const char *const weekdays[]={
    "一","二","三","四","五","六","日"
  };
  codepulse_life_date_t day=h->start;
  int end=life_ordinal(h->end);
  for(int i=0;i<7;i++){
    /* 376 pixels minus six 4px gaps: 352 distributed pixels, including two 51px cells. */
    int x=12+i*352/7+i*4;
    int right=12+(i+1)*352/7+i*4-1;
    int w=right-x+1;
    bool off=life_ordinal(day)<=end;
    if(off){
      rect(c,x,172,w,66,R);
    } else {
      frame(c,x,172,w,66);
    }
    epd_color_t ink=off?W:K;
    int cx=(x+right+1)/2;
    text(c,C14,cx,198,weekdays[life_ordinal(day)%7],DISPLAY_CENTER,ink);
    snprintf(days,sizeof(days),"%u",day.day);
    part_t p[]={
      P(SMALL,days,ink)
    };
    runs(c,cx,226,p,1,DISPLAY_CENTER);
    day=life_next_date(day);
  }
}
static bool supported_strings(const char *const *values,unsigned count){
  for(unsigned i=0;i<count;i++){
    if(!display_text_supports(values[i])){
      return false;
    }
  }
  return true;
}
#define SUPPORT(...) supported_strings((const char *const[]){__VA_ARGS__},sizeof((const char *const[]){__VA_ARGS__})/sizeof(const char *))
static bool supported(const codepulse_life_t *life){
  switch(life->kind){
    case LIFE_WEATHER:{
      const codepulse_life_weather_t *w=&life->data.weather;
      return SUPPORT(w->place,w->low,w->high,w->condition,w->feels,w->wind,w->humidity,w->air,w->restriction,w->sunset,w->tomorrow_low,w->tomorrow_high,w->tomorrow_condition);
    }
    case LIFE_GOLD:{
      const codepulse_life_gold_t *g=&life->data.gold;
      return SUPPORT(g->hero,g->percent,g->change,g->low,g->high,g->international,g->international_percent,g->brand,g->brand_price,g->source);
    }
    case LIFE_STOCK:{
      const codepulse_life_stock_t *s=&life->data.stock;
      return SUPPORT(s->name,s->symbol,s->hero,s->percent,s->change,s->low,s->high,s->open,s->previous,s->source);
    }
    case LIFE_TOOL:{
      const codepulse_life_tool_t *t=&life->data.tool;
      return SUPPORT(t->name,t->date,t->source,t->command,t->title,t->summary);
    }
    case LIFE_NEWS:{
      const codepulse_life_news_t *n=&life->data.news;
      if(n->count<1 || n->count>4){
        return false;
      }
      for(unsigned i=0;i<n->count;i++){
        if(!SUPPORT(n->headlines[i].title,n->headlines[i].source)){
          return false;
        }
      }
      return true;
    }
    case LIFE_HOLIDAY:{
      const codepulse_life_holiday_t *h=&life->data.holiday;
      return SUPPORT(h->name,h->next_name,h->label);
    }
    default:return false;
  }
}
#undef SUPPORT
bool life_dashboard_render(epd_canvas_t *c,const codepulse_life_t *life){
  if(!c || !life || life->version!=CODEPULSE_LIFE_VERSION || !display_text_init()){
    return false;
  }
  if(!supported(life)){
    return false;
  }
  /* Width guards run before the first ink pixel: oversized typed data falls back atomically. */
  if(life->kind==LIFE_WEATHER){
    const codepulse_life_weather_t *w=&life->data.weather;
    char hero[40];
    snprintf(hero,sizeof(hero),"%s-%s",w->low,w->high);
    if(w->icon>6 || (w->has_tomorrow && w->tomorrow_icon>6) || !w->condition[0] || !w->low[0] || !w->high[0] || bounds(HERO,hero).advance+16>178){
      return false;
    }
    weather(c,w);
  } else if(life->kind==LIFE_GOLD){
    if(!life->data.gold.hero[0] || bounds(HERO,life->data.gold.hero).advance+60>315){
      return false;
    }
    gold(c,&life->data.gold);
  } else if(life->kind==LIFE_STOCK){
    if(!life->data.stock.hero[0] || bounds(HERO,life->data.stock.hero).advance>376){
      return false;
    }
    stock(c,&life->data.stock);
  } else if(life->kind==LIFE_TOOL){
    if(!life->data.tool.name[0] || !life->data.tool.title[0]){
      return false;
    }
    tool(c,&life->data.tool);
  } else if(life->kind==LIFE_NEWS){
    if(life->data.news.count<1 || life->data.news.count>4){
      return false;
    }
    news(c,&life->data.news);
  } else if(life->kind==LIFE_HOLIDAY){
    if(life->data.holiday.year<1900 || life->data.holiday.year>2100 || life->data.holiday.next.year<1900 || !life->data.holiday.next_name[0]){
      return false;
    }
    holiday(c,&life->data.holiday);
  } else {
    return false;
  }
  return true;
}
