"""Create the shared Noto Sans SC weight-700 title bitmap (CJK and Latin 20px) from Noto Sans SC.

Usage: python generate-title-font.py NotoSansSC.ttf title20.bdf.gz
Requires Pillow 12.3.0. Body/metadata still use their original native BDFs.
The source is licensed under SIL OFL 1.1 (fonts/LICENSE.txt).
"""
from pathlib import Path
import gzip,hashlib,sys
from PIL import ImageFont
import math

source,output=map(Path,sys.argv[1:3])
assert hashlib.sha256(source.read_bytes()).hexdigest()=='a3041811a78c361b1de50f953c805e0244951c21c5bd412f7232ef0d899af0da'
codes=set(range(32,256))|set(range(0x2000,0x2070))|{0xfffd}
for a in range(0xa1,0xf8):
    for b in range(0xa1,0xff):
        try: codes.add(ord(bytes((a,b)).decode('gb2312')))
        except UnicodeDecodeError:pass
font=ImageFont.truetype(str(source),20)
font.set_variation_by_axes([700])
latin=ImageFont.truetype(str(source),20)
latin.set_variation_by_axes([700])
lines=['STARTFONT 2.1','FONT CodePulse-Headline20','SIZE 20 75 75',
       'FONTBOUNDINGBOX 22 24 0 -4','STARTPROPERTIES 3','PIXEL_SIZE 20',
       'FONT_ASCENT 18','FONT_DESCENT 6','ENDPROPERTIES',f'CHARS {len(codes)}']
for cp in sorted(codes):
    face = latin if cp < 256 else font
    advance = math.ceil(face.getlength(chr(cp))) if cp < 256 else 22
    mask,(left,top)=face.getmask2(chr(cp),mode='L',anchor='ls')
    w,h=mask.size
    # A few accents and the vertical bar exceed the 24px title line box at
    # optical Latin size. Use the 20px face for those glyphs; never crop ink.
    if h > 24:
        face = font
        advance = math.ceil(face.getlength(chr(cp))) if cp < 256 else 22
        mask,(left,top)=face.getmask2(chr(cp),mode='L',anchor='ls')
        w,h=mask.size
    left=max(0,left+1)
    if cp < 256:
        advance=max(advance,1+max((left+x for y in range(h) for x in range(w) if mask[y*w+x]>=128),default=0))
    top=max(-20,min(top,4-h))
    # Fixed 22px CJK cells; both scripts use the same 20px weight-700 face.
    # Proportional headline advances preserve natural Latin spacing; body stays fixed.
    # Baseline 18+2. Preserve the source mask;
    # fail generation instead of extending advances or clipping accents.
    assert all(mask[y*w+x]<128 or (0<=left+x<advance and 0<=20+top+y<24)
               for y in range(h) for x in range(w)),hex(cp)
    rows=[]
    for y in range(h):
        row=bytearray((w+7)//8)
        for x in range(w):
            if mask[y*w+x]>=128:row[x//8]|=128>>(x%8)
        rows.append(row.hex().upper())
    lines += [f'STARTCHAR U{cp:04X}',f'ENCODING {cp}','SWIDTH 1100 0',f'DWIDTH {advance} 0',
              f'BBX {w} {h} {left} {-top-h}','BITMAP',*rows,'ENDCHAR']
lines+=['ENDFONT']
data=('\n'.join(lines)+'\n').encode()
output.parent.mkdir(parents=True,exist_ok=True)
output.write_bytes(gzip.compress(data,mtime=0))
print('Headline20:',len(codes),'glyphs, sha256',hashlib.sha256(data).hexdigest())
