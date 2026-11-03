"""Compare optimized code/RO data with saved source trees, without ESP-IDF.

Run from an initialized MSVC x64 shell. This is a conservative host-object
estimate, not an Xtensa link/map or a claim about the final app partition.
"""
from pathlib import Path
import argparse, hashlib, json, re, shutil, struct, subprocess

def sections(path):
    data=path.read_bytes();_,count,_,_,_,optional,_=struct.unpack_from('<HHIIIHH',data)
    result=dict.fromkeys(['text','rdata','data','bss'],0)
    for i in range(count):
        at=20+optional+i*40;name=data[at:at+8].split(b'\0')[0].decode('ascii')
        size=struct.unpack_from('<I',data,at+16)[0]
        for kind in result:
            if name.startswith('.'+kind):result[kind]+=size
    return result

def main():
    ap=argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--baseline',required=True,type=Path)
    ap.add_argument('--previous',required=True,type=Path)
    ap.add_argument('--baseline-name',default='0.0.28',help='Identify the actual saved source tree')
    ap.add_argument('--output',required=True,type=Path)
    ap.add_argument('--wasm',type=Path)
    args=ap.parse_args();root=Path(__file__).resolve().parents[1];out=args.output.resolve()
    cl=shutil.which('cl.exe')
    if not cl:raise SystemExit('Run in the initialized MSVC x64 environment')
    summary={'method':'MSVC x64 /O1 /Gy COFF .text + .rdata, including compressed atlas exactly once','versions':{}}
    for label,tree in [(args.baseline_name,args.baseline.resolve()),('previous',args.previous.resolve()),('current',root)]:
        folder=out/label;folder.mkdir(parents=True,exist_ok=True)
        includes=[tree/'main',root/'preview/include',root/'tests/vendor/miniz',root/'managed_components/espressif__cjson/cJSON']
        units={}
        units_to_check=['display_text','quiet_dashboard','codepulse_protocol']
        if (tree/'main/life_dashboard.c').exists():units_to_check.append('life_dashboard')
        for unit in units_to_check:
            command=[cl,'/nologo','/std:c11','/utf-8','/O1','/Gy','/c','/D_CRT_SECURE_NO_WARNINGS',
                     *['/I'+str(p) for p in includes],str(tree/f'main/{unit}.c'),'/Fo:'+unit+'.obj']
            result=subprocess.run(command,cwd=folder,stdout=subprocess.PIPE,stderr=subprocess.STDOUT)
            if result.returncode:raise RuntimeError(result.stdout.decode(errors='replace'))
            units[unit]=sections(folder/(unit+'.obj'))
        header=(tree/'main/display_font_data.h').read_text(encoding='utf-8')
        compressed=bytes(int(v,16) for v in re.findall(r'0x([0-9a-f]{2})',header.split('font_compressed[] = {')[1]))
        expanded=int(re.search(r'#define DISPLAY_FONT_ATLAS_SIZE (\d+)',header)[1])
        text=sum(u['text'] for u in units.values());ro=sum(u['rdata'] for u in units.values())
        entry={'atlasCompressed':len(compressed),'atlasExpanded':expanded,'units':units,'text':text,
               'rdata':ro,'rdataExcludingAtlas':ro-len(compressed),'combined':text+ro}
        wasm=args.wasm if label=='current' else next((p for p in [tree/'renderer.wasm',tree/'tmp/preview-out/renderer.wasm'] if p.exists()),None)
        if wasm:
            entry['wasmBytes']=wasm.stat().st_size
            entry['wasmSha256']=hashlib.sha256(wasm.read_bytes()).hexdigest()
        summary['versions'][label]=entry
    summary['method']='MSVC x64 /O1 /Gy COFF .text + .rdata; includes life renderer when present; each atlas counted once'
    versions=summary['versions'];delta=versions['current']['combined']-versions[args.baseline_name]['combined']
    summary['budget']={'limitDelta':-8192,'actualDelta':delta,'passed':delta<=-8192,
                       'expandedRamLimit':1086869,'expandedRamPassed':versions['current']['atlasExpanded']<=1086869}
    (out/'result.json').write_text(json.dumps(summary,indent=2)+'\n',encoding='utf-8')
    for label,v in versions.items():print(label,': compressed',v['atlasCompressed'],'expanded',v['atlasExpanded'],'text+RO',v['combined'])
    print('Current minus '+args.baseline_name+':',delta,'bytes; budget',summary['budget'])
    if not all(summary['budget'][k] for k in ['passed','expandedRamPassed']):raise SystemExit('Font/code budget failed')

if __name__=='__main__':main()
