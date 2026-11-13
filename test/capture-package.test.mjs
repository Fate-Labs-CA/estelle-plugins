import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, cp, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const BUNDLE=fileURLToPath(new URL('../plugins/codex/',import.meta.url));
function fixturePort(log) {
 return `const https=require('node:https'),http=require('node:http'),child=require('node:child_process');
const{EventEmitter}=require('node:events');const fs=require('node:fs');
const{syncBuiltinESMExports}=require('node:module');
https.request=(url,options,callback)=>{
 if(!['https://api.fatelabs.ca/oauth/token','https://api.fatelabs.ca/oauth/revoke','https://api.fatelabs.ca/session/events'].includes(url))throw Error('owned_fixture_route');
 const req=new EventEmitter();req.end=body=>{fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({path:new URL(url).pathname})+'\\n');
 const value=url.endsWith('/oauth/token')?{token_type:'Bearer',scope:'estelle:mcp estelle:capture offline_access',expires_in:3600,access_token:'synthetic-installed-access',refresh_token:'synthetic-installed-refresh'}:
 url.endsWith('/oauth/revoke')?{revoked:true}:{receipts:JSON.parse(body).events.map((e,i)=>({event_id:e.event_id,seq:i+1,duplicate:false})),conflicts:[]};
 queueMicrotask(()=>{const res=new EventEmitter();res.statusCode=200;res.destroy=()=>{};callback(res);res.emit('data',Buffer.from(JSON.stringify(value)));res.emit('end');});};return req;
};
child.execFile=(name,args,options,callback)=>{
 if(!['open','xdg-open'].includes(name)||args.length!==1)throw Error('owned_fixture_native');
 const authorize=new URL(args[0]);if(authorize.origin!=='https://api.fatelabs.ca')throw Error('owned_fixture_origin');
 const target=new URL(authorize.searchParams.get('redirect_uri'));if(target.hostname!=='127.0.0.1')throw Error('owned_fixture_loopback');
 target.search=new URLSearchParams({code:'installed-owned-code',state:authorize.searchParams.get('state'),iss:'https://api.fatelabs.ca'});
 const req=http.get(target,{agent:false},res=>{res.resume();res.on('end',()=>callback(res.statusCode===200?null:Error('owned_fixture_callback')));});req.on('error',callback);
};syncBuiltinESMExports();`;
}

test('actual copied native CLI signs in, captures with its private owner, diagnoses scope and signs out',async t=>{
 const home=await mkdtemp(join(tmpdir(),'estelle-capture-installed-'));
 t.after(()=>rm(home,{recursive:true,force:true}));
 const bundle=join(home,'plugin');await cp(BUNDLE,bundle,{recursive:true});
 const preload=join(home,'owned-port.cjs'),log=join(home,'requests.jsonl');await writeFile(preload,fixturePort(log));
 const env={PATH:process.env.PATH,HOME:home,USERPROFILE:home,NODE_OPTIONS:`--require=${preload}`};
 const run=(args,input)=>spawnSync(process.execPath,[join(bundle,'runtime/cli.mjs'),...args],
  {env,input,encoding:'utf8',timeout:5000,maxBuffer:16000});
 const signed=run(['setup','codex','--login']);
 if(process.platform!=='win32')assert.match(signed.stderr,/^Sign in to Estelle at: https:\/\/api\.fatelabs\.ca\/oauth\/authorize\?\S+\n$/);
 if(process.platform==='win32'){
  assert.equal(signed.status,1);assert.equal(JSON.parse(signed.stdout).status,'pending_unsupported_platform');
  await assert.rejects(readFile(log),{code:'ENOENT'});return;
 }
 assert.equal(signed.status,0);assert.equal(JSON.parse(signed.stdout).status,'capture_configured');
 const credential=JSON.parse(await readFile(join(home,'.estelle-plugins/capture-auth/credential.json')));
 assert.equal(credential.resource,'https://api.fatelabs.ca/mcp');
 const transcript=join(home,'session.jsonl');await writeFile(transcript,JSON.stringify({type:'user',uuid:'fixture-message',
  timestamp:'2026-11-02T00:00:00Z',message:{role:'user',content:[{type:'text',text:'owned synthetic session'}]}})+'\n');
 const captured=run(['hook','claude-code'],JSON.stringify({session_id:'installed-owned-session',cwd:home,
  transcript_path:transcript,hook_event_name:'Stop'}));assert.equal(captured.status,0);assert.equal(captured.stderr,'');
 const doctor=run(['doctor']);assert.equal(doctor.status,0);const status=JSON.parse(doctor.stdout);
 assert.equal(status.credential,'capture_scoped');assert.equal(status.mcp_auth,'not_probed');
 assert(status.status.some(x=>x.mode==='stream'&&x.status==='ok'));
 const canonicalSetup=run(['setup','codex','--apply']);assert.equal(canonicalSetup.status,1);
 assert.equal(JSON.parse(canonicalSetup.stdout).status,'pending_auth','capture does not authorize native MCP removal');
 const signedOut=run(['setup','codex','--logout']);assert.equal(signedOut.status,0);
 assert.equal(JSON.parse(signedOut.stdout).status,'capture_signed_out');
 assert.deepEqual((await readFile(log,'utf8')).trim().split('\n').map(x=>JSON.parse(x).path),
  ['/oauth/token','/session/events','/oauth/revoke']);
 await assert.rejects(readFile(join(home,'.estelle-plugins/capture-auth/credential.json')),{code:'ENOENT'});
 for(const value of [signed.stdout,captured.stdout,doctor.stdout,canonicalSetup.stdout,signedOut.stdout]){
  assert(!value.includes(credential.access_token));assert(!value.includes(credential.refresh_token));
 }
});
