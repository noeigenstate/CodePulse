import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { orderDeviceThreadSources, reconcileDeviceThreadOrder, normalizeDeviceThreadOrder,
  deviceThreadId, DEVICE_ORDER_LIMIT, StatusHub } from '@codepulse/core'
import { hudProviderRank, normalizeDeviceDisplay, TurnState, type AgentRuntimeState, type StatusSnapshot } from '@codepulse/shared'
import { startDeviceServer, DEVICE_AUTH_HEADER, DEVICE_STATUS_PATH } from '@codepulse/local-server'
import { createDeviceDisplayProjector } from '../apps/desktop/src/main/device-display-projection.js'

function agent(id: string, provider: AgentRuntimeState['agentType'] = 'codex', path = 'F:/private/' + id): AgentRuntimeState {
  return { agentType: provider, externalSessionId: id, workspacePath: path, taskTitle: id,
    state: TurnState.THINKING, lastEventAt: 100, unread: false, toolCallCount: 0, needPermission: false, needUserInput: false }
}
function snapshot(agents: AgentRuntimeState[]): StatusSnapshot { return { overall: 'running', updatedAt: 100, agents } }
const config = normalizeDeviceDisplay({ agents: ['codex','claude_code','grok'] })
const titles = (rows: AgentRuntimeState[]) => rows.map(r => r.taskTitle)

test('HUD provider rank and multi-agent project grouping keep independent sessions', () => {
  assert.deepEqual(['grok','codex','kimi','claude_code'].sort((a,b) => hudProviderRank(a as any)-hudProviderRank(b as any)), ['claude_code','codex','kimi','grok'])
  const codex = agent('codex-only'), grok = agent('grok', 'grok'), shared = agent('shared-codex', 'codex', 'F:/mixed')
  const claude = agent('shared-claude', 'claude_code', 'f:\\MIXED\\')
  const fork = agent('shared-fork', 'codex', 'F:/mixed')
  grok.state = TurnState.WAITING_PERMISSION
  const sources=[codex,grok,shared,claude,fork], original=structuredClone(sources)
  assert.deepEqual(titles(orderDeviceThreadSources(sources)), ['shared-claude','shared-codex','shared-fork','codex-only','grok'])
  assert.deepEqual(sources, original)
})

test('first-seen order survives activity, state, renames, disappearance and new arrivals', () => {
  const a=agent('older'), b=agent('newer'), c=agent('latest')
  let order=reconcileDeviceThreadOrder([a,b])
  a.state=TurnState.DONE; a.unread=true; b.lastEventAt=5000; b.state=TurnState.WAITING_PERMISSION
  a.taskTitle='renamed'
  assert.deepEqual(titles(orderDeviceThreadSources([b,a],order)), ['renamed','newer'])
  order=reconcileDeviceThreadOrder([b,c],order)
  assert.deepEqual(titles(orderDeviceThreadSources([c,b,a],order)), ['renamed','newer','latest'])
})

test('native session IDs stay stable; missing paths do not collapse unrelated tasks', () => {
  const a=agent('first'), b=agent('second')
  a.workspacePath=undefined; b.workspacePath=undefined
  const id=deviceThreadId(a)
  a.taskTitle='new title'; a.workspacePath='F:/moved'
  assert.equal(deviceThreadId(a),id)
  a.workspacePath=undefined
  assert.equal(orderDeviceThreadSources([a,b]).length,2)
})

test('bounded history discards absent entries first and retains live entries', () => {
  const sources=Array.from({length:DEVICE_ORDER_LIMIT+2},(_,i)=>agent(String(i)))
  const old=reconcileDeviceThreadOrder(sources)
  assert.equal(old.threads.length,DEVICE_ORDER_LIMIT+2)
  const live=sources.slice(2)
  const trimmed=reconcileDeviceThreadOrder(live,old)
  assert.equal(trimmed.threads.length,DEVICE_ORDER_LIMIT)
  assert.deepEqual(trimmed.threads,live.map(deviceThreadId))
  assert.deepEqual(normalizeDeviceThreadOrder({version:1,groups:[null,'bad',trimmed.groups[0],trimmed.groups[0]],threads:{}}),{version:2,groups:[trimmed.groups[0]],threads:[],threadGroups:{}})
})

test('one persisted projector keeps API/preview order, paging and configuration filters consistent', async () => {
  const dir=mkdtempSync(join(tmpdir(),'codepulse-order-')), path=join(dir,'order.json')
  const sources=Array.from({length:12},(_,i)=>agent('task-'+i,i<4?'claude_code':i<10?'codex':'grok'))
  let current=snapshot(sources)
  const hub=new StatusHub(); hub.snapshot=()=>current
  const project=createDeviceDisplayProjector(path)
  const first=project(current,config), firstCopy=structuredClone(current)
  current=snapshot([...sources].reverse())
  sources.forEach(a=>a.lastEventAt+=1000)
  const next=project(current,config)
  assert.deepEqual(next.threads,first.threads)
  assert.equal(next.revision,first.revision)
  assert.equal(first.threadTotal,12)
  const page=project(current,{...config,page:1})
  assert.deepEqual(page.threads!.map(t=>t.title),['task-9','task-10','task-11'])
  assert.equal(new Set([...first.threads!,...page.threads!].map(t=>t.id)).size,12)
  const saved=readFileSync(path,'utf8')
  assert.ok(!saved.includes('private') && !saved.includes('task-'))
  assert.equal(project(current,{...config,agents:['grok']}).threads!.length,2)
  assert.equal(readFileSync(path,'utf8'),saved)
  const restored=createDeviceDisplayProjector(path)
  assert.deepEqual(restored(current,config).threads,first.threads)
  assert.deepEqual(firstCopy.agents.map(a=>a.taskTitle),sources.map(a=>a.taskTitle))
  const server=await startDeviceServer({hub,projectStatus:restored,getDisplayConfig:()=>config,
    host:'127.0.0.1',port:0,authToken:'e'.repeat(32),serverId:'order-test',publishMdns:false})
  try {
    const response=await fetch(server.url+DEVICE_STATUS_PATH,{headers:{[DEVICE_AUTH_HEADER]:'e'.repeat(32)}})
    assert.deepEqual(await response.json(),restored(current,config))
  } finally { await server.close(); rmSync(dir,{recursive:true,force:true}) }
})

test('a corrupt save or failed atomic save cannot reorder the in-memory presentation', () => {
  const dir=mkdtempSync(join(tmpdir(),'codepulse-order-fail-')), path=join(dir,'order.json')
  try {
    writeFileSync(path,'invalid')
    const failures: unknown[]=[]
    const project=createDeviceDisplayProjector(path,e=>failures.push(e))
    mkdirSync(path+'.tmp')
    const a=agent('first'), b=agent('second')
    const first=project(snapshot([a,b]),config)
    assert.equal(failures.length,1)
    assert.deepEqual(project(snapshot([b,a]),config).threads,first.threads)
    assert.equal(readFileSync(path,'utf8'),'invalid')
  } finally { rmSync(dir,{recursive:true,force:true}) }
})

test('file URI/native path changes do not move a task or split its project group', () => {
  const a=agent('first','codex','F:/project grid'), b=agent('second','codex','F:/other')
  const order=reconcileDeviceThreadOrder([a,b])
  const original=structuredClone([a,b])
  for (const path of ['file:///F:/project%20grid','file://localhost/F:/project%20grid','f:\\project grid']) {
    a.workspacePath=path
    assert.deepEqual(titles(orderDeviceThreadSources([b,a],order)), ['first','second'])
    assert.equal(reconcileDeviceThreadOrder([a,b],order).groups.length,2)
    assert.equal(deviceThreadId(a),deviceThreadId(original[0]))
  }
  const claude=agent('same-group','claude_code','file:///F:/project%20grid')
  assert.deepEqual(titles(orderDeviceThreadSources([b,a,claude],order)),['same-group','first','second'])
  const unc=agent('unc','codex','\\\\server\\share\\folder')
  const remote=agent('uri','claude_code','file://server/share/folder')
  assert.equal(reconcileDeviceThreadOrder([unc,remote]).groups.length,1)
})


test('real hook/rollout cwd conflict cannot move the same session, including 3/6/9 cards', () => {
  for (const count of [3,6,9]) {
    const rows=Array.from({length:count},(_,i)=>agent('row-'+i,'codex','F:/project-'+i))
    let order=reconcileDeviceThreadOrder(rows)
    const expected=titles(orderDeviceThreadSources(rows,order))
    const original=structuredClone(rows)
    for (let i=0;i<40;i++) {
      // Actual failure: native metadata says project-B while tool hooks say
      // project-A, joining another live task's group and moving the card.
      rows[2].workspacePath=i%2?'file:///F:/project-2':'F:/project-0'
      rows[2].state=i%2?TurnState.THINKING:TurnState.WAITING_PERMISSION
      rows[2].lastEventAt+=1000
      const shuffled=[...rows].reverse()
      order=reconcileDeviceThreadOrder(shuffled,order)
      assert.deepEqual(titles(orderDeviceThreadSources(shuffled,order)),expected)
      assert.equal(order.groups.length,count)
    }
    rows[2].workspacePath=undefined
    assert.deepEqual(titles(orderDeviceThreadSources(rows,order)),expected)
    assert.equal(order.threadGroups[deviceThreadId(rows[2])],reconcileDeviceThreadOrder(original).threadGroups[deviceThreadId(original[2])])
  }
})

test('v1 order migrates once; saved membership survives cwd conflicts, absence and app restart', () => {
  const dir=mkdtempSync(join(tmpdir(),'codepulse-order-migration-')),path=join(dir,'order.json')
  try {
    const a=agent('A'),b=agent('B'),c=agent('C'),rows=[a,b,c]
    const seeded=reconcileDeviceThreadOrder(rows)
    writeFileSync(path,JSON.stringify({version:1,groups:seeded.groups,threads:seeded.threads}))
    let project=createDeviceDisplayProjector(path)
    const expected=project(snapshot(rows),config).threads!.map(t=>t.id)
    assert.equal(JSON.parse(readFileSync(path,'utf8')).version,2)
    const saved=readFileSync(path,'utf8')
    c.workspacePath=a.workspacePath;c.state=TurnState.WAITING_PERMISSION
    for (let i=0;i<3;i++) {
      project=createDeviceDisplayProjector(path)
      const output=project(snapshot([c,b,a]),config)
      assert.deepEqual(output.threads!.map(t=>t.id),expected)
      assert.equal(output.threads![2].state,'waiting_permission')
      assert.equal(readFileSync(path,'utf8'),saved)
    }
    project(snapshot([b]),config)
    c.workspacePath='file:///F:/another';c.taskTitle='renamed task'
    assert.deepEqual(project(snapshot([c,b,a]),config).threads!.map(t=>t.id),expected)
    assert.equal(c.workspacePath,'file:///F:/another') // Never rewrite canonical data.
    assert.ok(!saved.includes('private')&&!saved.includes('project'))
  } finally { rmSync(dir,{recursive:true,force:true}) }
})

test('bound groups preserve HUD provider priority, adjacency and trim invalid memberships', () => {
  const a=agent('A','codex','F:/shared'),b=agent('B','claude_code','F:/shared'),c=agent('C')
  const order=reconcileDeviceThreadOrder([c,a,b])
  b.workspacePath='F:/tool-work';a.workspacePath=undefined
  assert.deepEqual(titles(orderDeviceThreadSources([c,a,b],order)),['B','A','C'])
  const bad={...order,threadGroups:{...order.threadGroups,['a'.repeat(24)]:'b'.repeat(24)}}
  assert.deepEqual(normalizeDeviceThreadOrder(bad),order)
  const many=Array.from({length:DEVICE_ORDER_LIMIT+2},(_,i)=>agent(String(i)))
  const old=reconcileDeviceThreadOrder(many)
  const next=reconcileDeviceThreadOrder(many.slice(2),old)
  assert.equal(Object.keys(next.threadGroups).length,DEVICE_ORDER_LIMIT)
  assert.ok(!(deviceThreadId(many[0]) in next.threadGroups))
})
