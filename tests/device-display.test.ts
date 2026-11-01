import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { StatusHub, toDeviceStatusV1 } from '@codepulse/core'
import { startDeviceServer, DEVICE_AUTH_HEADER, DEVICE_STATUS_PATH } from '@codepulse/local-server'
import { TurnState, normalizeDeviceDisplay, deviceGridColumns, deviceDisplayQuota, type StatusSnapshot } from '@codepulse/shared'
import { readDeviceDisplayConfig, writeDeviceDisplayConfig } from '../apps/desktop/src/main/device-display-settings.js'

function snapshot(count: number): StatusSnapshot {
  return { overall: 'running', updatedAt: 1000, agents: Array.from({length: count},(_,i)=>({
    agentType: i%2 ? 'claude_code' : 'codex', workspacePath: `/private/projects/线程${i}`,
    state: TurnState.THINKING, externalSessionId: `secret-session-${i}`, toolCallCount: 0,
    needPermission: false, needUserInput: false, lastEventAt: 1000, unread: false,
  })) }
}
test('display grid expands column-major in fixed groups of three',()=>{
  assert.deepEqual([1,3,4,6,7,9].map(deviceGridColumns),[1,1,2,2,3,3])
  const config=normalizeDeviceDisplay({})
  const s=snapshot(11), first=toDeviceStatusV1(s,config)
  assert.equal(first.threadTotal,11);assert.equal(first.threads?.length,9)
  assert.deepEqual(first.threads?.map(t=>t.title),[1,3,5,7,9,0,2,4,6].map(i=>`线程${i}`))
  const second=toDeviceStatusV1(s,{...config,page:1})
  assert.deepEqual(second.threads?.map(t=>t.title),['线程8','线程10'])
  assert.equal(toDeviceStatusV1(s,{...config,page:999}).display?.page,1)
  s.agents[0]!.state=TurnState.WAITING_PERMISSION
  const changed=toDeviceStatusV1(s,config)
  assert.deepEqual(changed.threads?.map(t=>t.id),first.threads?.map(t=>t.id))
  assert.notEqual(changed.revision,first.revision)
  const data=JSON.stringify(changed)
  assert.ok(!data.includes('/private/'));assert.ok(!data.includes('secret-session'))
})
test('thread projection respects canonical dismissal, provider selection and UTF-8 bounds',()=>{
  const s=snapshot(5)
  s.agents[0]!.taskHidden=true
  s.agents[1]!.state=TurnState.DONE;s.agents[1]!.unread=false
  s.agents[2]!.state=TurnState.DONE;s.agents[2]!.unread=true
  s.agents[3]!.workspacePath='/private/'+ '中文字😀'.repeat(30)
  const d=toDeviceStatusV1(s,normalizeDeviceDisplay({}))
  assert.equal(d.threads?.length,4) // Read completion stays until the shared presentation deadline.
  for(const t of d.threads??[]) { assert.ok(Buffer.byteLength(t.title)<=96);assert.ok(!t.title.includes('\ufffd')) }
  assert.equal(toDeviceStatusV1(s,normalizeDeviceDisplay({agents:['codex']})).threads?.length,2)
  assert.equal(toDeviceStatusV1(s,normalizeDeviceDisplay({agents:[]})).threads?.length,0)
  assert.equal(toDeviceStatusV1(s).display,undefined)
})
test('configuration revision changes without mutating canonical data; timestamps stay quiet',()=>{
  const s=snapshot(2),copy=structuredClone(s),c=normalizeDeviceDisplay({})
  const before=toDeviceStatusV1(s,c)
  assert.notEqual(toDeviceStatusV1(s,{...c,mode:'usage'}).revision,before.revision)
  assert.notEqual(toDeviceStatusV1(s,{...c,metric:'used'}).revision,before.revision)
  assert.deepEqual(s,copy)
  s.updatedAt+=1000;s.agents.forEach(a=>a.lastEventAt+=1000)
  assert.equal(toDeviceStatusV1(s,c).revision,before.revision)
})
test('display settings normalize, persist and preserve old configuration when atomic replacement fails',()=>{
  const dir=mkdtempSync(join(tmpdir(),'codepulse-display-')),path=join(dir,'display.json')
  try {
    assert.equal(readDeviceDisplayConfig(path).mode,'hud')
    writeDeviceDisplayConfig(path,{mode:'usage',agents:['grok','grok','unknown','codex'],page:-1})
    assert.deepEqual(readDeviceDisplayConfig(path).agents,['codex','grok'])
    assert.equal(readDeviceDisplayConfig(path).page,0)
    const original=readFileSync(path,'utf8');mkdirSync(`${path}.tmp`)
    assert.throws(()=>writeDeviceDisplayConfig(path,{mode:'hud'}))
    assert.equal(readFileSync(path,'utf8'),original)
    writeFileSync(path,'invalid json');assert.equal(readDeviceDisplayConfig(path).mode,'hud')
  } finally { rmSync(dir,{recursive:true,force:true}) }
})
test('preview quota picks same model bucket and skips unknown windows',()=>{
  const a=toDeviceStatusV1(snapshot(1)).agents[0]!
  const window={usedPercent:20,resetsAt:null,windowMinutes:null}
  a.model='spark';a.quotas=[{id:'codex',name:null,weekly:window,fiveHour:null},{id:'codex_spark',name:null,weekly:{...window,usedPercent:90},fiveHour:null}]
  assert.equal(deviceDisplayQuota(a)?.weekly?.usedPercent,90)
  a.model='gpt';assert.equal(deviceDisplayQuota(a)?.weekly?.usedPercent,20)
  a.quotas[0]!.weekly=null;assert.equal(deviceDisplayQuota(a)?.weekly?.usedPercent,90)
})
test('saved display configuration invalidates conditional GET without a new agent event',async()=>{
  let config=normalizeDeviceDisplay({mode:'usage'})
  const server=await startDeviceServer({hub:new StatusHub(),getDisplayConfig:()=>config,host:'127.0.0.1',port:0,authToken:'d'.repeat(32),serverId:'display-test',publishMdns:false})
  try {
    const url=server.url+DEVICE_STATUS_PATH,headers={[DEVICE_AUTH_HEADER]:'d'.repeat(32)}
    const first=await fetch(url,{headers}),etag=first.headers.get('etag')!
    assert.equal((await first.json()).display.mode,'usage')
    const unchanged=await fetch(url,{headers:{...headers,'if-none-match':etag}})
    assert.equal(unchanged.status,304)
    config={...config,mode:'hud'}
    const next=await fetch(url,{headers:{...headers,'if-none-match':etag}})
    assert.equal(next.status,200);assert.notEqual(next.headers.get('etag'),etag)
    assert.equal((await next.json()).display.mode,'hud')
    assert.equal((await fetch(url)).status,401)
  } finally {await server.close()}
})


test('same-workspace native sessions remain distinct and valid across device pages', () => {
  const hub = new StatusHub({ sessionThrottleMs: 0 })
  for (let i = 0; i < 11; i++) {
    hub.ingest({
      id: `device-concurrent-${i}`, source: 'codex', eventType: 'prompt_submit',
      externalSessionId: `private-native-${i}`, cwd: 'F:/private/shared-project',
      timestamp: 1000 + i,
    })
  }
  const state = hub.snapshot(2000), original = structuredClone(state)
  const config = normalizeDeviceDisplay({ agents: ['codex'] })
  const first = toDeviceStatusV1(state, config)
  const second = toDeviceStatusV1(state, { ...config, page: 1 })
  assert.equal(first.threadTotal, 11)
  assert.equal(first.threads?.length, 9)
  assert.equal(second.threads?.length, 2)
  const rows = [...first.threads!, ...second.threads!]
  assert.equal(new Set(rows.map(row => row.id)).size, 11)
  assert.ok(rows.every(row => /^[a-f0-9]{24}$/.test(row.id)))
  assert.ok(rows.every(row => row.title === 'shared-project'))
  assert.ok(!JSON.stringify(first).includes('private-native-'))
  assert.ok(!JSON.stringify(first).includes('F:/private'))
  assert.deepEqual(state, original)
})

test('device identity follows a session through state/path changes and distinguishes fallback scopes', () => {
  const state = snapshot(1)
  const a = state.agents[0]!
  state.agents = [a, { ...a, externalSessionId: undefined },
    { ...a, agentType: 'claude_code' },
    { ...a, externalSessionId: a.workspacePath }]
  const config = normalizeDeviceDisplay({})
  const before = toDeviceStatusV1(state, config)
  assert.equal(new Set(before.threads!.map(row => row.id)).size, 4)
  const originalId = before.threads!.find(t => t.type === 'codex' && t.title === '线程0')!.id
  a.workspacePath = 'F:/private/renamed-project'
  a.state = TurnState.DONE
  a.unread = true
  a.lastEventAt += 1000
  const after = toDeviceStatusV1(state, config)
  assert.equal(after.threads!.find(t => t.id === originalId)!.state, 'done')
  assert.equal(after.threads!.length, 4)
})
