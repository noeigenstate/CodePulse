"""Independent BDF pixel identity; deterministic topology cleanup and hero repro."""
from pathlib import Path
import argparse,gzip,importlib.util,json,re,struct,sys,unittest
ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('source',ROOT/'scripts/generate-native-font-masks.py')
g=importlib.util.module_from_spec(spec);spec.loader.exec_module(g)
ap=argparse.ArgumentParser();ap.add_argument('--freetype-path',type=Path);args,rest=ap.parse_known_args()
if args.freetype_path:sys.path.insert(0,str(args.freetype_path.resolve()))
class GridSource(unittest.TestCase):
    def test_every_designed_mask_and_metric_is_unmodified(self):
        folder=ROOT/'fonts/sources';source=json.loads((folder/'grid-native-masks.json').read_text())
        raw=gzip.decompress((folder/'grid-native-masks.bin.gz').read_bytes());fonts={}
        def load(name):
            if name not in fonts:
                data=gzip.decompress((folder/name).read_bytes()).decode('utf-8');glyphs={}
                for block in data.split('STARTCHAR ')[1:]:
                    cp=int(re.search(r'\nENCODING (-?\d+)',block)[1]);a=int(re.search(r'\nDWIDTH (\d+)',block)[1])
                    w,h,l,b=map(int,re.search(r'\nBBX (\d+) (\d+) (-?\d+) (-?\d+)',block).groups())
                    bitmap=re.search(r'\nBITMAP[^\n]*\n(.*?)ENDCHAR',block,re.S)[1]
                    bits=b''.join(bytes.fromhex(line.strip())[:(w+7)//8] for line in bitmap.splitlines())
                    glyphs[cp]=(a,l,-b-h,w,h,bits)
                fonts[name]=glyphs
            return fonts[name]
        count=0
        for face in source['faces']:
            indices={cp:i for i,cp in enumerate(face['codes'])}
            for origin,points in face['origins'].items():
                if origin.startswith('Noto'):continue
                name='terminus-ter-u'+origin.split()[-1]+'.bdf.gz' if origin.startswith('Terminus') else 'ZhengGeDianHei-16.bdf.gz' if origin.startswith('Zheng') else 'fusion-pixel-12px-proportional-2026.10.25.bdf.gz' if origin.startswith('Fusion') else 'unifont-18.0.01.bdf.gz'
                font=load(name)
                for cp in points:
                    p,a,l,t,w,h=struct.unpack_from('<IHbbBB',raw,face['offset']+indices[cp]*10)
                    self.assertEqual((a//64,l,t,w,h,raw[p:p+(w+7)//8*h]),font[cp],(face['name'],hex(cp),origin));count+=1
        self.assertGreater(count,18000)
        for strike in ['12n','16n','16b','18b','20b','32b']:
            font=load('terminus-ter-u'+strike+'.bdf.gz');self.assertEqual(font[0x2212],font[0x2013])
    def test_cleanup_preserves_strokes_and_counters(self):
        ring={(x,y) for y in range(7) for x in range(7) if x in [0,1,5,6] or y in [0,1,5,6]}
        for points in [ring,ring|{(3,3)}, {(0,0)}, {(0,0),(1,0)}, {(x,2) for x in range(7)}]:
            before=(g.components(points,True),g.components({(x,y) for y in range(-1,8) for x in range(-1,8)}-points,False))
            clean,_,_=g.cleanup(points,7,7)
            after=(g.components(clean,True),g.components({(x,y) for y in range(-1,8) for x in range(-1,8)}-clean,False))
            self.assertEqual(before,after);self.assertTrue(clean)
        square={(x,y) for y in range(2,5) for x in range(2,5)}
        _,removed,_=g.cleanup(square|{(1,1)},7,7)
        _,_,filled=g.cleanup(square-{(3,2)},7,7)
        self.assertGreater(removed,0);self.assertGreater(filled,0)
    def test_small_outline_rasterization_is_forbidden(self):
        with self.assertRaisesRegex(ValueError,'forbidden'):g.rasterize(None,None,48,32)
    @unittest.skipUnless(args.freetype_path,'dev-only rasterizer not needed for ordinary atlas checks')
    def test_reproduce_all_hero_masks_and_open_counters(self):
        import freetype
        from importlib.metadata import version
        self.assertEqual(freetype.version(),(2,13,2));self.assertEqual(version('freetype-py'),'2.5.1')
        folder=ROOT/'fonts/sources';source=json.loads((folder/'grid-native-masks.json').read_text());raw=gzip.decompress((folder/'grid-native-masks.bin.gz').read_bytes())
        face=freetype.Face(str(folder/'NotoSans-Bold.ttf'))
        for size in [40,56,60]:
            table=next(f for f in source['faces'] if f['name']=='hero-'+str(size))
            for i,cp in enumerate(table['codes']):
                actual,_,_=g.rasterize(freetype,face,cp,size)
                p,a,l,t,w,h=struct.unpack_from('<IHbbBB',raw,table['offset']+i*10)
                self.assertEqual(actual,(a//64,l,t,w,h,raw[p:p+(w+7)//8*h]))
                if cp in [48,56]:
                    bits=actual[-1];ink={(x,y) for y in range(h) for x in range(w) if bits[y*((w+7)//8)+x//8]&(128>>(x%8))}
                    domain={(x,y) for y in range(-1,h+1) for x in range(-1,w+1)}
                    self.assertEqual(g.components(domain-ink,False)-1,1 if cp==48 else 2)
if __name__=='__main__':unittest.main(argv=[sys.argv[0],*rest])
