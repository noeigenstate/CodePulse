"""Pack checked-in, native FreeType MONO masks using only Python stdlib.

Outline rasterization is the separate generate-native-font-masks.py step.
All semantic faces retain the full repertoire through shared 14/16px tables.
Sparse native strikes override Latin and the closed 12px calendar vocabulary.
"""
from pathlib import Path
import argparse,gzip,hashlib,json,runpy,struct,zlib

SPACING=runpy.run_path(str(Path(__file__).with_name('font-spacing.py')))

SOURCE_RECORD=struct.Struct('<IHbbBB')
class GlyphRecord:
    size=8
    @staticmethod
    def pack_into(blob,at,p,a,l,t,w,h):
        if not (0<=p<1<<24 and 0<=a<256):raise ValueError('packed glyph range')
        blob[at:at+8]=p.to_bytes(3,'little')+struct.pack('<BbbBB',a,l,t,w,h)
    @staticmethod
    def unpack_from(blob,at):return (int.from_bytes(blob[at:at+3],'little'),*struct.unpack_from('<BbbBB',blob,at+3))
RECORD=GlyphRecord()
FACE_MAP=[0,1,1,3,0,5,3,0,4,1,0,3,2,6]

def repertoire():
    codes=set(range(32,256))|set(range(0x2000,0x2070))|{0xfffd}
    for a in range(0xa1,0xf8):
        for b in range(0xa1,0xff):
            try:codes.add(ord(bytes((a,b)).decode('gb2312')))
            except UnicodeDecodeError:pass
    return sorted(codes)

def generate(root):
    folder=root/'fonts/sources';source=json.loads((folder/'grid-native-masks.json').read_text(encoding='utf-8'))
    raw=gzip.decompress((folder/'grid-native-masks.bin.gz').read_bytes())
    if hashlib.sha256(raw).hexdigest()!=source['atlasSha256']:raise ValueError('source masks hash')
    if source['codes']!=repertoire():raise ValueError('codepoint repertoire')
    for name,digest in source['sourceHashes'].items():
        if hashlib.sha256((folder/name).read_bytes()).hexdigest()!=digest:raise ValueError(name+' hash')
    provenance=json.loads((folder/'font-grid-sources.json').read_text(encoding='utf-8'))
    for font in provenance:
        if hashlib.sha256((root/font['path']).read_bytes()).hexdigest()!=font['sha256']:raise ValueError('font source hash')
        for license in font['licenses']:
            if hashlib.sha256((root/license['path']).read_bytes()).hexdigest()!=license['sha256']:raise ValueError('license hash')
    calendar=json.loads((folder/'calendar-charset.json').read_text(encoding='utf-8'))
    micro=source['microCodes'];atlas=bytearray();tables=[];seen={};override_codes=[]
    used={'pixel-16','compact-12','terminus-16b','terminus-18b','terminus-20b','terminus-32b','hero-40','calendar-12'}
    for face in [face for face in source['faces'] if face['name'] in used]:
        points=face['codes'];offset=len(atlas);atlas.extend(bytes(len(points)*8));top=bottom=0
        for i,cp in enumerate(points):
            p,a,l,t,w,h=SOURCE_RECORD.unpack_from(raw,face['offset']+i*10)
            bits=raw[p:p+(w+7)//8*h]
            if any(origin.startswith('Terminus') and cp in members for origin,members in face['origins'].items()):
                a,l,t,w,h,bits=SPACING['terminus_spacing'](cp,(a//64,l,t,w,h,bits))
                a*=64
            key=(w,h,bits)
            if key not in seen:seen[key]=len(atlas);atlas.extend(bits)
            RECORD.pack_into(atlas,offset+i*8,seen[key],a//64,l,t,w,h)
            if h:top=min(top,t);bottom=max(bottom,t+h)
        first=len(override_codes)
        if face['name'] not in ['pixel-16','compact-12']:override_codes.extend(points)
        tables.append({'name':face['name'],'offset':offset,'count':len(points),'top':top,'bottom':bottom,'codeFirst':first})
    by_name={t['name']:t for t in tables}
    def info(base,override=None):
        f=by_name[base];o=by_name[override] if override else None
        top=min(f['top'],o['top']) if o else f['top'];bottom=max(f['bottom'],o['bottom']) if o else f['bottom']
        return [f['offset'],bottom-top+2,1-top,o['offset'] if o else 0,o['count'] if o else 0,16 if base=='pixel-16' else 12,o['codeFirst'] if o else 0]
    roles=[('pixel-16',None),('pixel-16','terminus-20b'),('pixel-16','terminus-20b'),
           ('compact-12','terminus-16b'),('pixel-16','terminus-18b'),('pixel-16','hero-40'),
           ('compact-12','terminus-16b'),('compact-12','terminus-16b'),('compact-12','terminus-16b'),
           ('pixel-16','terminus-20b'),('compact-12','terminus-16b'),('compact-12','terminus-16b'),
           ('pixel-16','calendar-12'),('pixel-16','terminus-32b')]
    faces=[info(*role) for role in roles]
    meta={'recordSize':8,'codes':source['codes'],'latinCodes':source['latinCodes'],'microCodes':micro,
          'overrideCodes':override_codes,'calendarCharsetSha256':hashlib.sha256((folder/'calendar-charset.json').read_bytes().replace(b'\r\n',b'\n')).hexdigest(),
          'faces':faces,'faceMap':list(range(14)),'tables':tables,'rasterizer':source['rasterizer'],
          'recipe':source['recipe'],'spacing':SPACING['POLICY'],'fallbacks':source['fallbacks'],'roles':[list(role) for role in roles],
          'sourceMaskSha256':source['atlasSha256'],'atlasSha256':hashlib.sha256(atlas).hexdigest()}
    return meta,bytes(atlas)

def emit(meta,atlas,output):
    compressed=zlib.compress(encoded_atlas(meta,atlas),9)
    rows=['/* CodePulse native pixel grid; original designed masks, no runtime font rasterizer. See fonts/SOURCE.txt. */',
          '#include <stdint.h>',f'#define DISPLAY_FONT_ATLAS_SIZE {len(atlas)}u',
          f'#define DISPLAY_FONT_GLYPHS {len(meta["codes"])}u',f'#define DISPLAY_GLYPH_RECORD_SIZE {RECORD.size}u',
          'typedef struct { unsigned offset, height, ascent, override_offset, override_count, size, code_first; } display_font_info_t;',
          'static const display_font_info_t font_info[] = {']
    rows+=['{'+','.join(str(v)+'u' for v in meta['faces'][i])+'},' for i in meta['faceMap']]
    rows+=['};',f'#define DISPLAY_FONT_TABLE_COUNT {len(meta["tables"])}u',
           'static const struct { unsigned offset, count; } font_tables[] = {']
    rows += ['{%du,%du},'%(t['offset'],t['count']) for t in meta['tables']]
    rows+=['};','static const uint16_t font_codes[] = {']
    rows += [','.join(f'0x{c:04x}' for c in meta['codes'][i:i+16])+',' for i in range(0,len(meta['codes']),16)]
    rows+=['};','static const uint16_t override_codes[] = {']
    rows += [','.join(str(c) for c in meta['overrideCodes'])+'};','static const uint8_t font_compressed[] = {']
    rows += [','.join(f'0x{v:02x}' for v in compressed[i:i+24])+',' for i in range(0,len(compressed),24)]
    rows+=['};'];output.write_text('\n'.join(rows)+'\n',encoding='utf-8',newline='\n')
    print('Native pixel-grid atlas:',len(atlas),'PSRAM bytes;',len(compressed),'compressed bytes; compact 8-byte records')

def encoded_atlas(meta,atlas):
    result=bytearray(atlas)
    for table in meta['tables']:
        previous=0
        for i in range(table['count']):
            p=table['offset']+i*RECORD.size;current=int.from_bytes(atlas[p:p+3],'little')
            result[p:p+3]=((current-previous)&0xffffff).to_bytes(3,'little');previous=current
    return bytes(result)

def third_party_text(root):
    fonts=json.loads((root/'fonts/sources/font-grid-sources.json').read_text(encoding='utf-8'))
    parts=['Third-party fonts embedded in the CodePulse device preview','Native monochrome bitmap derivatives. Original font copyrights and licenses follow.']
    for font in fonts:
        parts += ['', '='*72,font['name']+' '+font['version'],font['copyright'],'Source: '+font['url'],
                  'Stored source: '+font['path'],'Stored source SHA-256: '+font['sha256']]
        for name,digest in font.get('variants',{}).items():
            parts += ['Variant: '+name+' SHA-256: '+digest]
        for license in font['licenses']:
            data=(root/license['path']).read_bytes()
            if hashlib.sha256(data).hexdigest()!=license['sha256']:raise ValueError('license hash')
            parts += ['',data.decode('utf-8')]
    return '\n'.join(parts)+'\n'

def main():
    root=Path(__file__).resolve().parents[1];ap=argparse.ArgumentParser()
    ap.add_argument('--output',type=Path);ap.add_argument('--write-source',action='store_true');args=ap.parse_args()
    meta,atlas=generate(root)
    if args.write_source:
        (root/'fonts/sources/native-hierarchy.bin.gz').write_bytes(gzip.compress(atlas,mtime=0))
        (root/'fonts/sources/native-hierarchy.json').write_text(json.dumps(meta,separators=(',',':'))+'\n',encoding='utf-8')
    emit(meta,atlas,args.output or root/'main/display_font_data.h')

if __name__=='__main__':main()
