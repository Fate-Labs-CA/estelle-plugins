import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { handleHook, drainOne } from '../runtime/hooks.mjs';
import { hash, stateDirectory } from '../runtime/io.mjs';

async function fixture(t) {
 const home=await mkdtemp(join(tmpdir(),'estelle-capture-hooks-'));
 t.after(()=>rm(home,{recursive:true,force:true}));
 const cwd=join(home,'repo');await mkdir(cwd);
 const env={PATH:process.env.PATH,HOME:home,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null'};
 for(const args of [['init','-q'],['remote','add','origin','https://github.com/fixture/capture.git']]){
  execFileSync('git',['-C',cwd,'-c','core.hooksPath=/dev/null',...args],{env,stdio:'ignore',timeout:2000});
 }
 const transcript=join(home,'native.jsonl');
 await writeFile(transcript,JSON.stringify({type:'user',uuid:'owned',timestamp:'2026-11-02T00:00:00Z',
  message:{role:'user',content:[{type:'text',text:'synthetic owned capture'}]}})+'\n');
 const stateDir=join(home,'capture-state'),calls=[];
 const request=async(route,body)=>{calls.push({route,body});
  if(route!=='/session/events')throw Error('capture_route');
  return {receipts:body.events.map((e,i)=>({event_id:e.event_id,seq:i+1,duplicate:false})),conflicts:[]};
 };
 const payload={session_id:'owned-native-session',cwd,transcript_path:transcript,hook_event_name:'Stop'};
 return {home,payload,stateDir,request,calls};
}

test('capture-only actual shared hook streams Git sessions but cannot recall, checkpoint or reindex',async t=>{
 const f=await fixture(t);
 for(const event of ['UserPromptSubmit','PostToolUse','Stop']){
  await handleHook({host:'claude-code',payload:{...f.payload,hook_event_name:event,prompt:'owned prompt',
   tool_name:'Write',tool_input:{file_path:'safe.ts',content:'ordinary code'}},
   stateDir:f.stateDir,request:f.request,captureOnly:true});
 }
 assert(f.calls.length>0);assert(f.calls.every(x=>x.route==='/session/events'));
 assert(f.calls.flatMap(x=>x.body.events).some(e=>e.kind==='customer_message'));
 assert.equal(f.calls[0].body.session_id,'claude-code-owned-native-session');
 await assert.rejects(readFile(join(f.stateDir,'status','claude-code-checkpoint.json')),{code:'ENOENT'});
 await assert.rejects(readFile(join(f.stateDir,'status','claude-code-reindex.json')),{code:'ENOENT'});
});

test('capture-only deferred drain uses stream acknowledgement without a fabricated checkpoint receipt',async t=>{
 const f=await fixture(t);
 await handleHook({host:'claude-code',payload:{...f.payload,hook_event_name:'SessionEnd'},
  stateDir:f.stateDir,request:f.request,captureOnly:true});
 assert.equal(f.calls.length,0);assert.equal((await readdir(join(f.stateDir,'deferred'))).length,1);
 await drainOne(f.stateDir,f.request,{captureOnly:true});
 assert(f.calls.length>0&&f.calls.every(x=>x.route==='/session/events'));
 assert.equal((await readdir(join(f.stateDir,'deferred'))).length,0);
 const count=f.calls.length;await drainOne(f.stateDir,f.request,{captureOnly:true});assert.equal(f.calls.length,count);
});

test('auth context changes state partition before capture and never touches the canonical request',async t=>{
 const f=await fixture(t);let auth=0;
 const target=stateDirectory({ESTELLE_PLUGIN_DATA:join(f.home,'state')},'a'.repeat(32));
 await handleHook({host:'claude-code',payload:f.payload,stateDir:f.stateDir,
  request:async()=>assert.fail('canonical request must not run'),requestContext:async()=>{
   auth++;return{stateDir:target,request:f.request,captureOnly:true};}});
 assert.equal(auth,1);assert(f.calls.length>0&&f.calls.every(x=>x.route==='/session/events'));
 assert.equal(JSON.parse(await readFile(join(target,'status','claude-code-stream.json'))).status,'ok');
 assert.notEqual(target,stateDirectory({ESTELLE_PLUGIN_DATA:join(f.home,'state')}));
 assert.throws(()=>stateDirectory({ESTELLE_PLUGIN_DATA:f.home},'../escape'),/capture_binding_changed/);
});

const KEY=['gh','p_'].join('')+'a'.repeat(30);
const unsafeWrite=f=>({...f.payload,hook_event_name:'PreToolUse',tool_name:'Write',
 tool_input:{file_path:'unsafe.txt',content:`k = "${KEY}"`}});

test('the write warning is still given when the capture credential cannot be read, and it does not stop the edit',async t=>{
 const f=await fixture(t);
 const output=await handleHook({host:'claude-code',payload:unsafeWrite(f),stateDir:f.stateDir,
  request:async()=>assert.fail('no request on a failed auth context'),
  requestContext:async()=>{throw Error('capture_private');}});
 assert.match(output.systemMessage,/Estelle warning: unsafe\.txt/);
 assert.notEqual(output.hookSpecificOutput?.permissionDecision,'deny');
 assert.equal(JSON.parse(await readFile(join(f.stateDir,'status','claude-code-capture.json'))).code,'capture_private');
});

test('a failed auth context with nothing to warn about is a hook failure, not a silent unauthenticated run',async t=>{
 const f=await fixture(t);
 await assert.rejects(handleHook({host:'claude-code',payload:f.payload,stateDir:f.stateDir,request:f.request,
  requestContext:async()=>{throw Error('capture_private');}}),/capture_private/);
 assert.equal(f.calls.length,0);
});

test('a stopped capture sign-in tells the person at session start, with the command, and calls nothing',async t=>{
 const f=await fixture(t);
 const output=await handleHook({host:'claude-code',payload:{...f.payload,hook_event_name:'SessionStart'},stateDir:f.stateDir,
  request:f.request,requestContext:async()=>{throw Error('capture_pending');}});
 assert.match(output.systemMessage,/not recording this session.*capture_pending.*\/estelle:login/);
 assert.match(output.hookSpecificOutput.additionalContext,/estelle_resume[\s\S]*\/estelle:login/);
 assert.equal(f.calls.length,0);
 assert.equal(JSON.parse(await readFile(join(f.stateDir,'status','claude-code-capture.json'))).code,'capture_pending');
});

for(const [host,payload,words] of [
 ['claude-code',{hook_event_name:'SessionStart'},o=>o.systemMessage],
 ['codex',{hook_event_name:'SessionStart',model:'gpt-5',permission_mode:'default',source:'startup'},o=>o.systemMessage],
 ['dsh',{hook_event_name:'SessionStart'},o=>o.context],
 ['cursor',{hook_event_name:'sessionStart',conversation_id:'owned-native-session'},o=>o.additional_context],
 ['kimi',{hook_event_name:'UserPromptSubmit',prompt:'hi'},o=>o.message],
 ['grok',{hookEventName:'pre_tool_use',sessionId:'owned-native-session',toolName:'Read',toolInput:{}},o=>o.hookSpecificOutput?.additionalContext],
]){
 test(`a stopped sign-in reaches ${host} once, in its own field`,async t=>{
  const f=await fixture(t);
  const send=()=>handleHook({host,payload:{...f.payload,...payload},stateDir:f.stateDir,request:f.request,
   requestContext:async()=>{throw Error('capture_pending');}});
  const first=await send();
  assert.match(words(first)??'',/not recording this session.*capture_pending/);
  const second=await send().catch(error=>error);
  assert.ok(second instanceof Error||!JSON.stringify(second??'').includes('not recording'),'said once per session');
  assert.equal(f.calls.length,0);
 });
}

test('someone with no sign-in is told once per session start how to fix it, and only then',async t=>{
 const f=await fixture(t);
 const send=event=>handleHook({host:'claude-code',payload:{...f.payload,hook_event_name:event},stateDir:f.stateDir,
  request:f.request,requestContext:async()=>({signedOut:true})});
 assert.match((await send('SessionStart')).systemMessage,/\/estelle:login/);
 assert.equal(JSON.stringify(await send('UserPromptSubmit')??'').includes('/estelle:login'),false);
});

test('the write warning still fires on a capture-only session and nothing but the stream route is called',async t=>{
 const f=await fixture(t);
 const output=await handleHook({host:'claude-code',payload:unsafeWrite(f),stateDir:f.stateDir,request:f.request,captureOnly:true});
 assert.match(output.systemMessage,/Estelle warning/);
 assert(f.calls.every(x=>x.route==='/session/events'));
});

test('capture-only Grok and Cursor never queue or deliver recall context',async t=>{
 for(const host of ['grok','cursor']){
  const f=await fixture(t),turn='turn-1',id=`captured-${host}`;
  const native=host==='grok'
   ?(name,extra)=>({hookEventName:name,sessionId:id,cwd:f.home+'/repo',promptId:turn,...extra})
   :(name,extra)=>({hook_event_name:name,conversation_id:id,generation_id:turn,workspace_roots:[f.home+'/repo'],...extra});
  const prompt=native(host==='grok'?'user_prompt_submit':'beforeSubmitPrompt',{prompt:'owned prompt'});
  const boundary=host==='grok'
   ?native('pre_tool_use',{toolName:'Read',toolInput:{file_path:'safe.ts'}})
   :native('postToolUse',{tool_name:'Read',tool_input:{file_path:'safe.ts'},tool_output:'{}'});
  // A recall some earlier, keyed session left behind must not be delivered by a capture-only hook either.
  const path=join(f.stateDir,'context',`${hash(`${host}:${id}`)}.json`);
  await mkdir(join(f.stateDir,'context'),{recursive:true});
  await writeFile(path,JSON.stringify({turnId:turn,requestId:'seed',text:'SEEDED-RECALL',degraded:false}));
  for(const payload of [prompt,boundary]){
   const output=await handleHook({host,payload,stateDir:f.stateDir,request:f.request,captureOnly:true});
   assert(!JSON.stringify(output??{}).includes('SEEDED-RECALL'),host);
  }
  assert.equal(JSON.parse(await readFile(path,'utf8')).text,'SEEDED-RECALL',`${host}: nothing was begun, claimed or taken`);
  assert(f.calls.every(x=>x.route==='/session/events'),host);
 }
});
