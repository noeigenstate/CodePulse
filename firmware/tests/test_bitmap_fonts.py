"""Stdlib-only atlas/coverage/source-mask validation; checks also run with -O.

python tests/test_bitmap_fonts.py [build-quiet-tests/display-font-cells.pgm]
"""
from pathlib import Path
import gzip,hashlib,importlib.util,json,re,struct,sys,zlib
root=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('generator',root/'scripts/generate-hierarchy-font.py')
g=importlib.util.module_from_spec(spec);spec.loader.exec_module(g)
def check(value,message):
    if not value:raise RuntimeError(message)
meta,atlas=g.generate(root)
stored=json.loads((root/'fonts/sources/native-hierarchy.json').read_text(encoding='utf-8'))
check(meta==stored,'stale metadata')
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
source=json.loads((root/'fonts/sources/noto-native-masks.json').read_text(encoding='utf-8'))
raw=gzip.decompress((root/'fonts/sources/noto-native-masks.bin.gz').read_bytes());sr=struct.Struct('<IHbbBB')
check(len(meta['codes'])==7752 and meta['codes']==g.repertoire(),'codepoint repertoire')
check(len(meta['faceMap'])==14 and len(meta['latinCodes'])==103,'semantic/native Latin descriptors')
check(source['rasterizer']=='FreeType 2.13.2 / freetype-py 2.5.1','rasterizer version')
check(source['flags']=='RENDER|TARGET_MONO|MONOCHROME|NO_BITMAP','native mono hinting flags')
by_offset={t['offset']:i for i,t in enumerate(meta['tables'])}
code_index={cp:i for i,cp in enumerate(meta['codes'])}
native={f['name']:f for f in source['faces']}
native_indices={name:{cp:i for i,cp in enumerate(f['codes'])} for name,f in native.items()}
calendar=json.loads((root/'fonts/sources/calendar-charset.json').read_text(encoding='utf-8'))
expected_micro=sorted((set(calendar['codepoints'])|set(source['latinCodes']))&set(meta['codes']))
check(meta['microCodes']==expected_micro,'sparse calendar repertoire')
calendar_text=''.join(calendar['labels'])+calendar['lunarCharacters']+calendar['fixed']+''.join(calendar['compatibility'])
check(set(map(ord,calendar_text))==set(calendar['codepoints']),'calendar charset completeness')
check(calendar['range']==[1900,2100] and calendar['days']==73414 and calendar['months']==2412,'calendar enumeration range')
check(len(meta['tables'])==7,'shared full faces and only referenced sparse strikes')
check(sum(t['count']==7752 for t in meta['tables'])==2,'duplicate complete faces')
def record(enum,cp):
    f=meta['faces'][meta['faceMap'][enum]];table=by_offset[f[0]];index=code_index[cp]
    override=meta['overrideCodes'][f[6]:f[6]+f[4]]
    if cp in override:table=by_offset[f[3]];index=override.index(cp)
    p,a,l,t,w,h=g.RECORD.unpack_from(atlas,meta['tables'][table]['offset']+index*8)
    return (p,a,l,t,w,h),table,index
for enum in range(len(meta['faceMap'])):
    f=meta['faces'][meta['faceMap'][enum]]
    for cp in meta['codes']:
        (p,a,l,t,w,h),table,index=record(enum,cp)
        base='text-16' if enum in [1,2,5,9,13] else 'text-14'
        override={3:14,5:40,6:14,8:12,11:14,13:24}.get(enum)
        name='text-12' if enum==12 and cp in expected_micro else base
        if override and cp in source['latinCodes']:name='latin-'+str(override)
        original=native[name];source_index=native_indices[name][cp]
        sp,sa,sl,st,sw,sh=sr.unpack_from(raw,original['offset']+source_index*10)
        check((a,l,t,w,h)==(sa//64,sl,st,sw,sh),'native metrics changed')
        check(atlas[p:p+(w+7)//8*h]==raw[sp:sp+(sw+7)//8*sh],'original MONO mask changed')
        check(p+(w+7)//8*h<=len(atlas) and f[2]+t>=0 and f[2]+t+h<=f[1],'glyph bounds')
check(len(atlas)<=1086869,'expanded atlas exceeds 0.0.28 PSRAM budget')
check(len(compressed)<395971-8192,'atlas must leave space for calendar code')
notices=g.third_party_text(root)
for font in json.loads((root/'fonts/sources/noto-sources.json').read_text(encoding='utf-8')):
    check(font['name'] in notices and font['version'] in notices and font['copyright'] in notices,'missing font attribution')
    for license in font['licenses']:check((root/license['path']).read_bytes().decode('utf-8') in notices,'license not verbatim')
for forbidden in ['UserData','scratchpad','quiet_dashboard.c','codepulse_protocol.c','E:/','E:\\']:
    check(forbidden not in notices,'private/source data in public font notice')
print('PASS: stdlib regeneration, original native masks/metrics, 14 x 7752 glyphs via shared full faces, sparse calendar12 and SC14 fallback, lossless delta24, public font notices')
if len(sys.argv)>1:
    pgm=Path(sys.argv[1]).read_bytes();prefix=b'P5\n400 300\n255\n';check(pgm.startswith(prefix),'specimen format')
    expected=bytearray([255])*120000
    cases=[(8,0,'在电脑上处理提醒 周剩余 待确认'),(40,3,'待确认 待查看 工作中'),
           (72,0,'CodePulse WWW iii jp-work-proxy 47%'),(104,1,'CodePulse WWW jp-work 47%'),
           (136,7,'Codex 30.9 C 52% Claude Grok 100%'),(168,4,'0123456789-%.'),
           (200,5,'0123456789-%.'),(232,1,'低闪烁看板 固件 状态同步 桌面布局'),(262,9,'Codex Claude Grok')]
    for y,enum,text in cases:
        f=meta['faces'][meta['faceMap'][enum]];points=[];pen=0
        for ch in text:
            (off,adv,left,top,w,h),_,_=record(enum,ord(ch));bits=atlas[off:off+(w+7)//8*h]
            for yy in range(h):
                for xx in range(w):
                    if bits[yy*((w+7)//8)+xx//8]&(128>>(xx%8)):points.append((pen+left+xx,top+yy))
            pen+=adv
        origin=8-min(x for x,_ in points)
        for x0,y0 in points:expected[(y+f[2]+y0)*400+origin+x0]=0
    check(pgm[len(prefix):]==expected,'native specimen lost strokes/changed baseline')
    print('PASS: nine native C specimen rows exactly match source masks and bearings')
