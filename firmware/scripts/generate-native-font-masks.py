"""Font-grid source stage: native designed BDF masks, outlines ONLY above 32px.

python -B firmware/scripts/generate-native-font-masks.py --freetype-path <tools>
FreeType 2.13.2 / freetype-py 2.5.1 are dev-only. Atlas packing remains stdlib-only.
"""
from pathlib import Path
import argparse,ctypes,gzip,hashlib,json,platform,struct,sys

ROOT=Path(__file__).resolve().parents[1]
RECORD=struct.Struct('<IHbbBB')
LATIN_CODES=sorted(set(range(32,127))|{0xb0,0xb7,0xd7,0xf7,0x2013,0x2014,0x2026,0x2212})
HERO_CODES=sorted(set(map(ord,'0123456789.:%+-/'))|{0xb0,0x2212,0x2013})
PINS={
 'ZhengGeDianHei-16.bdf.gz':'6bc128a69a03b683fc3aaf1373b06a66e9efc76417834cad9946d23be0a81327',
 'fusion-pixel-12px-proportional-2026.10.25.bdf.gz':'7fa678ba5ad903bee6c31534acf1ec2f801f4e09f0001fe46b60a940529ac40b',
 'terminus-ter-u12n.bdf.gz':'f9d54f02eec846fc04911eaf9792431efcc2a9a44c7b9ee0a9e605ce843fedd5',
 'terminus-ter-u16n.bdf.gz':'f2ba142483584ef5ecf644bdc636d49ef00b87b2efeb9b2a34a11d4b3680fb3b',
 'terminus-ter-u16b.bdf.gz':'3f7b63f12162dcb2d29c8d32bfb0d1a5fa67fde42843b6254b45e14567addc08',
 'terminus-ter-u18b.bdf.gz':'62ab52f8bc0052f1660320fedec159aa62cd24ee751c10895a50e5a6e51c75d2',
 'terminus-ter-u20b.bdf.gz':'67557c2e8a5d2deba2c6caee7b5b4b6aa4d7fb7951d9f237f7360cec21e9cd70',
 'terminus-ter-u32b.bdf.gz':'9bf7c8feb04601ed162e81f8e73dfccde946374f5dfa85395aaa7bab0cb714b0',
 'unifont-18.0.01.bdf.gz':'2989e0211030d8219fd931aba599fc95c86bc327ce1423848ef949783b208257',
 'NotoSans-Bold.ttf':'c976e4b1b99edc88775377fcc21692ca4bfa46b6d6ca6522bfda505b28ff9d6a',
}
SAMPLE=8
RECIPE={'small':'original BDF masks/metrics, no scaling, dilation or synthetic bold',
 'hero':'FreeType unhinted GRAY at 8x; integer baseline-aligned 8x8 box; >=50% coverage',
 'thresholdPercent':50,'supersample':8,
 'cleanup':'one row-major spur pass, then notch pass; foreground-8/background-4 topology and component counts preserved',
 'heroAliases':{'U+2212':'U+2013 (Noto Sans Bold 2.008 has no U+2212; native same-size dash outline)'},
 'metrics':'original BDF bearings/advance; hero native unhinted advance rounded, empty margins trimmed'}

def bdf(path):
    result={};glyph=None;rows=None
    for line in gzip.decompress(path.read_bytes()).decode('utf-8').splitlines():
        line=line.strip()
        if line.startswith('STARTCHAR '):glyph={};rows=None
        elif line.startswith('ENCODING '):glyph['code']=int(line.split()[1])
        elif line.startswith('DWIDTH '):glyph['advance']=int(line.split()[1])
        elif line.startswith('BBX '):glyph['box']=tuple(map(int,line.split()[1:]))
        elif line=='BITMAP':rows=[]
        elif line=='ENDCHAR':
            w,h,l,bottom=glyph['box'];stride=(w+7)//8
            bits=b''.join(bytes.fromhex(row)[:stride] for row in (rows or []))
            if len(bits)!=(w+7)//8*h:raise ValueError('BDF row stride '+str(glyph['code']))
            result[glyph['code']]=(glyph['advance'],l,-bottom-h,w,h,bits);rows=None
        elif rows is not None:rows.append(line.strip())
    return result

def components(points,diagonal):
    points=set(points);count=0
    neighbors=[(x,y) for y in [-1,0,1] for x in [-1,0,1] if (x or y) and (diagonal or abs(x)+abs(y)==1)]
    while points:
        count+=1;stack=[points.pop()]
        while stack:
            x,y=stack.pop()
            for dx,dy in neighbors:
                p=(x+dx,y+dy)
                if p in points:points.remove(p);stack.append(p)
    return count

def cleanup(points,w,h):
    """Only topologically simple changes; no counter closure or stroke separation."""
    points=set(points);domain={(x,y) for y in range(-1,h+1) for x in range(-1,w+1)}
    topology=lambda p:(components(p,True),components(domain-p,False))
    before=topology(points);removed=filled=0
    adjacent=lambda p:sum((p[0]+dx,p[1]+dy) in points for dy in [-1,0,1] for dx in [-1,0,1] if dx or dy)
    spurs=[p for p in sorted(points,key=lambda p:(p[1],p[0])) if adjacent(p)==1]
    for p in spurs:
        q=next((q for q in points if max(abs(q[0]-p[0]),abs(q[1]-p[1]))==1),None)
        if q is None or adjacent(q)<3:continue
        candidate=points-{p}
        if topology(candidate)==before:points=candidate;removed+=1
    notches=[(x,y) for y in range(h) for x in range(w) if (x,y) not in points and adjacent((x,y))>=5]
    for p in notches:
        candidate=points|{p}
        if topology(candidate)==before:points=candidate;filled+=1
    if topology(points)!=before:raise ValueError('Cleanup changed topology')
    return points,removed,filled

def box_mask(raw,width,height,pitch,left,top):
    x0=left//8;y0=(-top)//8
    w=(left+width+7)//8-x0;h=(height-top+7)//8-y0
    if not width or not height:return (0,0,0,0,b'',0,0)
    stride=w*8;gray=bytearray(stride*h*8);dx=left-x0*8;dy=-top-y0*8
    for y in range(height):
        row=y if pitch>=0 else height-y-1;start=(dy+y)*stride+dx
        gray[start:start+width]=raw[row*abs(pitch):row*abs(pitch)+width]
    points=set()
    for y in range(h):
        for x in range(w):
            coverage=sum(sum(gray[(y*8+yy)*stride+x*8:(y*8+yy)*stride+x*8+8]) for yy in range(8))
            if coverage*2>=255*64:points.add((x,y))
    points,removed,filled=cleanup(points,w,h)
    if not points:return (0,0,0,0,b'',removed,filled)
    lx=min(x for x,y in points);rx=max(x for x,y in points);ty=min(y for x,y in points);by=max(y for x,y in points)
    w=rx-lx+1;h=by-ty+1;bits=bytearray((w+7)//8*h)
    for x,y in points:bits[(y-ty)*((w+7)//8)+(x-lx)//8]|=128>>((x-lx)%8)
    return (x0+lx,y0+ty,w,h,bytes(bits),removed,filled)

def rasterize(freetype,face,cp,size):
    if size<=32:raise ValueError('Outline rasterization is forbidden at <=32px')
    actual=0x2013 if cp==0x2212 else cp
    if not face.get_char_index(actual):raise ValueError('Missing hero outline '+hex(cp))
    flags=freetype.FT_LOAD_NO_HINTING|freetype.FT_LOAD_NO_AUTOHINT|freetype.FT_LOAD_NO_BITMAP
    face.set_pixel_sizes(0,size);face.load_char(chr(actual),flags);advance=(face.glyph.advance.x+32)//64
    face.set_pixel_sizes(0,size*8);face.load_char(chr(actual),flags|freetype.FT_LOAD_RENDER|freetype.FT_LOAD_TARGET_NORMAL)
    slot=face.glyph;bm=slot.bitmap
    if bm.rows and (bm.pixel_mode!=freetype.FT_PIXEL_MODE_GRAY or bm.num_grays!=256):raise ValueError('Expected grayscale source')
    raw=ctypes.string_at(bm._FT_Bitmap.buffer,abs(bm.pitch)*bm.rows) if bm.rows else b''
    l,t,w,h,bits,removed,filled=box_mask(raw,bm.width,bm.rows,bm.pitch,slot.bitmap_left,slot.bitmap_top)
    return (advance,l,t,w,h,bits),removed,filled

def main():
    ap=argparse.ArgumentParser();ap.add_argument('--freetype-path',type=Path);args=ap.parse_args()
    if args.freetype_path:sys.path.insert(0,str(args.freetype_path.resolve()))
    import freetype
    from importlib.metadata import version
    if version('freetype-py')!='2.5.1' or freetype.version()!=(2,13,2):raise ValueError('Require FreeType 2.13.2 / freetype-py 2.5.1')
    folder=ROOT/'fonts/sources'
    for name,digest in PINS.items():
        if hashlib.sha256((folder/name).read_bytes()).hexdigest()!=digest:raise ValueError(name+' hash')
    fonts={name:bdf(folder/(name+'.bdf.gz')) for name in ['ZhengGeDianHei-16','fusion-pixel-12px-proportional-2026.10.25','unifont-18.0.01']}
    strikes={name:bdf(folder/('terminus-ter-u'+name+'.bdf.gz')) for name in ['12n','16n','16b','18b','20b','32b']}
    zheng=fonts['ZhengGeDianHei-16'];fusion=fonts['fusion-pixel-12px-proportional-2026.10.25'];unifont=fonts['unifont-18.0.01']
    codes=json.loads((folder/'noto-hierarchy.json').read_text())['codes']
    calendar=json.loads((folder/'calendar-charset.json').read_text());micro=sorted((set(calendar['codepoints'])|set(LATIN_CODES))&set(codes))
    if len(micro)!=207 or any(cp not in fusion and cp not in strikes['12n'] for cp in micro):raise ValueError('Closed calendar vocabulary needs a non-native fallback')
    blob=bytearray();faces=[];used={};cleanup_stats={}
    def pack(name,points,getter):
        offset=len(blob);blob.extend(bytes(len(points)*RECORD.size));origins={}
        for i,cp in enumerate(points):
            glyph,origin=getter(cp);a,l,t,w,h,bits=glyph
            if not(0<=a<256 and -128<=l<128 and -128<=t<128 and w<256 and h<256):raise ValueError('Glyph bounds')
            p=len(blob);blob.extend(bits);RECORD.pack_into(blob,offset+i*10,p,a*64,l,t,w,h)
            used[origin]=used.get(origin,0)+1;origins.setdefault(origin,[]).append(cp)
        faces.append({'name':name,'codes':points,'offset':offset,'origins':origins})
    def full(cp):
        if cp in strikes['16b']:return strikes['16b'][cp],'Terminus 16b'
        if cp in zheng:return zheng[cp],'ZhengGeDianHei 16'
        if cp in fusion:return fusion[cp],'Fusion Pixel 12'
        return unifont[cp],'Unifont 16 compatibility'
    def compact(cp):
        if cp in strikes['16b']:return strikes['16b'][cp],'Terminus 16b'
        if cp in fusion:return fusion[cp],'Fusion Pixel 12'
        if cp in zheng:return zheng[cp],'ZhengGeDianHei 16 fallback'
        return unifont[cp],'Unifont 16 compatibility'
    pack('pixel-16',codes,full);pack('compact-12',codes,compact)
    for name,glyphs in strikes.items():
        pack('terminus-'+name,sorted(set(codes)&set(glyphs)),lambda cp,g=glyphs,n=name:(g[cp],'Terminus '+n))
    face=freetype.Face(str(folder/'NotoSans-Bold.ttf'))
    for size in [40,56,60]:
        stats={'spursRemoved':0,'notchesFilled':0};cache={}
        for cp in HERO_CODES:
            glyph,removed,filled=rasterize(freetype,face,cp,size);cache[cp]=glyph
            stats['spursRemoved']+=removed;stats['notchesFilled']+=filled
        cleanup_stats[str(size)]=stats
        pack('hero-'+str(size),HERO_CODES,lambda cp,cache=cache,n=size:(cache[cp],'Noto Sans Bold '+str(n)))
    pack('calendar-12',micro,lambda cp:(strikes['16b'][cp],'Terminus 16b') if cp in strikes['16b'] else (fusion[cp],'Fusion Pixel 12'))
    origins=next(f for f in faces if f['name']=='compact-12')['origins']
    fallbacks={'compactZheng16':origins.get('ZhengGeDianHei 16 fallback',[]),
        'compactCjkZheng16':[cp for cp in origins.get('ZhengGeDianHei 16 fallback',[]) if 0x4e00<=cp<=0x9fff],
        'compactUnifont16':origins.get('Unifont 16 compatibility',[]),'calendar12':[],
        'policy':'Compact roles have >=16px line boxes; MICRO closed 207 uses Fusion12 CJK and native Terminus16b Latin, other characters use complete pixel16 fallback.'}
    if len(fallbacks['compactCjkZheng16'])!=116:raise ValueError('Unexpected Fusion CJK fallback set')
    meta={'recordSize':10,'faces':faces,'codes':codes,'latinCodes':LATIN_CODES,'microCodes':micro,
        'sourceHashes':PINS,'recipe':RECIPE,'rasterizer':'native BDF; heroes FreeType 2.13.2 / freetype-py 2.5.1',
        'python':platform.python_version(),'fallbacks':fallbacks,'usedRecords':used,'cleanup':cleanup_stats,
        'atlasSha256':hashlib.sha256(blob).hexdigest()}
    (folder/'grid-native-masks.bin.gz').write_bytes(gzip.compress(blob,mtime=0))
    (folder/'grid-native-masks.json').write_text(json.dumps(meta,separators=(',',':'))+'\n',encoding='utf-8',newline='\n')
    groups={name:[{'code':'U+%04X'%cp,'char':chr(cp)} for cp in points] for name,points in fallbacks.items() if isinstance(points,list)}
    full_origins=next(f for f in faces if f['name']=='pixel-16')['origins']
    groups['fullUnifont16']=[{'code':'U+%04X'%cp,'char':chr(cp)} for cp in full_origins.get('Unifont 16 compatibility',[])]
    groups['fullFusion12']=[{'code':'U+%04X'%cp,'char':chr(cp)} for cp in full_origins.get('Fusion Pixel 12',[])]
    fallback_report={'compactRoles':['DISPLAY_BADGE','DISPLAY_SMALL_BOLD','DISPLAY_META','DISPLAY_BRAND','DISPLAY_STATE','DISPLAY_SUMMARY'],
        'fullRoles':['DISPLAY_BODY','DISPLAY_TITLE','DISPLAY_DENSE_TITLE','DISPLAY_NUMBER','DISPLAY_USAGE_NUMBER fallback','DISPLAY_USAGE_TITLE','DISPLAY_MICRO outside closed 207','DISPLAY_DATE fallback'],
        'compactLineBoxMinimum':16,'calendarClosed':207,'fallbacks':groups,'policy':fallbacks['policy']}
    (folder/'font-grid-fallbacks.json').write_text(json.dumps(fallback_report,ensure_ascii=False,indent=2)+'\n',encoding='utf-8',newline='\n')
    print('Native grid masks',len(blob),'bytes;',used,'cleanup',cleanup_stats)
    print('Fusion missing CJK:',len(fallbacks['compactCjkZheng16']),'; closed calendar fallback:',len(fallbacks['calendar12']))

if __name__=='__main__':main()
