"""Build the production C renderer for desktop without ESP-IDF or a device.

python scripts/build-preview.py --zig /path/to/zig --output /output/directory
Pinned toolchain: Zig 0.13.0 (bundled Clang/WASI libc). Only compiler output is
shipped; no Zig/WASI installation is required on the user's desktop.
"""
from pathlib import Path
import sys
import argparse,base64,hashlib,json,os,re,subprocess,runpy,textwrap

def code_notices(root,cjson):
    # The Wasm also compiles miniz (tinfl) and cJSON; both are MIT and need their notices.
    miniz=(root/'tests/vendor/miniz/LICENSE').read_text(encoding='utf-8').strip()
    comment=re.match(r'\s*/\*(.*?)\*/',(cjson/'cJSON.c').read_text(encoding='utf-8'),re.S)
    if not comment or 'Permission is hereby granted' not in comment[1]:raise SystemExit('cJSON.c lacks its license header')
    parts=['','='*72,'Other third-party code compiled into the device preview renderer',
           '','='*72,'miniz (tinfl decompressor)','',miniz,
           '','='*72,'cJSON','',textwrap.dedent(comment[1]).strip()]
    return '\n'.join(parts)+'\n'

def card_notice(root):
    # The reading cards' 32px strike is a bitmap derivative of Noto Sans SC Regular.
    fonts=json.loads((root/'fonts/sources/noto-sources.json').read_text(encoding='utf-8'))
    font=next(f for f in fonts if f['name']=='Noto Sans SC Regular')
    masks=json.loads((root/'fonts/sources/card-hero-masks.json').read_text(encoding='utf-8'))
    if masks['sha256']!=font['sha256']:raise SystemExit('Card hero strike source does not match noto-sources.json')
    parts=['','='*72,font['name']+' '+font['version']+' (native 32px reading-card strike)',font['copyright'],
           'Source: '+font['url'],'Stored source: '+font['path'],'Stored source SHA-256: '+font['sha256']]
    for license in font['licenses']:
        data=(root/license['path']).read_bytes()
        if hashlib.sha256(data).hexdigest()!=license['sha256']:raise SystemExit('license hash')
        parts+=['',data.decode('utf-8')]
    return '\n'.join(parts)+'\n'

def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--zig',required=True)
    parser.add_argument('--output',required=True,type=Path)
    parser.add_argument('--cjson',type=Path)
    args=parser.parse_args()
    root=Path(__file__).resolve().parents[1]
    subprocess.run([sys.executable,str(root/'scripts/generate-life-assets.py'),'--check'],check=True)
    subprocess.run([sys.executable,str(root/'scripts/generate-card-hero.py'),'--check'],check=True)
    zig=str(Path(args.zig).resolve())
    version=subprocess.check_output([zig,'version'],text=True).strip()
    if version!='0.13.0':raise SystemExit('Expected Zig 0.13.0, got '+version)
    out=args.output.resolve();out.mkdir(parents=True,exist_ok=True)
    cjson=(args.cjson or root/'managed_components/espressif__cjson/cJSON').resolve()
    sources=[root/p for p in ['preview/renderer.c','main/codepulse_protocol.c',
      'main/quiet_dashboard.c','main/life_dashboard.c','main/display_text.c','main/epd_canvas.c',
      'tests/vendor/miniz/miniz_tinfl.c']]+[cjson/'cJSON.c']
    includes=[root/'main',root/'preview/include',root/'tests/vendor/miniz',cjson]
    exports=['preview_input','preview_capacity','preview_frame','preview_red_frame','preview_size','preview_render']
    env=os.environ.copy();env['ZIG_GLOBAL_CACHE_DIR']=str(out/'cache')
    command=[zig,'cc','-target','wasm32-wasi','-mexec-model=reactor','-Os',
      '-DNDEBUG','-DMINIZ_NO_STDIO','-DMINIZ_NO_TIME','-std=c11',
      '-Wl,--initial-memory=0x400000','-Wl,--max-memory=0x1000000','-Wl,-z,stack-size=131072',
      *['-Wl,--export='+name for name in exports],*['-I'+str(p) for p in includes],
      *map(str,sources),'-o',str(out/'renderer.wasm')]
    subprocess.run(command,check=True,env=env)
    (out/'renderer.b64').write_text(base64.b64encode((out/'renderer.wasm').read_bytes()).decode('ascii'),encoding='ascii')
    files=set(sources)
    files.update((root/'main').glob('*.h'))
    files.update((root/'preview/include').rglob('*.h'))
    files.update((root/'tests/vendor/miniz').glob('*.h'))
    files.update(cjson.glob('*.h'))
    files.add(Path(__file__))
    # Text provenance pins the raw font/license bytes without applying LF
    # normalization to compressed inputs. The generator validates those pins.
    for name in ['scripts/generate-display-font.py','scripts/generate-hierarchy-font.py',
                 'scripts/generate-native-font-masks.py','scripts/font-spacing.py','fonts/SOURCE.txt',
                 'scripts/generate-calendar-font-charset.mjs','fonts/sources/calendar-charset.json',
                 'fonts/sources/font-grid-sources.json','fonts/sources/grid-native-masks.json','fonts/sources/font-grid-fallbacks.json',
                 'fonts/sources/native-hierarchy.json']:
        files.add(root/name)
    for name in ['scripts/generate-life-assets.py','preview/life-icons.json','fonts/sources/life-assets.json','fonts/licenses/Terminus-OFL.txt',
                 'scripts/generate-card-hero.py','fonts/sources/card-hero-charset.txt','fonts/sources/card-hero-masks.json','fonts/licenses/NotoSansSC-2.004-OFL.txt','fonts/sources/noto-sources.json']:
        files.add(root/name)
    fonts=json.loads((root/'fonts/sources/font-grid-sources.json').read_text(encoding='utf-8'))
    for font in fonts:
        files.update(root/license['path'] for license in font['licenses'])
    generator=runpy.run_path(str(root/'scripts/generate-hierarchy-font.py'))
    (out/'THIRD-PARTY-FONTS.txt').write_text(generator['third_party_text'](root)+card_notice(root)+code_notices(root,cjson),encoding='utf-8',newline='\n')
    files.add(root/'tests/vendor/miniz/LICENSE')
    hashes={str(p.relative_to(root)).replace('\\','/'):hashlib.sha256(p.read_bytes().replace(b'\r\n',b'\n')).hexdigest()
      for p in files if p.is_relative_to(root)}
    # cJSON may be supplied from a local dependency checkout when staging.
    for p in [cjson/'cJSON.c',*cjson.glob('*.h')]:
        hashes['managed_components/espressif__cjson/cJSON/'+p.name]=hashlib.sha256(p.read_bytes().replace(b'\r\n',b'\n')).hexdigest()
    version=re.search(r'else\(\)\s*set\(PROJECT_VER "([^"]+)"\)',(root/'CMakeLists.txt').read_text(encoding='utf-8'))[1]
    manifest={'firmwareVersion':version,'width':400,'height':300,
      'sourceHashFormat':'sha256-text-lf',
      'compiler':'Zig 0.13.0 / Clang WASI','sources':dict(sorted(hashes.items())),
      'wasmSha256':hashlib.sha256((out/'renderer.wasm').read_bytes()).hexdigest()}
    (out/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n',encoding='utf-8',newline='\n')
    print('Built shared 400x300 renderer:',(out/'renderer.wasm').stat().st_size,'bytes')

if __name__=='__main__':main()
