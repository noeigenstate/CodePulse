#include "display_text.h"
#include "display_font_data.h"
#include <stdlib.h>
#include <string.h>
#ifdef ESP_PLATFORM
#include "esp_heap_caps.h"
#include "miniz.h"
#else
#include "miniz_tinfl.h"
#endif

static uint8_t *atlas;
bool display_text_init(void) {
  if (atlas)
    return true;
#ifdef ESP_PLATFORM
  uint8_t *memory = heap_caps_malloc(DISPLAY_FONT_ATLAS_SIZE,
                                     MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
#else
  uint8_t *memory = malloc(DISPLAY_FONT_ATLAS_SIZE);
#endif
  if (!memory)
    return false;
  if (tinfl_decompress_mem_to_mem(memory, DISPLAY_FONT_ATLAS_SIZE,
                                  font_compressed, sizeof(font_compressed),
                                  TINFL_FLAG_PARSE_ZLIB_HEADER) !=
      DISPLAY_FONT_ATLAS_SIZE) {
    free(memory);
    return false;
  }
  /* Restore exact bitmap offsets after lossless delta24 table coding. */
  for (unsigned table = 0; table < DISPLAY_FONT_TABLE_COUNT; table++) {
    unsigned offset = 0;
    for (unsigned i = 0; i < font_tables[table].count; i++) {
      uint8_t *g = memory + font_tables[table].offset + i * DISPLAY_GLYPH_RECORD_SIZE;
      offset = (offset + g[0] + ((unsigned)g[1] << 8) + ((unsigned)g[2] << 16)) & 0xffffffu;
      g[0] = (uint8_t)offset; g[1] = (uint8_t)(offset >> 8); g[2] = (uint8_t)(offset >> 16);
    }
  }
  atlas = memory;
  return true;
}
static unsigned next(const char **s) {
  const unsigned char *p = (const unsigned char *)*s;
  unsigned cp = *p++, count = 0, min = 0;
  if (cp < 0x80) {
    *s = (const char *)p;
    return cp;
  }
  if (cp >= 0xc2 && cp <= 0xdf) {
    cp &= 31;
    count = 1;
    min = 0x80;
  } else if (cp >= 0xe0 && cp <= 0xef) {
    cp &= 15;
    count = 2;
    min = 0x800;
  } else if (cp >= 0xf0 && cp <= 0xf4) {
    cp &= 7;
    count = 3;
    min = 0x10000;
  } else {
    *s = (const char *)p;
    return 0xfffd;
  }
  for (unsigned i = 0; i < count; i++) {
    if ((*p & 0xc0) != 0x80) {
      *s = (const char *)p;
      return 0xfffd;
    }
    cp = (cp << 6) | (*p++ & 63);
  }
  *s = (const char *)p;
  return cp < min || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff) ? 0xfffd
                                                                     : cp;
}
typedef struct {
  const uint8_t *bits;
  unsigned advance, width, height;
  int left, top;
} glyph_t;
bool display_text_supports(const char *text) {
  if (!text) {
    return false;
  }
  while (*text) {
    /* Terminus' native U+2212 and U+2013 masks/metrics are byte-identical.
     * Keep the historical 7,752-codepoint table while accepting math minus. */
    unsigned cp = next(&text);
    if (cp == 0x2212) {
      cp = 0x2013;
    }
    unsigned lo = 0, hi = DISPLAY_FONT_GLYPHS;
    while (lo < hi) {
      unsigned mid = lo + (hi - lo) / 2;
      if (font_codes[mid] < cp) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }
    if (lo == DISPLAY_FONT_GLYPHS || font_codes[lo] != cp) {
      return false;
    }
  }
  return true;
}
static unsigned u16(const uint8_t *p) { return p[0] | (unsigned)p[1] << 8; }
static unsigned u24(const uint8_t *p) { return u16(p) | (unsigned)p[2] << 16; }
static bool valid(display_font_t font) {
  return font >= 0 && font < DISPLAY_FONT_COUNT && display_text_init();
}
static glyph_t glyph(display_font_t font, unsigned cp) {
  if (cp == 0x2212) {
    cp = 0x2013;
  }
  unsigned lo = 0, hi = DISPLAY_FONT_GLYPHS;
  while (lo < hi) {
    unsigned mid = lo + (hi - lo) / 2;
    if (font_codes[mid] < cp) lo = mid + 1; else hi = mid;
  }
  if (lo == DISPLAY_FONT_GLYPHS || font_codes[lo] != cp)
    lo = DISPLAY_FONT_GLYPHS - 1;
  const display_font_info_t *f = &font_info[font];
  unsigned position = f->offset + lo * DISPLAY_GLYPH_RECORD_SIZE;
  if (f->override_count) {
    const uint16_t *codes = override_codes + f->code_first;
    unsigned a = 0, b = f->override_count;
    while (a < b) {
      const unsigned mid = a + (b - a) / 2;
      if (codes[mid] < cp) a = mid + 1; else b = mid;
    }
    if (a < f->override_count && codes[a] == cp) position = f->override_offset + a * DISPLAY_GLYPH_RECORD_SIZE;
  }
  const uint8_t *g = atlas + position;
  return (glyph_t){atlas + u24(g), g[3], g[6], g[7], (int)(int8_t)g[4], (int)(int8_t)g[5]};
}
int display_font_height(display_font_t font) {
  return font >= 0 && font < DISPLAY_FONT_COUNT ? (int)font_info[font].height : 0;
}
display_text_bounds_t display_font_bounds(display_font_t font, const char *s) {
  display_text_bounds_t b = {0};
  if (!s || !valid(font)) return b;
  bool ink = false; int pen = 0;
  while (*s) {
    unsigned cp = next(&s); glyph_t g = glyph(font, cp);
    int x0 = pen + g.left;
    /* Actual ink bounds include negative bearings but exclude cell padding. */
    unsigned stride = (g.width + 7) / 8;
    for (unsigned y = 0; y < g.height; y++)
      for (unsigned x = 0; x < g.width; x++)
        if (g.bits[y * stride + x / 8] & (128u >> (x % 8))) {
          int px = x0 + (int)x, py = g.top + (int)y;
          if (!ink || px < b.left) b.left = px;
          if (!ink || px + 1 > b.right) b.right = px + 1;
          if (!ink || py < b.top) b.top = py;
          if (!ink || py + 1 > b.bottom) b.bottom = py + 1;
          ink = true;
        }
    pen += (int)g.advance;
  }
  b.advance = pen;
  return b;
}
int display_font_width(display_font_t font, const char *text) {
  display_text_bounds_t b = display_font_bounds(font, text);
  int ink = b.right - b.left;
  return ink > b.advance ? ink : b.advance;
}
static void run(epd_canvas_t *c, display_font_t font, int x, int baseline,
                const char *s, display_align_t align, epd_color_t color,
                int left, int top, int right, int bottom, int scale) {
  if (!c || !s || !valid(font)) return;
  display_text_bounds_t b = display_font_bounds(font, s);
  if (align == DISPLAY_RIGHT) x -= b.right * scale;
  else if (align == DISPLAY_CENTER) x -= (b.left + b.right) * scale / 2;
  else x -= b.left * scale;
  int pen = 0;
  while (*s) {
    unsigned cp = next(&s); glyph_t g = glyph(font, cp);
    unsigned stride = (g.width + 7) / 8;
    int x0 = x + (pen + g.left) * scale;
    for (unsigned row = 0; row < g.height; row++)
      for (unsigned col = 0; col < g.width; col++) {
        int px = x0 + (int)col * scale, py = baseline + (g.top + (int)row) * scale;
        if (px + scale > left && px < right && py + scale > top && py < bottom &&
            (g.bits[row * stride + col / 8] & (128u >> (col % 8))))
          epd_canvas_fill_rect(c, px, py, scale, scale, color);
      }
    pen += (int)g.advance;
  }
}
void display_font_run(epd_canvas_t *c, display_font_t font, int x, int baseline,
                      const char *s, display_align_t align, epd_color_t color) {
  run(c, font, x, baseline, s, align, color, 0, 0, BOARD_EPD_WIDTH, BOARD_EPD_HEIGHT, 1);
}
void display_font_run_scaled(epd_canvas_t *c, display_font_t font, int x, int baseline,
                             const char *s, display_align_t align, epd_color_t color, int scale) {
  if (scale < 1 || scale > 4) return;
  run(c, font, x, baseline, s, align, color, 0, 0, BOARD_EPD_WIDTH, BOARD_EPD_HEIGHT, scale);
}
bool display_font_circle_fit(display_font_t font, int x, int baseline, const char *s,
                             display_align_t align, int cx, int cy, int diameter) {
  if (!s || !valid(font) || diameter < 1) return false;
  display_text_bounds_t b = display_font_bounds(font, s);
  if (align == DISPLAY_RIGHT) x -= b.right;
  else if (align == DISPLAY_CENTER) x -= (b.left + b.right) / 2;
  else x -= b.left;
  int pen = 0;
  while (*s) {
    glyph_t g = glyph(font, next(&s)); unsigned stride = (g.width + 7) / 8;
    for (unsigned row = 0; row < g.height; row++) for (unsigned col = 0; col < g.width; col++)
      if ((g.bits[row * stride + col / 8] & (128u >> (col % 8))) &&
          !display_circle_pixel(x + pen + g.left + (int)col, baseline + g.top + (int)row, cx, cy, diameter)) return false;
    pen += (int)g.advance;
  }
  return true;
}
/* Return the next UTF-8 line and advance the input. All measurements use the
 * same integer advances as drawing. Never slice inside a codepoint. */
static bool word_character(unsigned cp) {
  return (cp >= 'A' && cp <= 'Z') || (cp >= 'a' && cp <= 'z') ||
         (cp >= '0' && cp <= '9') || cp == '_' || cp == '.' || cp == '-';
}
static void take_line(display_font_t font, const char **source, int width,
                       bool last, char *out, size_t capacity) {
  const char *start = *source, *p = start, *end = start, *word = NULL;
  size_t used = 0, word_used = 0;
  out[0] = 0;
  while (*p) {
    const char *after = p; unsigned cp = next(&after);
    if (word_character(cp)) {
      if (!word) { word = p; word_used = used; }
    } else word = NULL;
    size_t bytes = (size_t)(after - p);
    if (used + bytes + 4 >= capacity) break;
    memcpy(out + used, p, bytes); out[used + bytes] = 0;
    if (display_font_width(font, out) > width) { out[used] = 0; break; }
    used += bytes; end = after; p = after;
  }
  if (!*p) { *source = p; return; }
  if (last) {
    while (used) {
      out[used] = 0;
      while (used && out[used - 1] == ' ') out[--used] = 0;
      memcpy(out + used, "\xe2\x80\xa6", 4);
      if (display_font_width(font, out) <= width) { *source = start + strlen(start); return; }
      out[used] = 0;
      do { used--; } while (used && ((unsigned char)out[used] & 0xc0) == 0x80);
    }
    strcpy(out, display_font_width(font, "\xe2\x80\xa6") <= width ? "\xe2\x80\xa6" : "");
    *source = start + strlen(start); return;
  }
  /* Start the complete ASCII token on the next line. Only a token that
   * starts this line and exceeds its whole width may be split. */
  if (word && word > start) { end = word; used = word_used; out[used] = 0; }
  if (end == start) { const char *after = start; next(&after); end = after; }
  while (used && out[used - 1] == ' ') out[--used] = 0;
  while (*end == ' ') end++;
  *source = end;
}
static int block(epd_canvas_t *c, display_font_t font, int x, int baseline,
                  int width, int limit, int step, const char *s,
                  epd_color_t color, int top, int bottom) {
  if (!s || width <= 0 || limit < 1 || !valid(font)) return 0;
  int count = 0; char line[512];
  while (*s && count < limit) {
    take_line(font, &s, width, count == limit - 1, line, sizeof(line));
    if (c) run(c, font, x, baseline + count * step, line, DISPLAY_LEFT,
               color, x, top, x + width, bottom, 1);
    count++;
  }
  return count;
}
int display_font_block(epd_canvas_t *c, display_font_t font, int x, int baseline,
                        int width, int lines, int step, const char *text,
                        epd_color_t color) {
  return block(c, font, x, baseline, width, lines, step, text, color, 0, BOARD_EPD_HEIGHT);
}
int display_font_lines(display_font_t font, int width, int limit, const char *text) {
  return block(NULL, font, 0, 0, width, limit, 0, text, EPD_COLOR_BLACK, 0, 0);
}
void display_font_text(epd_canvas_t *c, display_font_t font, int x, int y,
                       int width, int lines, const char *text, epd_color_t color) {
  if (!valid(font)) return;
  block(c, font, x, y + (int)font_info[font].ascent, width, lines,
        display_font_height(font), text, color, y, y + lines * display_font_height(font));
}
int display_text_width(const char *text) { return display_font_width(DISPLAY_BODY, text); }
void display_text(epd_canvas_t *c, int x, int y, int width, int lines,
                  const char *text, epd_color_t color) {
  display_font_text(c, DISPLAY_BODY, x, y, width, lines, text, color);
}
void display_droplet(epd_canvas_t *c, int x, int y) {
  static const uint16_t rows[] = {0x000,0x040,0x0a0,0x110,0x110,0x208,
                                 0x208,0x404,0x404,0x404,0x208,0x1f0};
  for (unsigned row = 0; row < 12; row++)
    for (unsigned col = 0; col < 12; col++)
      if (rows[row] & (0x800u >> col)) epd_canvas_pixel(c,x+(int)col,y+(int)row,EPD_COLOR_BLACK);
}
