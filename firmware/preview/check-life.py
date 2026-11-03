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


def compare(output,record=False,update_holiday_bar=False):
    reference=Path(__file__).resolve().parent/'baselines/life-approved';results={}
    for name in NAMES:
        black=(output/(name+'.black.bin')).read_bytes();red=(output/(name+'.red.bin')).read_bytes()
        if len(black)!=15000 or len(red)!=15000:raise ValueError('Bad production plane size')
        if any(a|b!=255 for a,b in zip(black,red)):raise ValueError('Black/red pigment overlap')
        pixels=[RED if not(red[i//8]&(128>>(i%8))) else (0,0,0) if not(black[i//8]&(128>>(i%8))) else (255,255,255) for i in range(120000)]
        expected=read_png(reference/(name+'.png'));diff=[];body=policy=chrome=red_count=unexpected=0
        approved=holiday_bar_reference(expected) if name=='holiday-yes' else expected
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
        results[name]={'bodyPixelDiff':body,'approvedPolicyDiff':policy,'unexpectedBodyDiff':unexpected,
                       'headerFooterDiff':chrome,'redPixels':red_count,'bodyPixels':92800,'redSharePercent':round(red_count/928,3)}
        print(name+': '+json.dumps(results[name]))
    (output/'pixel-report.json').write_text(json.dumps(results,indent=2)+'\n',encoding='utf-8')
    if any(r['unexpectedBodyDiff'] or r['headerFooterDiff'] for r in results.values()):raise SystemExit('Unexpected pixels differ from approved B; inspect .diff.png')
    sha=lambda path:hashlib.sha256(path.read_bytes()).hexdigest()
    baseline={'firmwareVersion':'0.0.30-life','design':'yb-life-v1 variant B; black falling/closed stocks; pending fixed-holiday countdown',
      'pixels':{name:{'black':sha(output/(name+'.black.bin')),'red':sha(output/(name+'.red.bin')),
        'approvedPng':sha(reference/(name+'.png')),**results[name]} for name in NAMES}}
    path=reference.parent/'0.0.30-life.json'
    if record:
        if path.exists():raise SystemExit('Initial life baseline already exists; review changes instead of overwriting')
        path.write_text(json.dumps(baseline,indent=2)+'\n',encoding='utf-8')
    elif update_holiday_bar:
        prior=json.loads(path.read_text(encoding='utf-8'))
        if prior['firmwareVersion']!=baseline['firmwareVersion'] or prior['design']!=baseline['design']:raise SystemExit('Unexpected baseline metadata changed')
        for name in NAMES:
            if name!='holiday-yes' and prior['pixels'][name]!=baseline['pixels'][name]:raise SystemExit('Only the reviewed holiday bar baseline may change: '+name)
        prior['pixels']['holiday-yes']=baseline['pixels']['holiday-yes']
        path.write_text(json.dumps(prior,indent=2)+'\n',encoding='utf-8')
    elif path.exists():
        if json.loads(path.read_text(encoding='utf-8'))!=baseline:raise SystemExit('Frozen life pixel baseline changed')
    else:raise SystemExit('Missing initial life baseline; verify pixels then use --record once')
    print('PASS: approved B body pixels, with the explicit design/review overrides; header/footer identical')
    return results


if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('output',type=Path)
    mode=parser.add_mutually_exclusive_group();mode.add_argument('--record',action='store_true');mode.add_argument('--update-holiday-bar',action='store_true')
    args=parser.parse_args();compare(args.output,args.record,args.update_holiday_bar)
