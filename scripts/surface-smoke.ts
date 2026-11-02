import { app, BrowserWindow, ipcMain, nativeImage, screen as screenApi } from 'electron'
import { resolve, join } from 'node:path'
import { mkdirSync, writeFileSync, readFileSync, appendFileSync } from 'node:fs'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { createDeviceRenderer, frameToRgba } from '../apps/desktop/src/renderer/src/device-preview/renderer.mjs'
import { StatusHub } from '@codepulse/core'
import { DEFAULT_AMBIENT, DEFAULT_DEVICE_DISPLAY, normalizeDeviceDisplay, normalizeShellPreferences, type DeviceDisplayConfig } from '@codepulse/shared'
import { ProductShell, shellPreferenceStore } from '../apps/desktop/src/main/product-shell.js'
import { registerProductIpc } from '../apps/desktop/src/main/product-ipc.js'
import { ScreenWorkbenchWindow } from '../apps/desktop/src/main/screen-workbench-window.js'
import { AmbientService } from '../apps/desktop/src/main/ambient-service.js'
import { createAmbientRuntime } from '../apps/desktop/src/main/ambient-runtime.js'
import { registerAmbientIpc } from '../apps/desktop/src/main/ambient-ipc.js'
import { withAmbient } from '../apps/desktop/src/main/ambient-rules.js'
import { HudSurface } from '../apps/desktop/src/main/hud-surface.js'
import { createDeviceDisplayProjector } from '../apps/desktop/src/main/device-display-projection.js'
import { AssistantStore } from '../apps/desktop/src/main/assistant-store.js'
import { AssistantService } from '../apps/desktop/src/main/assistant-service.js'
import { LumaAssistantProvider } from '../apps/desktop/src/main/assistant-provider.js'
import { registerAssistantIpc } from '../apps/desktop/src/main/assistant-ipc.js'
import { inkFeatureAt } from '../apps/desktop/src/main/ambient-plan.js'
import { selectDeskContent } from '../apps/desktop/src/main/assistant-presentation.js'
import { computeInkStatus } from '../apps/desktop/src/main/ink-status.js'
import { applyInk, endInkTemporary } from '../apps/desktop/src/main/ink-apply.js'

const output = resolve('.tmpshots/surface-smoke', process.env.CODEPULSE_SMOKE_RUN ?? 'local')
mkdirSync(output,{recursive:true}); app.setPath('userData',join(output,'profile'))
app.disableHardwareAcceleration() // Isolated software rendering gives fresh hidden-window captures.
const errors: string[] = [], visible = new Map<number,boolean>()
const wait = (ms=200) => new Promise(r=>setTimeout(r,ms))
const deadline = setTimeout(()=>{writeFileSync(join(output,'failure.txt'),'timeout');app.exit(1)},120000)
app.on('browser-window-created',(_e,win)=>{
  // Exercise real window constructors and renderers without showing test windows.
  win.show=()=>{visible.set(win.id,true)}; win.showInactive=()=>{visible.set(win.id,true)}
  win.hide=()=>{visible.set(win.id,false)}
  win.isVisible=()=>visible.get(win.id) ?? false
  win.webContents.setBackgroundThrottling(false)
  win.webContents.on('console-message',(_e,level,message)=>{if(level>=3)errors.push(message)})
})
async function until(check:()=>boolean|Promise<boolean>, description:string) {
  for(let i=0;i<100;i++){if(await check())return;await wait(80)}
  throw new Error('Timeout: '+description)
}
async function click(win: BrowserWindow, selector: string) {
  assert.ok(await win.webContents.executeJavaScript(`Boolean(document.querySelector(${JSON.stringify(selector)}))`),selector)
  await win.webContents.executeJavaScript(`document.querySelector(${JSON.stringify(selector)}).click()`); await wait()
}
async function button(win: BrowserWindow, label: string) {
  const code=`(()=>{const b=Array.from(document.querySelectorAll('button')).find(b=>b.getClientRects().length && !b.disabled && b.textContent.trim()===${JSON.stringify(label)});if(!b)throw Error(${JSON.stringify('Missing button: '+label)});b.click()})()`
  await win.webContents.executeJavaScript(code);await wait()
}
// A device pixel must cover a whole number (>= minK) of physical pixels, or 1px strokes blur unevenly.
// The canvas must also start on a physical pixel (layout units are 1/64 css px, so allow 0.03), or it paints 400k+-1 wide.
function assertWholePixels([width,height]: number[], dpr: number, minK: number, message: string, [left,top]: number[] = []) {
  const k = width!*dpr/400
  assert.ok(Math.abs(k-Math.round(k))<0.01 && Math.round(k)>=minK, `${message}: ${width}x${height} css at dpr ${dpr}`)
  assert.ok(Math.abs(height!*dpr-300*Math.round(k))<0.01, `${message}: height ${height} css at dpr ${dpr}`)
  for (const edge of [left,top]) if (edge !== undefined) assert.ok(Math.abs(edge*dpr-Math.round(edge*dpr))<0.03, `${message}: canvas origin ${left},${top} css at dpr ${dpr}`)
}
// k of a measured canvas, for the readability checks.
const pixelRatio = ([width]: number[], dpr: number) => Math.round(width!*dpr/400)
app.whenReady().then(async()=>{
  try {
    // This harness never calls bootstrap/startLocalServer or modifies real hooks.
    const sqlite = new Database(join(output, 'smoke.sqlite'))
    sqlite.exec('CREATE TABLE IF NOT EXISTS smoke (value TEXT)')
    sqlite.prepare('INSERT INTO smoke VALUES (?)').run('isolated')
    assert.equal(sqlite.prepare('SELECT value FROM smoke LIMIT 1').get().value, 'isolated')
    sqlite.close()
    const hub = new StatusHub()
    hub.ingest({id:'shell-fixture',source:'codex',eventType:'session_start',externalSessionId:'shell-ui',workspacePath:'F:/example/codepulse',timestamp:Date.now()})
    const before=JSON.stringify(hub.snapshot().agents)
    let config: DeviceDisplayConfig={...DEFAULT_DEVICE_DISPLAY,agents:[...DEFAULT_DEVICE_DISPLAY.agents]}
    let main: BrowserWindow | undefined
    const host=resolve(process.env.CODEPULSE_SMOKE_ASSETS ?? 'apps/desktop')
    const broadcast=(channel:string,payload:unknown)=>BrowserWindow.getAllWindows().forEach(w=>w.webContents.send(channel,payload))
    let publishInk = () => {}
    let product: ProductShell
    const hud=new HudSurface(hub,join(host,'out/hud'),join(output,'hud-workspaces.json'),()=>product?.refresh());hud.registerIpc()
    const screen=new ScreenWorkbenchWindow({preload:join(host,'out/preload/index.js'),renderer:join(host,'out/renderer/index.html'),icon:join(host,'build/icon.png')})
    writeFileSync(join(output,'window-state.log'),'')
    const configure=screen.configure.bind(screen)
    screen.configure=(id,input)=>{const before=screen.state();const result=configure(id,input);appendFileSync(join(output,'window-state.log'),JSON.stringify({id,input,before,result})+'\n');return result}
    const store=shellPreferenceStore(join(output,'product-shell.json'));store.write(normalizeShellPreferences({version:1,form:'standard',view:'overview'}))
    product=new ProductShell(store.read(),store.write,{hudAvailable:()=>true,hudVisible:()=>hud.isVisible(),standard:()=>main?.show(),hud:()=>hud.open(main?.getBounds()),screen:()=>screen.open(),hideStandard:()=>main?.hide(),hideHud:()=>hud.hide()},s=>{broadcast('codepulse:shell-status',s);publishInk()})
    let targetDelay = 0, failTarget: string | undefined
    registerProductIpc({ handle(channel, listener) {
      ipcMain.handle(channel, async (event, ...args) => {
        if (channel === 'codepulse:shell-target') {
          if (targetDelay) await wait(targetDelay)
          if (args[0] === failTarget) throw Error('TEST FIXTURE: preference write failed')
        }
        return listener(event, ...args)
      })
    } },product,screen,plan=>applyInk({plan,display:config},inkApplyDependencies).shell)
    const previewReads: Record<string, number> = {}
    const measuredIpc = { handle(channel: string, listener: (...args: any[]) => any) {
      ipcMain.handle(channel, (...args) => {
        previewReads[channel] = (previewReads[channel] ?? 0) + 1
        return listener(...args)
      })
    } }
    const readCount = (name: string) => previewReads['codepulse:' + name] ?? 0
    const ambient=new AmbientService({
      config:{...DEFAULT_AMBIENT,enabled:false,xEnabled:true,memeEnabled:false,calendarEnabled:false,quietStart:0,quietEnd:0,idleOnly:false},
      status:()=>hub.snapshot(),key:()=> 'fixture-key',save:()=>{},changed:()=>{broadcast('codepulse:ambient-status',ambient.snapshot());publishInk()},
      plan:()=>product.snapshot().inkPlan, automaticAllowed:()=>inkFeatureAt(product.snapshot().inkPlan,Date.now())==='ambient',
      request:async()=>({tweets:[{id:'12345',author:{userName:'Polymarket'},text:'TEST FIXTURE — this is a screen integration test, not a real news post.',createdAt:new Date().toISOString(),likeCount:9000}]}),image:async()=>'',
    })
    const projector=createDeviceDisplayProjector(join(output,'device-order.json'))
    const assistantStore=new AssistantStore(join(output,'assistant.sqlite'))
    const assistant=new AssistantService({store:assistantStore,keys:()=>({llmKey:'',speechAppKey:'',speechToken:''}),
      provider:new LumaAssistantProvider(()=>({llmKey:'',speechAppKey:'',speechToken:''}),async()=>{throw Error('No external calls in UI fixtures')}),
      save:()=>{},changed:()=>{broadcast('codepulse:assistant-status',assistant.snapshot());publishInk()},notify:()=>false,
      automaticAllowed:()=>inkFeatureAt(product.snapshot().inkPlan,Date.now())==='todos'})
    const device=(draft?:DeviceDisplayConfig)=>({config,status:withAmbient(projector(hud.snapshot(),draft??config),draft?undefined:selectDeskContent(assistant.inkCard(hud.snapshot()),ambient.current())),serverAvailable:false})
    // A synthetic authenticated device exercises connected drafts without binding a server.
    const inkSnapshot=()=>computeInkStatus({plan:product.snapshot().inkPlan,now:Date.now(),lastSeenAt:Date.now(),serverEnabled:true,
      projected:device().status,ambientTemporary:ambient.temporaryInk(),assistantUntil:assistant.temporaryInkUntil(),
      ambientPausedReason:ambient.snapshot().pausedReason,nextAutoAt:ambient.nextAutoAt()})
    publishInk=()=>{broadcast('codepulse:ink-status',inkSnapshot());broadcast('codepulse:device-display',device())}
    const inkApplyDependencies={shell:product,ambient,readDisplay:()=>config,writeDisplay:(next:DeviceDisplayConfig)=>{config=next},displaySnapshot:()=>device(),
      committed:()=>{broadcast('codepulse:shell-status',product.snapshot());broadcast('codepulse:ambient-status',ambient.snapshot());publishInk()}}
    registerAssistantIpc(measuredIpc,()=>({service:assistant,setKey:()=>assistant.snapshot(),close:()=>{assistant.stop();assistantStore.close()}}),()=>device().status,()=>ambient.dismiss())
    const imageDir = join(output, 'image-library'); mkdirSync(imageDir, { recursive: true })
    const imageRuntime = createAmbientRuntime(imageDir, { status: () => hub.snapshot(), changed: () => {} })
    registerAmbientIpc(measuredIpc,{service:ambient,setKey:()=>ambient.snapshot(),importImage:(bytes,name)=>{const card=imageRuntime.importImage(bytes,name);return ambient.addPersonal('image',card.text,card.imageHex)}},()=>device().status,async()=>{},()=>assistant.clearTemporaryInk())
    const handlers: Record<string, (...args:any[])=>any>={
      'ink-status-get':()=>inkSnapshot(),'ink-apply':(_e,request)=>applyInk(request,inkApplyDependencies),
      'ink-temporary-end':()=>{endInkTemporary(ambient,assistant);publishInk();return inkSnapshot()},
      'get-status':(event)=>hud.owns(event.sender)?hud.snapshot():hub.snapshot(),'sync-sessions':(event)=>hud.owns(event.sender)?hud.snapshot():hub.snapshot(),
      'detect-agents':()=>[],'get-update':()=>null,'get-version':()=> '1.4.11','get-notifications':()=>false,'set-notifications':(_e,v)=>v,
      'hud-preview':()=>hud.snapshot(),'get-usage':()=>null,'mimo-login-status':()=>false,'set-locale':(_e,v)=>v,'set-window-theme':(_e,v)=>v,
      'get-device-display':(_e,draft)=>device(draft),'set-device-display':(_e,value)=>{config=normalizeDeviceDisplay(value);const next=device();broadcast('codepulse:device-display',next);return next},
      'get-device-provisioning':()=>({serverAvailable:false,scanning:false,devices:[],displays:[],phase:'idle',updatedAt:Date.now()}),
      'start-device-scan':()=>({serverAvailable:false,scanning:false,devices:[],displays:[],phase:'idle',updatedAt:Date.now()}),
      'stop-device-scan':()=>({serverAvailable:false,scanning:false,devices:[],displays:[],phase:'idle',updatedAt:Date.now()}),
      'ack':()=>{throw Error('A presentation action must not acknowledge tasks')},
    }
    for(const [name,run]of Object.entries(handlers))measuredIpc.handle('codepulse:'+name,run)
    main=new BrowserWindow({show:false,frame:false,width:1120,height:780,webPreferences:{preload:join(host,'out/preload/index.js'),sandbox:false,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false,offscreen:true}})
    await main.loadFile(join(host,'out/renderer/index.html'));await wait(700);product.restore()
    await until(()=>main!.webContents.executeJavaScript(`Boolean(document.querySelector('.product-control'))`),'control')
    // Text-based fixtures explicitly choose Chinese; CI may run an English OS.
    // This writes only the disposable profile, never the user's saved language.
    await main.webContents.executeJavaScript(`localStorage.setItem('codepulse:locale','zh')`)
    await main.loadFile(join(host,'out/renderer/index.html'))
    await until(()=>main!.webContents.executeJavaScript(`Boolean(document.querySelector('.product-control'))`),'Chinese control reload')
    assert.ok(await main.webContents.executeJavaScript(`document.querySelector('[data-view=control]').textContent.includes('控制')`),'Chinese fixture locale')
    assert.equal(product.snapshot().view,'control','legacy overview migrates to control')
    assert.equal(await main.webContents.executeJavaScript(`Boolean(document.querySelector('.product-topbar'))`),false)
    await main.webContents.executeJavaScript(`localStorage.setItem('codepulse:dashboard-settings',JSON.stringify({...JSON.parse(localStorage.getItem('codepulse:dashboard-settings')||'{}'),theme:'light'}))`)
    await main.webContents.reload(); await wait(900)
    await until(()=>main!.webContents.executeJavaScript(`Boolean(document.querySelector('.product-control'))`),'control reload')
    const capture=async(name:string)=>{await wait(350);writeFileSync(join(output,name+'.png'),(await main!.webContents.capturePage()).toPNG())}
    // Every physical pixel under the preview canvas, edges included, must be paper, ink or red:
    // a fractional canvas size or phase resamples the last row/column into blends like #E1AFB1.
    const assertCanvasPure=async(label:string,selector='.ambient-panel .device-preview canvas.device-screen')=>{
      await main!.webContents.executeJavaScript(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'center',inline:'center'})`);await wait(400)
      const box=await main!.webContents.executeJavaScript(`(()=>{const c=document.querySelector(${JSON.stringify(selector)});c.scrollIntoView({block:'center',inline:'center'});const r=c.getBoundingClientRect();return {x:r.left,y:r.top,w:r.width,h:r.height,dpr:window.devicePixelRatio}})()`) as {x:number;y:number;w:number;h:number;dpr:number}
      const image=await main!.webContents.capturePage(), size=image.getSize(), bitmap=image.toBitmap()
      const left=Math.round(box.x*box.dpr), top=Math.round(box.y*box.dpr), width=Math.round(box.w*box.dpr), height=Math.round(box.h*box.dpr)
      assert.ok(left>=0&&top>=0&&left+width<=size.width&&top+height<=size.height,label+': canvas is inside the capture '+JSON.stringify({box,size}))
      const colours=new Map<string,number>(), bad=new Map<string,string>()
      for(let y=top;y<top+height;y++)for(let x=left;x<left+width;x++){
        const i=(y*size.width+x)*4, key=[bitmap[i+2],bitmap[i+1],bitmap[i]].map(v=>v!.toString(16).padStart(2,'0')).join('')
        colours.set(key,(colours.get(key)??0)+1)
        if(!['ffffff','000000','be1e2d'].includes(key)&&bad.size<6)bad.set(key,`${x-left},${y-top}`)
      }
      if(bad.size)writeFileSync(join(output,'canvas-edge-'+label.replace(/\W+/g,'-')+'.png'),image.toPNG())
      assert.equal(bad.size,0,label+': canvas pixels outside {white, black, red} at dpr '+box.dpr+' css '+box.w+'x'+box.h+' (first at x,y): '+JSON.stringify([...bad])+' box '+JSON.stringify({left,top,width,height,size}))
    }
    await capture('control-desktop')
    // The e-ink state lives in one sidebar pill; there is no banner and no live-console footer.
    assert.equal(await main.webContents.executeJavaScript(`Boolean(document.querySelector('.ink-status, .ink-status-slot'))`),false,'no status banner')
    assert.match(await main.webContents.executeJavaScript(`document.querySelector('.product-rail .ink-pill-main')?.textContent??''`),/墨水屏/,'sidebar pill shows the e-ink state')
    assert.equal(await main.webContents.executeJavaScript(`document.body.innerText.includes('助手分屏')||document.body.innerText.includes('本地服务')`),false,'footer strip and rail caption are gone')
    // Desktop has one live workbench and one focus entry; the stored layout stays compatible.
    assert.equal(await main.webContents.executeJavaScript(`Array.from(document.querySelectorAll('.product-control button')).filter(b=>b.textContent.includes('功能平铺')).length`),0)
    assert.equal(await main.webContents.executeJavaScript(`document.querySelectorAll('.product-control .page-header button').length`),1)
    await button(main,'专注模式')
    assert.equal(product.snapshot().focusMode,true)
    assert.equal(await main.webContents.executeJavaScript(`getComputedStyle(document.querySelector('.product-rail')).display`),'none')
    assert.ok(await main.webContents.executeJavaScript(`document.querySelector('.product-live-console').getClientRects().length > 0`))
    await capture('focus')
    assert.equal(await main.webContents.executeJavaScript(`document.body.innerText.includes('助手分屏')`),false,'focus mode has no footer strip')
    await button(main,'返回控制台')
    assert.equal(product.snapshot().focusMode,false)
    assert.equal(product.snapshot().desktopLayout,'work')
    assert.ok(await main.webContents.executeJavaScript(`Boolean(document.querySelector('.product-console-live-stage'))`))
    await click(main,'[data-view=usage]')
    assert.ok(await main.webContents.executeJavaScript(`document.body.textContent.includes('暂无可用的历史统计')`))
    assert.equal(await main.webContents.executeJavaScript(`document.querySelectorAll('.product-targets').length`),0)
    await click(main,'[data-view=control]');await click(main,'#endpoint-ink')
    await until(()=>main!.webContents.executeJavaScript(`document.querySelector('.product-control .device-preview')?.getAttribute('data-render-state')==='ready'`),'ink draft preview')
    const previewWidth=await main.webContents.executeJavaScript(`document.querySelector('.product-control .device-preview canvas').getBoundingClientRect().width`)
    assert.ok(previewWidth>0,'preview is shown at default window size')
    const layouts: unknown[] = []
    const geometry = () => main!.webContents.executeJavaScript(`(() => {
      const control = document.querySelector('.product-control');
      const stage = document.querySelector('.ink-control-workspace .product-preview-stage');
      const canvas = stage.querySelector('.device-preview-scroll canvas').getBoundingClientRect();
      const apply = document.querySelector('.ink-config .product-config-actions').getBoundingClientRect();
      return {viewport: [innerWidth,innerHeight], dpr: devicePixelRatio, canvas: [canvas.width,canvas.height], origin: [canvas.left,canvas.top],
        canvasBottom: canvas.bottom, applyBottom: apply.bottom, applyTop: apply.top,
        pageOverflow: control.scrollHeight-control.clientHeight,
        previewOverflow: stage.scrollHeight-stage.clientHeight,
        configOverflow: document.querySelector('.ink-config').scrollHeight-document.querySelector('.ink-config').clientHeight,
        horizontalOverflow: document.documentElement.scrollWidth-innerWidth};
    })()`)
    for (const [width,height] of [[1120,780],[1366,900],[1440,900],[1600,1000],[1000,720]]) {
      main.setContentSize(width!,height!); await wait(250)
      const measured = await geometry(); layouts.push(measured)
      assertWholePixels(measured.canvas as number[],measured.dpr as number,1,'resizing keeps whole physical pixels per device pixel',measured.origin as number[])
      if(width===1440) assert.equal(pixelRatio(measured.canvas as number[],measured.dpr as number),Math.max(1,Math.round(measured.dpr as number)),'1440x900 reaches the preferred 1:k scale')
      assert.ok(measured.previewOverflow <= 1,JSON.stringify(measured))
      if(width! >= 1120) assert.ok(measured.configOverflow <= 1,JSON.stringify(measured))
      assert.equal(await main.webContents.executeJavaScript(`getComputedStyle(document.querySelector('.ink-config .product-config-actions')).position`),'static','apply stays in document flow')
      await main.webContents.executeJavaScript(`document.querySelector('.ink-config .product-config-actions').scrollIntoView({block:'end'})`)
      assert.ok(await main.webContents.executeJavaScript(`document.querySelector('.ink-config .product-config-actions').getBoundingClientRect().bottom<=innerHeight+1`),'apply footer is reachable by scrolling')
      await main.webContents.executeJavaScript(`document.querySelector('.product-control').scrollTop=0`)
      assert.equal(measured.horizontalOverflow,0)
      await capture('ink-'+width+'x'+height)
    }
    main.setContentSize(1120,780); await wait(250)
    {
      // Give the preferred integer scale enough width, then bound the stage's height.
      // Closing the actual options disclosure must lift that height cap without resizing the host.
      const scale = async () => { const m = await geometry(); return {k: pixelRatio(m.canvas as number[],m.dpr as number), m} }
      const originalZoom = main.webContents.getZoomFactor()
      const originalDpr = await main.webContents.executeJavaScript('devicePixelRatio') as number
      const stageStyle = await main.webContents.executeJavaScript(`document.querySelector('.ink-preview-card').style.cssText`) as string
      try {
        main.setContentSize(1600,1000)
        main.webContents.setZoomFactor(originalZoom * 2 / originalDpr)
        await wait(350)
        await main.webContents.executeJavaScript(`document.querySelector('.ink-preview-options').open=true`)
        await wait(350)
        const natural = await scale(), preferred = Math.round(natural.m.dpr as number)
        assert.ok(preferred>=2,'fixture must have two or more available integer scales')
        assert.equal(natural.k,preferred,'width allows the preferred scale before applying a height cap')
        await main.webContents.executeJavaScript(`(() => {
          const stage=document.querySelector('.ink-preview-card');
          const height=stage.getBoundingClientRect().height;
          stage.style.boxSizing='border-box';stage.style.height=(height-150/devicePixelRatio)+'px';
          stage.style.overflow='hidden';
        })()`)
        await until(async()=>(await scale()).k<preferred,'bounded stage caps the preferred preview')
        const before = await scale()
        await main.webContents.executeJavaScript(`document.querySelector('.ink-preview-options').open=false`)
        await wait(350)
        const roomy = await scale()
        writeFileSync(join(output,'cap-lift.json'),JSON.stringify({natural,before,roomy,preferred},null,2))
        assert.equal(roomy.k,preferred,'closing options restores the preferred integer scale: '+JSON.stringify([before.k,roomy.k]))
        assert.ok(roomy.k>before.k,'cap lifting must actually increase the scale')
        assert.ok((roomy.m.previewOverflow as number)<=1,JSON.stringify(roomy.m))
        await main.webContents.executeJavaScript(`document.querySelector('.ink-preview-options').open=true`)
        await until(async()=>(await scale()).k===before.k,'reopening options restores the height cap')
        const back=await scale()
        assert.ok((back.m.previewOverflow as number)<=1,JSON.stringify(back.m))
        for(const measured of [before.m,roomy.m,back.m]) assertWholePixels(measured.canvas as number[],measured.dpr as number,1,'height cap preserves whole physical pixels',measured.origin as number[])
        writeFileSync(join(output,'cap-lift.json'),JSON.stringify({natural,before,roomy,back,preferred},null,2))
      } finally {
        await main.webContents.executeJavaScript(`document.querySelector('.ink-preview-card').style.cssText=${JSON.stringify(stageStyle)};document.querySelector('.ink-preview-options').open=false`)
        main.webContents.setZoomFactor(originalZoom)
        main.setContentSize(1120,780)
        await wait(350)
      }
    }
    for (const zoom of [1.25,1.5,2,1]) {
      main.webContents.setZoomFactor(zoom); await wait(300)
      const measured = await geometry(); layouts.push(measured)
      assertWholePixels(measured.canvas as number[],measured.dpr as number,1,`zoom ${zoom} keeps whole physical pixels`,measured.origin as number[])
      assert.equal(measured.horizontalOverflow,0,JSON.stringify(measured))
      assert.ok(measured.previewOverflow <= 1,JSON.stringify(measured))
      // Below 900 CSS px the control page stacks and scrolls as a whole, by design.
      assert.equal(measured.configOverflow,0,'the playlist does not clip content behind a sticky footer')
    }
    await wait(250)
    assert.equal(await main.webContents.executeJavaScript(`document.querySelector('.ink-preview-options').open`),false,'preview options start collapsed')
    await click(main,'.ink-preview-options > summary')
    const beforeInspect = JSON.stringify(config)
    await button(main,'2 倍检查')
    assert.ok(await main.webContents.executeJavaScript(`Boolean(document.querySelector('.ink-control-workspace dialog[open]'))`))
    const inspectSize=await main.webContents.executeJavaScript(`(() => { const r=document.querySelector('dialog[open] canvas').getBoundingClientRect(); return [r.width,r.height] })()`)
    assertWholePixels(inspectSize,await main.webContents.executeJavaScript('devicePixelRatio'),2,'inspection uses a deliberate whole-pixel zoom of at least 2x')
    assert.equal(await main.webContents.executeJavaScript(`document.querySelector('.ink-control-workspace .device-preview-scroll canvas').toDataURL() === document.querySelector('dialog[open] canvas').toDataURL()`),true,'both views use identical source pixels')
    await capture('ink-inspector')
    await button(main,'关闭检查')
    assert.equal(await main.webContents.executeJavaScript(`document.querySelectorAll('dialog[open]').length`),0)
    assert.equal(await main.webContents.executeJavaScript(`document.activeElement?.textContent`),'2 倍检查','inspection restores keyboard focus')
    assert.equal(JSON.stringify(config),beforeInspect,'inspection never applies device settings')
    await click(main,'.ink-work-options summary')
    const normalPixels = await main.webContents.executeJavaScript(`Array.from(document.querySelector('.ink-control-workspace .device-preview-scroll canvas').getContext('2d').getImageData(0,0,400,300).data)`)
    await main.webContents.executeJavaScript(`Array.from(document.querySelectorAll('.ink-config label')).find(l=>l.textContent.includes('反色显示')).querySelector('input').click()`)
    assert.equal(config.inverted,false,'connected changes stay drafts')
    assert.deepEqual(await main.webContents.executeJavaScript(`Array.from(document.querySelector('.ink-control-workspace .device-preview-scroll canvas').getContext('2d').getImageData(0,0,400,300).data)`),normalPixels,'live preview keeps the applied target')
    await button(main,'应用到设备')
    await until(()=>main!.webContents.executeJavaScript(`document.querySelector('.ink-control-workspace .device-preview-scroll canvas').getContext('2d').getImageData(0,0,1,1).data[0]===0`),'applied inverted pixels')
    const invertedPixels = await main.webContents.executeJavaScript(`Array.from(document.querySelector('.ink-control-workspace .device-preview-scroll canvas').getContext('2d').getImageData(0,0,400,300).data)`)
    assert.deepEqual(invertedPixels, normalPixels.map((v:number,i:number)=>i%4===3?v:255-v),'apply updates the production pixels')
    await capture('ink-inverted')
    await main.webContents.executeJavaScript(`Array.from(document.querySelectorAll('.ink-config label')).find(l=>l.textContent.includes('反色显示')).querySelector('input').click()`)
    await button(main,'应用到设备')
    const beforeSamples=JSON.stringify(config)
    await button(main,'9 任务')
    assert.equal(await main.webContents.executeJavaScript(`document.querySelector('.ink-preview-caption').textContent`),'样例 · 不是设备画面')
    assert.equal(JSON.stringify(config),beforeSamples,'sample selection never applies synthetic content')
    await capture('ink-dense')
    await button(main,'2 倍检查'); await capture('ink-dense-inspector')
    main.webContents.sendInputEvent({type:'keyDown',keyCode:'Escape'})
    await until(()=>main!.webContents.executeJavaScript(`document.querySelectorAll('dialog[open]').length===0`),'Escape closes the inspection')
    await button(main,'实时')
    writeFileSync(join(output,'layout.json'),JSON.stringify(layouts,null,2))
    await capture('control-ink')
    await button(main,'用量看板');assert.equal(config.mode,'hud')
    await button(main,'专注模式');await button(main,'返回控制台')
    assert.equal(product.snapshot().target,'ink')
    assert.ok(await main.webContents.executeJavaScript(`Array.from(document.querySelectorAll('.product-control .ink-config button')).some(b=>b.textContent==='用量看板' && b.getAttribute('aria-pressed')==='true')`))
    await button(main,'应用到设备');assert.equal(config.mode,'usage')
    await click(main,'#endpoint-hud')
    await until(()=>main!.webContents.executeJavaScript(`Boolean(document.querySelector('.product-control .hud-preview .project-deck-shell'))`),'real HUD preview')
    await capture('control-hud')
    // Only the visible preview consumes status updates. Keep the UI responsive while saving is slow.
    await wait(400)
    const inactiveReads = readCount('get-device-display'), ambientReads = readCount('ambient-get')
    for (let i = 0; i < 40; i++) broadcast('codepulse:status',hub.snapshot())
    await wait(400)
    assert.equal(readCount('get-device-display'),inactiveReads,'hidden ink never reads on agent events')
    assert.equal(readCount('ambient-get'),ambientReads,'agent events do not read content')
    targetDelay = 650
    await main.webContents.executeJavaScript("document.querySelector('#endpoint-ink').click()")
    await wait(100)
    assert.equal(product.snapshot().target,'hud','fixture save is still pending')
    assert.equal(await main.webContents.executeJavaScript("document.querySelector('#endpoint-ink').getAttribute('aria-selected')"),'true','tab selection paints before persistence completes')
    await until(()=>product.snapshot().target==='ink','delayed target saved'); await wait(300)
    targetDelay = 0
    await main.webContents.executeJavaScript(`(() => {
      const note = document.querySelector('.ink-control-workspace .device-preview-footnote');
      window.__previewNotes = [note.textContent];
      window.__previewObserver = new MutationObserver(() => window.__previewNotes.push(note.textContent));
      window.__previewObserver.observe(note, {subtree:true, childList:true, characterData:true});
    })()`)
    const activeReads = readCount('get-device-display'), contentReads = readCount('ambient-get')
    for (let i = 0; i < 40; i++) broadcast('codepulse:status',hub.snapshot())
    await wait(400)
    assert.equal(readCount('get-device-display')-activeReads,1,'burst of agent updates coalesces to one preview read')
    assert.equal(readCount('ambient-get'),contentReads,'work refresh does not reload X/meme')
    assert.ok(await main.webContents.executeJavaScript(`window.__previewObserver.disconnect(); window.__previewNotes.every(note=>!note.includes('正在生成画面'))`),'background frames preserve the preview explanation')
    targetDelay = 500
    await main.webContents.executeJavaScript("document.querySelector('#endpoint-hud').click()")
    await wait(30)
    await main.webContents.executeJavaScript("document.querySelector('#endpoint-desktop').click()")
    await wait(30)
    await main.webContents.executeJavaScript("document.querySelector('#endpoint-ink').click()")
    await wait(100)
    assert.equal(await main.webContents.executeJavaScript("document.querySelector('#endpoint-ink').getAttribute('aria-selected')"),'true','last quick click wins immediately')
    await wait(650)
    assert.equal(product.snapshot().target,'ink')
    targetDelay = 0
    failTarget = 'hud'
    await click(main,'#endpoint-hud')
    await until(()=>main!.webContents.executeJavaScript("Boolean(document.querySelector('.product-attention[role=alert]'))"),'failed-save feedback')
    assert.equal(product.snapshot().target,'ink')
    assert.equal(await main.webContents.executeJavaScript("document.querySelector('#endpoint-ink').getAttribute('aria-selected')"),'true','failed save rolls back selection')
    failTarget = undefined
    await click(main,'#endpoint-hud')
    writeFileSync(join(output,'switching.json'),JSON.stringify({immediateSelection:true,rapidSelection:true,rollback:true,hiddenPreviewPaused:true,coalescedReads:true,previewReads},null,2))

    assert.equal(product.snapshot().hudVisible,false,'target selection must not open a window')
    await button(main,'开启 HUD')
    await until(()=>BrowserWindow.getAllWindows().some(w=>w.getTitle()==='CodePulse HUD'),'HUD window')
    const hudWindow=BrowserWindow.getAllWindows().find(w=>w.getTitle()==='CodePulse HUD')!
    await until(()=>hudWindow.webContents.executeJavaScript(`Boolean(document.querySelector('.surface-controls.is-compact'))`),'HUD controls')
    assert.equal(visible.get(main.id),true,'desktop and HUD coexist')
    assert.equal(product.snapshot().hudVisible,true)
    assert.ok(hudWindow.isVisible(),'open must actually show the native window')
    // Simulate a stale off-screen/minimized HUD, then explicitly reopen from Control.
    hudWindow.setBounds({x:50000,y:50000,width:470,height:300})
    let minimized = true, restored = false, focused = false
    const originalMinimized = hudWindow.isMinimized.bind(hudWindow), originalRestore = hudWindow.restore.bind(hudWindow), originalFocus = hudWindow.focus.bind(hudWindow)
    hudWindow.isMinimized=()=>minimized
    hudWindow.restore=()=>{minimized=false;restored=true}
    hudWindow.focus=()=>{focused=true}
    assert.equal(hud.isVisible(),false,'minimized window is not reported as visible')
    product.setHudVisible(true)
    assert.equal(restored,true,'explicit open restores minimized HUD')
    assert.equal(focused,true,'explicit open brings HUD forward')
    assert.equal(hud.isVisible(),true)
    const area=screenApi.getDisplayMatching(main.getBounds()).workArea, bounds=hudWindow.getBounds()
    assert.ok(bounds.x>=area.x && bounds.y>=area.y && bounds.x+bounds.width<=area.x+area.width && bounds.y+bounds.height<=area.y+area.height,'reopen recovers off-screen bounds onto client display')
    hudWindow.isMinimized=originalMinimized;hudWindow.restore=originalRestore;hudWindow.focus=originalFocus
    writeFileSync(join(output,'hud-reveal.json'),JSON.stringify({restored,focused,area,bounds,visible:hud.isVisible()},null,2))
    assert.equal(product.snapshot().form,'standard','opening HUD preserves launch preference')
    await button(main,'专注模式');await button(hudWindow,'标准')
    assert.equal(product.snapshot().focusMode,false);assert.equal(product.snapshot().view,'control')
    assert.equal(visible.get(hudWindow.id),true,'HUD return opens console without hiding HUD')
    writeFileSync(join(output,'hud.png'),(await hudWindow.webContents.capturePage()).toPNG())
    // Updates keeps the original bounded service; synthetic content never touches live accounts.
    await click(main,'[data-view=ambient]')
    assert.equal(product.snapshot().target,'ink')
    assert.equal(await main.webContents.executeJavaScript(`document.querySelectorAll('.product-targets').length`),0)
    // 桌边内容: one category list whose rows carry the *Enabled rules; rules save by themselves.
    const TEMP='临时展示 10 分钟'
    const category=(id:string)=>click(main!,`[data-cat=${id}]`)
    const openSettings=async()=>{if(!await main!.webContents.executeJavaScript(`Boolean(document.querySelector('.ambient-settings')?.open)`))await click(main!,'.ambient-settings > summary')}
    const previewReady=()=>until(()=>main!.webContents.executeJavaScript(`document.querySelector('.ambient-panel .device-preview')?.getAttribute('data-render-state')==='ready'`),'ambient preview renderer')
    assert.deepEqual(await main.webContents.executeJavaScript(`Array.from(document.querySelectorAll('.ambient-catlist [data-cat]')).map(b=>b.querySelector('span').textContent)`), ['概念卡','思考实验','像素宠物','日历','科技热议','X 与 meme','我的图片与便签'], 'category order')
    for (const gone of ['保存推送设置','预览画面','当前目标画面','规则修改后立即保存','图片拖进此页即可导入']) assert.equal(await main.webContents.executeJavaScript(`document.body.innerText.includes(${JSON.stringify(gone)})`), false, 'removed copy is gone: '+gone)
    assert.equal(await main.webContents.executeJavaScript(`document.querySelector('.ambient-panel select[aria-label="选择内容"]')`), null, 'no item dropdown')
    // The social row switch is the existing xEnabled / memeEnabled rule pair.
    await click(main,'[data-rule=social] .ambient-switch')
    await until(()=>!ambient.snapshot().config.xEnabled&&!ambient.snapshot().config.memeEnabled,'row switch saves on its own')
    await until(()=>main!.webContents.executeJavaScript(`document.querySelector('.page-saved')?.textContent==='已保存'`),'saved confirmation')
    assert.equal(ambient.current(), undefined, 'saving rules does not select content')
    await click(main,'[data-rule=social] .ambient-switch')
    await until(()=>ambient.snapshot().config.xEnabled&&ambient.snapshot().config.memeEnabled,'row switch turns both back on')
    await category('social');await openSettings()
    for (const label of ['保存密钥','清除密钥','检查新内容']) assert.ok(await main.webContents.executeJavaScript(`Array.from(document.querySelectorAll('.ambient-settings button')).some(b=>b.textContent.trim()===${JSON.stringify(label)})`), 'X settings keep '+label)
    await click(main,'.ambient-group[aria-label=Meme] .page-switch input')
    await until(()=>ambient.snapshot().config.memeEnabled===false,'meme switch inside settings saves')
    await button(main,'检查新内容')
    await until(()=>ambient.snapshot().cards.filter(c=>c.kind==='x').length===1,'content fixture')
    await click(main,'.ambient-item');await previewReady()
    await capture('updates')
    await category('concept');await previewReady()
    // Reference for the pet page: where the display button sits for a normal category at scroll top.
    const conceptFirstScreen = await main.webContents.executeJavaScript(`(() => {
      for(let e=document.querySelector('.ambient-panel');e;e=e.parentElement)e.scrollTop=0;
      const r=Array.from(document.querySelectorAll('button')).find(b=>b.getClientRects().length&&b.textContent.trim()===${JSON.stringify(TEMP)}).getBoundingClientRect();
      return {top:r.top,bottom:r.bottom,height:window.innerHeight}
    })()`) as {top:number;bottom:number;height:number}
    await button(main, TEMP)
    assert.equal(ambient.current()?.kind, 'concept')
    assert.equal(ambient.current()?.manual, true)
    await until(()=>main!.webContents.executeJavaScript(`document.querySelector('[data-feedback=content]').textContent.includes('已临时展示')`), 'temporary display confirmed')
    assert.equal(await main.webContents.executeJavaScript(`(() => {
      document.querySelector('.ambient-temp').scrollIntoView({block:'center'});
      const r=document.querySelector('[data-feedback=content]').getBoundingClientRect();
      return r.top>=0 && r.bottom<=window.innerHeight;
    })()`), true, 'content result is visible when its display button is visible')
    await capture('multimedia-concept')
    await category('prompt');await previewReady();await button(main, TEMP)
    assert.equal(ambient.current()?.kind, 'prompt')
    await category('local')
    await main.webContents.executeJavaScript(`(() => { const t=document.querySelector('#ambient-note');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(t,'TEST NOTE — pause, then choose one useful task.');t.dispatchEvent(new Event('input',{bubbles:true})); })()`)
    await button(main, '保存并预览')
    await until(()=>ambient.snapshot().cards.some(c=>c.kind==='note'),'saved local note')
    await previewReady();await button(main, TEMP); assert.equal(ambient.current()?.kind, 'note')
    await capture('multimedia-note')
    await button(main, '移除'); assert.equal(ambient.current(), undefined)
    const imageBytes = Array.from(nativeImage.createFromBitmap(Buffer.alloc(80*120*4, 255), {width:80,height:120}).toPNG())
    await main.webContents.executeJavaScript(`(() => {const transfer = new DataTransfer();transfer.items.add(new File([new Uint8Array(${JSON.stringify(imageBytes)})], 'TEST-portrait.png', {type:'image/png'}));document.querySelector('.ambient-panel').dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:transfer}));})()`)
    await until(()=>ambient.snapshot().cards.some(c=>c.kind==='image'),'dragged image is imported')
    assert.equal(ambient.current(), undefined, 'importing never changes the e-ink screen by itself')
    await until(()=>main!.webContents.executeJavaScript(`document.querySelector('[data-feedback=content]').textContent.includes('已导入 1 张图片')`),'import confirmed')
    await previewReady();await button(main, TEMP)
    assert.equal(ambient.current()?.kind,'image','the imported picture is shown on request')
    assert.equal(ambient.current()?.imageHex?.length,19968)
    await capture('multimedia-image')
    ambient.dismiss(); await wait(); assert.equal(ambient.current(), undefined)
    // Pixel pets: the page lists five pets, shows red ink in the preview, and displays one on the screen.
    const petStats = () => main!.webContents.executeJavaScript(`(() => {
      const canvas=document.querySelector('.ambient-panel .device-preview canvas.device-screen');
      const d=canvas.getContext('2d').getImageData(0,0,400,300).data;let red=0,hash=0;
      for(let i=0;i<d.length;i+=4){if(d[i]===190&&d[i+1]===30&&d[i+2]===45)red++;hash=(hash*31+d[i]+d[i+1]*3+d[i+2]*7)>>>0}
      return {red,hash,state:document.querySelector('.ambient-panel .device-preview').getAttribute('data-render-state')}
    })()`) as Promise<{red:number;hash:number;state:string}>
    // Every pet option must show its name and full one-line character note without truncation.
    const assertPetTextFits = async (label: string) => {
      const cells = await main!.webContents.executeJavaScript(`Array.from(document.querySelectorAll('.ambient-pet-option')).map(o=>Array.from(o.querySelectorAll('strong,span')).map(e=>({text:e.textContent,scrollWidth:e.scrollWidth,clientWidth:e.clientWidth})))`) as {text:string;scrollWidth:number;clientWidth:number}[][]
      assert.equal(cells.length,5)
      for (const row of cells) { assert.equal(row.length,2); for (const e of row) assert.ok(e.text&&e.scrollWidth<=e.clientWidth,label+' text is not truncated: '+JSON.stringify(e)) }
    }
    const petChecked = () => main!.webContents.executeJavaScript(`Array.from(document.querySelectorAll('.ambient-pet-option')).map(b=>b.getAttribute('aria-checked'))`) as Promise<string[]>
    await category('pet');await openSettings();await previewReady()
    assert.deepEqual(await petChecked(), ['true','false','false','false','false'], 'first pet is chosen by default')
    assert.equal(await main.webContents.executeJavaScript(`document.querySelectorAll('.ambient-pet-option canvas').length`), 5, 'five pet thumbnails')
    await click(main,'.ambient-pet-option:nth-child(1)')
    await until(async()=>{const s=await petStats();return s.state==='ready'&&s.red>0},'pet preview draws red pixels')
    const firstPet = await petStats()
    assert.ok(firstPet.red>=100, 'preview paints rgb(190,30,45), got '+firstPet.red)
    // The primary action stays on the first screen at the default 1120 x 780 window, like other categories.
    const firstScreen = await main.webContents.executeJavaScript(`(() => {
      for(let e=document.querySelector('.ambient-panel');e;e=e.parentElement)e.scrollTop=0;
      const r=Array.from(document.querySelectorAll('button')).find(b=>b.getClientRects().length&&b.textContent.trim()===${JSON.stringify(TEMP)}).getBoundingClientRect();
      return {top:r.top,bottom:r.bottom,height:window.innerHeight}
    })()`) as {top:number;bottom:number;height:number}
    writeFileSync(join(output,'first-screen.json'),JSON.stringify({concept:conceptFirstScreen,pet:firstScreen}))
    // Five pet cards with real thumbnails need a little more height than the one-line concept row.
    assert.ok(Math.abs(firstScreen.top-conceptFirstScreen.top)<=24,'pet page keeps the display button where the concept page has it: '+JSON.stringify({pet:firstScreen,concept:conceptFirstScreen}))
    await click(main,'.ambient-pet-option:nth-child(2)')
    assert.deepEqual(await petChecked(), ['false','true','false','false','false'], 'selection moves to the second pet')
    await until(async()=>{const s=await petStats();return s.state==='ready'&&s.hash!==firstPet.hash&&s.red>0},'second pet preview')
    assert.match(await main.webContents.executeJavaScript(`document.querySelector('.ambient-pet-option[aria-checked=true]').textContent`), /已选/)
    await button(main, TEMP)
    assert.equal(ambient.current()?.kind, 'pet')
    assert.equal(ambient.current()?.pet?.id, 'yaya')
    assert.ok(ambient.current()?.red, 'the pet on screen carries a red plane')
    assert.ok(withAmbient(device().status,ambient.current()).ambient?.red, 'device status exposes ambient.red')
    await until(async()=>(await petStats()).red>0,'live target shows red')
    await assertPetTextFits('1120')
    await capture('multimedia-pet')
    await assertCanvasPure('pet 1120')
    // ui-acceptance viewports with a pet chosen; the window goes back to 1120 x 780 afterwards.
    for (const [width,height] of [[1440,900],[1024,768],[390,844]] as const) {
      main.setContentSize(width,height); await wait(450)
      const overflow = await main.webContents.executeJavaScript(`document.documentElement.scrollWidth-window.innerWidth`) as number
      if (width>=1024) assert.ok(overflow<=1,'no horizontal page scroll at '+width+': '+overflow)
      assert.equal(await main.webContents.executeJavaScript(`document.querySelectorAll('.ambient-pet-option').length`),5)
      if (width>=1024) await assertPetTextFits(String(width))
      if (width>=1024) await assertCanvasPure('pet '+width)
      await capture('multimedia-pet-'+width)
    }
    main.setContentSize(1120,780); await wait(350)
    await click(main,'.ambient-pet-option:nth-child(1)')
    assert.deepEqual(await petChecked(), ['true','false','false','false','false'])
    await assertPetTextFits('1120 first pet chosen')
    ambient.dismiss(); await wait(); assert.equal(ambient.current(), undefined)
    // Calendar: a category with only its own switch, opening on today's card with its info line.
    await category('calendar');await previewReady()
    const calendarPage = await main.webContents.executeJavaScript(`(() => ({
      selected:document.querySelector('.ambient-catlist li.is-current [data-cat]')?.getAttribute('data-cat'),
      info:document.querySelector('.ambient-calendar-info')?.textContent??'',
      infoBox:(()=>{for(let e=document.querySelector('.ambient-panel');e;e=e.parentElement)e.scrollTop=0;const r=document.querySelector('.ambient-calendar-info')?.getBoundingClientRect();return r?{top:r.top,bottom:r.bottom,height:window.innerHeight}:null})(),
      hint:document.querySelector('.ambient-calendar-info')?.getAttribute('title')??'',
      picker:Boolean(document.querySelector('.ambient-pet-picker')),
      settings:Boolean(document.querySelector('.ambient-settings')),
      toggle:Boolean(document.querySelector('[data-rule=calendar] .ambient-switch'))
    }))()`) as {selected:string;info:string;infoBox:{top:number;bottom:number;height:number}|null;hint:string;picker:boolean;settings:boolean;toggle:boolean}
    assert.equal(calendarPage.selected,'calendar','calendar category is selected'); assert.equal(calendarPage.picker,false,'one card a day needs no picker'); assert.equal(calendarPage.settings,false,'calendar has no extra options')
    assert.match(calendarPage.info,/^\d+月\d+日 周[一二三四五六日] · 农历.+ · 第\d+周/,'info line: date, lunar, week'); assert.match(calendarPage.hint,/固件 0\.0\.29/)
    assert.match(calendarPage.info,/(假期中|距 .+ 还有 \d+ 天|暂无下一个假日数据)$/,'info line ends with the next holiday or says there is none')
    assert.ok(calendarPage.infoBox&&calendarPage.infoBox.top>=0&&calendarPage.infoBox.bottom<=calendarPage.infoBox.height,'calendar info is on the first screen at 1120x780: '+JSON.stringify(calendarPage.infoBox))
    assert.ok(calendarPage.toggle,'calendar keeps its own switch')
    await button(main, TEMP)
    assert.equal(ambient.current()?.kind, 'calendar'); assert.equal(ambient.current()?.manual, true)
    assert.equal(withAmbient(device().status,ambient.current()).ambient?.layout,'calendar'); assert.ok(withAmbient(device().status,ambient.current()).ambient?.calendar,'device status exposes ambient.calendar')
    await capture('multimedia-calendar')
    await assertCanvasPure('calendar 1120')
    for (const [width,height] of [[1440,900],[1024,768]] as const) {
      main.setContentSize(width,height); await wait(450)
      const overflow = await main.webContents.executeJavaScript(`document.documentElement.scrollWidth-window.innerWidth`) as number
      assert.ok(overflow<=1,'no horizontal page scroll on the calendar page at '+width+': '+overflow)
      await assertCanvasPure('calendar '+width)
      await capture('multimedia-calendar-'+width)
    }
    main.setContentSize(1120,780); await wait(350)
    ambient.dismiss(); await wait(); assert.equal(ambient.current(), undefined)
    await click(main,'[data-view=settings]');assert.equal(await main.webContents.executeJavaScript(`document.body.textContent.includes('屏幕工作台')`),false,'settings no longer lists the screen workbench');await main.webContents.executeJavaScript(`window.codepulse.openSurface('screen')`);await wait()
    await until(()=>BrowserWindow.getAllWindows().some(w=>w.getTitle().includes('屏幕工作台')),'screen window')
    const screenWindow=BrowserWindow.getAllWindows().find(w=>w.getTitle().includes('屏幕工作台'))!
    await until(()=>screenWindow.webContents.executeJavaScript(`document.querySelector('.screen-live .device-preview')?.getAttribute('data-render-state')==='ready'`),'real Wasm screen pixels')
    const render=await createDeviceRenderer(readFileSync('apps/desktop/src/renderer/src/device-preview/renderer.wasm'))
    const rendered=await screenWindow.webContents.executeJavaScript(`Array.from(document.querySelector('.screen-live canvas').getContext('2d').getImageData(0,0,400,300).data)`)
    assert.deepEqual(rendered,Array.from(frameToRgba(render(device().status))))
    await button(screenWindow,'置顶');const nativePinApplied=screen.state().pinned
    if(!nativePinApplied) assert.ok(await screenWindow.webContents.executeJavaScript(`document.body.textContent.includes('系统未应用置顶设置')`))
    await assert.rejects(main.webContents.executeJavaScript(`window.codepulse.setWorkbenchWindow({pinned:true})`))
    await button(screenWindow,'显示配置');await button(screenWindow,'工作状态')
    await main.webContents.executeJavaScript(`window.codepulse.setDeviceDisplay({...${JSON.stringify(config)},metric:'used'})`);await wait()
    assert.ok(await screenWindow.webContents.executeJavaScript(`document.body.textContent.includes('保留你的未保存修改')`))
    await button(screenWindow,'当前画面');ambient.dismiss();await wait(500)
    assert.ok(await screenWindow.webContents.executeJavaScript(`document.querySelector('.screen-context').textContent.includes('用量看板')`))
    writeFileSync(join(output,'device.json'),JSON.stringify(device().status,null,2))
    await button(screenWindow,'专注展示');await wait(700);writeFileSync(join(output,'screen.png'),(await screenWindow.webContents.capturePage()).toPNG());await button(screenWindow,'退出展示')
    await new Promise<void>(resolve=>{screenWindow.webContents.once('did-finish-load',()=>resolve());screenWindow.webContents.reload()})
    await until(()=>screenWindow.webContents.executeJavaScript(`Array.from(document.querySelectorAll('button')).some(b=>b.textContent===${JSON.stringify(nativePinApplied?'已置顶':'置顶')})`),'pin state after reload')
    const savedOrder=JSON.stringify({version:1,workspaceKeys:['f:/example/new-project','f:/example/codepulse']})
    await main.webContents.executeJavaScript(`localStorage.setItem('codepulse:project-order-v1',${JSON.stringify(savedOrder)})`)
    const next=hub.snapshot();next.agents=[...next.agents,{...next.agents[0]!,workspacePath:'F:/example/new-project',externalSessionId:'order-fixture'}]
    screen.broadcast('codepulse:status',next);await wait()
    assert.equal(await main.webContents.executeJavaScript(`localStorage.getItem('codepulse:project-order-v1')`),savedOrder)
    await click(main,'[data-view=settings]')
    assert.equal(await main.webContents.executeJavaScript(`Boolean(document.querySelector('.product-topbar'))`),false)
    assert.ok(await main.webContents.executeJavaScript(`Boolean(document.querySelector('.settings-embedded'))`))
    await click(main,'[data-view=ambient]');assert.equal(product.snapshot().view,'ambient')
    await click(main,'[data-view=settings]');await click(main,'.theme-swatch-dark');await wait(500)
    await click(main,'[data-view=control]');await capture('control-dark')
    main.setSize(720,600);await capture('compact')
    // At a narrow width the pill collapses to its dot; the full text stays in title and aria-label, and the hit area stays 32px.
    const narrowPill=await main.webContents.executeJavaScript(`(()=>{const b=document.querySelector('.product-rail .ink-pill-main'),r=b.getBoundingClientRect();return {text:getComputedStyle(b.querySelector('.ink-pill-text')).display,h:r.height,w:r.width,title:b.title,label:b.getAttribute('aria-label')}})()`) as {text:string;h:number;w:number;title:string;label:string}
    assert.equal(narrowPill.text,'none','collapsed pill hides its text');assert.ok(narrowPill.h>=32&&narrowPill.w>=32,'collapsed pill keeps a 32px hit area: '+JSON.stringify(narrowPill));assert.ok(narrowPill.title.includes('墨水屏')&&narrowPill.label.includes('墨水屏'),'collapsed pill keeps its text in title and aria-label')
    assert.equal(await main.webContents.executeJavaScript(`document.documentElement.scrollWidth<=window.innerWidth`),true)
    assert.equal(JSON.stringify(hub.snapshot().agents),before,'UI actions preserve canonical task state')
    // Real assistant preload/IPC and an isolated database, without microphones or external calls.
    main.setSize(1120,780)
    await click(main,'[data-view=settings]');await click(main,'.theme-swatch-light')
    await click(main,'[data-view=assistant]')
    await until(()=>main!.webContents.executeJavaScript(`Boolean(document.querySelector('.desk-task-form'))`),'assistant view')
    await main.webContents.executeJavaScript(`(() => { const field=document.querySelector('.desk-task-form input'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(field,'测试待办 · 离线验证');field.dispatchEvent(new Event('input',{bubbles:true})); })()`)
    await wait();await button(main,'添加待办')
    await until(()=>assistantStore.list().length===1,'task form persists')
    await main.webContents.executeJavaScript(`(() => { const field=document.querySelector('.desk-assistant-prompt');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(field,'10分钟后提醒我喝水');field.dispatchEvent(new Event('input',{bubbles:true})); })()`)
    await wait();await button(main,'交给助手')
    await until(()=>main!.webContents.executeJavaScript(`Boolean(document.querySelector('.desk-assistant-draft'))`),'assistant proposal')
    assert.equal(assistantStore.list().length,1,'AI suggestion does not mutate storage before confirmation')
    await button(main,'确认执行');await until(()=>assistantStore.list().length===2,'assistant confirmation persists')
    assert.ok(await main.webContents.executeJavaScript(`Array.from(document.querySelectorAll('.desk-assistant button')).find(b=>b.textContent==='开始录音').disabled`),'microphone is opt-in')
    await capture('assistant')
    await click(main,'[data-view=control]');await click(main,'#endpoint-ink');await button(main,'轮播')
    const previousPlan=structuredClone(product.snapshot().inkPlan)
    ambient.dismiss()
    await click(main,'button[role=switch][aria-label="待办与提醒加入节目单"]')
    assert.deepEqual(product.snapshot().inkPlan,previousPlan,'todo configuration remains a draft')
    await button(main,'应用到设备')
    assert.equal(product.snapshot().inkPlan.mode,'cycle')
    assert.deepEqual(product.snapshot().inkPlan.items,['work','ambient','todos'])
    assistant.showOnInk();publishInk()
    await until(()=>main!.webContents.executeJavaScript(`document.querySelector('.ink-control-workspace .device-preview').getAttribute('data-render-state')==='ready'`),'production todo preview')
    assert.equal(device().status.ambient?.items?.length,2,'temporary todo display uses the production checklist')
    await capture('control-todos')
    assert.equal(JSON.stringify(hub.snapshot().agents),before,'assistant work never acknowledges programming tasks')
    hub.ingest({id:'shell-attention',source:'codex',eventType:'permission_request',externalSessionId:'shell-ui',workspacePath:'F:/example/codepulse',toolName:'shell',timestamp:Date.now()})
    const attentionState=JSON.stringify(hub.snapshot().agents)
    broadcast('codepulse:status',hub.snapshot());ambient.tick()
    await until(()=>main!.webContents.executeJavaScript(`Boolean(document.querySelector('.product-nav-count'))`),'work attention badge')
    await click(main,'[data-view=control]');assert.equal(product.snapshot().view,'control')
    assert.equal(JSON.stringify(hub.snapshot().agents),attentionState)
    // The expected unauthorized native-window rejection is visible to Electron's console.
    const unexpected=errors.filter(e=>!e.includes('Only the screen window'))
    assert.deepEqual(unexpected,[])
    writeFileSync(join(output,'result.json'),JSON.stringify({passed:true,views:5,assistantTasks:true,todoPlan:true,focusRoundTrip:true,consolidatedNavigation:true,fixedPixelResize:true,inspectionPixelEquality:true,visibleApply:true,stablePreviewNotes:true,invertedStyle:true,conceptCard:true,thoughtPrompt:true,personalNote:true,imageDrop:true,pixelPet:true,calendar:true,hudCoexistence:true,largePreview:true,independentScreen:true,draftPreserved:true,settingsShortcuts:true,globalAttention:true,canonicalStatePreserved:true,nativePinApplied,errors:unexpected},null,2))
    assistant.stop();assistantStore.close();ambient.stop();BrowserWindow.getAllWindows().forEach(w=>w.destroy());screen.destroy();clearTimeout(deadline);app.exit(0)
  }catch(error){writeFileSync(join(output,'failure.txt'),(error instanceof Error ? error.stack : String(error))+'\n'+JSON.stringify(errors));clearTimeout(deadline);app.exit(1)}
})
