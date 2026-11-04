"""Stdlib-only grid atlas/coverage/native source identity checks, also under -O."""
from pathlib import Path
import gzip,hashlib,importlib.util,json,re,struct,sys,zlib
root=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('generator',root/'scripts/generate-hierarchy-font.py')
g=importlib.util.module_from_spec(spec);spec.loader.exec_module(g)
def check(value,message):
    if not value:raise RuntimeError(message)
meta,atlas=g.generate(root)
check(meta==json.loads((root/'fonts/sources/native-hierarchy.json').read_text(encoding='utf-8')),'stale metadata')
check(gzip.decompress((root/'fonts/sources/native-hierarchy.bin.gz').read_bytes())==atlas,'stale raw atlas')
header=(root/'main/display_font_data.h').read_text(encoding='utf-8')
compressed=bytes(int(v,16) for v in re.findall(r'0x([0-9a-f]{2})',header.split('font_compressed[] = {')[1]))
decoded=bytearray(zlib.decompress(compressed))
for table in meta['tables']:
    offset=0
    for i in range(table['count']):
        p=table['offset']+i*8;offset=(offset+int.from_bytes(decoded[p:p+3],'little'))&0xffffff
        decoded[p:p+3]=offset.to_bytes(3,'little')
check(bytes(decoded)==atlas,'delta24 round trip')
source=json.loads((root/'fonts/sources/grid-native-masks.json').read_text(encoding='utf-8'))
raw=gzip.decompress((root/'fonts/sources/grid-native-masks.bin.gz').read_bytes());sr=struct.Struct('<IHbbBB')
check(len(meta['codes'])==7752 and meta['codes']==g.repertoire(),'codepoint repertoire')
check(len(meta['faceMap'])==14,'all semantic faces retained')
check(len(meta['microCodes'])==207,'calendar closed vocabulary')
check(len(meta['fallbacks']['compactCjkZheng16'])==116 and not meta['fallbacks']['calendar12'],'explicit compact/calendar fallbacks')
fallback_report=json.loads((root/'fonts/sources/font-grid-fallbacks.json').read_text(encoding='utf-8'))
check([int(v['code'][2:],16) for v in fallback_report['fallbacks']['compactCjkZheng16']]==meta['fallbacks']['compactCjkZheng16'],'stale readable CJK fallback list')
check(source['recipe']['supersample']==8 and source['recipe']['thresholdPercent']==50,'hero sampling recipe')
check('native BDF' in source['rasterizer'],'small fonts must not use outline rasterization')
native={f['name']:f for f in source['faces']};native_indices={name:{cp:i for i,cp in enumerate(f['codes'])} for name,f in native.items()}
by_offset={t['offset']:t for t in meta['tables']};code_index={cp:i for i,cp in enumerate(meta['codes'])}
def record(enum,cp):
    f=meta['faces'][meta['faceMap'][enum]];table=by_offset[f[0]];index=code_index[cp]
    override=meta['overrideCodes'][f[6]:f[6]+f[4]]
    if cp in override:table=by_offset[f[3]];index=override.index(cp)
    return g.RECORD.unpack_from(atlas,table['offset']+index*8),table
for enum in range(14):
    f=meta['faces'][enum]
    for cp in meta['codes']:
        (p,a,l,t,w,h),table=record(enum,cp)
        original=native[table['name']];i=native_indices[table['name']][cp]
        sp,sa,sl,st,sw,sh=sr.unpack_from(raw,original['offset']+i*10)
        expected_a=sa//64;expected_l=sl
        terminus=any(origin.startswith('Terminus') and cp in members for origin,members in original['origins'].items())
        if terminus and cp==32:expected_a=(expected_a+1)//2
        if terminus and cp==0xb7:
            source_bits=raw[sp:sp+(sw+7)//8*sh]
            columns=[x for y in range(sh) for x in range(sw) if source_bits[y*((sw+7)//8)+x//8]&(128>>(x%8))]
            expected_a=max(columns)-min(columns)+5;expected_l=2-min(columns)
        check((a,l,t,w,h)==(expected_a,expected_l,st,sw,sh),'native metrics/compact separator policy changed')
        check(atlas[p:p+(w+7)//8*h]==raw[sp:sp+(sw+7)//8*sh],'native mask changed')
        check(p+(w+7)//8*h<=len(atlas) and f[2]+t>=0 and f[2]+t+h<=f[1],'glyph bounds')
    if meta['roles'][enum][0]=='compact-12':check(f[1]>=16,'compact fallback line box too short')
calendar=json.loads((root/'fonts/sources/calendar-charset.json').read_text(encoding='utf-8'))
check(set(meta['microCodes'])==(set(calendar['codepoints'])|set(source['latinCodes']))&set(meta['codes']),'calendar charset drift')
check(calendar['range']==[1900,2100] and calendar['days']==73414 and calendar['months']==2412,'calendar enumeration')
check(len(atlas)<=1086869,'expanded atlas exceeds historical PSRAM budget')
check(len(compressed)<395971-8192,'atlas leaves insufficient code budget')
notices=g.third_party_text(root)
for font in json.loads((root/'fonts/sources/font-grid-sources.json').read_text(encoding='utf-8')):
    check(font['name'] in notices and font['version'] in notices and font['copyright'] in notices,'font attribution missing')
    for license in font['licenses']:check((root/license['path']).read_bytes().decode('utf-8') in notices,'license not verbatim')
check('Noto Sans SC' not in notices,'unused vector CJK font still shipped')
for forbidden in ['UserData','scratchpad','quiet_dashboard.c','codepulse_protocol.c','E:/','E:\\']:
    check(forbidden not in notices,'private/source path in public notices')
print('PASS: 14 x 7752 native grid glyphs/metrics, 207 native calendar glyphs, 116 explicit CJK fallbacks, delta24, verbatim licenses')
if len(sys.argv)>1:
    pgm=Path(sys.argv[1]).read_bytes();prefix=b'P5\n400 300\n255\n';check(pgm.startswith(prefix),'specimen format')
    expected=bytearray([255])*120000
    cases=[(8,0,'在电脑上处理提醒 周剩余 待确认'),(40,3,'待确认 待查看 工作中'),
           (72,0,'CodePulse WWW iii jp-work-proxy 47%'),(104,1,'CodePulse WWW jp-work 47%'),
           (136,7,'Codex 30.9 C 52% Claude Grok 100%'),(168,4,'0123456789-%.'),
           (200,5,'0123456789-%.'),(232,1,'低闪烁看板 固件 状态同步 桌面布局'),(262,9,'Codex Claude Grok')]
    for y,enum,text in cases:
        f=meta['faces'][enum];points=[];pen=0
        for char in text:
            (p,a,l,t,w,h),_=record(enum,ord(char));bits=atlas[p:p+(w+7)//8*h]
            for yy in range(h):
                for xx in range(w):
                    if bits[yy*((w+7)//8)+xx//8]&(128>>(xx%8)):points.append((pen+l+xx,t+yy))
            pen+=a
        origin=8-min(x for x,y in points)
        for xx,yy in points:
            if 0<=origin+xx<400 and 0<=y+f[2]+yy<300:expected[(y+f[2]+yy)*400+origin+xx]=0
    check(pgm[len(prefix):]==expected,'native C specimen differs from source pixels/bearings')
    print('PASS: nine native C specimen rows match source glyphs exactly')
