import assert from 'node:assert/strict'
import { test } from 'node:test'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'

for (const event of ['PreToolUse', 'Stop', 'PreInvocation']) {
 test('Antigravity hook observes '+event+' without changing approvals or loop flow',()=>{
  const input={conversationId:'synthetic-id',workspacePaths:['/synthetic'],toolCall:{name:'run_command',args:{CommandLine:'PRIVATE_TOOL_ARGUMENT'}},transcriptPath:'PRIVATE_TRANSCRIPT_PATH',fullyIdle:true}
  const script=`process.argv[2]=${JSON.stringify(event)};globalThis.fetch=async(_url,init)=>{process.stderr.write(init.body);return {ok:true}};await import(${JSON.stringify(pathToFileURL(resolve('packages/hooks/bin/antigravity-hook.js')).href)})`
  const result=spawnSync(process.execPath,['--input-type=module','-e',script],{input:JSON.stringify(input),encoding:'utf8',windowsHide:true,env:{...process.env,CODEPULSE_TOKEN:'synthetic-test-token'},timeout:5000})
  assert.equal(result.status,0,result.stderr)
  assert.deepEqual(JSON.parse(result.stdout),event==='PreInvocation'?{}:{decision:'allow'})
  const sent=JSON.parse(result.stderr)
  assert.equal(sent.hook_event_name,event)
  assert.equal(sent.conversationId,'synthetic-id')
  assert.equal(result.stderr.includes('PRIVATE_'),false)
 })
}
