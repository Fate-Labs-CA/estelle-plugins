/** Explicit native setup; no install callback, hook-trust edit, credential-store or cache migration. */
import { execFile } from 'node:child_process';
import { request as httpsRequest } from 'node:https';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { launchCredential } from './auth.mjs';
import { UNREADABLE, codexHookTrust } from './codex-trust.mjs';
import { inspectHooks, planHooks, commitHooks } from './migration.mjs';
import { VERSION } from './version.mjs';

const CAP=16384, BUDGET_MS=45000, CALL_MS=8000;
const BASE='https://api.fatelabs.ca';
const object=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const hash=x=>createHash('sha256').update(x).digest('hex');
const COMMANDS=Object.freeze({plugin:['plugin','list','--marketplace','estelle-plugins','--json'],
 legacy:['mcp','get','estelle'],remove:['mcp','remove','estelle']});
const remaining=deadline=>{const value=Math.min(CALL_MS,deadline-Date.now());if(value<=0)throw Error('setup_deadline');return value;};

export function nativeCodex(operation,deadline=Date.now()+BUDGET_MS) {
 if(!Object.hasOwn(COMMANDS,operation))throw Error('setup_operation');
 return new Promise(resolveResult=>{
  execFile('codex',COMMANDS[operation],{timeout:remaining(deadline),maxBuffer:CAP,windowsHide:true},(error,stdout,stderr)=>{
   if(error){
    const missing=operation==='legacy'&&stderr.trim()==="Error: No MCP server named 'estelle' found.";
    resolveResult(missing?{missing:true}:{ok:false});return;
   }
   resolveResult({ok:true,text:stdout});
  });
 });
}

/** Fixed authenticated read-only MCP initialization, not an account/key-presence substitute. */
export function probeMcp(key,{request=httpsRequest,deadline=Date.now()+BUDGET_MS}={}) {
 const body=JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-11-25',
  capabilities:{prompts:{}},clientInfo:{name:'estelle-plugin-setup',version:VERSION}}});
 return new Promise(resolveResult=>{
  let settled=false;
  const done=value=>{if(!settled){settled=true;resolveResult(value);}};
  const req=request(BASE+'/mcp',{method:'POST',agent:false,headers:{Authorization:`Bearer ${key}`,
   'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)},signal:AbortSignal.timeout(remaining(deadline))},res=>{
   if(res.statusCode!==200){res.destroy();done(false);return;}
   const chunks=[];let bytes=0;
   res.on('data',chunk=>{bytes+=chunk.length;if(bytes>CAP){res.destroy();done(false);}else chunks.push(chunk);});
   res.on('error',()=>done(false));res.on('aborted',()=>done(false));
   res.on('end',()=>{
    try{
     const value=JSON.parse(Buffer.concat(chunks).toString('utf8')),result=value.result;
     done(value.jsonrpc==='2.0'&&value.id===1&&!Object.hasOwn(value,'error')&&object(result)
      &&result.protocolVersion==='2025-11-25'&&object(result.capabilities)&&object(result.capabilities.tools));
    }catch{done(false);}
   });
  });
  req.on('error',()=>done(false));req.end(body);
 });
}

export function parseLegacyMcp(text) {
 if(typeof text!=='string'||Buffer.byteLength(text)>CAP)return 'unavailable';
 const lines=text.trim().split(/\r?\n/);if(lines.shift()!=='estelle')return 'unavailable';
 const fields=Object.create(null);
 for(const line of lines){
  const match=/^\s+([a-z_]+): (.*)$/.exec(line);if(!match || Object.hasOwn(fields,match[1]))return 'unavailable';
  fields[match[1]]=match[2];
 }
 const allowed=['enabled','transport','url','bearer_token_env_var','http_headers','env_http_headers','http_headers_helper','remove'];
 if(Object.keys(fields).some(k=>!allowed.includes(k)))return 'unavailable';
 if(fields.enabled!=='true'||fields.transport!=='streamable_http')return 'unavailable';
 if(fields.url!==BASE+'/mcp'||fields.bearer_token_env_var!=='ESTELLE_API_KEY')return 'preserved';
 if(['http_headers','env_http_headers','http_headers_helper'].some(k=>fields[k]!=='-'))return 'unavailable';
 if(fields.remove!==undefined&&fields.remove!=='codex mcp remove estelle')return 'unavailable';
 return 'duplicate';
}

async function packageJson(path) {
 const file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
 try{
  const info=await file.stat();if(!info.isFile()||info.size>CAP)throw Error('package_bound');
  const bytes=Buffer.alloc(CAP+1),read=await file.read(bytes,0,bytes.length,0);
  if(read.bytesRead>CAP)throw Error('package_bound');
  if(read.bytesRead!==info.size)throw Error('package_incomplete');
  return JSON.parse(bytes.subarray(0,read.bytesRead).toString('utf8'));
 }finally{await file.close();}
}

async function packageReady(bundleRoot,native) {
 try{
  const paths=['.codex-plugin/plugin.json','.mcp.json'];const docs=[];
  for(const path of paths)docs.push(await packageJson(join(bundleRoot,path)));
  const [manifest,mcp]=docs;
  if(manifest.name!=='estelle'||manifest.version!==VERSION||manifest.mcpServers!=='./.mcp.json')return false;
  const server=mcp.mcpServers?.Estelle;
  if(!object(server)||Object.keys(server).sort().join(',')!=='bearer_token_env_var,url'
    ||server.url!==BASE+'/mcp'||server.bearer_token_env_var!=='ESTELLE_API_KEY')return false;
  const listing=await native('plugin');if(listing.ok!==true||Buffer.byteLength(listing.text)>CAP)return false;
  const items=JSON.parse(listing.text).installed;if(!Array.isArray(items)||items.length>64)return false;
  const own=items.filter(x=>x?.pluginId==='estelle@estelle-plugins');
  return own.length===1&&own[0].name==='estelle'&&own[0].marketplaceName==='estelle-plugins'
   &&own[0].version===VERSION&&own[0].installed===true&&own[0].enabled===true;
 }catch{return false;}
}

const projection=(status,extra={})=>({status,host:'codex',version:VERSION,...extra,
 capture_auth:'unavailable_or_unproven',mcp_auth:'not_probed',hook_execution:'not_observed',
 trust:'not_changed_not_measured',reload:'fresh_session_required',active_cache:'not_migrated'});
const authenticated=(status,extra={})=>({...projection(status,extra),
 capture_auth:'canonical_environment_available',mcp_auth:'initialized'});
const same=(a,b)=>a===null?b===null:b!==null&&a.hash===b.hash&&a.identity===b.identity;

async function applyPlan(file,snapshot,legacy,native) {
 if(!same(snapshot,await inspectHooks(file)))return authenticated('pending_conflict');
 if(legacy==='duplicate'){
  const fresh=await native('legacy');if(fresh.ok!==true||parseLegacyMcp(fresh.text)!=='duplicate')return authenticated('pending_conflict');
  const removed=await native('remove');
  if(removed.ok!==true||removed.text.trim()!=="Removed global MCP server 'estelle'.")return authenticated('unknown',{mcp:'unknown',hooks:'not_started'});
  const readback=await native('legacy');if(readback.missing!==true)return authenticated('unknown',{mcp:'unknown',hooks:'not_started'});
 }
 const mcp=legacy==='duplicate'?'removed':legacy;
 try{
  const hooks=snapshot?await commitHooks(file,snapshot):{status:'unchanged',removed:0};
  return authenticated(hooks.status==='unknown'?'unknown':hooks.status==='unchanged'&&mcp!=='removed'?'unchanged':'applied',
   {mcp,hooks:hooks.status,hook_removals:hooks.removed,...(hooks.cleanup?{cleanup:hooks.cleanup}:{})});
 }catch{return authenticated(mcp==='removed'?'partial':'pending_conflict',{mcp,hooks:'not_applied'});}
}

export async function runSetup({host,apply=false,expect,env=process.env,home=homedir(),
 bundleRoot=resolve(import.meta.dirname,'..')}={},ports={}) {
 if(host==='claude'){
  const {runClaudeSetup}=await import('./claude-setup.mjs');
  return runClaudeSetup({apply,expect,env,home},ports);
 }
 if(host!=='codex')return {status:'pending_unsupported_host',host:typeof host==='string'&&/^[a-z-]{1,20}$/.test(host)?host:'unknown'};
 if(apply&&(ports.platform||process.platform)==='win32')return projection('pending_unsupported_platform');
 // Do not invoke the legacy auth-file fallback. Hooks and MCP must share this one canonical variable.
 if(!env.ESTELLE_API_KEY)return projection('pending_auth');
 const key=await launchCredential({ESTELLE_API_KEY:env.ESTELLE_API_KEY}).catch(()=>null);
 if(!key)return projection('pending_auth');
 const deadline=Date.now()+BUDGET_MS,native=ports.native||(op=>nativeCodex(op,deadline));
 if(!await packageReady(bundleRoot,native))return projection('pending_package');
 const authenticate=ports.authenticate||(k=>probeMcp(k,{deadline}));
 try{if(await authenticate(key)!==true)return projection('pending_auth');}
 catch{return projection('pending_auth');}
 const review=await(ports.hookTrust||(()=>codexHookTrust(process.cwd(),{env})))().catch(()=>UNREADABLE);
 return withReview(await migrateCodex({home,env,native,expect,apply}),review);
}

// Setup measures hook review so it can say the next step. Approving stays with the person, in Codex.
const withReview=(result,review)=>({...result,hook_review:review.status,trust:'not_changed',
 ...(review.next_step?{next_step:review.next_step}:{})});

async function migrateCodex({home,env,native,expect,apply}) {
 try{
  const codexHome=env.CODEX_HOME?resolve(env.CODEX_HOME):join(home,'.codex'),file=join(codexHome,'hooks.json');
  const snapshot=await inspectHooks(file),plan=snapshot?planHooks(snapshot.bytes):{removed:0};
  const result=await native('legacy'),legacy=result.missing===true?'absent':result.ok===true?parseLegacyMcp(result.text):'unavailable';
  if(legacy==='unavailable')return authenticated('pending_mcp_lookup');
  const planHash=hash(JSON.stringify({before:snapshot?.hash||null,removed:plan.removed,mcp:legacy,version:VERSION}));
  if(expect!==undefined&&expect!==planHash)return authenticated('pending_conflict');
  if(!apply)return authenticated('planned',{hook_removals:plan.removed,mcp:legacy,plan_sha256:planHash});
  return await applyPlan(file,snapshot,legacy,native);
 }catch{return authenticated('pending_configuration');}
}

export async function runSetupArgs(args) {
 if(args.length===2&&['--login','--logout'].includes(args[1])){
  const {runCaptureSetup}=await import('./capture-auth.mjs');
  const controller=new AbortController(),stop=()=>controller.abort();
  process.once('SIGINT',stop);process.once('SIGTERM',stop);
  try{return await runCaptureSetup({host:args[0],logout:args[1]==='--logout'},{signal:controller.signal});}
  finally{process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);}
 }
 const [host,...flags]=args;let apply=false,expect;
 for(let i=0;i<flags.length;i++){
  if(flags[i]==='--apply'&&!apply)apply=true;
  else if(flags[i]==='--expect'&&expect===undefined&&/^[a-f0-9]{64}$/.test(flags[i+1]||''))expect=flags[++i];
  else return {status:'pending_arguments'};
 }
 return runSetup({host,apply,expect});
}
