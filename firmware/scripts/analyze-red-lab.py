"""Derive facts from host-replayed frozen sources; no optical model or hardware."""
from pathlib import Path
import csv
import hashlib
import json
import re
import argparse

parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('--replays',type=Path,required=True)
parser.add_argument('--sources',type=Path,required=True)
args=parser.parse_args()
root=args.replays.resolve()
profiles={name:json.loads((root/name/"replay.json").read_text(encoding="utf-8-sig"))
          for name in ("Tail48","Neutral50","Stagger51")}

def expand(lut):
    levels=[]
    boundaries=[]
    for group in range(7):
        data=lut[group*6:group*6+6]
        for repeat in range(data[5]):
            for phase in range(4):
                code=(data[0]>>(6-2*phase))&3
                start=len(levels)
                levels.extend([code]*data[phase+1])
                if data[phase+1]:
                    boundaries.append((group,repeat,phase,code,start,len(levels)))
    return levels,boundaries

rows=[]
summary={}
for name,replay in profiles.items():
    passes=[]
    for stage in replay["passes"]:
        counts=[]
        frames=[]
        for index,lut in enumerate(stage["tables"]):
            levels,boundaries=expand(lut)
            frames.append(len(levels))
            counts.append([levels.count(code) for code in range(4)])
            if index in (2,4):
                for group,repeat,phase,code,start,end in boundaries:
                    rows.append((name,stage["pass"],hex(0x20+index),group,repeat,phase,
                                 code,start*1000/stage["hz"],end*1000/stage["hz"]))
        if len(set(frames))!=1 or frames[0]!=stage["declaredFrames"]:
            raise ValueError("Unsynchronized nominal LUT duration")
        passes.append(dict(passIndex=stage["pass"],hz=stage["hz"],frames=frames[0],
                           nominalMs=1000*frames[0]/stage["hz"],
                           selectedPixelsR22R23R24=stage["selectedPixelsR22R23R24"],
                           oldBlackToWhiteHeld=stage["oldBlackToWhiteHeld"],
                           outsideActivePixels=stage["outsideActive"],
                           levelFrameCountsByTable=counts))
    summary[name]=dict(transitionMatrix=replay["windowTransitionMatrixWhiteBlackRed"],passes=passes)

a=profiles["Tail48"]["passes"][0]["tables"][2]
b=profiles["Neutral50"]["passes"][0]["tables"][2]
changes=[dict(offset=i,oldHex=f"{x:02x}",newHex=f"{y:02x}")
         for i,(x,y) in enumerate(zip(a,b)) if x!=y]
assert changes==[dict(offset=24,oldHex="b0",newHex="30"),
                 dict(offset=30,oldHex="b0",newHex="30")]
for pass_index in range(2):
    for table in range(5):
        if pass_index==0 and table==2:
            continue
        assert profiles["Tail48"]["passes"][pass_index]["tables"][table]==profiles["Neutral50"]["passes"][pass_index]["tables"][table]
a_levels,_=expand(a)
sa=profiles["Stagger51"]["passes"][0]["tables"][2]
sb=profiles["Stagger51"]["passes"][0]["tables"][4]
sa_levels,_=expand(sa)
sb_levels,_=expand(sb)
assert a_levels==sa_levels
comparison=dict(tail48ToNeutral50LutChanges=changes,
                tail48OtherTableBytesEqualNeutral50=True,
                staggerR22NominalCodesEqualTail48=(a_levels==sa_levels),
                staggerR22RawBytesEqualTail48=(a==sa),
                staggerGroupBUsesR24=True,
                staggerR24OpticalEquivalentProven=False,
                staggerSameFrameCodesDoesNotProvePhysicalPhaseEquivalence=True,
                factoryOtpUsedInReplay=False,
                opticalModelUsed=False,hardwareAccessed=False)
reference_path=args.sources.resolve()/"Tail48/firmware/experiments/epd-waveform-probe/waveform_data.h"
reference_text=reference_path.read_text(encoding="utf-8")
timing_text=re.search(r"probe_group_timing\[7\]\[5\]\s*=\s*\{(.*?)\n\};",reference_text,re.S).group(1)
numbers=[int(n,0) for n in re.findall(r"0x[0-9a-fA-F]+|\d+",timing_text)]
assert len(numbers)==35
groups=[numbers[i:i+5] for i in range(0,35,5)]
full_prefix=sum(sum(g[:4])*g[4] for g in groups[:4])
short_prefix=sum(sum(g[:4])*(g[4]//2 if i in (1,2,3) else g[4]) for i,g in enumerate(groups[:4]))
comparison.update(referenceFullPrefixFrames=full_prefix,referenceShortPrefixFrames=short_prefix,
                  maskCandidatePrefixFrames=122,referenceIsFactoryOtp=False)
assert (full_prefix,short_prefix)==(852,452)
out=dict(profiles=summary,comparison=comparison)
(root/"summary.json").write_text(json.dumps(out,indent=2)+"\n",encoding="utf-8")
with (root/"nominal-phase-timeline.csv").open("w",newline="",encoding="utf-8") as f:
    writer=csv.writer(f)
    writer.writerow(["profile","pass","LUT","group","repeat","phase","level_code",
                     "start_nominal_ms","end_nominal_ms"])
    writer.writerows(rows)
print(json.dumps(out))
