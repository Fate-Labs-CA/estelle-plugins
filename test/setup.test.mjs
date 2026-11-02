import test from 'node:test';import assert from 'node:assert/strict';
import { mkdtemp,writeFile,readFile,rm,mkdir,cp } from 'node:fs/promises';import {join}from'node:path';import{tmpdir}from'node:os';
import { runSetup, parseLegacyMcp, probeMcp, nativeCodex, runSetupArgs } from '../runtime/setup.mjs';import{VERSION}from'../runtime/version.mjs';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
const BUNDLE=fileURLToPath(new URL('../plugins/codex/',import.meta.url));
const KEY='synthetic-setup-environment-key';
const listing=()=>JSON.stringify({installed:[{pluginId:'estelle@estelle-plugins',name:'estelle',marketplaceName:'estelle-plugins',version:VERSION,installed:true,enabled:true}],available:[]});
const descriptor=()=>`estelle\n  enabled: true\n  transport: streamable_http\n  url: https://api.fatelabs.ca/mcp\n  bearer_token_env_var: ESTELLE_API_KEY\n  http_headers: -\n  env_http_headers: -\n  http_headers_helper: -\n  remove: codex mcp remove estelle\n`;
async function fixture(t){const home=await mkdtemp(join(tmpdir(),'estelle-setup-flow-'));t.after(()=>rm(home,{recursive:true,force:true}));const codex=join(home,'.codex');await mkdir(codex);const file=join(codex,'hooks.json');await writeFile(file,JSON.stringify({foreign:true,hooks:{PreToolUse:[{hooks:[{type:'command',command:'estelle hook ground --event PreToolUse'},{type:'command',command:'foreign-security'}]}]}}),{mode:0o600});return{home,file};}
function ports(){const calls=[];let removed=false;return{calls,platform:'linux',authenticate:async key=>{assert.equal(key,KEY);calls.push('auth');return true;},native:async op=>{calls.push(op);if(op==='plugin')return{ok:true,text:listing()};if(op==='legacy')return removed?{missing:true}:{ok:true,text:descriptor()};if(op==='remove'){removed=true;return{ok:true,text:"Removed global MCP server 'estelle'."};}throw Error('unknown fixture port');}};}
test('missing canonical environment auth and unsupported hosts perform zero native/config operations',async()=>{for(const env of [{},{ESTELLE_KEY:KEY}]){const p=ports();const result=await runSetup({host:'codex',bundleRoot:BUNDLE,env,home:'/not-read'},p);assert.equal(result.status,'pending_auth');assert.equal(result.mcp_auth,'not_probed');assert.equal(result.hook_execution,'not_observed');assert.deepEqual(p.calls,[]);}const p=ports();assert.equal((await runSetup({host:'kimi',env:{ESTELLE_API_KEY:KEY}},p)).status,'pending_unsupported_host');assert.deepEqual(p.calls,[]);});
test('plan is public and nonmutating; apply removes only owned hooks and a proven duplicate once',async t=>{const f=await fixture(t),p=ports();const before=await readFile(f.file);const options={host:'codex',bundleRoot:BUNDLE,env:{ESTELLE_API_KEY:KEY},home:f.home};const plan=await runSetup(options,p);assert.equal(plan.status,'planned');assert.equal(plan.mcp_auth,'initialized');assert.equal(plan.hook_execution,'not_observed');assert.equal(plan.hook_removals,1);assert.equal(plan.mcp,'duplicate');assert.deepEqual(await readFile(f.file),before);assert(!JSON.stringify(plan).includes(KEY));const applied=await runSetup({...options,apply:true,expect:plan.plan_sha256},p);assert.equal(applied.status,'applied');assert.equal(applied.hooks,'applied');assert.equal(applied.mcp,'removed');assert.deepEqual(JSON.parse(await readFile(f.file)).hooks.PreToolUse[0].hooks,[{type:'command',command:'foreign-security'}]);const again=await runSetup({...options,apply:true},p);assert.equal(again.status,'unchanged');assert.equal(p.calls.filter(x=>x==='remove').length,1);});
test('unavailable replacement or auth refuses before reading/changing host hooks',async t=>{const f=await fixture(t);for(const failure of ['auth','plugin']){const p=ports();if(failure==='auth')p.authenticate=async()=>false;else p.native=async()=>({ok:false});const result=await runSetup({host:'codex',bundleRoot:BUNDLE,apply:true,env:{ESTELLE_API_KEY:KEY},home:f.home},p);assert.match(result.status,/^pending_/);assert((await readFile(f.file,'utf8')).includes('estelle hook ground'));assert(!p.calls.includes('remove'));}});
test('legacy metadata requires exact endpoint/env and rejects policy/auth overrides',()=>{assert.equal(parseLegacyMcp(descriptor()),'duplicate');for(const text of [descriptor().replace('api.fatelabs.ca','foreign.invalid'),descriptor().replace('ESTELLE_API_KEY','OTHER_KEY'),descriptor().replace('http_headers: -','http_headers: Authorization=*****'),descriptor()+' enabled_tools: []\n',descriptor()+'  __proto__: ignored\n',descriptor()+' env_http_headers: Authorization=OTHER_KEY\n',descriptor().replace('/mcp','/mcp?key=private')])assert.notEqual(parseLegacyMcp(text),'duplicate');});
test('stale expected plan and changed legacy metadata never dispatch a remove',async t=>{const f=await fixture(t),p=ports();const result=await runSetup({host:'codex',bundleRoot:BUNDLE,apply:true,expect:'0'.repeat(64),env:{ESTELLE_API_KEY:KEY},home:f.home},p);assert.equal(result.status,'pending_conflict');assert(!p.calls.includes('remove'));let reads=0;const native=p.native;p.native=async op=>op==='legacy'&&++reads===2?{ok:true,text:descriptor().replace('ESTELLE_API_KEY','OTHER_KEY')}:native(op);const changed=await runSetup({host:'codex',bundleRoot:BUNDLE,apply:true,env:{ESTELLE_API_KEY:KEY},home:f.home},p);assert.equal(changed.status,'pending_conflict');assert(!p.calls.includes('remove'));assert((await readFile(f.file,'utf8')).includes('estelle hook ground'));});
test('ambiguous native mutation stops without resending or pretending success',async t=>{const f=await fixture(t),p=ports();p.native=async op=>{p.calls.push(op);return op==='plugin'?{ok:true,text:listing()}:op==='legacy'?{ok:true,text:descriptor()}:{ok:false};};const result=await runSetup({host:'codex',bundleRoot:BUNDLE,apply:true,env:{ESTELLE_API_KEY:KEY},home:f.home},p);assert.equal(result.status,'unknown');assert.equal(result.mcp,'unknown');assert.equal(p.calls.filter(x=>x==='remove').length,1);assert((await readFile(f.file,'utf8')).includes('estelle hook ground'));});

function requestFixture({status=200,value,raw,fail=false}={}) {
 const calls=[];
 const request=(url,options,callback)=>{
  const req=new EventEmitter();req.end=body=>{
   calls.push({url,options,body:JSON.parse(body)});
   queueMicrotask(()=>{
    if(fail){req.emit('error',Error('synthetic only'));return;}
    const response=new EventEmitter();response.statusCode=status;response.destroy=()=>{response.destroyed=true;};
    callback(response);
    if(response.destroyed)return;
    response.emit('data',Buffer.from(raw??JSON.stringify(value)));
    if(!response.destroyed)response.emit('end');
   });
  };return req;
 };return {request,calls};
}
const initialized=()=>({jsonrpc:'2.0',id:1,result:{protocolVersion:'2025-11-25',capabilities:{tools:{}}}});
test('replacement proof is exactly one fixed authenticated MCP initialize, never account lookup',async()=>{
 const fixture=requestFixture({value:initialized()});assert.equal(await probeMcp(KEY,fixture),true);
 assert.equal(fixture.calls.length,1);const call=fixture.calls[0];
 assert.equal(call.url,'https://api.fatelabs.ca/mcp');assert.equal(call.options.method,'POST');assert.equal(call.options.agent,false);
 assert.equal(call.options.headers.Authorization,`Bearer ${KEY}`);assert(call.options.signal instanceof AbortSignal);
 assert.equal(call.body.method,'initialize');assert.equal(call.body.params.protocolVersion,'2025-11-25');
 assert.deepEqual(call.body.params.capabilities,{prompts:{}});
});
test('redirect, denied, malformed, inner error, oversized and failed MCP initialization never authenticate',async()=>{
 for(const options of [{status:302},{status:401},{raw:'not JSON'},{raw:'x'.repeat(16385)},
  {value:{...initialized(),error:{code:-32000}}},{value:{...initialized(),id:2}},
  {value:{jsonrpc:'2.0',id:1,result:{protocolVersion:'2025-11-25',capabilities:{tools:false}}}},
  {value:{...initialized(),result:{protocolVersion:'old',capabilities:{tools:{}}}}},{fail:true}]){
  const fixture=requestFixture(options);assert.equal(await probeMcp(KEY,fixture),false);assert.equal(fixture.calls.length,1);
 }
});
test('throwing authentication, malformed key and disabled replacement are zero-mutation pending states',async t=>{
 const f=await fixture(t),before=await readFile(f.file);const p=ports();p.authenticate=async()=>{throw Error('sensitive details must never escape');};
 const options={host:'codex',bundleRoot:BUNDLE,apply:true,env:{ESTELLE_API_KEY:KEY},home:f.home};
 const output=await runSetup(options,p);assert.equal(output.status,'pending_auth');assert(!JSON.stringify(output).includes('sensitive'));
 assert(!p.calls.includes('remove'));assert.deepEqual(await readFile(f.file),before);
 const invalid=ports();assert.equal((await runSetup({...options,env:{ESTELLE_API_KEY:'invalid key'}},invalid)).status,'pending_auth');assert.deepEqual(invalid.calls,[]);
 const disabled=ports();disabled.native=async()=>({ok:true,text:listing().replace('"enabled":true','"enabled":false')});
 assert.equal((await runSetup(options,disabled)).status,'pending_package');assert(!disabled.calls.includes('auth'));
});
test('explicit Windows apply is pending; unsupported hosts and malformed flags cannot start setup',async()=>{
 const p=ports();p.platform='win32';assert.equal((await runSetup({host:'codex',apply:true,env:{ESTELLE_API_KEY:KEY}},p)).status,'pending_unsupported_platform');assert.deepEqual(p.calls,[]);
 for(const args of [['codex','--unsafe'],['codex','--apply','--apply'],['codex','--expect','bad'],['codex','--expect','0'.repeat(64),'--expect','0'.repeat(64)]])assert.equal((await runSetupArgs(args)).status,'pending_arguments');
 await assert.rejects(async()=>nativeCodex('unrecognized'),/setup_operation/);
});
test('actual copied native package ships setup entry and imports its own closure',async t=>{
 const f=await fixture(t),bundle=join(f.home,'installed-codex');await cp(BUNDLE,bundle,{recursive:true});
 const {runSetup:installed}=await import(new URL(`file://${join(bundle,'runtime/setup.mjs')}`));
 const p=ports();assert.equal((await installed({host:'codex',bundleRoot:bundle,apply:true,home:f.home,env:{ESTELLE_API_KEY:KEY}},p)).status,'applied');
 const result=spawnSync(process.execPath,[join(bundle,'runtime/cli.mjs'),'setup','codex'],{env:{PATH:process.env.PATH,HOME:f.home},encoding:'utf8',timeout:5000});
 assert.equal(result.status,1);assert.equal(JSON.parse(result.stdout).status,'pending_auth');assert.equal(result.stderr,'');
 for(const host of ['claude','cursor','kimi','grok']){
  const runtime=fileURLToPath(new URL(`../plugins/${host}/runtime/`,import.meta.url));
  assert.deepEqual(await readFile(join(runtime,'setup.mjs')),await readFile(new URL('../runtime/setup.mjs',import.meta.url)));
  assert.deepEqual(await readFile(join(runtime,'migration.mjs')),await readFile(new URL('../runtime/migration.mjs',import.meta.url)));
 }
});
test('native command adapter uses fixed argv against an owned executable fixture, not a shell/config parser',async t=>{
 const f=await fixture(t);
 if(process.platform==='win32'){
  assert.equal((await runSetup({host:'codex',apply:true,env:{ESTELLE_API_KEY:KEY}},{platform:'win32'})).status,'pending_unsupported_platform');return;
 }
 const bin=join(f.home,'bin');await mkdir(bin);const log=join(f.home,'argv.jsonl');
 const executable=`#!${process.execPath}\nimport{appendFileSync}from'node:fs';appendFileSync(${JSON.stringify(log)},JSON.stringify(process.argv.slice(2))+'\\n');if(process.argv[2]==='mcp'&&process.argv[3]==='get'){console.error(\"Error: No MCP server named 'estelle' found.\");process.exitCode=1;}else console.log('fixture-output');\n`;
 await writeFile(join(bin,'codex'),executable,{mode:0o700});
 const runner=join(f.home,'native-fixture.mjs');
 await writeFile(runner,`import{nativeCodex}from ${JSON.stringify(new URL('../runtime/setup.mjs',import.meta.url).href)};for(const op of ['plugin','legacy','remove'])console.log(JSON.stringify(await nativeCodex(op)));`);
 const result=spawnSync(process.execPath,[runner],{env:{PATH:bin,HOME:f.home},encoding:'utf8',timeout:5000});
 assert.equal(result.status,0);assert.equal(result.stderr,'');
 assert.deepEqual(result.stdout.trim().split('\n').map(JSON.parse),[{ok:true,text:'fixture-output\n'},{missing:true},{ok:true,text:'fixture-output\n'}]);
 assert.deepEqual((await readFile(log,'utf8')).trim().split('\n').map(JSON.parse),[
  ['plugin','list','--marketplace','estelle-plugins','--json'],['mcp','get','estelle'],['mcp','remove','estelle']]);
});
async function childRead(t,kind,{fifo=false,symlink=false}={}){
 const f=await fixture(t),bundle=join(f.home,'package');await cp(BUNDLE,bundle,{recursive:true});
 const target=kind==='hooks'?f.file:join(bundle,'.codex-plugin/plugin.json');
 if(fifo){await rm(target);const made=spawnSync('mkfifo',[target],{encoding:'utf8',timeout:2000});assert.equal(made.status,0);}
 if(symlink){const original=target+'.original';await cp(target,original);await rm(target);const {symlink:link}=await import('node:fs/promises');await link(original,target);}
 const script=join(f.home,'bounded-reader.mjs');
 const code=kind==='hooks'
  ?`import{inspectHooks}from ${JSON.stringify(new URL('../runtime/migration.mjs',import.meta.url).href)};try{await inspectHooks(${JSON.stringify(target)});console.log('regular');}catch{console.log('refused');}`
  :`import{runSetup}from ${JSON.stringify(new URL('../runtime/setup.mjs',import.meta.url).href)};const result=await runSetup({host:'codex',bundleRoot:${JSON.stringify(bundle)},home:${JSON.stringify(f.home)},env:{ESTELLE_API_KEY:${JSON.stringify(KEY)}}},{native:async op=>op==='plugin'?{ok:true,text:${JSON.stringify(listing())}}:{missing:true},authenticate:async()=>true});console.log(result.status);`;
 await writeFile(script,code);
 return spawnSync(process.execPath,[script],{env:{PATH:process.env.PATH,HOME:f.home},encoding:'utf8',timeout:1500});
}
test('actual owned FIFO hooks read refuses promptly while regular hooks remain readable',async t=>{
 if(process.platform==='win32'){assert.equal((await runSetup({host:'codex',apply:true},{platform:'win32'})).status,'pending_unsupported_platform');return;}
 const normal=await childRead(t,'hooks');assert.equal(normal.status,0);assert.equal(normal.stdout.trim(),'regular');
 const hostile=await childRead(t,'hooks',{fifo:true});assert.equal(hostile.error,undefined);assert.equal(hostile.status,0);assert.equal(hostile.stdout.trim(),'refused');
});
test('actual owned FIFO or symlink package descriptor refuses promptly; regular package authenticates',async t=>{
 if(process.platform==='win32'){assert.equal((await runSetup({host:'codex',apply:true},{platform:'win32'})).status,'pending_unsupported_platform');return;}
 const normal=await childRead(t,'package');assert.equal(normal.status,0);assert.equal(normal.stdout.trim(),'planned');
 for(const shape of [{fifo:true},{symlink:true}]){
  const hostile=await childRead(t,'package',shape);assert.equal(hostile.error,undefined);assert.equal(hostile.status,0);assert.equal(hostile.stdout.trim(),'pending_package');
 }
});
test('short package descriptor reads refuse before authentication or host configuration access',async t=>{
 const f=await fixture(t),bundle=join(f.home,'partial-package');await cp(BUNDLE,bundle,{recursive:true});
 const target=join(bundle,'.codex-plugin/plugin.json'),prefix=await readFile(target);
 const raw=Buffer.concat([prefix,Buffer.from('\nUNSUPPORTED_TRAILING_BYTES')]);await writeFile(target,raw);
 const script=join(f.home,'partial-package-reader.mjs');
 await writeFile(script,`import{createRequire,syncBuiltinESMExports}from'node:module';const fs=createRequire(import.meta.url)('node:fs/promises');const open=fs.open;fs.open=async(...args)=>{const h=await open(...args);if(args[0]===${JSON.stringify(target)}){const read=h.read.bind(h);h.read=(b,o,l,p)=>read(b,o,Math.min(${prefix.length},l),p);}return h;};syncBuiltinESMExports();const{runSetup}=await import(${JSON.stringify(new URL('../runtime/setup.mjs',import.meta.url).href)});let native=0,auth=0;const result=await runSetup({host:'codex',apply:true,bundleRoot:${JSON.stringify(bundle)},home:${JSON.stringify(f.home)},env:{ESTELLE_API_KEY:${JSON.stringify(KEY)}}},{platform:'linux',native:async()=>{native++;return{ok:true,text:${JSON.stringify(listing())}};},authenticate:async()=>{auth++;return true;}});console.log(JSON.stringify({status:result.status,native,auth}));`);
 const result=spawnSync(process.execPath,[script],{env:{PATH:process.env.PATH,HOME:f.home},encoding:'utf8',timeout:3000});
 assert.equal(result.status,0);assert.equal(result.stderr,'');assert.deepEqual(JSON.parse(result.stdout),{status:'pending_package',native:0,auth:0});
 assert.deepEqual(await readFile(target),raw);assert((await readFile(f.file,'utf8')).includes('estelle hook ground'));
 const normal=await childRead(t,'package');assert.equal(normal.status,0);assert.equal(normal.stdout.trim(),'planned');
});
