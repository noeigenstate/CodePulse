"""Independent pinned-BDF rows, approved icon pixels, and deterministic generation checks."""
import gzip
import hashlib
import json
from pathlib import Path
import re
import subprocess
import sys
import unittest

ROOT=Path(__file__).resolve().parents[1]
class LifeAssets(unittest.TestCase):
    def test_bdf_rows_are_native_unmodified_and_pinned(self):
        meta=json.loads((ROOT/'fonts/sources/life-assets.json').read_text())
        raw=(ROOT/meta['source']).read_bytes()
        self.assertEqual(hashlib.sha256(raw).hexdigest(),meta['sha256'])
        rows={}
        for block in gzip.decompress(raw).decode('ascii').split('STARTCHAR ')[1:]:
            code=int(re.search(r'\nENCODING (\d+)',block)[1])
            bitmap=re.search(r'\nBITMAP\n(.*?)\nENDCHAR',block,re.S)[1]
            rows[code]=[int(row,16) for row in bitmap.splitlines()]
        header=(ROOT/'main/life_assets.generated.h').read_text()
        table=re.search(r'life_font_rows\[\]\[32\] = \{(.*?)\n\};',header,re.S)[1]
        actual=[[int(value,16) for value in re.findall(r'0x[0-9a-f]+',r)] for r in re.findall(r'\{([^}]+)\}',table)]
        self.assertEqual(actual,[rows[code] for code in meta['glyphCodes']])
        self.assertIn(176,meta['glyphCodes']);self.assertIn(0x2212,meta['glyphCodes'])
    def test_all_icon_pixels_are_exact(self):
        header=(ROOT/'main/life_assets.generated.h').read_text()
        table=re.search(r'life_icon_pixels\[\] = \{(.*?)\n\};',header,re.S)[1]
        packed=[int(v,16) for v in re.findall(r'0x[0-9a-f]+',table)]
        expected=[]
        for group in json.loads((ROOT/'preview/life-icons.json').read_text()).values():
            for image in group.values():expected.extend('.#Ro'.index(ch) for row in image for ch in row)
        actual=[(byte>>shift)&3 for byte in packed for shift in [6,4,2,0]]
        self.assertEqual(actual,expected)
    def test_generated_outputs_are_current(self):
        subprocess.run([sys.executable,str(ROOT/'scripts/generate-life-assets.py'),'--check'],check=True)

if __name__=='__main__':unittest.main()
