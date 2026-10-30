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
function assertWholePixels([width,height]: number[], dpr: number, minK: number, message: string) {
  const k = width!*dpr/400
  assert.ok(Math.abs(k-Math.round(k))<0.01 && Math.round(k)>=minK, `${message}: ${width}x${height} css at dpr ${dpr}`)
  assert.ok(Math.abs(height!*dpr-300*Math.round(k))<0.01, `${message}: height ${height} css at dpr ${dpr}`)
}
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
    let product: ProductShell
    const hud=new HudSurface(hub,join(host,'out/hud'),join(output,'hud-workspaces.json'),()=>product?.refresh());hud.registerIpc()
    const screen=new ScreenWorkbenchWindow({preload:join(host,'out/preload/index.js'),renderer:join(host,'out/renderer/index.html'),icon:join(host,'build/icon.png')})
    writeFileSync(join(output,'window-state.log'),'')
    const configure=screen.configure.bind(screen)
    screen.configure=(id,input)=>{const before=screen.state();const result=configure(id,input);appendFileSync(join(output,'window-state.log'),JSON.stringify({id,input,before,result})+'\n');return result}
    const store=shellPreferenceStore(join(output,'product-shell.json'));store.write(normalizeShellPreferences({version:1,form:'standard',view:'overview'}))
    product=new ProductShell(store.read(),store.write,{hudAvailable:()=>true,hudVisible:()=>hud.isVisible(),standard:()=>main?.show(),hud:()=>hud.open(main?.getBounds()),screen:()=>screen.open(),hideStandard:()=>main?.hide(),hideHud:()=>hud.hide()},s=>broadcast('codepulse:shell-status',s))
    let targetDelay = 0, failTarget: string | undefined
    registerProductIpc({ handle(channel, listener) {
      ipcMain.handle(channel, async (event, ...args) => {
        if (channel === 'codepulse:shell-target') {
          if (targetDelay) await wait(targetDelay)
          if (args[0] === failTarget) throw Error('TEST FIXTURE: preference write failed')
        }
        return listener(event, ...args)
      })
    } },product,screen)
    const previewReads: Record<string, number> = {}
    const measuredIpc = { handle(channel: string, listener: (...args: any[]) => any) {
      ipcMain.handle(channel, (...args) => {
        previewReads[channel] = (previewReads[channel] ?? 0) + 1
        return listener(...args)
      })
    } }
    const readCount = (name: string) => previewReads['codepulse:' + name] ?? 0
    const ambient=new AmbientService({
      config:{...DEFAULT_AMBIENT,enabled:false,xEnabled:true,memeEnabled:false,quietStart:0,quietEnd:0,idleOnly:false},
      status:()=>hub.snapshot(),key:()=> 'fixture-key',save:()=>{},changed:()=>broadcast('codepulse:ambient-status',ambient.snapshot()),
      request:async()=>({tweets:[{id:'12345',author:{userName:'Polymarket'},text:'TEST FIXTURE — this is a screen integration test, not a real news post.',createdAt:new Date().toISOString(),likeCount:9000}]}),image:async()=>'',
    })
    const projector=createDeviceDisplayProjector(join(output,'device-order.json'))
    const device=(draft?:DeviceDisplayConfig)=>({config,status:withAmbient(projector(hud.snapshot(),draft??config),draft?undefined:ambient.current()),serverAvailable:false})
    const imageDir = join(output, 'image-library'); mkdirSync(imageDir, { recursive: true })
    const imageRuntime = createAmbientRuntime(imageDir, { status: () => hub.snapshot(), changed: () => {} })
    registerAmbientIpc(measuredIpc,{service:ambient,setKey:()=>ambient.snapshot(),importImage:(bytes,name)=>{const card=imageRuntime.importImage(bytes,name);return ambient.addPersonal('image',card.text,card.imageHex)}},()=>device().status,async()=>{})
    const handlers: Record<string, (...args:any[])=>any>={
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
    assert.ok(await main.webContents.executeJavaScript(`document.querySelector('[data-view=control]').textContent.includes('控制')`),'Chinese fixture locale')
    assert.equal(product.snapshot().view,'control','legacy overview migrates to control')
    assert.equal(await main.webContents.executeJavaScript(`Boolean(document.querySelector('.product-topbar'))`),false)
    await main.webContents.executeJavaScript(`localStorage.setItem('codepulse:dashboard-settings',JSON.stringify({...JSON.parse(localStorage.getItem('codepulse:dashboard-settings')||'{}'),theme:'light'}))`)
    await main.webContents.reload(); await wait(900)
    await until(()=>main!.webContents.executeJavaScript(`Boolean(document.querySelector('.product-control'))`),'control reload')
    const capture=async(name:string)=>{await wait(350);writeFileSync(join(output,name+'.png'),(await main!.webContents.capturePage()).toPNG())}
    await capture('control-desktop')
    // Layout changes stay drafts until applied, and survive focus/console transitions.
    await button(main,'功能平铺');assert.equal(product.snapshot().desktopLayout,'work')
    await button(main,'进入专注模式')
    assert.equal(product.snapshot().focusMode,true)
    assert.equal(await main.webContents.executeJavaScript(`getComputedStyle(document.querySelector('.product-rail')).display`),'none')
    assert.ok(await main.webContents.executeJavaScript(`document.querySelector('.product-live-console').getClientRects().length > 0`))
    await capture('focus')
    await button(main,'返回控制台')
    assert.equal(product.snapshot().focusMode,false)
    assert.ok(await main.webContents.executeJavaScript(`document.querySelector('.product-segments [aria-pressed=true]').textContent.includes('功能平铺')`))
    await button(main,'立即应用');assert.equal(product.snapshot().desktopLayout,'board')
    assert.ok(await main.webContents.executeJavaScript(`Boolean(document.querySelector('.product-desktop-preview.is-board'))`))
    await click(main,'[data-view=usage]')
    assert.ok(await main.webContents.executeJavaScript(`document.body.textContent.includes('暂无可用的历史统计')`))
    assert.equal(await main.webContents.executeJavaScript(`document.querySelectorAll('.product-targets').length`),0)
    await click(main,'[data-view=control]');await click(main,'#endpoint-ink')
    await until(()=>main!.webContents.executeJavaScript(`document.querySelector('.product-control .device-preview')?.getAttribute('data-render-state')==='ready'`),'ink draft preview')
    const previewWidth=await main.webContents.executeJavaScript(`document.querySelector('.product-control .device-preview canvas').getBoundingClientRect().width`)
    assert.ok(previewWidth>=200,'preview must remain legible at default window size')
    const layouts: unknown[] = []
    const geometry = () => main!.webContents.executeJavaScript(`(() => {
      const control = document.querySelector('.product-control');
      const stage = document.querySelector('.ink-control-workspace .product-preview-stage');
      const canvas = stage.querySelector('.device-preview-scroll canvas').getBoundingClientRect();
      const apply = document.querySelector('.ink-config .product-config-actions button').getBoundingClientRect();
      return {viewport: [innerWidth,innerHeight], dpr: devicePixelRatio, canvas: [canvas.width,canvas.height],
        canvasBottom: canvas.bottom, applyBottom: apply.bottom, applyTop: apply.top,
        pageOverflow: control.scrollHeight-control.clientHeight,
        previewOverflow: stage.scrollHeight-stage.clientHeight,
        configOverflow: document.querySelector('.ink-config .product-config-scroll').scrollHeight-document.querySelector('.ink-config .product-config-scroll').clientHeight,
        horizontalOverflow: document.documentElement.scrollWidth-innerWidth};
    })()`)
    for (const [width,height] of [[1120,780],[1366,900],[1600,1000],[1000,720]]) {
      main.setContentSize(width!,height!); await wait(250)
      const measured = await geometry(); layouts.push(measured)
      assertWholePixels(measured.canvas as number[],measured.dpr as number,1,'resizing keeps whole physical pixels per device pixel')
      assert.ok(measured.pageOverflow <= 1,JSON.stringify(measured))
      assert.ok(measured.previewOverflow <= 1,JSON.stringify(measured))
      if(width! >= 1120) assert.ok(measured.configOverflow <= 1,JSON.stringify(measured))
      assert.ok(measured.applyBottom <= height! && measured.applyTop >= 0,'apply remains visible')
      assert.equal(measured.horizontalOverflow,0)
      await capture('ink-'+width+'x'+height)
    }
    main.setContentSize(1120,780)
    for (const zoom of [1.25,1.5,2,1]) {
      main.webContents.setZoomFactor(zoom); await wait(300)
      const measured = await geometry(); layouts.push(measured)
      assertWholePixels(measured.canvas as number[],measured.dpr as number,1,`zoom ${zoom} keeps whole physical pixels`)
    }
    await wait(250)
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
    await main.webContents.executeJavaScript(`Array.from(document.querySelectorAll('.ink-config label')).find(l=>l.textContent.includes('黑底白字')).querySelector('input').click()`)
    await until(()=>main!.webContents.executeJavaScript(`document.querySelector('.ink-control-workspace .device-preview-scroll canvas').getContext('2d').getImageData(0,0,1,1).data[0]===0`),'inverted draft pixels')
    const invertedPixels = await main.webContents.executeJavaScript(`Array.from(document.querySelector('.ink-control-workspace .device-preview-scroll canvas').getContext('2d').getImageData(0,0,400,300).data)`)
    assert.deepEqual(invertedPixels, normalPixels.map((v:number,i:number)=>i%4===3?v:255-v),'style checkbox flips production pixels without saving')
    await capture('ink-inverted')
    await main.webContents.executeJavaScript(`Array.from(document.querySelectorAll('.ink-config label')).find(l=>l.textContent.includes('黑底白字')).querySelector('input').click()`)
    await wait(350)
    assert.equal(await main.webContents.executeJavaScript(`document.querySelector('.product-sample-options')?.tagName`),'SECTION','density samples never collapse')
    await button(main,'9 个任务样例')
    assert.equal(await main.webContents.executeJavaScript(`document.querySelector('.ink-config .product-config-actions button').disabled`),true,'samples cannot be applied')
    const expanded=await geometry(); assert.ok(expanded.applyBottom <= 780,'expanded details keep the apply action in view')
    await capture('ink-dense')
    await button(main,'2 倍检查'); await capture('ink-dense-inspector')
    main.webContents.sendInputEvent({type:'keyDown',keyCode:'Escape'})
    await until(()=>main!.webContents.executeJavaScript(`document.querySelectorAll('dialog[open]').length===0`),'Escape closes the inspection')
    await button(main,'实时任务')
    await click(main,'.ink-work-options summary')
    writeFileSync(join(output,'layout.json'),JSON.stringify(layouts,null,2))
    await capture('control-ink')
    await button(main,'用量看板');assert.equal(config.mode,'hud')
    await button(main,'进入专注模式');await button(main,'返回控制台')
    assert.equal(product.snapshot().target,'ink')
    assert.ok(await main.webContents.executeJavaScript(`Array.from(document.querySelectorAll('.product-control .ink-config button')).some(b=>b.textContent==='用量看板' && b.getAttribute('aria-pressed')==='true')`))
    await button(main,'立即应用');assert.equal(config.mode,'usage')
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
    assert.equal(await main.webContents.executeJavaScript("document.querySelector('#endpoint-ink').getAttribute('aria-pressed')"),'true','card selection paints before persistence completes')
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
    assert.equal(await main.webContents.executeJavaScript("document.querySelector('#endpoint-ink').getAttribute('aria-pressed')"),'true','last quick click wins immediately')
    await wait(650)
    assert.equal(product.snapshot().target,'ink')
    targetDelay = 0
    failTarget = 'hud'
    await click(main,'#endpoint-hud')
    await until(()=>main!.webContents.executeJavaScript("Boolean(document.querySelector('.product-attention[role=alert]'))"),'failed-save feedback')
    assert.equal(product.snapshot().target,'ink')
    assert.equal(await main.webContents.executeJavaScript("document.querySelector('#endpoint-ink').getAttribute('aria-pressed')"),'true','failed save rolls back selection')
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
    await button(main,'进入专注模式');await button(hudWindow,'标准')
    assert.equal(product.snapshot().focusMode,false);assert.equal(product.snapshot().view,'control')
    assert.equal(visible.get(hudWindow.id),true,'HUD return opens console without hiding HUD')
    writeFileSync(join(output,'hud.png'),(await hudWindow.webContents.capturePage()).toPNG())
    // Updates keeps the original bounded service; synthetic content never touches live accounts.
    await click(main,'[data-view=ambient]')
    assert.equal(product.snapshot().target,'ink')
    assert.equal(await main.webContents.executeJavaScript(`document.querySelectorAll('.product-targets').length`),0)
    if (!await main.webContents.executeJavaScript(`document.querySelector('.ambient-configuration > fieldset > .ambient-toggle input').checked`)) await click(main,'.ambient-configuration > fieldset > .ambient-toggle input')
    await button(main,'保存推送设置');assert.match(await main.webContents.executeJavaScript(`document.querySelector('[data-feedback=settings]').textContent`), /设置已保存/);assert.equal(ambient.current(), undefined, 'saving preferences does not select content');await button(main,'检查新内容')
    await until(()=>ambient.snapshot().cards.filter(c=>c.kind==='x').length===1,'content fixture');await button(main,'热点与 meme');await button(main,'预览画面')
    await until(()=>main!.webContents.executeJavaScript(`document.querySelector('.ambient-panel .device-preview')?.getAttribute('data-render-state')==='ready'`),'content renderer')
    await capture('updates')
    await button(main, '概念卡'); await button(main, '预览画面')
    await until(()=>main!.webContents.executeJavaScript(`document.querySelector('.ambient-panel .device-preview')?.getAttribute('data-render-state')==='ready'`),'concept canvas')
    // Reference for the pet page: where the display button sits for a normal category at scroll top.
    const conceptFirstScreen = await main.webContents.executeJavaScript(`(() => {
      for(let e=document.querySelector('.ambient-panel');e;e=e.parentElement)e.scrollTop=0;
      const r=Array.from(document.querySelectorAll('button')).find(b=>b.getClientRects().length&&b.textContent.trim()==='显示到屏幕').getBoundingClientRect();
      return {top:r.top,bottom:r.bottom,height:window.innerHeight}
    })()`) as {top:number;bottom:number;height:number}
    await button(main, '显示到屏幕')
    assert.equal(ambient.current()?.kind, 'concept')
    assert.equal(ambient.current()?.manual, true)
    await until(()=>main!.webContents.executeJavaScript(`document.querySelector('.ambient-panel .product-preview-label').textContent.includes('当前目标画面')`), 'manual display leaves sample mode')
    assert.match(await main.webContents.executeJavaScript(`document.querySelector('[data-feedback=content]').textContent`), /已设为目标画面/)
    assert.equal(await main.webContents.executeJavaScript(`(() => {
      const actions=document.querySelector('.ambient-display-actions');actions.scrollIntoView({block:'end'});
      const r=document.querySelector('[data-feedback=content]').getBoundingClientRect();
      return r.top>=0 && r.bottom<=window.innerHeight;
    })()`), true, 'content result is visible when its display button is visible')
    await capture('multimedia-concept')
    await button(main, '思考实验'); await button(main, '预览画面'); await button(main, '显示到屏幕')
    assert.equal(ambient.current()?.kind, 'prompt')
    await button(main, '我的图片与便签')
    await main.webContents.executeJavaScript(`(() => { const t=document.querySelector('#ambient-note');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(t,'TEST NOTE — pause, then choose one useful task.');t.dispatchEvent(new Event('input',{bubbles:true})); })()`)
    await button(main, '保存并预览')
    await until(()=>ambient.snapshot().cards.some(c=>c.kind==='note'),'saved local note')
    await button(main, '显示到屏幕'); assert.equal(ambient.current()?.kind, 'note')
    await capture('multimedia-note')
    await button(main, '移除'); assert.equal(ambient.current(), undefined)
    const imageBytes = Array.from(nativeImage.createFromBitmap(Buffer.alloc(80*120*4, 255), {width:80,height:120}).toPNG())
    await main.webContents.executeJavaScript(`(() => {const transfer = new DataTransfer();transfer.items.add(new File([new Uint8Array(${JSON.stringify(imageBytes)})], 'TEST-portrait.png', {type:'image/png'}));document.querySelector('.ambient-panel').dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:transfer}));})()`)
    await until(()=>ambient.current()?.kind==='image','dragged image becomes current target')
    assert.equal(ambient.current()?.imageHex?.length,19968)
    await capture('multimedia-image')
    await button(main, '回到工作画面'); assert.equal(ambient.current(), undefined)
    // Pixel pets: the page lists three pets, shows red ink in the preview, and displays one on the screen.
    const petStats = () => main!.webContents.executeJavaScript(`(() => {
      const canvas=document.querySelector('.ambient-panel .device-preview canvas.device-screen');
      const d=canvas.getContext('2d').getImageData(0,0,400,300).data;let red=0,hash=0;
      for(let i=0;i<d.length;i+=4){if(d[i]===190&&d[i+1]===30&&d[i+2]===45)red++;hash=(hash*31+d[i]+d[i+1]*3+d[i+2]*7)>>>0}
      return {red,hash,state:document.querySelector('.ambient-panel .device-preview').getAttribute('data-render-state')}
    })()`) as Promise<{red:number;hash:number;state:string}>
    // Every pet option must show its name and full one-line character note without truncation.
    const assertPetTextFits = async (label: string) => {
      const cells = await main!.webContents.executeJavaScript(`Array.from(document.querySelectorAll('.ambient-pet-option')).map(o=>Array.from(o.querySelectorAll('strong,span')).map(e=>({text:e.textContent,scrollWidth:e.scrollWidth,clientWidth:e.clientWidth})))`) as {text:string;scrollWidth:number;clientWidth:number}[][]
      assert.equal(cells.length,3)
      for (const row of cells) { assert.equal(row.length,2); for (const e of row) assert.ok(e.text&&e.scrollWidth<=e.clientWidth,label+' text is not truncated: '+JSON.stringify(e)) }
    }
    const petChecked = () => main!.webContents.executeJavaScript(`Array.from(document.querySelectorAll('.ambient-pet-option')).map(b=>b.getAttribute('aria-checked'))`) as Promise<string[]>
    await button(main, '像素宠物')
    assert.deepEqual(await petChecked(), ['true','false','false'], 'first pet is chosen by default')
    assert.equal(await main.webContents.executeJavaScript(`document.querySelectorAll('.ambient-pet-option canvas').length`), 3, 'three pet thumbnails')
    await click(main,'.ambient-pet-option:nth-child(1)')
    await until(async()=>{const s=await petStats();return s.state==='ready'&&s.red>0},'pet preview draws red pixels')
    const firstPet = await petStats()
    assert.ok(firstPet.red>=100, 'preview paints rgb(190,30,45), got '+firstPet.red)
    // The primary action stays on the first screen at the default 1120 x 780 window, like other categories.
    const firstScreen = await main.webContents.executeJavaScript(`(() => {
      for(let e=document.querySelector('.ambient-panel');e;e=e.parentElement)e.scrollTop=0;
      const r=Array.from(document.querySelectorAll('button')).find(b=>b.getClientRects().length&&b.textContent.trim()==='显示到屏幕').getBoundingClientRect();
      return {top:r.top,bottom:r.bottom,height:window.innerHeight}
    })()`) as {top:number;bottom:number;height:number}
    writeFileSync(join(output,'first-screen.json'),JSON.stringify({concept:conceptFirstScreen,pet:firstScreen}))
    assert.ok(firstScreen.top<=conceptFirstScreen.top+1,'pet page keeps 显示到屏幕 as high as the concept page: '+JSON.stringify({pet:firstScreen,concept:conceptFirstScreen}))
    await click(main,'.ambient-pet-option:nth-child(2)')
    assert.deepEqual(await petChecked(), ['false','true','false'], 'selection moves to the second pet')
    await until(async()=>{const s=await petStats();return s.state==='ready'&&s.hash!==firstPet.hash&&s.red>0},'second pet preview')
    assert.match(await main.webContents.executeJavaScript(`document.querySelector('.ambient-pet-option[aria-checked=true]').textContent`), /已选/)
    await button(main, '显示到屏幕')
    assert.equal(ambient.current()?.kind, 'pet')
    assert.equal(ambient.current()?.pet?.id, 'yaya')
    assert.ok(ambient.current()?.red, 'the pet on screen carries a red plane')
    assert.ok(withAmbient(device().status,ambient.current()).ambient?.red, 'device status exposes ambient.red')
    await until(()=>main!.webContents.executeJavaScript(`document.querySelector('.ambient-panel .product-preview-label').textContent.includes('当前目标画面')`), 'pet display leaves sample mode')
    await until(async()=>(await petStats()).red>0,'live target shows red')
    await assertPetTextFits('1120')
    await capture('multimedia-pet')
    // ui-acceptance viewports with a pet chosen; the window goes back to 1120 x 780 afterwards.
    for (const [width,height] of [[1440,900],[1024,768],[390,844]] as const) {
      main.setContentSize(width,height); await wait(450)
      const overflow = await main.webContents.executeJavaScript(`document.documentElement.scrollWidth-window.innerWidth`) as number
      if (width>=1024) assert.ok(overflow<=1,'no horizontal page scroll at '+width+': '+overflow)
      assert.equal(await main.webContents.executeJavaScript(`document.querySelectorAll('.ambient-pet-option').length`),3)
      if (width>=1024) await assertPetTextFits(String(width))
      await capture('multimedia-pet-'+width)
    }
    main.setContentSize(1120,780); await wait(350)
    await click(main,'.ambient-pet-option:nth-child(1)')
    assert.deepEqual(await petChecked(), ['true','false','false'])
    await assertPetTextFits('1120 first pet chosen')
    await button(main, '回到工作画面'); assert.equal(ambient.current(), undefined)
    await button(main, '热点与 meme')
    await click(main,'[data-view=settings]');await button(main,'屏幕工作台 ↗')
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
    await button(main,'多媒体玩法（X 与 meme）');assert.equal(product.snapshot().view,'ambient')
    await click(main,'[data-view=settings]');await click(main,'.theme-swatch-dark');await wait(500)
    await click(main,'[data-view=control]');await capture('control-dark')
    main.setSize(720,600);await capture('compact')
    assert.equal(await main.webContents.executeJavaScript(`document.documentElement.scrollWidth<=window.innerWidth`),true)
    assert.equal(JSON.stringify(hub.snapshot().agents),before,'UI actions preserve canonical task state')
    hub.ingest({id:'shell-attention',source:'codex',eventType:'permission_request',externalSessionId:'shell-ui',workspacePath:'F:/example/codepulse',toolName:'shell',timestamp:Date.now()})
    const attentionState=JSON.stringify(hub.snapshot().agents)
    broadcast('codepulse:status',hub.snapshot());ambient.tick()
    await until(()=>main!.webContents.executeJavaScript(`Boolean(document.querySelector('.product-nav-count'))`),'work attention badge')
    await click(main,'[data-view=control]');assert.equal(product.snapshot().view,'control')
    assert.equal(JSON.stringify(hub.snapshot().agents),attentionState)
    // The expected unauthorized native-window rejection is visible to Electron's console.
    const unexpected=errors.filter(e=>!e.includes('Only the screen window'))
    assert.deepEqual(unexpected,[])
    writeFileSync(join(output,'result.json'),JSON.stringify({passed:true,views:4,focusRoundTrip:true,consolidatedNavigation:true,fixedPixelResize:true,inspectionPixelEquality:true,visibleApply:true,stablePreviewNotes:true,invertedStyle:true,conceptCard:true,thoughtPrompt:true,personalNote:true,imageDrop:true,pixelPet:true,hudCoexistence:true,largePreview:true,independentScreen:true,draftPreserved:true,settingsShortcuts:true,globalAttention:true,canonicalStatePreserved:true,nativePinApplied,errors:unexpected},null,2))
    ambient.stop();BrowserWindow.getAllWindows().forEach(w=>w.destroy());screen.destroy();clearTimeout(deadline);app.exit(0)
  }catch(error){writeFileSync(join(output,'failure.txt'),(error instanceof Error ? error.stack : String(error))+'\n'+JSON.stringify(errors));clearTimeout(deadline);app.exit(1)}
})
