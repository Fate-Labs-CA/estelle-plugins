import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { handleHook, drainOne } from '../runtime/hooks.mjs';
import { stateDirectory } from '../runtime/io.mjs';

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

test('auth context changes state partition before capture and never weakens credential protection',async t=>{
 const f=await fixture(t);let auth=0;
 const output=await handleHook({host:'claude-code',payload:{...f.payload,hook_event_name:'PreToolUse',
  tool_name:'Write',tool_input:{file_path:'unsafe.txt',content:'key = "estelle_live_'+'x'.repeat(40)+'"'}},
  stateDir:f.stateDir,request:f.request,requestContext:async()=>{auth++;throw Error('capture_private');}});
 assert.equal(output.hookSpecificOutput.permissionDecision,'deny');assert.equal(auth,0);assert.equal(f.calls.length,0);
 const target=stateDirectory({ESTELLE_PLUGIN_DATA:join(f.home,'state')},'a'.repeat(32));
 await handleHook({host:'claude-code',payload:f.payload,stateDir:f.stateDir,
  request:async()=>assert.fail('canonical request must not run'),requestContext:async()=>{
   auth++;return{stateDir:target,request:f.request,captureOnly:true};}});
 assert.equal(auth,1);assert(f.calls.length>0&&f.calls.every(x=>x.route==='/session/events'));
 assert.equal(JSON.parse(await readFile(join(target,'status','claude-code-stream.json'))).status,'ok');
 assert.notEqual(target,stateDirectory({ESTELLE_PLUGIN_DATA:join(f.home,'state')}));
 assert.throws(()=>stateDirectory({ESTELLE_PLUGIN_DATA:f.home},'../escape'),/capture_binding_changed/);
});
