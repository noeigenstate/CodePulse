"""Rasterize pinned outline sources once; atlas generation itself is stdlib-only.

python scripts/generate-native-font-masks.py --freetype-path tmp/f3/vendor
Requires freetype-py 2.5.1 with FreeType 2.13.2. No system font installation.
"""
from pathlib import Path
import argparse,gzip,hashlib,json,struct,sys

ROOT=Path(__file__).resolve().parents[1]
RECORD=struct.Struct('<IHbbBB')
SIZES=[12,14,16,20,24,40]
LATIN_CODES=sorted(set(range(32,127))|{0xb0,0xb7,0xd7,0xf7,0x2013,0x2014,0x2026,0x2212})
PINS={'NotoSans-Bold.ttf':'c976e4b1b99edc88775377fcc21692ca4bfa46b6d6ca6522bfda505b28ff9d6a',
      'NotoSansSC-Regular.otf':'faa6c9df652116dde789d351359f3d7e5d2285a2b2a1f04a2d7244df706d5ea9'}

def unifont(wanted):
    raw=gzip.decompress((ROOT/'fonts/sources/unifont-18.0.01.bdf.gz').read_bytes())
    if hashlib.sha256(raw).hexdigest()!='8c3c5ce5fb524eec5bacbc91b5ddfde81641e2cfc015521e95107b77570368e3':raise ValueError('Unifont hash')
    result={};cp=None;rows=None
    for line in raw.decode('utf-8').splitlines():
        if line.startswith('STARTCHAR '):cp=None;rows=None
        elif line.startswith('ENCODING '):cp=int(line.split()[1])
        elif line.startswith('DWIDTH '):advance=int(line.split()[1])
        elif line.startswith('BBX '):box=tuple(map(int,line.split()[1:]))
        elif line=='BITMAP':rows=[]
        elif line=='ENDCHAR':
            if cp in wanted:
                w,h,left,bottom=box
                result[cp]=(advance,left,-bottom-h,w,h,bytes.fromhex(''.join(rows or [])))
            rows=None
        elif rows is not None:rows.append(line.strip())
    return result

def sfnt(face,name_id):
    for i in range(face.sfnt_name_count):
        name=face.get_sfnt_name(i)
        if name.name_id==name_id and name.platform_id==3:return name.string.decode('utf-16-be')
    raise ValueError('Missing font name')

def main():
    ap=argparse.ArgumentParser();ap.add_argument('--freetype-path',type=Path);args=ap.parse_args()
    if args.freetype_path:sys.path.insert(0,str(args.freetype_path.resolve()))
    import freetype
    from importlib.metadata import version
    if version('freetype-py')!='2.5.1':raise ValueError('Pinned freetype-py 2.5.1 required')
    if freetype.version()!=(2,13,2):raise ValueError('Pinned FreeType 2.13.2 required')
    folder=ROOT/'fonts/sources'
    for name,digest in PINS.items():
        if hashlib.sha256((folder/name).read_bytes()).hexdigest()!=digest:raise ValueError(name+' hash')
    latin=freetype.Face(str(folder/'NotoSans-Bold.ttf'));sc=freetype.Face(str(folder/'NotoSansSC-Regular.otf'))
    if not sfnt(latin,5).startswith('Version 2.008') or not sfnt(sc,5).startswith('Version 2.004'):raise ValueError('font version')
    codes=json.loads((folder/'noto-hierarchy.json').read_text())['codes'];fallback=unifont(set(codes))
    flags=freetype.FT_LOAD_RENDER|freetype.FT_LOAD_TARGET_MONO|freetype.FT_LOAD_MONOCHROME|freetype.FT_LOAD_NO_BITMAP
    def glyph(face,cp,size):
        face.set_pixel_sizes(0,size);face.load_char(chr(cp),flags);slot=face.glyph;bm=slot.bitmap
        if bm.pixel_mode!=freetype.FT_PIXEL_MODE_MONO and bm.rows:raise ValueError('non-MONO bitmap')
        raw=bytes(bm.buffer);pitch=abs(bm.pitch);stride=(bm.width+7)//8
        rows=[raw[y*pitch:y*pitch+stride] for y in range(bm.rows)]
        if bm.pitch<0:rows.reverse()
        return ((slot.advance.x+32)//64,slot.bitmap_left,-slot.bitmap_top,bm.width,bm.rows,b''.join(rows))
    blob=bytearray();faces=[];used={}
    def pack(name,points,getter):
        offset=len(blob);blob.extend(bytes(len(points)*RECORD.size))
        for i,cp in enumerate(points):
            a,l,t,w,h,bits,origin=getter(cp)
            if not (0<=a<256 and -128<=l<128 and -128<=t<128 and 0<=w<256 and 0<=h<256):raise ValueError('glyph bounds')
            p=len(blob);blob.extend(bits);RECORD.pack_into(blob,offset+i*RECORD.size,p,a*64,l,t,w,h)
            used[origin]=used.get(origin,0)+1
        faces.append({'name':name,'codes':points,'offset':offset})
    for size,latin_size in [(12,12),(14,16),(16,20)]:
        def get(cp,size=size,latin_size=latin_size):
            if (cp<0x2100 or cp==0xfffd) and latin.get_char_index(cp):return (*glyph(latin,cp,latin_size),'Noto Sans Bold')
            if sc.get_char_index(cp):return (*glyph(sc,cp,size),'Noto Sans SC Regular')
            return (*fallback[cp],'GNU Unifont legacy controls')
        pack('text-'+str(size),codes,get)
    for size in SIZES:
        def get(cp,size=size):
            if latin.get_char_index(cp):return (*glyph(latin,cp,size),'Noto Sans Bold')
            if sc.get_char_index(cp):return (*glyph(sc,cp,size),'Noto Sans SC Regular')
            raise ValueError('missing native symbol')
        pack('latin-'+str(size),LATIN_CODES,get)
    meta={'recordSize':10,'faces':faces,'latinSizes':SIZES,'latinCodes':LATIN_CODES,'codes':codes,
          'rasterizer':'FreeType 2.13.2 / freetype-py 2.5.1','flags':'RENDER|TARGET_MONO|MONOCHROME|NO_BITMAP',
          'sourceHashes':PINS,'copyright':{'Noto Sans Bold':sfnt(latin,0),'Noto Sans SC Regular':sfnt(sc,0)},
          'versions':{'Noto Sans Bold':sfnt(latin,5),'Noto Sans SC Regular':sfnt(sc,5)},
          'usedRecords':used,'atlasSha256':hashlib.sha256(blob).hexdigest()}
    (folder/'noto-native-masks.bin.gz').write_bytes(gzip.compress(blob,mtime=0))
    (folder/'noto-native-masks.json').write_text(json.dumps(meta,separators=(',',':'))+'\n',encoding='utf-8')
    print('Native MONO source masks:',len(blob),'bytes;',used)

if __name__=='__main__':main()
