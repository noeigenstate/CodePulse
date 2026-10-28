import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { StatusHub, toDeviceStatusV1, deviceThreadId, normalizeEvent } from '@codepulse/core'
import { TurnState, normalizeDeviceDisplay, buildWorkPresentation, buildProjectDeckGroups, buildProjectUsageSummaries, hudStateLevel, type AgentRuntimeState, type StatusSnapshot } from '@codepulse/shared'
import { HudProjection } from '../apps/desktop/src/main/hud-projection.js'

const now = 1_800_000_000_000
const row = (id: string, state: AgentRuntimeState['state'] = TurnState.THINKING): AgentRuntimeState => ({ agentType: 'codex', externalSessionId: id, workspacePath: '/private/project', taskTitle: id, state, toolCallCount: 0, needPermission: false, needUserInput: false, unread: false, lastEventAt: now })
const source = (agents: AgentRuntimeState[]): StatusSnapshot => ({ agents, overall: 'running', updatedAt: now })
const config = normalizeDeviceDisplay({})
function compare(snapshot: StatusSnapshot) {
  const panels = buildWorkPresentation(snapshot).panels
  const cards = buildProjectDeckGroups(panels).flatMap(g => g.cards)
  const device = toDeviceStatusV1(snapshot, config)
  assert.deepEqual(device.threads?.map(t => [t.id,t.level,t.unread]),cards.map(c => [deviceThreadId(c.agent),hudStateLevel(c.agent),c.agent.unread]))
  assert.ok(!JSON.stringify(device).includes('/private/'))
  return device
}
test('HUD and e-paper retain idle/read result cards until the same deadline', () => {
  const projection = new HudProjection()
  const idle = row('idle',TurnState.IDLE), read = {...row('read',TurnState.DONE),terminalAt:now}
  const unread = {...row('unread',TurnState.DONE),unread:true,terminalAt:now}
  const input = source([idle,read,unread,row('busy')])
  assert.equal(compare(projection.snapshot(input,now + 5*60_000)).threadTotal,4)
  assert.equal(compare(projection.snapshot(input,now + 30*60_000)).threadTotal,2)
  assert.equal(input.agents.some(a=>a.taskHidden),false)
  projection.setRetention(60)
  assert.equal(compare(projection.snapshot(input,now + 31*60_000)).threadTotal,4)
})
test('shared dismissal, new activity, provider grouping and first-seen order survive restart', () => {
  const dir=mkdtempSync(join(tmpdir(),'codepulse-work-order-'))
  try {
    const path=join(dir,'workspaces.json'), projection=new HudProjection(path)
    const input=source([row('one'),row('two'),{...row('claude'),agentType:'claude_code'}])
    const first=compare(projection.snapshot(input,now))
    input.agents.reverse()
    assert.deepEqual(compare(projection.snapshot(input,now+1)).threads?.map(t=>t.id),first.threads?.map(t=>t.id))
    assert.deepEqual(compare(new HudProjection(path).snapshot(input,now+1)).threads?.map(t=>t.id),first.threads?.map(t=>t.id))
    projection.dismiss(input,'codex',undefined,'one')
    assert.equal(compare(projection.snapshot(input,now+2)).threadTotal,2)
    input.agents.find(a=>a.externalSessionId==='one')!.toolCallCount++
    assert.equal(compare(projection.snapshot(input,now+3)).threadTotal,3)
  } finally { rmSync(dir,{recursive:true,force:true}) }
})
test('device summary is exactly the HUD footer, including real five-hour and weekly values', () => {
  const input=source([{...row('claude'),agentType:'claude_code',token:{rateLimits:{fiveHour:{usedPercent:27,windowMinutes:300},sevenDay:{usedPercent:61,windowMinutes:10080}},accuracy:'exact'}}])
  const snapshot=new HudProjection().snapshot(input,now)
  const summary=buildProjectUsageSummaries(buildWorkPresentation(snapshot).panels)[0]!
  const device=compare(snapshot)
  assert.deepEqual(device.agents[0]!.quotaSummary,{fiveHourUsedPercent:summary.fiveHourPercent,weeklyUsedPercent:summary.sevenDayPercent})
  assert.equal(device.agents[0]!.quotas[0]!.fiveHour!.usedPercent,27)
  assert.equal(device.agents[0]!.quotas[0]!.weekly!.usedPercent,61)
})
test('retained hub source remains available after canonical expiry', () => {
  const hub=new StatusHub(), projection=new HudProjection()
  hub.setPresentationRetention((agent,time)=>projection.shouldRetain(agent,time))
  hub.ingest(normalizeEvent({source:'codex',eventType:'session_start',externalSessionId:'idle',workspacePath:'/private/project',timestamp:now}))
  // Trigger the real pruning path, not just the read projection.
  ;(hub as unknown as { tick(time:number):void }).tick(now+5*60_000)
  assert.equal(hub.snapshot(now+5*60_000).agents.length,0)
  // No second data store: the same canonical row is retained for presentation.
  assert.equal(compare(projection.snapshot(hub.snapshotForPresentation(now+5*60_000),now+5*60_000)).threadTotal,1)
})

test('a HUD attention card without a workspace/session is not silently filtered by the device',()=>{
 const snapshot=new HudProjection().snapshot(source([{...row('unbound',TurnState.WAITING_PERMISSION),externalSessionId:undefined,workspacePath:undefined}]),now)
 assert.equal(compare(snapshot).threadTotal,1)
})

test('acknowledged errors are quiet and do not override active work in the device summary',()=>{
 const input=source([{...row('read-error',TurnState.ERROR),terminalAt:now},row('working')])
 const device=compare(new HudProjection().snapshot(input,now))
 assert.equal(device.agents[0]?.state,'thinking')
 assert.equal(device.agents[0]?.needsAttention,false)
})
