import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fromAntigravityHook } from '@codepulse/adapters'
import { StatusHub, normalizeEvent } from '@codepulse/core'
import { TurnState } from '@codepulse/shared'
import { configureAntigravityAgent, cleanupAgents } from '@codepulse/local-server'
import { detectAntigravityAgent } from '../packages/local-server/src/agent-detect.js'
const base={conversationId:'conversation-1',workspacePaths:['/project'],modelName:'gemini-test'}
const event=(name:string,extra:Record<string,unknown>={})=>fromAntigravityHook({...base,hook_event_name:name,...extra})
test('Antigravity loop state does not finish on model response or pending background jobs',()=>{
 const hub=new StatusHub()
 const send=(name:string,extra:Record<string,unknown>={})=>{const input=event(name,extra);if(input)hub.ingest(normalizeEvent(input));return hub.snapshot().agents[0]!}
 assert.equal(send('PreInvocation',{invocationNum:0}).state,TurnState.THINKING)
 assert.equal(send('PreToolUse',{toolCall:{name:'run_command'}}).toolCallCount,1)
 assert.equal(send('PreInvocation',{invocationNum:1}).toolCallCount,1)
 assert.equal(event('PostInvocation'),null)
 assert.equal(event('Stop',{fullyIdle:false,terminationReason:'model_stop'}),null)
 assert.equal(send('Stop',{fullyIdle:true,terminationReason:'model_stop'}).state,TurnState.DONE)
 const resumed=send('PreInvocation',{invocationNum:5})
 assert.equal(resumed.unread,false);assert.equal(resumed.toolCallCount,0);assert.equal(resumed.state,TurnState.THINKING)
 assert.equal(event('Stop',{fullyIdle:true,terminationReason:'error'})?.eventType,'turn_error')
 assert.equal(event('Stop',{fullyIdle:true,terminationReason:'max_steps_exceeded'})?.eventType,'turn_timeout')
 assert.equal(fromAntigravityHook({hook_event_name:'PreInvocation'}),null)
 assert.equal(event('PreInvocation')?.token,undefined)
})
test('Antigravity integration preserves other hooks, is idempotent and restores exact original file',async()=>{
 const home=await mkdtemp(join(tmpdir(),'codepulse-antigravity-'))
 try {
  const path=join(home,'.gemini','config','hooks.json'), hookBinDir=join(home,'.codepulse','hooks','bin')
  const options={homeDir:home,hookBinDir,env:{CODEPULSE_ANTIGRAVITY_HOOKS_FILE:path}}
  await mkdir(join(home,'.gemini','config'),{recursive:true})
  const original=JSON.stringify({personal:{enabled:true,Stop:[{command:'echo personal'}]}},null,4)+'\n'
  await writeFile(path,original)
  assert.equal((await configureAntigravityAgent(options)).configured,true)
  const configured=JSON.parse(await readFile(path,'utf8'))
  assert.deepEqual(configured.personal,JSON.parse(original).personal)
  assert.match(configured['codepulse-status'].PreToolUse[0].hooks[0].command,/antigravity-hook.js.* PreToolUse$/)
  assert.equal((await configureAntigravityAgent(options)).changed,false)
  assert.equal((await detectAntigravityAgent({...options,runCommand:async()=>({ok:false})})).configured,true)
  await cleanupAgents(options)
  assert.equal(await readFile(path,'utf8'),original)
  assert.equal((await configureAntigravityAgent({homeDir:home,hookBinDir,env:{}})).changed,false,'absent installation is not configured')
 }finally{await rm(home,{recursive:true,force:true})}
})
test('Antigravity refuses malformed config and an unrelated hook with the same key',async()=>{
 const home=await mkdtemp(join(tmpdir(),'codepulse-antigravity-conflict-'))
 try {
  const path=join(home,'hooks.json'),options={homeDir:home,hookBinDir:join(home,'hooks'),env:{CODEPULSE_ANTIGRAVITY_HOOKS_FILE:path}}
  for(const original of ['{broken',JSON.stringify({'codepulse-status':{enabled:true,Stop:[{command:'unrelated'}]}})]){
   await writeFile(path,original)
   assert.ok((await configureAntigravityAgent(options)).error)
   assert.equal(await readFile(path,'utf8'),original)
  }
 }finally{await rm(home,{recursive:true,force:true})}
})
