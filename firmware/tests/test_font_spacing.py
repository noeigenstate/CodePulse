"""Spacing/weight contracts; native pixel shapes remain unscaled and unfiltered."""
from pathlib import Path
import gzip,json,runpy,struct,unittest
ROOT=Path(__file__).resolve().parents[1]
class Typography(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.meta=json.loads((ROOT/'fonts/sources/native-hierarchy.json').read_text())
        cls.atlas=gzip.decompress((ROOT/'fonts/sources/native-hierarchy.bin.gz').read_bytes())
        cls.source=json.loads((ROOT/'fonts/sources/grid-native-masks.json').read_text())
        cls.raw=gzip.decompress((ROOT/'fonts/sources/grid-native-masks.bin.gz').read_bytes())
        cls.policy=staticmethod(runpy.run_path(str(ROOT/'scripts/font-spacing.py'))['terminus_spacing'])
    def original(self,name,cp):
        face=next(f for f in self.source['faces'] if f['name']==name)
        p,a,l,t,w,h=struct.unpack_from('<IHbbBB',self.raw,face['offset']+face['codes'].index(cp)*10)
        return a//64,l,t,w,h,self.raw[p:p+(w+7)//8*h]
    def actual(self,role,cp):
        f=self.meta['faces'][self.meta['faceMap'][role]]
        overrides=self.meta['overrideCodes'][f[6]:f[6]+f[4]]
        at=f[3]+overrides.index(cp)*8 if cp in overrides else f[0]+self.meta['codes'].index(cp)*8
        p=int.from_bytes(self.atlas[at:at+3],'little');a,l,t,w,h=struct.unpack_from('<BbbBB',self.atlas,at+3)
        return a,l,t,w,h,self.atlas[p:p+(w+7)//8*h]
    def test_exact_native_space_and_dot_advances(self):
        expected={'12n':(3,5),'16n':(4,5),'16b':(4,6),'18b':(5,6),'20b':(5,6),'32b':(8,7)}
        for name,(space,dot) in expected.items():
            a=self.policy(32,self.original('terminus-'+name,32));b=self.policy(0xb7,self.original('terminus-'+name,0xb7))
            self.assertEqual(a[0],space);self.assertEqual(b[0],dot)
            self.assertEqual(a[2:],self.original('terminus-'+name,32)[2:])
            self.assertEqual(b[2:],self.original('terminus-'+name,0xb7)[2:])
            _,left,_,w,h,bits=b
            xs=[left+x for y in range(h) for x in range(w) if bits[y*((w+7)//8)+x//8]&(128>>(x%8))]
            self.assertEqual(min(xs),2);self.assertEqual(b[0]-max(xs)-1,2)
    def test_every_previously_bold_role_uses_a_native_bold_strike(self):
        expected=['16b','20b','20b','16b','18b','16b','16b','16b','16b','20b','16b','16b','16b','32b']
        for role,strike in enumerate(expected):
            self.assertEqual(self.actual(role,ord('A')),self.original('terminus-'+strike,ord('A')),role)
    def test_spacing_is_packed_for_every_runtime_consumer(self):
        for role in range(14):
            for cp in [32,0xb7]:
                face=self.meta['faces'][self.meta['faceMap'][role]]
                table=next(t for t in self.meta['tables'] if t['offset']==face[0])
                overrides=self.meta['overrideCodes'][face[6]:face[6]+face[4]]
                if cp in overrides:table=next(t for t in self.meta['tables'] if t['offset']==face[3])
                self.assertEqual(self.actual(role,cp),self.policy(cp,self.original(table['name'],cp)))
    def test_meta_and_state_keep_fusion_cjk(self):
        for role in [7,10]:
            for char in '元宝搜索天气周剩余':
                self.assertEqual(self.actual(role,ord(char)),self.original('compact-12',ord(char)))

if __name__=='__main__':unittest.main()
