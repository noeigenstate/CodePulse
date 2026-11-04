"""Compare production planes with the approved B PNGs, using only the stdlib.

Explicit approved overrides: falling/closed stocks are entirely black; the pending
holiday's old decorative months are replaced with the requested useful countdown.
Review fix: redistribute the holiday week cells to the full content edge x387.
"""
import argparse
import binascii
import json
import hashlib
from pathlib import Path
import struct
import zlib

NAMES = ['weather','gold','stock-down','stock-up','stock-closed','tool-codex','tool-claude','news','holiday-yes','holiday-none']
RED = (190,30,45)


def read_png(path):
    raw=Path(path).read_bytes()
    if raw[:8] != b'\x89PNG\r\n\x1a\n': raise ValueError('Not PNG')
    at=8; data=b''
    while at<len(raw):
        n=struct.unpack('>I',raw[at:at+4])[0];kind=raw[at+4:at+8];chunk=raw[at+8:at+8+n];at+=n+12
        if kind==b'IHDR':w,h,depth,color,_,_,interlace=struct.unpack('>IIBBBBB',chunk)
        if kind==b'IDAT':data+=chunk
    if (w,h)!=(400,300) or depth!=8 or color not in (2,6) or interlace: raise ValueError('Expected 400x300 native RGB(A) PNG')
    channels=3 if color==2 else 4;stride=w*channels;decoded=zlib.decompress(data);rows=[];previous=bytearray(stride);at=0
    def paeth(a,b,c):
        p=a+b-c;da,db,dc=abs(p-a),abs(p-b),abs(p-c)
        return a if da<=db and da<=dc else b if db<=dc else c
    for _ in range(h):
        filter=decoded[at];at+=1;row=bytearray(decoded[at:at+stride]);at+=stride
        for i in range(stride):
            a=row[i-channels] if i>=channels else 0;b=previous[i];c=previous[i-channels] if i>=channels else 0
            row[i]=(row[i]+(0 if filter==0 else a if filter==1 else b if filter==2 else (a+b)//2 if filter==3 else paeth(a,b,c)))&255
        rows.extend(tuple(row[i:i+3]) for i in range(0,stride,channels));previous=row
    return rows


def png(path,pixels):
    def chunk(kind,data):return struct.pack('>I',len(data))+kind+data+struct.pack('>I',binascii.crc32(kind+data)&0xffffffff)
    rows=b''.join(b'\0'+bytes(v for p in pixels[y*400:(y+1)*400] for v in p) for y in range(300))
    Path(path).write_bytes(b'\x89PNG\r\n\x1a\n'+chunk(b'IHDR',struct.pack('>IIBBBBB',400,300,8,2,0,0,0))+chunk(b'IDAT',zlib.compress(rows,9))+chunk(b'IEND',b''))


def holiday_bar_reference(original):
    """Move only approved cell glyph pixels; fonts, colors and surrounding body stay fixed."""
    adjusted=list(original)
    for y in range(172,238):
        for x in range(12,388):adjusted[y*400+x]=(255,255,255)
    for i in range(7):
        old_left=12+i*376//7;old_right=12+(i+1)*376//7-5
        left=12+i*352//7+i*4;right=12+(i+1)*352//7+i*4-1
        center=(left+right+1)//2;old_center=(old_left+old_right+1)//2
        off=i<3
        for y in range(172,238):
            for x in range(left,right+1):
                adjusted[y*400+x]=RED if off else (0,0,0) if x in (left,right) or y in (172,237) else (255,255,255)
        foreground=(255,255,255) if off else (0,0,0)
        for y in range(173,237):
            for x in range(old_left+1,old_right):
                if original[y*400+x]==foreground:adjusted[y*400+x+center-old_center]=foreground
    return adjusted


def geometry(pixels,name):
    checks=0
    def require(value,message):
        nonlocal checks
        if not value:raise ValueError(name+' layout: '+message)
        checks+=1
    black=(0,0,0);white=(255,255,255)
    def line(y,start=12,end=387):
        require(all(pixels[y*400+x]==black for x in range(start,end+1)),'separator '+str(y))
    def frame(left,top,width,height,color):
        for y in [top,top+height-1]:require(all(pixels[y*400+x]==color for x in range(left,left+width)),'frame horizontal')
        for x in [left,left+width-1]:require(all(pixels[y*400+x]==color for y in range(top,top+height)),'frame vertical')
    def badge(left,top,width,height):
        for row in range(height):
            edge=min(row,height-row-1);cut=[3,1,1,0][edge] if edge<4 else 0
            require(pixels[(top+row)*400+left+cut]==RED and pixels[(top+row)*400+left+width-cut-1]==RED,'rounded badge edges')
            for col in range(cut):
                require(pixels[(top+row)*400+left+col]==white and pixels[(top+row)*400+left+width-col-1]==white,'rounded badge cutout')
    line(30);line(58);line(263)
    if name=='weather':line(149);line(200);badge(12,160,120,30)
    elif name=='gold':line(206)
    elif name.startswith('stock-'):frame(296,67,91,24,black)
    elif name=='news':
        for i in range(4):frame(12,75+i*46,26,26,RED)
        for i in range(3):line(112+i*46,50)
    elif name=='holiday-yes':
        line(165)
        for i in range(7):
            left=12+i*352//7+i*4;right=12+(i+1)*352//7+i*4-1
            frame(left,172,right-left+1,66,RED if i<3 else black)
    elif name=='holiday-none':line(154);badge(252,118,135,30)
    icons=json.loads((Path(__file__).parent/'life-icons.json').read_text(encoding='utf-8'))
    header={'weather':'sun','gold':'ingot','stock-up':'chart','stock-down':'chart','stock-closed':'chart',
            'tool-codex':'tool','tool-claude':'tool','news':'news','holiday-yes':'lantern','holiday-none':'calendar'}
    def icon(group,icon_name,x,y,black_only=False):
        for row,line_pixels in enumerate(icons[group][icon_name]):
            for col,pixel in enumerate(line_pixels):
                if pixel=='.':continue
                expected=black if pixel=='#' or (pixel=='R' and black_only) else RED if pixel=='R' else white
                require(pixels[(y+row)*400+x+col]==expected,'unchanged '+icon_name+' icon')
    icon('inline16',header[name],12,38,name in ['stock-down','stock-closed'])
    if name=='weather':icon('hero48','sun',12,72)
    if name=='gold':icon('hero48','ingot',339,68)
    if name=='holiday-yes':icon('hero48','lantern',12,82)
    if name=='holiday-none':icon('hero48','calendar',12,74)
    return checks


def compare(output,record=False):
    reference=Path(__file__).resolve().parent/'baselines/life-approved';results={}
    for name in NAMES:
        black=(output/(name+'.black.bin')).read_bytes();red=(output/(name+'.red.bin')).read_bytes()
        if len(black)!=15000 or len(red)!=15000:raise ValueError('Bad production plane size')
        if any(a|b!=255 for a,b in zip(black,red)):raise ValueError('Black/red pigment overlap')
        pixels=[RED if not(red[i//8]&(128>>(i%8))) else (0,0,0) if not(black[i//8]&(128>>(i%8))) else (255,255,255) for i in range(120000)]
        expected=read_png(reference/(name+'.png'));diff=[];body=policy=chrome=red_count=unexpected=0
        approved=holiday_bar_reference(expected) if name=='holiday-yes' else expected
        geometry_checks=geometry(pixels,name)
        for i,(actual,target) in enumerate(zip(pixels,expected)):
            y=i//400;inside=31<=y<=262
            if actual==RED and inside:red_count+=1
            pending=name=='holiday-none' and y>154
            policy_target=(0,0,0) if name in ['stock-down','stock-closed'] and target==RED else approved[i]
            if inside and not pending and actual!=policy_target:unexpected+=1
            if actual==target:diff.append((255,255,255))
            else:
                diff.append((255,0,255))
                if inside:
                    body+=1
                    if pending or actual==policy_target:policy+=1
                else:chrome+=1
        png(output/(name+'.png'),pixels);png(output/(name+'.diff.png'),diff)
        if name in ['stock-down','stock-closed'] and red_count:raise ValueError('Falling/closed stock must be black')
        results[name]={'bodyPixelDiff':body,'approvedPolicyDiff':policy,'fontBodyDiff':unexpected,
                       'headerFooterDiff':chrome,'layoutChecks':geometry_checks,'redPixels':red_count,'bodyPixels':92800,'redSharePercent':round(red_count/928,3)}
        print(name+': '+json.dumps(results[name]))
    (output/'pixel-report.json').write_text(json.dumps(results,indent=2)+'\n',encoding='utf-8')
    sha=lambda path:hashlib.sha256(path.read_bytes()).hexdigest()
    baseline={'firmwareVersion':'0.0.31-font','design':'yb-life-v1 B geometry; native ZhengGe/Fusion/Terminus; cleaned native Noto heroes',
      'pixels':{name:{'black':sha(output/(name+'.black.bin')),'red':sha(output/(name+'.red.bin')),
        'approvedPng':sha(reference/(name+'.png')),**results[name]} for name in NAMES}}
    path=reference.parent/'0.0.31-font-life.json'
    if record:
        path.write_text(json.dumps(baseline,indent=2)+'\n',encoding='utf-8')
    elif path.exists():
        if json.loads(path.read_text(encoding='utf-8'))!=baseline:raise SystemExit('Frozen life pixel baseline changed')
    else:raise SystemExit('Missing initial life baseline; verify pixels then use --record once')
    print('PASS: frozen font-grid pixels, original B PNG differences reported, unchanged layout geometry/icons')
    return results


READING={'concept':'book','concept-long':'book','prompt':'bulb','hn':'flame'}


def reading(output,record=False):
    """0.0.32-cards reading layouts: shared chrome, label row and icon, frozen planes."""
    black=(0,0,0);white=(255,255,255);icons=json.loads((Path(__file__).parent/'life-icons.json').read_text(encoding='utf-8'))
    sha=lambda path:hashlib.sha256(path.read_bytes()).hexdigest();frozen={}
    for name,icon_name in READING.items():
        b=(output/(name+'.black.bin')).read_bytes();r=(output/(name+'.red.bin')).read_bytes()
        if any(x|y!=255 for x,y in zip(b,r)):raise ValueError(name+': black/red overlap')
        pixels=[RED if not(r[i//8]&(128>>(i%8))) else black if not(b[i//8]&(128>>(i%8))) else white for i in range(120000)]
        for y in (30,58,263):
            if any(pixels[y*400+x]!=black for x in range(12,388)):raise ValueError(name+': separator '+str(y))
        for row,line in enumerate(icons['inline16'][icon_name]):
            for col,p in enumerate(line):
                if p!='.' and pixels[(38+row)*400+12+col]!=(black if p=='#' else RED if p=='R' else white):raise ValueError(name+': icon')
        if not any(p==RED for p in pixels[31*400:263*400]):raise ValueError(name+': no red accent')
        png(output/(name+'.png'),pixels)
        frozen[name]={'black':sha(output/(name+'.black.bin')),'red':sha(output/(name+'.red.bin'))}
    path=Path(__file__).resolve().parent/'baselines/0.0.32-cards-reading.json'
    baseline={'firmwareVersion':'0.0.32-cards','design':'reading cards approved 2026-11-04; native 32px Noto Sans SC strike','pixels':frozen}
    if record:path.write_text(json.dumps(baseline,indent=2)+'\n',encoding='utf-8')
    elif not path.exists():raise SystemExit('Missing reading-card baseline; verify pixels then use --update-reading once')
    elif json.loads(path.read_text(encoding='utf-8'))!=baseline:raise SystemExit('Frozen reading-card pixels changed')
    print('PASS: reading cards keep chrome, icons, red accents and frozen pixels')


if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('output',type=Path)
    parser.add_argument('--update',action='store_true',help='Explicit font-grid baseline re-record after review')
    parser.add_argument('--update-reading',action='store_true',help='Record the reading-card baseline after review')
    args=parser.parse_args();compare(args.output,args.update);reading(args.output,args.update_reading)
