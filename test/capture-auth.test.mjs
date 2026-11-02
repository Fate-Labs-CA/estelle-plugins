import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs/promises';
import { get } from 'node:http';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CAPTURE_AUTH, CaptureCredentialOwner } from '../runtime/auth.mjs';
import { runCaptureSetup, captureHookContext, receiveCaptureCode } from '../runtime/capture-auth.mjs';

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
    if(value instanceof Error){req.emit('error',value);return;}
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
 assert.equal((await runCaptureSetup({host:'codex',home,logout:true},lost)).status,'pending_capture_auth');
 assert.equal(lost.calls.length,1);
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
  await assert.rejects(second.request('/session/events',{}),/capture_busy/);}
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
