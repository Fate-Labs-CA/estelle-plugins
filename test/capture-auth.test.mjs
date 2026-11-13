import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs/promises';
import { get } from 'node:http';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CAPTURE_AUTH, CaptureCredentialOwner } from '../runtime/auth.mjs';
import { runCaptureSetup, captureHookContext, mcpHeaders, receiveCaptureCode } from '../runtime/capture-auth.mjs';
import { createHash } from 'node:crypto';

const response=()=>({token_type:'Bearer',scope:CAPTURE_AUTH.scope,expires_in:3600,
 access_token:'synthetic-access-token',refresh_token:'synthetic-refresh-token'});
async function unsupportedWindows() {
 if(process.platform!=='win32')return false;
 let effects=0;const result=await runCaptureSetup({host:'codex'},
  {owner:{locked:()=>{effects++;throw Error('no private mutation');}},open:()=>{effects++;},request:()=>{effects++;}});
 assert.equal(result.status,'pending_unsupported_platform');assert.equal(effects,0);return true;
}
async function fixture(t) {
 const home=await fs.mkdtemp(join(tmpdir(),'estelle-capture-auth-'));
 t.after(()=>fs.rm(home,{recursive:true,force:true}));
 return {home,owner:new CaptureCredentialOwner({home})};
}
function remote(replies) {
 const calls=[];
 return {calls,request:(url,options,callback)=>{
  const req=new EventEmitter();req.end=body=>{
   calls.push({url,options,body});const value=replies.shift();
   queueMicrotask(()=>{
    if(value===undefined){req.emit('error',Error('unexpected_fixture_request'));return;}
    if(value instanceof Error){
     // A real request that fails after the handshake: its body may have reached the server. Only a fixture
     // marked neverConnected models a failure with no connection, which is the one proof of "not sent".
     if(!value.neverConnected){const socket=new EventEmitter();req.emit('socket',socket);socket.emit('secureConnect');}
     req.emit('error',value);return;
    }
    const res=new EventEmitter();res.statusCode=value?.status||200;res.destroy=()=>{res.destroyed=true;};
    callback(res);res.emit('data',Buffer.from(value?.raw??JSON.stringify(value?.body??value)));
    if(!res.destroyed)res.emit('end');
   });
  };return req;
 }};
}
async function callback(url,{wrong=false}={}) {
 const authorize=new URL(url);assert.equal(authorize.origin,CAPTURE_AUTH.issuer);
 assert.equal(authorize.searchParams.get('client_id'),CAPTURE_AUTH.client);
 assert.equal(authorize.searchParams.get('scope'),CAPTURE_AUTH.scope);
 const target=new URL(authorize.searchParams.get('redirect_uri'));
 assert.equal(target.hostname,'127.0.0.1');
 target.search=new URLSearchParams({code:'synthetic-owned-code',
  state:wrong?'foreign-state':authorize.searchParams.get('state'),iss:CAPTURE_AUTH.issuer});
 return new Promise((resolve,reject)=>{
  const req=get(target,{agent:false},res=>{res.resume();res.on('end',()=>resolve(res.statusCode));});req.on('error',reject);
 });
}
async function seeded(t,expires=3600) {
 const {home,owner}=await fixture(t),port=remote([response()]);
 assert.equal((await runCaptureSetup({host:'codex',home},{...port,open:callback})).status,'capture_configured');
 await owner.locked(async state=>{await state.save({...state.record,expires_at:Math.floor(Date.now()/1000)+expires});});
 return {home,owner};
}

test('owned callback obtains a separate capture grant once; public result and browser argv contain no secret',async t=>{
 if(await unsupportedWindows())return;
 const {home,owner}=await fixture(t),port=remote([response()]);let authorize;
 const result=await runCaptureSetup({host:'codex',home},{...port,open:async url=>{authorize=url;assert.equal(await callback(url),200);}});
 assert.equal(result.status,'capture_configured');assert.equal(result.mcp_auth,'not_probed');
 const record=await owner.read();assert.equal(record.resource,CAPTURE_AUTH.resource);assert.equal(record.state,'active');
 assert.equal(port.calls.length,1);const call=port.calls[0],form=new URLSearchParams(call.body);
 assert.equal(call.url,CAPTURE_AUTH.issuer+'/oauth/token');assert.equal(call.options.agent,false);
 assert.equal(form.get('resource'),CAPTURE_AUTH.resource);assert.equal(form.get('code'),'synthetic-owned-code');
 assert.equal(form.get('client_id'),CAPTURE_AUTH.client);assert.equal(form.get('code_verifier').length,64);
 for(const secret of [record.access_token,record.refresh_token,form.get('code_verifier'),'synthetic-owned-code']){
  assert(!JSON.stringify(result).includes(secret));assert(!authorize.includes(secret));
 }
 assert.equal((await runCaptureSetup({host:'codex',home},port)).status,'capture_already_configured');assert.equal(port.calls.length,1);
});

test('wrong state and deadline close owned listeners without token exchange or credential',async t=>{
 if(await unsupportedWindows())return;
 const {home,owner}=await fixture(t),port=remote([response()]);let target,callbackStatus;
 assert.equal((await runCaptureSetup({host:'codex',home},{...port,open:async url=>{
  target=new URL(new URL(url).searchParams.get('redirect_uri'));callbackStatus=await callback(url,{wrong:true});
 }})).status,'pending_capture_auth');
 assert.equal(callbackStatus,400);assert.equal(port.calls.length,0);assert.equal(await owner.read(),null);
 await assert.rejects(new Promise((resolve,reject)=>{const req=get(target,{agent:false},resolve);req.on('error',reject);}),{code:'ECONNREFUSED'});
 await assert.rejects(receiveCaptureCode({state:'owned',challenge:'challenge',deadline:Date.now()+30,open:async()=>{}}),/capture_deadline/);
});

test('Windows profile and unsupported host refuse before touching credential owner or browser',async()=>{
 let effects=0;const owner={locked:async()=>{effects++;throw Error('must not read');}};
 const ports={owner,open:async()=>{effects++;},request:()=>{effects++;}};
 assert.equal((await runCaptureSetup({host:'codex'},{...ports,platform:'win32'})).status,'pending_unsupported_platform');
 assert.equal((await runCaptureSetup({host:'foreign'},ports)).status,
  process.platform==='win32'?'pending_unsupported_platform':'pending_unsupported_host');assert.equal(effects,0);
});

test('canonical environment bypasses private capture owner; capture cannot send to other resources',async t=>{
 let reads=0;assert.equal(await captureHookContext({env:{ESTELLE_API_KEY:'canonical'},owner:{read:async()=>{reads++;}}}),null);
 assert.equal(reads,0);if(await unsupportedWindows())return;
 const {owner}=await seeded(t),port=remote([{receipts:[]}]);
 const context=await captureHookContext({env:{},owner,...port});
 for(const path of ['/mcp','/work','/search','/checkpoint','/reindex','/settings/suite','/oauth/token','/oauth/revoke'])await assert.rejects(context.request(path,{}),/capture_route/);
 assert.equal(port.calls.length,0);await context.request('/session/events',{events:[]});
 assert.equal(port.calls[0].options.headers['X-Estelle-Capture-Only'],'1');
 assert.equal(port.calls[0].options.headers.Authorization,'Bearer synthetic-access-token');
 await assert.rejects(captureHookContext({env:{ESTELLE_API_URL:'https://foreign.invalid'},owner,...port}),/capture_origin/);
 assert.equal(port.calls.length,1);
});

test('refresh persists pending before dispatch and publishes replacement before capture; unknown never resends',async t=>{
 if(await unsupportedWindows())return;
 const {owner}=await seeded(t,0),port=remote([response(),{receipts:[]}]);
 const request=port.request;port.request=(url,options,cb)=>{
  const req=request(url,options,cb),end=req.end;
  req.end=body=>{if(url.endsWith('/oauth/token'))owner.read().then(value=>{
   assert.equal(value.state,'refresh_pending');end(body);
  }).catch(error=>req.emit('error',error));else end(body);};return req;
 };
 const context=await captureHookContext({env:{},owner,...port});await context.request('/session/events',{events:[]});
 assert.equal(port.calls.length,2);assert.equal((await owner.read()).state,'active');
 const {owner:unknown}=await seeded(t,0),failed=remote([Error('synthetic lost acknowledgement')]);
 const old=await captureHookContext({env:{},owner:unknown,...failed});
 await assert.rejects(old.request('/session/events',{}),/capture_transport_unknown/);
 assert.equal((await unknown.read()).state,'refresh_pending');
 await assert.rejects(old.request('/session/events',{}),/capture_pending/);
 await assert.rejects(captureHookContext({env:{},owner:unknown,...failed}),/capture_pending/);
 assert.equal(failed.calls.length,1);
});

test('late context cannot replay an old account partition; logout is explicit and unknown stays blocked',async t=>{
 if(await unsupportedWindows())return;
 const {home,owner}=await seeded(t),port=remote([{revoked:true}]);
 const old=await captureHookContext({env:{},owner,...port});
 const result=await runCaptureSetup({host:'codex',home,logout:true},port);
 assert.equal(result.status,'capture_signed_out');assert.equal(await owner.read(),null);
 await assert.rejects(old.request('/session/events',{}),/capture_binding_changed/);
 assert.equal(port.calls.length,1);
 const again=remote([response()]);assert.equal((await runCaptureSetup({host:'codex',home},{...again,open:callback})).status,'capture_configured');
 await assert.rejects(old.request('/session/events',{}),/capture_binding_changed/);
 const lost=remote([Error('synthetic lost revoke acknowledgement')]);
 assert.equal((await runCaptureSetup({host:'codex',home,logout:true},lost)).status,'pending_capture_auth');
 assert.equal((await owner.read()).state,'logout_pending');
 assert.equal(lost.calls.length,1);
 const retried=remote([{revoked:false}]);
 assert.equal((await runCaptureSetup({host:'codex',home,logout:true},retried)).status,'capture_signed_out');
 assert.equal(await owner.read(),null);assert.equal(retried.calls.length,1);
});

test('a refresh that never left the machine keeps the sign-in; the next hook refreshes and uploads',async t=>{
 if(await unsupportedWindows())return;
 const {owner}=await seeded(t,0),offline=remote([Object.assign(Error('offline'),{neverConnected:true})]);
 const first=await captureHookContext({env:{},owner,...offline});
 await assert.rejects(first.request('/session/events',{}),/capture_not_sent/);
 assert.equal((await owner.read()).state,'active');assert.equal(offline.calls.length,1);
 const back=remote([response(),{receipts:[]}]);
 const second=await captureHookContext({env:{},owner,...back});await second.request('/session/events',{});
 assert.deepEqual(back.calls.map(x=>new URL(x.url).pathname),['/oauth/token','/session/events']);
 assert.equal((await owner.read()).state,'active');
});

test('a real refused connection counts as never sent, through the real https client',async t=>{
 if(await unsupportedWindows())return;
 const {owner}=await seeded(t,0),{request:real}=await import('node:https');
 const closed=(url,options,cb)=>real('https://127.0.0.1:1'+new URL(url).pathname,options,cb);
 const context=await captureHookContext({env:{},owner,request:closed});
 await assert.rejects(context.request('/session/events',{}),/capture_not_sent/);
 assert.equal((await owner.read()).state,'active');
});

test('a sign-in stuck by a lost reply is replaced only by explicit new consent, on a new partition',async t=>{
 if(await unsupportedWindows())return;
 const {home,owner}=await seeded(t,0),before=(await owner.read()).partition,lost=remote([Error('lost acknowledgement')]);
 const old=await captureHookContext({env:{},owner,...lost});
 await assert.rejects(old.request('/session/events',{}),/capture_transport_unknown/);
 assert.equal((await owner.read()).state,'refresh_pending');
 const denied=remote([]);
 assert.equal((await runCaptureSetup({host:'codex',home,deadline:Date.now()+150},{...denied,open:async()=>{throw Error('capture_browser');}})).status,'pending_capture_auth');
 assert.equal((await owner.read()).state,'refresh_pending');assert.equal(denied.calls.length,0);
 const again=remote([response()]);
 assert.equal((await runCaptureSetup({host:'codex',home},{...again,open:callback})).status,'capture_configured');
 const record=await owner.read();assert.equal(record.state,'active');assert.notEqual(record.partition,before);
});

test('uploads do not take the lock, so one in flight refuses no other hook',async t=>{
 if(await unsupportedWindows())return;
 const {owner}=await seeded(t);let arrived,release;
 const began=new Promise(resolve=>arrived=resolve),go=new Promise(resolve=>release=resolve);
 const port=remote([{receipts:[]},{receipts:[]}]),request=port.request;let held=false;
 port.request=(url,options,cb)=>{
  const req=request(url,options,cb),end=req.end;
  req.end=body=>{if(!held){held=true;arrived();go.then(()=>end(body));}else end(body);};return req;
 };
 const context=await captureHookContext({env:{},owner,...port});
 const first=context.request('/session/events',{});await began;
 await context.request('/session/events',{});release();await first;
 assert.equal(port.calls.length,2);
});

for(const [name,reply] of [['503',{status:503,body:{error:'temporarily_unavailable'}}],['429',{status:429,body:{error:'slow_down'}}],
 ['a gateway error page',{status:502,raw:'<html>bad gateway</html>'}]]){
 test(`a refresh answered by ${name} keeps the sign-in, and the next hook refreshes`,async t=>{
  if(await unsupportedWindows())return;
  const {owner}=await seeded(t,0),busy=remote([reply]);
  const first=await captureHookContext({env:{},owner,...busy});
  await assert.rejects(first.request('/session/events',{}),/capture_http/);
  assert.equal((await owner.read()).state,'active');
  const back=remote([response(),{receipts:[]}]);
  await (await captureHookContext({env:{},owner,...back})).request('/session/events',{});
  assert.equal(back.calls.length,2);
 });
}

test('a refresh reply with no scope is accepted, and a login with none, or a refresh with a wrong one, is not',async t=>{
 if(await unsupportedWindows())return;
 const {scope:_scope,...noScope}=response();
 const {owner}=await seeded(t,0),port=remote([noScope,{receipts:[]}]);
 await (await captureHookContext({env:{},owner,...port})).request('/session/events',{});
 assert.equal((await owner.read()).state,'active');assert.equal(port.calls.length,2);
 const {owner:wrong}=await seeded(t,0),widened=remote([{...response(),scope:'estelle:mcp'}]);
 await assert.rejects((await captureHookContext({env:{},owner:wrong,...widened})).request('/session/events',{}),/capture_grant/);
 const {home,owner:fresh}=await fixture(t),login=remote([noScope]);
 assert.equal((await runCaptureSetup({host:'claude',home},{...login,open:callback})).status,'pending_capture_auth');
 assert.equal(await fresh.read(),null);
});

test('a refresh the server refuses as dead stays stopped: only new consent fixes that',async t=>{
 if(await unsupportedWindows())return;
 const {owner}=await seeded(t,0),dead=remote([{status:400,body:{error:'invalid_grant'}}]);
 const context=await captureHookContext({env:{},owner,...dead});
 await assert.rejects(context.request('/session/events',{}),/capture_http/);
 assert.equal((await owner.read()).state,'refresh_pending');
});

test('a refresh with too little time left is not started, so no reply can be lost',async t=>{
 if(await unsupportedWindows())return;
 const {owner}=await seeded(t,0),port=remote([response()]);
 const context=await captureHookContext({env:{},owner,deadline:Date.now()+2000,...port});
 await assert.rejects(context.request('/session/events',{}),/capture_deadline/);
 assert.equal((await owner.read()).state,'active');assert.equal(port.calls.length,0);
});

test('a refresh in flight is not a stopped sign-in, and one nobody holds is',async t=>{
 if(await unsupportedWindows())return;
 const {owner}=await seeded(t,0);
 await owner.locked(async state=>{
  await state.save({...state.record,state:'refresh_pending'});
  assert.equal((await captureHookContext({env:{},owner})).captureOnly,true);
 });
 await assert.rejects(captureHookContext({env:{},owner}),/capture_pending/);
});

test('the MCP header comes from the one sign-in, and is absent whenever the host should use its own',async t=>{
 if(await unsupportedWindows())return;
 const {owner:none}=await fixture(t);
 assert.deepEqual(await mcpHeaders({env:{},owner:none}),{},'never signed in here');
 const {owner}=await seeded(t);
 assert.deepEqual(await mcpHeaders({env:{},owner}),{Authorization:`Bearer ${(await owner.read()).access_token}`});
 const {owner:expired}=await seeded(t,0),port=remote([response()]);
 const header=await mcpHeaders({env:{},owner:expired,...port});
 assert.equal(header.Authorization,`Bearer ${(await expired.read()).access_token}`);
 assert.equal(new URL(port.calls[0].url).pathname,'/oauth/token');assert.equal(port.calls.length,1,'a refresh, and no upload');
 const {owner:stuck}=await seeded(t,0),lost=remote([Error('lost')]);
 assert.deepEqual(await mcpHeaders({env:{},owner:stuck,...lost}),{},'a failed refresh falls back and never throws');
});

test('a callback that is not exactly ours is refused',async t=>{
 if(await unsupportedWindows())return;
 for(const change of [u=>{u.searchParams.set('iss','https://other.example');},u=>{u.pathname='/other';},u=>{u.searchParams.delete('iss');}]){
  let status;
  await assert.rejects(receiveCaptureCode({state:'owned',challenge:'c',deadline:Date.now()+3000,open:async url=>{
   const target=new URL(new URL(url).searchParams.get('redirect_uri'));
   target.search=new URLSearchParams({code:'abc',state:'owned',iss:CAPTURE_AUTH.issuer});change(target);
   status=await new Promise((resolve,reject)=>{const r=get(target,{agent:false},res=>{res.resume();res.on('end',()=>resolve(res.statusCode));});r.on('error',reject);});
  }}),/capture_callback/);
  assert.equal(status,400);
 }
});

test('what the plugin asks for at sign-in is what the server requires',async t=>{
 if(await unsupportedWindows())return;
 const {home}=await fixture(t),login=remote([response()]);let url;
 await runCaptureSetup({host:'claude',home},{...login,open:async u=>{url=new URL(u);assert.equal(await callback(u),200);}});
 const asked=url.searchParams;
 assert.equal(url.origin+url.pathname,'https://api.fatelabs.ca/oauth/authorize');
 assert.equal(asked.get('client_id'),'https://api.fatelabs.ca/oauth/clients/plugin');
 assert.equal(asked.get('resource'),'https://api.fatelabs.ca/mcp');
 assert.equal(asked.get('scope'),'estelle:mcp estelle:capture offline_access');
 assert.equal(asked.get('response_type'),'code');assert.equal(asked.get('code_challenge_method'),'S256');
 assert.match(asked.get('redirect_uri'),/^http:\/\/127\.0\.0\.1:\d+\/estelle-plugin\/callback$/);
 const sent=new URLSearchParams(login.calls[0].body);
 assert.equal(sent.get('grant_type'),'authorization_code');
 assert.equal(sent.get('redirect_uri'),asked.get('redirect_uri'));
 assert.equal(sent.get('resource'),asked.get('resource'));
 assert.equal(createHash('sha256').update(sent.get('code_verifier')).digest('base64url'),asked.get('code_challenge'));
});

test('a login that fails says why, in our own words',async t=>{
 if(await unsupportedWindows())return;
 const {home}=await fixture(t);
 const result=await runCaptureSetup({host:'claude',home,deadline:Date.now()+100},{...remote([]),open:async()=>{}});
 assert.equal(result.status,'pending_capture_auth');assert.equal(result.reason,'capture_deadline');
});

test('a browser that will not open does not end the sign-in: the address still works',async t=>{
 if(await unsupportedWindows())return;
 const {home,owner}=await fixture(t),port=remote([response()]);
 const result=await runCaptureSetup({host:'claude',home},{...port,open:async url=>{setTimeout(()=>callback(url),10);throw Error('capture_browser');}});
 assert.equal(result.status,'capture_configured');assert.equal((await owner.read()).state,'active');
});

test('dsh signs in for capture like every other host',async t=>{
 if(await unsupportedWindows())return;
 const {home,owner}=await fixture(t),port=remote([response()]);
 assert.equal((await runCaptureSetup({host:'dsh',home},{...port,open:callback})).status,'capture_configured');
 assert.equal((await owner.read()).state,'active');
});

test('portable callback protocol is one-shot, source-bound and closes its actual loopback listener',async()=>{
 let target;
 const result=await receiveCaptureCode({state:'synthetic-state',challenge:'synthetic-challenge',
  deadline:Date.now()+5000,open:async url=>{
   target=new URL(new URL(url).searchParams.get('redirect_uri'));assert.equal(await callback(url),200);
  }});
 assert.equal(result.code,'synthetic-owned-code');assert.equal(result.redirect,target.href);
 await assert.rejects(new Promise((resolve,reject)=>{const req=get(target,{agent:false},resolve);req.on('error',reject);}),{code:'ECONNREFUSED'});
});

test('malformed, redirected or widened grants never publish a credential or echo response material',async t=>{
 if(await unsupportedWindows())return;
 for(const reply of [{status:302,body:response()},{status:401,body:response()},
  {raw:'x'.repeat(16001)},{body:{...response(),scope:'estelle:mcp'}},
  {body:{...response(),expires_in:true}},{body:{...response(),expires_in:3601}},
  {body:{...response(),refresh_token:'bad\nvalue'}},{raw:'not-json'}]){
  const {home,owner}=await fixture(t),port=remote([reply]);
  const result=await runCaptureSetup({host:'codex',home},{...port,open:callback});
  assert.equal(result.status,'pending_capture_auth');assert.equal(await owner.read(),null);
  assert.equal(port.calls.length,1);assert(!JSON.stringify(result).includes('synthetic-access-token'));
 }
});

test('two real credential-owner callers cannot spend one refresh permission twice',async t=>{
 if(await unsupportedWindows())return;
 const {owner}=await seeded(t,0);let arrived,release;
 const began=new Promise(resolve=>arrived=resolve),go=new Promise(resolve=>release=resolve);
 const port=remote([response(),{receipts:[]}]),request=port.request;
 port.request=(url,options,cb)=>{
  const req=request(url,options,cb),end=req.end;
  req.end=body=>{if(url.endsWith('/oauth/token')){arrived();go.then(()=>end(body));}else end(body);};return req;
 };
 const first=await captureHookContext({env:{},owner,...port});
 const second=await captureHookContext({env:{},owner,...port});
 const active=first.request('/session/events',{});let timer;
 try{await Promise.race([began,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('owned_barrier_timeout')),3000);})]);
  await assert.rejects(second.request('/session/events',{}),/capture_pending/);}
 finally{clearTimeout(timer);release();}
 await active;assert.equal(port.calls.filter(x=>x.url.endsWith('/oauth/token')).length,1);
 assert.equal(port.calls.filter(x=>x.url.endsWith('/session/events')).length,1);
});

test('explicit cancellation closes the listener and releases only its own setup lock without exchanging a code',async t=>{
 if(await unsupportedWindows())return;
 const {home,owner}=await fixture(t),controller=new AbortController(),port=remote([response()]);
 const result=await runCaptureSetup({host:'codex',home},{...port,signal:controller.signal,
  open:async()=>controller.abort()});
 assert.equal(result.status,'pending_capture_auth');assert.equal(port.calls.length,0);assert.equal(await owner.read(),null);
 await assert.rejects(fs.stat(join(home,'.estelle-plugins/capture-auth/credential.lock')),{code:'ENOENT'});
 assert.equal((await runCaptureSetup({host:'codex',home},{...port,open:callback})).status,'capture_configured');
 assert.equal(port.calls.length,1);
});

test('a custom API URL costs nobody who never signed in for capture anything; it refuses only once a capture grant exists',async t=>{
 if(await unsupportedWindows())return;
 const {home,owner}=await fixture(t),env={ESTELLE_API_URL:'http://127.0.0.1:1'};
 assert.equal(await captureHookContext({env,owner}),null);
 const port=remote([response()]);
 assert.equal((await runCaptureSetup({host:'codex',home},{...port,open:callback})).status,'capture_configured');
 await assert.rejects(captureHookContext({env,owner}),/capture_origin/);
});
