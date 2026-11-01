"""Compose the supplied, already-normalized calendar photo and native output.

No sharpening, watermark removal or font reconstruction; only 2x NEAREST.
"""
from pathlib import Path
import argparse
from PIL import Image
ap=argparse.ArgumentParser();ap.add_argument('--reference',required=True,type=Path)
ap.add_argument('--render',required=True,type=Path);ap.add_argument('--output',required=True,type=Path)
args=ap.parse_args()
reference=Image.open(args.reference).convert('RGB');render=Image.open(args.render).convert('RGB')
if reference.size!=(400,300) or render.size!=(400,300):raise ValueError('Use native 400x300 inputs')
sheet=Image.new('RGB',(1600,600),'white')
sheet.paste(reference.resize((800,600),Image.Resampling.NEAREST),(0,0))
sheet.paste(render.resize((800,600),Image.Resampling.NEAREST),(800,0))
sheet.save(args.output)
print('PASS: 1600x600 reference/calendar comparison; exact nearest-neighbor 2x')
