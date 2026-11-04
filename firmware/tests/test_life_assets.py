"""Independent exact native pixels, icon masks and deterministic life packing."""
import gzip,hashlib,json,re,struct,subprocess,sys,unittest
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
class LifeAssets(unittest.TestCase):
    def test_native_metrics_and_pixels_match_source_without_enlargement(self):
        meta=json.loads((ROOT/'fonts/sources/life-assets.json').read_text());header=(ROOT/'main/life_assets.generated.h').read_text()
        source=json.loads((ROOT/'fonts/sources/grid-native-masks.json').read_text())
        raw=gzip.decompress((ROOT/'fonts/sources/grid-native-masks.bin.gz').read_bytes())
        self.assertEqual(hashlib.sha256(raw).hexdigest(),meta['sourceMasksSha256'])
        self.assertEqual(meta['recipe'],source['recipe'])
        self.assertEqual([s['nativeSize'] for s in meta['strikes']],[32,56,60])
        data=re.search(r'life_font_bits\[\] = \{(.*?)\n\};',header,re.S)[1]
        bits=bytes(int(v,16) for v in re.findall(r'0x[0-9a-f]+',data))
        descriptors=re.search(r'life_font_glyphs\[\]\[\d+\] = \{(.*?)\n\};',header,re.S)[1]
        actual=[tuple(map(int,row.split(','))) for row in re.findall(r'\{([^{}]+)\}',descriptors)]
        def pixels(blob,p,l,t,w,h):
            return {(l+x,t+y) for y in range(h) for x in range(w) if blob[p+y*((w+7)//8)+x//8]&(128>>(x%8))}
        for index,strike in enumerate(meta['strikes']):
            face=next(f for f in source['faces'] if f['name']==strike['sourceFace'])
            for column,cp in enumerate(meta['glyphCodes']):
                p,a,l,t,w,h=actual[index*len(meta['glyphCodes'])+column]
                if cp not in strike['codes']:
                    self.assertEqual((p,a,l,t,w,h),(0,0,0,0,0,0));continue
                original=0x2013 if cp==0x2212 and index==0 else cp
                sp,sa,sl,st,sw,sh=struct.unpack_from('<IHbbBB',raw,face['offset']+face['codes'].index(original)*10)
                expected_a=(sa//64+1)//2 if index==0 and cp==32 else sa//64
                original_pixels=pixels(raw,sp,sl,st,sw,sh)
                if index==0 and cp==0xb7:
                    x0=min(x for x,y in original_pixels);x1=max(x for x,y in original_pixels)
                    expected_a=x1-x0+5
                    original_pixels={(x-x0+2,y) for x,y in original_pixels}
                self.assertEqual(a,expected_a)
                self.assertEqual(pixels(bits,p,l,t,w,h),original_pixels)
        self.assertIn(0x2212,meta['glyphCodes'])
        renderer=(ROOT/'main/life_dashboard.c').read_text()
        self.assertNotIn('scale',renderer)
    def test_all_icon_pixels_are_exact(self):
        header=(ROOT/'main/life_assets.generated.h').read_text()
        table=re.search(r'life_icon_pixels\[\] = \{(.*?)\n\};',header,re.S)[1]
        packed=[int(v,16) for v in re.findall(r'0x[0-9a-f]+',table)]
        expected=[]
        for group in json.loads((ROOT/'preview/life-icons.json').read_text()).values():
            for image in group.values():expected.extend('.#Ro'.index(ch) for row in image for ch in row)
        self.assertEqual([(b>>shift)&3 for b in packed for shift in [6,4,2,0]],expected)
    def test_generated_outputs_are_current(self):
        subprocess.run([sys.executable,str(ROOT/'scripts/generate-life-assets.py'),'--check'],check=True)
if __name__=='__main__':unittest.main()
