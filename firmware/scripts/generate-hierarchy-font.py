"""Pack checked-in, native FreeType MONO masks using only Python stdlib.

Outline rasterization is the separate generate-native-font-masks.py step.
All semantic faces retain the full repertoire through shared 14/16px tables.
Sparse native strikes override Latin and the closed 12px calendar vocabulary.
"""
from pathlib import Path
import argparse,gzip,hashlib,json,struct,zlib

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
    folder=root/'fonts/sources';source=json.loads((folder/'noto-native-masks.json').read_text(encoding='utf-8'))
    raw=gzip.decompress((folder/'noto-native-masks.bin.gz').read_bytes())
    if hashlib.sha256(raw).hexdigest()!=source['atlasSha256']:raise ValueError('source masks hash')
    if source['codes']!=repertoire():raise ValueError('codepoint repertoire')
    for name,digest in source['sourceHashes'].items():
        if hashlib.sha256((folder/name).read_bytes()).hexdigest()!=digest:raise ValueError(name+' hash')
    provenance=json.loads((folder/'noto-sources.json').read_text(encoding='utf-8'))
    for font in provenance:
        if hashlib.sha256((root/font['path']).read_bytes()).hexdigest()!=font['sha256']:raise ValueError('font source hash')
        for license in font['licenses']:
            if hashlib.sha256((root/license['path']).read_bytes()).hexdigest()!=license['sha256']:raise ValueError('license hash')
    calendar=json.loads((folder/'calendar-charset.json').read_text(encoding='utf-8'))
    if not set(calendar['codepoints'])<=set(source['codes']):raise ValueError('calendar repertoire')
    micro=sorted((set(calendar['codepoints'])|set(source['latinCodes']))&set(source['codes']))
    atlas=bytearray();tables=[];seen={}
    # Latin16/20 are already inside text-14/16; no descriptor needs duplicates.
    used={'text-14','text-16','latin-12','latin-14','latin-24','latin-40'}
    selected=[(f,f['codes'],f['name']) for f in source['faces'] if f['name'] in used]
    selected.append((source['faces'][0],micro,'calendar-12'))
    if selected[-1][0]['name']!='text-12':raise ValueError('native source table order')
    for source_face,points,name in selected:
        offset=len(atlas);atlas.extend(bytes(len(points)*RECORD.size));ymin=ymax=0
        indices={cp:i for i,cp in enumerate(source_face['codes'])}
        for i,cp in enumerate(points):
            p,a,l,t,w,h=SOURCE_RECORD.unpack_from(raw,source_face['offset']+indices[cp]*SOURCE_RECORD.size)
            bits=raw[p:p+(w+7)//8*h];key=(w,h,bits)
            if key not in seen:seen[key]=len(atlas);atlas.extend(bits)
            RECORD.pack_into(atlas,offset+i*RECORD.size,seen[key],a//64,l,t,w,h)
            if h:ymin=min(ymin,t);ymax=max(ymax,t+h)
        tables.append({'name':name,'offset':offset,'count':len(points),'top':ymin,'bottom':ymax})
    by_name={t['name']:t for t in tables}
    def info(base,override_name=None):
        f=by_name[base];override=by_name[override_name] if override_name else None
        top=min(f['top'],override['top']) if override else f['top']
        bottom=max(f['bottom'],override['bottom']) if override else f['bottom']
        return [f['offset'],bottom-top+2,1-top,override['offset'] if override else 0,
                override['count'] if override else 0,int(base.split('-')[1]),
                len(source['latinCodes']) if override_name=='calendar-12' else 0]
    faces=[info('text-14'),info('text-16'),info('text-14','calendar-12'),info('text-14','latin-14'),
           info('text-14','latin-12'),info('text-16','latin-40'),info('text-16','latin-24')]
    meta={'recordSize':RECORD.size,'codes':source['codes'],'latinCodes':source['latinCodes'],
          'microCodes':micro,'overrideCodes':source['latinCodes']+micro,
          'calendarCharsetSha256':hashlib.sha256((folder/'calendar-charset.json').read_bytes().replace(b'\r\n',b'\n')).hexdigest(),
          'faces':faces,'faceMap':FACE_MAP,'tables':tables,'rasterizer':source['rasterizer'],'flags':source['flags'],
          'sourceMaskSha256':source['atlasSha256'],'atlasSha256':hashlib.sha256(atlas).hexdigest()}
    return meta,bytes(atlas)

def emit(meta,atlas,output):
    compressed=zlib.compress(encoded_atlas(meta,atlas),9)
    rows=['/* CodePulse Noto MONO; original masks, no runtime font rasterizer. See fonts/SOURCE.txt. */',
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
    print('Noto MONO atlas:',len(atlas),'PSRAM bytes;',len(compressed),'compressed bytes; compact 8-byte records')

def encoded_atlas(meta,atlas):
    result=bytearray(atlas)
    for table in meta['tables']:
        previous=0
        for i in range(table['count']):
            p=table['offset']+i*RECORD.size;current=int.from_bytes(atlas[p:p+3],'little')
            result[p:p+3]=((current-previous)&0xffffff).to_bytes(3,'little');previous=current
    return bytes(result)

def third_party_text(root):
    fonts=json.loads((root/'fonts/sources/noto-sources.json').read_text(encoding='utf-8'))
    parts=['Third-party fonts embedded in the CodePulse device preview','Native monochrome bitmap derivatives. Original font copyrights and licenses follow.']
    for font in fonts:
        parts += ['', '='*72,font['name']+' '+font['version'],font['copyright'],'Source: '+font['url'],
                  'Source SHA-256: '+font['sha256']]
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
