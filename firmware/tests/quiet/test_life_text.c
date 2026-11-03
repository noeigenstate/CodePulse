/* Inspect the production-only string helpers, following the existing font test pattern. */
#include "../../main/life_dashboard.c"
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static uint8_t actual_black[15000], actual_red[15000];
static uint8_t expected_black[15000], expected_red[15000];
static void check(bool condition, const char *message) {
  if (!condition) {
    fprintf(stderr, "FAIL life text: %s\n", message);
    exit(1);
  }
}
static bool ink(const uint8_t *plane, unsigned x, unsigned y) {
  return !(plane[y * 50 + x / 8] & (128u >> (x % 8)));
}
static bool utf8(const char *s) {
  const unsigned char *p = (const unsigned char *)s;
  while (*p) {
    unsigned cp = *p++;
    unsigned remaining = 0;
    unsigned minimum = 0;
    if (cp >= 0xc2 && cp <= 0xdf) {
      cp &= 31;
      remaining = 1;
      minimum = 0x80;
    } else if (cp >= 0xe0 && cp <= 0xef) {
      cp &= 15;
      remaining = 2;
      minimum = 0x800;
    } else if (cp >= 0xf0 && cp <= 0xf4) {
      cp &= 7;
      remaining = 3;
      minimum = 0x10000;
    } else if (cp >= 0x80) {
      return false;
    }
    while (remaining > 0) {
      if ((*p & 0xc0) != 0x80) {
        return false;
      }
      cp = (cp << 6) | (*p++ & 63);
      remaining--;
    }
    if (cp < minimum || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) {
      return false;
    }
  }
  return true;
}
static void ellipsis_tests(void) {
  char prefix[513];
  char out[400];
  memset(prefix, 'a', sizeof(prefix));
  for (unsigned i = 0; i < 510; i += 5) {
    memcpy(prefix + i, "中ab", 5);
  }
  prefix[510] = 0;
  for (size_t capacity = 0; capacity <= 385; capacity++) {
    memset(out, 'Z', sizeof(out));
    copy_ellipsis(out, capacity, prefix);
    for (size_t i = capacity; i < sizeof(out); i++) {
      check(out[i] == 'Z', "ellipsis wrote beyond capacity");
    }
    if (capacity == 0) {
      continue;
    }
    size_t n = strlen(out);
    check(n < capacity, "ellipsis lacks bounded NUL");
    check(utf8(out), "ellipsis or prefix was cut mid-codepoint");
    if (capacity <= 3) {
      check(n == 0, "partial ellipsis must never be emitted");
    } else {
      check(n >= 3 && !memcmp(out + n - 3, "…", 3), "full UTF-8 ellipsis required");
      check(!memcmp(out, prefix, n - 3), "prefix changed");
    }
  }
}
static void gauge_precision(void) {
  epd_canvas_t actual = {actual_black, actual_red};
  epd_canvas_t expected = {expected_black, expected_red};
  epd_canvas_clear(&actual, W);
  epd_canvas_clear(&expected, W);
  gauge(&actual, "0.385", "375.200", "200", 120, false, false);
  part_t left[] = {P(C14, "低 ", K), P(SMALL, "0.385", K)};
  part_t right[] = {P(C14, "高 ", K), P(SMALL, "375.200", K)};
  runs(&expected, 12, 120, left, 2, DISPLAY_LEFT);
  runs(&expected, 387, 120, right, 2, DISPLAY_RIGHT);
  for (unsigned y = 100; y <= 122; y++) {
    for (unsigned x = 0; x < 400; x++) {
      check(ink(actual_black, x, y) == ink(expected_black, x, y), "gauge rounded or stripped source precision");
    }
  }
}
static void holiday_bar(void) {
  epd_canvas_t canvas = {actual_black, actual_red};
  codepulse_life_t life = {.version = 1, .kind = LIFE_HOLIDAY, .data.holiday = {
    .year = 2027, .published = true, .has_range = true, .days = 3,
    .next_name = "元旦", .name = "元旦", .next = {2027, 1, 1}, .start = {2027, 1, 1}, .end = {2027, 1, 3}}};
  epd_canvas_clear(&canvas, W);
  check(life_dashboard_render(&canvas, &life), "holiday fixture rejected");
  const unsigned starts[] = {12, 66, 120, 174, 229, 283, 337};
  const unsigned ends[] = {61, 115, 169, 224, 278, 332, 387};
  for (unsigned i = 0; i < 7; i++) {
    for (unsigned x = starts[i]; x <= ends[i]; x++) {
      check(ink(i < 3 ? actual_red : actual_black, x, 172), "holiday cell top edge");
    }
    if (i < 6) {
      check(starts[i + 1] - ends[i] == 5, "holiday gaps must stay four pixels");
      for (unsigned x = ends[i] + 1; x < starts[i + 1]; x++) {
        check(!ink(actual_black, x, 172) && !ink(actual_red, x, 172), "holiday gap contains pigment");
      }
    }
  }
  for (unsigned y = 172; y <= 237; y++) {
    check(ink(actual_black, 387, y), "last holiday cell must end at content edge x387");
  }
}
static void native_grid_fit(void) {
  display_text_bounds_t middle=bounds(MID,"0123456789");
  display_text_bounds_t hero=bounds(HERO,"0123456789");
  display_text_bounds_t temperature=bounds(WEATHER_HERO,"0123456789");
  check(middle.bottom-middle.top==20,"Terminus32 native cap height");
  check(hero.bottom-hero.top>=39 && hero.bottom-hero.top<=42,"Noto56 native hero cap height");
  check(temperature.bottom-temperature.top>=43 && temperature.bottom-temperature.top<=45,"Noto60 native temperature cap height");
  check(bounds(WEATHER_HERO,"3–17").advance+16<=178,"temperature must fit beside the native icon");
  check(bounds(C14," ").advance==4,"sunset uses a four-pixel native spacer");
  check(bounds(C16,"日落").advance+4+bounds(MID,"17:12").advance<=119,"sunset must stay inside its row");
  check(bounds(MID," ").advance==8 && bounds(MID,"·").advance==7,"life uses the shared native32 spacing policy");
  display_text_bounds_t range_dash=bounds(MID,"–");
  check(range_dash.right-range_dash.left==13,"holiday range keeps its thirteen-pixel native dash");
  check(display_text_supports("−") && font_index(HERO,0x2212)>=0,"mathematical minus remains supported");
  check(display_font_height(DISPLAY_META)>=16,"Zheng16 compact fallback needs a full line box");
  char shortened[512];
  check(bounds(MID,"WWWWWWWWWWWWWWWWWWWW").advance>319,"wide native32 command exercises fallback");
  fit(C16,"WWWWWWWWWWWWWWWWWWWW",319,shortened);
  check(bounds(C16,shortened).advance<=319,"wide command native-title fallback must fit");
}
static void shared_spacing_views(void) {
  epd_canvas_t actual={actual_black,actual_red},expected={expected_black,expected_red};
  display_font_t f=DISPLAY_META;
  check(display_font_bounds(f,"A · B").advance==30,"compact meta advance");
  check(display_font_bounds(DISPLAY_TITLE," · ").advance==16,"compact title separator advance");
  check(display_font_bounds(DISPLAY_DATE," · ").advance==23,"compact native32 separator advance");
  epd_canvas_clear(&actual,W);epd_canvas_clear(&expected,W);
  display_font_run(&actual,f,20,30,"A · B",DISPLAY_LEFT,K);
  const char *parts[]={"A","·","B"};
  const int pens[]={0,12,22};
  int origin=20-display_font_bounds(f,"A").left;
  for(unsigned i=0;i<3;i++) {
    display_text_bounds_t b=display_font_bounds(f,parts[i]);
    display_font_run(&expected,f,origin+pens[i]+b.left,30,parts[i],DISPLAY_LEFT,K);
  }
  check(!memcmp(actual_black,expected_black,sizeof(actual_black)),"run and measured advances disagree");
  for(int diameter=24;diameter<=64;diameter+=20) {
    bool inside=true;
    for(int y=0;y<300;y++) {
      for(int x=0;x<400;x++) {
        if(ink(actual_black,(unsigned)x,(unsigned)y) && !display_circle_pixel(x,y,35,25,diameter)) {
          inside=false;
        }
      }
    }
    check(display_font_circle_fit(f,20,30,"A · B",DISPLAY_LEFT,35,25,diameter)==inside,"circle fitting uses different spacing");
  }
  epd_canvas_clear(&actual,W);epd_canvas_clear(&expected,W);
  check(display_font_lines(f,30,2,"A · B C")==2,"line measurement uses different spacing");
  display_font_block(&actual,f,20,30,30,2,20,"A · B C",K);
  display_font_run(&expected,f,20,30,"A · B",DISPLAY_LEFT,K);
  display_font_run(&expected,f,20,50,"C",DISPLAY_LEFT,K);
  check(!memcmp(actual_black,expected_black,sizeof(actual_black)),"line breaking and run spacing disagree");
}
int main(void) {
  check(display_text_init(), "font initialization");
  ellipsis_tests();
  gauge_precision();
  holiday_bar();
  native_grid_fit();
  shared_spacing_views();
  puts("PASS life text: 386 UTF-8 capacities, source precision, seven holiday cells, native grid/hero fit and minus");
  return 0;
}
