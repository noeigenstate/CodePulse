import { app, BrowserWindow, ipcMain } from 'electron'
import { resolve, join } from 'node:path'
import { mkdirSync, writeFileSync, readFileSync, appendFileSync } from 'node:fs'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { createDeviceRenderer, frameToRgba } from '../apps/desktop/src/renderer/src/device-preview/renderer.mjs'
import { StatusHub } from '@codepulse/core'
import { DEFAULT_AMBIENT, DEFAULT_DEVICE_DISPLAY, normalizeDeviceDisplay, type DeviceDisplayConfig } from '@codepulse/shared'
import { ProductShell, shellPreferenceStore } from '../apps/desktop/src/main/product-shell.js'
import { registerProductIpc } from '../apps/desktop/src/main/product-ipc.js'
import { ScreenWorkbenchWindow } from '../apps/desktop/src/main/screen-workbench-window.js'
import { AmbientService } from '../apps/desktop/src/main/ambient-service.js'
import { registerAmbientIpc } from '../apps/desktop/src/main/ambient-ipc.js'
import { withAmbient } from '../apps/desktop/src/main/ambient-rules.js'
import { HudSurface } from '../apps/desktop/src/main/hud-surface.js'
import { createDeviceDisplayProjector } from '../apps/desktop/src/main/device-display-projection.js'

const output = resolve('.tmpshots/surface-smoke', process.env.CODEPULSE_SMOKE_RUN ?? 'local')
mkdirSync(output,{recursive:true}); app.setPath('userData',join(output,'profile'))
const errors: string[] = [], visible = new Map<number,boolean>()
const wait = (ms=200) => new Promise(r=>setTimeout(r,ms))
const deadline = setTimeout(()=>{writeFileSync(join(output,'failure.txt'),'timeout');app.exit(1)},120000)
app.on('browser-window-created',(_e,win)=>{
  // Exercise real window constructors and renderers without showing test windows.
  win.show=()=>{visible.set(win.id,true)}; win.showInactive=()=>{visible.set(win.id,true)}
  win.hide=()=>{visible.set(win.id,false)}
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
  const code=`(()=>{const b=Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()===${JSON.stringify(label)});if(!b)throw Error('Missing button');b.click()})()`
  await win.webContents.executeJavaScript(code);await wait()
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
    const hud=new HudSurface(hub,join(host,'out/hud'),join(output,'hud-workspaces.json'));hud.registerIpc()
    const screen=new ScreenWorkbenchWindow({preload:join(host,'out/preload/index.js'),renderer:join(host,'out/renderer/index.html'),icon:join(host,'build/icon.png')})
    writeFileSync(join(output,'window-state.log'),'')
    const configure=screen.configure.bind(screen)
    screen.configure=(id,input)=>{const before=screen.state();const result=configure(id,input);appendFileSync(join(output,'window-state.log'),JSON.stringify({id,input,before,result})+'\n');return result}
    const store=shellPreferenceStore(join(output,'product-shell.json'));store.write({version:1,form:'standard',view:'overview'})
    const product=new ProductShell(store.read(),store.write,{hudAvailable:()=>true,standard:()=>main?.show(),hud:()=>hud.open(),screen:()=>screen.open(),hideStandard:()=>main?.hide(),hideHud:()=>hud.hide()},s=>broadcast('codepulse:shell-status',s))
    registerProductIpc(ipcMain,product,screen)
    const ambient=new AmbientService({
      config:{...DEFAULT_AMBIENT,enabled:false,xEnabled:true,memeEnabled:false,quietStart:0,quietEnd:0,idleOnly:false},
      status:()=>hub.snapshot(),key:()=> 'fixture-key',save:()=>{},changed:()=>broadcast('codepulse:ambient-status',ambient.snapshot()),
      request:async()=>({tweets:[{id:'12345',author:{userName:'Polymarket'},text:'TEST FIXTURE — this is a screen integration test, not a real news post.',createdAt:new Date().toISOString(),likeCount:9000}]}),image:async()=>'',
    })
    const projector=createDeviceDisplayProjector(join(output,'device-order.json'))
    const device=(draft?:DeviceDisplayConfig)=>({config,status:withAmbient(projector(hub.snapshot(),draft??config),draft?undefined:ambient.current()),serverAvailable:false})
    registerAmbientIpc(ipcMain,{service:ambient,setKey:()=>ambient.snapshot()},()=>device().status,async()=>{})
    const handlers: Record<string, (...args:any[])=>any>={
      'get-status':(event)=>hud.owns(event.sender)?hud.snapshot():hub.snapshot(),'sync-sessions':(event)=>hud.owns(event.sender)?hud.snapshot():hub.snapshot(),
      'detect-agents':()=>[],'get-update':()=>null,'get-version':()=> '1.4.11','get-notifications':()=>false,'set-notifications':(_e,v)=>v,
      'get-usage':()=>null,'mimo-login-status':()=>false,'set-locale':(_e,v)=>v,'set-window-theme':(_e,v)=>v,
      'get-device-display':(_e,draft)=>device(draft),'set-device-display':(_e,value)=>{config=normalizeDeviceDisplay(value);const next=device();broadcast('codepulse:device-display',next);return next},
      'get-device-provisioning':()=>({serverAvailable:false,scanning:false,devices:[],displays:[],phase:'idle',updatedAt:Date.now()}),
      'start-device-scan':()=>({serverAvailable:false,scanning:false,devices:[],displays:[],phase:'idle',updatedAt:Date.now()}),
      'stop-device-scan':()=>({serverAvailable:false,scanning:false,devices:[],displays:[],phase:'idle',updatedAt:Date.now()}),
      'ack':()=>{throw Error('A presentation action must not acknowledge tasks')},
    }
    for(const [name,run]of Object.entries(handlers))ipcMain.handle('codepulse:'+name,run)
    main=new BrowserWindow({show:false,width:1120,height:820,webPreferences:{preload:join(host,'out/preload/index.js'),sandbox:false,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}})
    await main.loadFile(join(host,'out/renderer/index.html'));await wait(700);product.restore()
    await until(()=>main!.webContents.executeJavaScript(`Boolean(document.querySelector('.product-launch-grid'))`),'overview')
    if(!await main.webContents.executeJavaScript(`document.querySelector('[data-view=overview]').textContent.includes('总览')`)){await click(main,'.product-rail-footer button')}
    writeFileSync(join(output,'overview.png'),(await main.webContents.capturePage()).toPNG())
    await click(main,'[data-view=work]');assert.equal(product.snapshot().view,'work')
    await click(main,'[data-view=usage]');await button(main,'历史统计');assert.ok(await main.webContents.executeJavaScript(`document.body.textContent.includes('暂无可用的历史统计')`))
    assert.equal(await main.webContents.executeJavaScript(`getComputedStyle(document.querySelector('.product-quotas')).display`),'none')
    await click(main,'[data-view=ambient]');await click(main,'.ambient-panel input[type=checkbox]');await button(main,'保存设置');await button(main,'检查新内容')
    await until(()=>ambient.snapshot().cards.length===1,'content fixture');await button(main,'预览画面')
    await click(main,'[data-view=screen]');await until(()=>main!.webContents.executeJavaScript(`Boolean(document.querySelector('.screen-live canvas'))`),'live target')
    assert.ok(await main.webContents.executeJavaScript(`document.querySelector('.screen-context').textContent.includes('桌边动态')`))
    // Applying the layout uses a separate draft; it cannot replace an active content card.
    await button(main,'显示配置');await button(main,'用量看板');await button(main,'应用配置');assert.equal(config.mode,'usage')
    await button(main,'当前画面');assert.ok(device().status.ambient)
    await button(main,'独立打开 ↗')
    await until(()=>BrowserWindow.getAllWindows().some(w=>w.getTitle().includes('屏幕工作台')),'screen window')
    const screenWindow=BrowserWindow.getAllWindows().find(w=>w.getTitle().includes('屏幕工作台'))!
    await until(()=>screenWindow.webContents.executeJavaScript(`Boolean(document.querySelector('.screen-live canvas'))`),'screen renderer')
    await until(()=>screenWindow.webContents.executeJavaScript(`document.querySelector('.screen-live .device-preview')?.getAttribute('data-render-state')==='ready'`),'real Wasm screen pixels')
    // Built canvas must be exactly the committed production C/Wasm frame.
    const render = await createDeviceRenderer(readFileSync('apps/desktop/src/renderer/src/device-preview/renderer.wasm'))
    const rendered = await screenWindow.webContents.executeJavaScript(`Array.from(document.querySelector('.screen-live canvas').getContext('2d').getImageData(0,0,400,300).data)`)
    assert.deepEqual(rendered, Array.from(frameToRgba(render(device().status))))
    await button(screenWindow,'置顶')
    const nativePinApplied=screen.state().pinned
    if (!nativePinApplied) assert.ok(await screenWindow.webContents.executeJavaScript(`document.body.textContent.includes('系统未应用置顶设置')`),'report OS limitation without claiming success')
    await assert.rejects(main.webContents.executeJavaScript(`window.codepulse.setWorkbenchWindow({pinned:true})`))
    // Cross-window update: a clean draft follows, a dirty draft is retained.
    await button(screenWindow,'显示配置');await button(screenWindow,'工作状态')
    await main.webContents.executeJavaScript(`window.codepulse.setDeviceDisplay({...${JSON.stringify(config)},metric:'used'})`);await wait()
    assert.ok(await screenWindow.webContents.executeJavaScript(`document.body.textContent.includes('保留你的未保存修改')`))
    await button(screenWindow,'当前画面');ambient.dismiss();await wait(500)
    assert.ok(await screenWindow.webContents.executeJavaScript(`document.querySelector('.screen-context').textContent.includes('用量看板')`))
    writeFileSync(join(output,'device.json'),JSON.stringify(device().status,null,2))
    await button(screenWindow,'专注展示');await wait(1500);writeFileSync(join(output,'screen.png'),(await screenWindow.webContents.capturePage()).toPNG());await button(screenWindow,'退出展示')
    await new Promise<void>(resolve=>{screenWindow.webContents.once('did-finish-load',()=>resolve());screenWindow.webContents.reload()})
    await until(()=>screenWindow.webContents.executeJavaScript(`Array.from(document.querySelectorAll('button')).some(b=>b.textContent===${JSON.stringify(nativePinApplied ? '已置顶' : '置顶')})`),'native pin state after renderer reload')
    const savedOrder=JSON.stringify({version:1,workspaceKeys:['f:/example/new-project','f:/example/codepulse']})
    await main.webContents.executeJavaScript(`localStorage.setItem('codepulse:project-order-v1',${JSON.stringify(savedOrder)})`)
    const next=hub.snapshot();next.agents=[...next.agents,{...next.agents[0]!,workspacePath:'F:/example/new-project',externalSessionId:'order-fixture'}]
    screen.broadcast('codepulse:status',next);await wait()
    assert.equal(await main.webContents.executeJavaScript(`localStorage.getItem('codepulse:project-order-v1')`),savedOrder,'screen must not rewrite standard project ordering')
    await main.webContents.executeJavaScript(`window.codepulse.selectDesktopForm('hud')`)
    await until(()=>BrowserWindow.getAllWindows().some(w=>w.getTitle()==='CodePulse HUD'),'HUD window')
    const hudWindow=BrowserWindow.getAllWindows().find(w=>w.getTitle()==='CodePulse HUD')!
    await until(()=>hudWindow.webContents.executeJavaScript(`Boolean(document.querySelector('.surface-controls.is-compact'))`),'HUD navigation')
    assert.equal(visible.get(main.id),false);assert.equal(product.snapshot().form,'hud');assert.equal(store.read().form,'hud')
    assert.ok(visible.get(screenWindow.id),'independent workbench must remain open')
    writeFileSync(join(output,'hud.png'),(await hudWindow.webContents.capturePage()).toPNG())
    await button(hudWindow,'标准');assert.equal(visible.get(main.id),true);assert.equal(visible.get(hudWindow.id),false)
    await click(main,'[aria-label=设置]');await button(main,'X 与 meme');assert.equal(product.snapshot().view,'ambient')
    assert.equal(await main.webContents.executeJavaScript(`Boolean(document.querySelector('.settings-close'))`),false,'module shortcut closes settings')
    await click(main,'[aria-label=设置]');await click(main,'.theme-swatch-dark');await wait(500)
    // The swatch itself bubbles through its button.
    await main.webContents.executeJavaScript(`document.querySelector('.settings-close').click()`);await wait()
    await click(main,'[data-view=overview]');writeFileSync(join(output,'overview-dark.png'),(await main.webContents.capturePage()).toPNG())
    main.setSize(720,600);await wait(300);writeFileSync(join(output,'compact.png'),(await main.webContents.capturePage()).toPNG())
    assert.equal(await main.webContents.executeJavaScript(`document.documentElement.scrollWidth <= window.innerWidth`),true)
    assert.equal(JSON.stringify(hub.snapshot().agents),before,'view actions must preserve canonical task state')
    hub.ingest({id:'shell-attention',source:'codex',eventType:'permission_request',externalSessionId:'shell-ui',workspacePath:'F:/example/codepulse',toolName:'shell',timestamp:Date.now()})
    const attentionState=JSON.stringify(hub.snapshot().agents)
    broadcast('codepulse:status',hub.snapshot());ambient.tick()
    await until(()=>main!.webContents.executeJavaScript(`Boolean(document.querySelector('.product-attention button'))`),'global work attention')
    await button(main,'查看工作');assert.equal(product.snapshot().view,'work')
    assert.equal(JSON.stringify(hub.snapshot().agents),attentionState,'opening attention must not acknowledge the task')
    // The expected unauthorized native-window rejection is visible to Electron's console.
    const unexpected=errors.filter(e=>!e.includes('Only the screen window'))
    assert.deepEqual(unexpected,[])
    writeFileSync(join(output,'result.json'),JSON.stringify({passed:true,views:5,modeSwitch:true,independentScreen:true,draftPreserved:true,settingsShortcuts:true,globalAttention:true,canonicalStatePreserved:true,nativePinApplied,errors:unexpected},null,2))
    ambient.stop();BrowserWindow.getAllWindows().forEach(w=>w.destroy());screen.destroy();clearTimeout(deadline);app.exit(0)
  }catch(error){writeFileSync(join(output,'failure.txt'),(error instanceof Error ? error.stack : String(error))+'\n'+JSON.stringify(errors));clearTimeout(deadline);app.exit(1)}
})
