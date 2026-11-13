/** Separate public-client consent for session-event capture. Never reads or exports a native MCP token. */
import { createServer } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { execFile } from 'node:child_process';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { CAPTURE_AUTH, CaptureCredentialOwner, captureRecord } from './auth.mjs';
import { VERSION } from './version.mjs';

const LOGIN_MS=CAPTURE_AUTH.loginMs, REQUEST_MS=8000, REFRESH_MIN_MS=REQUEST_MS, CALLBACK_BYTES=8192, CALLBACK_REQUESTS=8;
// Claude Code gives headersHelper 10 seconds. Past this it is killed, which would look like a lost reply.
const HEADERS_MS=9500;
const MAX_EVENTS=2000000;
const hosts=new Set(['codex','claude','claude-code','cursor','kimi','grok','dsh']);
const equal=(a,b)=>typeof a==='string'&&typeof b==='string'&&Buffer.byteLength(a)===Buffer.byteLength(b)
 &&timingSafeEqual(Buffer.from(a),Buffer.from(b));
const remaining=deadline=>{const value=Math.min(REQUEST_MS,deadline-Date.now());if(value<=0)throw Error('capture_deadline');return value;};

function transport(path,body,headers,deadline,{request=httpsRequest,signal}={}) {
 if(!['/oauth/token','/oauth/revoke','/session/events'].includes(path))throw Error('capture_route');
 const cap=path==='/session/events'?MAX_EVENTS:CAPTURE_AUTH.bytes;
 if(Buffer.byteLength(body)>cap)throw Error('capture_bound');
 return new Promise((resolve,reject)=>{
  let done=false,connected=false;const finish=(error,value)=>{if(done)return;done=true;error?reject(error):resolve(value);};
  const timeout=AbortSignal.timeout(remaining(deadline));
  const req=request(CAPTURE_AUTH.issuer+path,{method:'POST',agent:false,
   headers:{...headers,'Content-Length':Buffer.byteLength(body)},
   signal:signal?AbortSignal.any([timeout,signal]):timeout},res=>{
   let size=0;const chunks=[];
   res.on('data',chunk=>{size+=chunk.length;if(size>cap){res.destroy();finish(Error('capture_response_bound'));}else chunks.push(chunk);});
   res.on('error',()=>finish(Error('capture_transport_unknown')));
   res.on('aborted',()=>finish(Error('capture_transport_unknown')));
   res.on('end',()=>{
    let value,parsed=true;
    try{value=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{parsed=false;}
    if(res.statusCode!==200){
     // The status decides, whatever the body: a gateway's error page is not a malformed grant.
     const error=Error('capture_http');error.status=res.statusCode;
     // Busy or down: the server said so and spent nothing it knows of. Worst case it did, and a retry ends in sign-in.
     error.notSpent=res.statusCode===429||res.statusCode>=500;
     if(path==='/session/events'&&parsed)error.message=String(value?.error?.message||'capture_http').slice(0,1000);
     finish(error);return;
    }
    if(parsed)finish(null,value);else finish(Error('capture_response_json'));
   });
  });
  // agent:false means a new socket each time, and no request byte leaves before the TLS handshake finishes.
  // So a failure before secureConnect is proof the server never saw this body: offline, DNS, a captive portal.
  req.on('socket',socket=>socket.once('secureConnect',()=>{connected=true;}));
  req.on('error',()=>finish(connected?Error('capture_transport_unknown'):Object.assign(Error('capture_not_sent'),{notSent:true})));
  req.end(body);
 });
}

// On a refresh `scope` may be absent: the server rotated the pair and could not re-read the grant. Answering an error there
// would send this client back with a spent token, so it hands over the pair instead. A login always states it.
function grant(value,partition,now,refreshed=false) {
 if(value?.token_type!=='Bearer'||(value.scope!==CAPTURE_AUTH.scope&&!(refreshed&&value.scope===undefined))
  || !Number.isSafeInteger(value.expires_in)||value.expires_in<1||value.expires_in>3600)throw Error('capture_grant');
 return captureRecord({schema:1,issuer:CAPTURE_AUTH.issuer,client_id:CAPTURE_AUTH.client,
  resource:CAPTURE_AUTH.resource,scope:CAPTURE_AUTH.scope,partition,state:'active',
  expires_at:now+value.expires_in,access_token:value.access_token,refresh_token:value.refresh_token});
}

const form=(path,value,deadline,ports)=>transport(path,new URLSearchParams(value).toString(),
 {'Content-Type':'application/x-www-form-urlencoded'},deadline,ports);

function usableRecord(record,partition) {
 if(!record||record.partition!==partition)throw Error('capture_binding_changed');
 if(record.state!=='active')throw Error('capture_pending');
 return record.expires_at>Math.floor(Date.now()/1000)+60;
}

/** The lock guards one spend of a refresh token and nothing else: hosts fire hooks concurrently, and an upload
 *  held under it would refuse them all for its whole duration. A definite "never sent" puts the grant back; a
 *  lost acknowledgement does not, because resending a consumed refresh token revokes the family. */
async function freshAccess(owner,partition,deadline,ports) {
 const seen=await owner.read();
 if(usableRecord(seen,partition))return seen.access_token;
 return owner.locked(async state=>{
  const record=state.record;
  if(usableRecord(record,partition))return record.access_token; // another hook refreshed while this one read
  // Spending a refresh with too little time left is how a reply gets lost. Nothing has been spent yet; the next caller can.
  if(deadline-Date.now()<REFRESH_MIN_MS)throw Error('capture_deadline');
  await state.save({...record,state:'refresh_pending'});
  let value;
  try{
   value=await form('/oauth/token',{grant_type:'refresh_token',client_id:CAPTURE_AUTH.client,
    resource:CAPTURE_AUTH.resource,refresh_token:record.refresh_token},deadline,ports);
  }catch(error){
   if(error.notSent||error.notSpent||error.message==='capture_deadline')await state.save(record);
   throw error;
  }
  const next=grant(value,partition,Math.floor(Date.now()/1000),true);await state.save(next);
  return next.access_token;
 });
}

/** What Claude Code sends to the MCP server, from `headersHelper`. Nothing here means "use the host's own OAuth", so
 *  a person who signed in through /mcp keeps working, and so does anyone whose sign-in this cannot use right now. */
export async function mcpHeaders({env=process.env,home,deadline=Date.now()+HEADERS_MS,owner,request=httpsRequest}={}) {
 if(env.ESTELLE_API_KEY||process.platform==='win32')return {};
 owner??=new CaptureCredentialOwner({home});
 try{
  const record=await owner.read();
  if(!record)return {};
  return {Authorization:'Bearer '+await freshAccess(owner,record.partition,deadline,{request})};
 }catch{return {};}
}

/** The canonical env key wins without opening this store. A hook only ever uploads to POST /session/events. */
export async function captureHookContext({env=process.env,home,deadline=Date.now()+12000,owner,
 request=httpsRequest}={}) {
 if(env.ESTELLE_API_KEY)return null;
 if(process.platform==='win32')return null; // This store has no Windows ACL/native proof; ordinary hooks are unchanged.
 owner??=new CaptureCredentialOwner({home});
 // Nobody who never signed in for capture is affected by this store, a custom API URL included.
 const record=await owner.read();if(!record)return null;
 if(env.ESTELLE_API_URL&&!['https://api.fatelabs.ca','https://api.fatelabs.ca/'].includes(env.ESTELLE_API_URL))throw Error('capture_origin');
 // A refresh in flight is not a stopped sign-in. headersHelper refreshes as a session starts, beside this very hook,
 // and a token is usually expired by then. An upload during it fails retryably and is spooled.
 if(record.state!=='active'&&!await owner.busy())throw Error('capture_pending');
 return {captureOnly:true,partition:record.partition,request:async(path,body)=>{
  if(path!=='/session/events')throw Error('capture_route');
  const encoded=JSON.stringify(body);if(Buffer.byteLength(encoded)>MAX_EVENTS)throw Error('capture_bound');
  const access=await freshAccess(owner,record.partition,deadline,{request});
  return transport(path,encoded,
   {Authorization:'Bearer '+access,'Content-Type':'application/json','X-Estelle-Capture-Only':'1',
    'X-Estelle-Client-Protocol':'1','X-Estelle-Hook-Contract':'1',
    'X-Estelle-Client-Version':`estelle-plugins/${VERSION}`},deadline,{request});
 }};
}

/** Only public authorization URL/state/challenge enters the browser argv; never a code or credential. */
function openBrowser(url,deadline,platform=process.platform) {
 return new Promise((resolve,reject)=>{
  const command=platform==='darwin'?'open':'xdg-open';
  execFile(command,[url],{timeout:remaining(deadline),maxBuffer:4096},error=>error?reject(Error('capture_browser')):resolve());
 });
}

function callbackValue(request,host,state) {
 if(request.method!=='GET'||request.headers.host!==host||request.url.length>CALLBACK_BYTES)throw Error('capture_callback');
 const url=new URL(request.url,'http://'+host),keys=[...url.searchParams.keys()];
 if(url.origin!=='http://'+host||url.hash||url.pathname!=='/estelle-plugin/callback'
  ||keys.length!==3||new Set(keys).size!==3
  ||keys.some(x=>!['code','error','state','iss'].includes(x))
  ||!equal(url.searchParams.get('state'),state)||url.searchParams.get('iss')!==CAPTURE_AUTH.issuer)throw Error('capture_callback');
 const code=url.searchParams.get('code');
 if(url.searchParams.has('error')||!code||!/^[A-Za-z0-9_-]{1,2048}$/.test(code))throw Error('capture_denied');
 return code;
}

/** Owned, finite loopback listener. Mandatory host bootstrap/trust remains outside this helper. */
export async function receiveCaptureCode({state,challenge,deadline,open=openBrowser,serverFactory=createServer,signal}) {
 if(signal?.aborted)throw Error('capture_cancelled');
 let timer,seen=0,settled=false,complete,fail;
 const received=new Promise((resolve,reject)=>{complete=resolve;fail=reject;});
 const stop=()=>{settled=true;fail(Error('capture_cancelled'));};
 received.catch(()=>{});
 const server=serverFactory((req,res)=>{
  if(settled){res.writeHead(409);res.end();return;}
  try{
   if(++seen>CALLBACK_REQUESTS)throw Error('capture_callback_bound');
   const code=callbackValue(req,`127.0.0.1:${server.address().port}`,state);
   settled=true;res.writeHead(200,{'Content-Type':'text/plain','Cache-Control':'no-store'});
   res.end('Sign-in received. Return to the setup command.');complete(code);
  }catch(error){res.writeHead(400,{'Content-Type':'text/plain'});res.end('Sign-in was not accepted.');
   settled=true;fail(error);}
 });
 server.requestTimeout=1000;server.headersTimeout=1000;server.maxHeadersCount=16;server.maxConnections=CALLBACK_REQUESTS;
 try{
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  signal?.addEventListener('abort',stop,{once:true});if(signal?.aborted)throw Error('capture_cancelled');
  const redirect=`http://127.0.0.1:${server.address().port}/estelle-plugin/callback`;
  const url=new URL(CAPTURE_AUTH.issuer+'/oauth/authorize');
  url.search=new URLSearchParams({client_id:CAPTURE_AUTH.client,redirect_uri:redirect,response_type:'code',
   scope:CAPTURE_AUTH.scope,resource:CAPTURE_AUTH.resource,state,code_challenge:challenge,code_challenge_method:'S256'});
  const left=deadline-Date.now();if(left<=0||left>LOGIN_MS)throw Error('capture_deadline');
  timer=setTimeout(()=>{settled=true;fail(Error('capture_deadline'));},left);
  // An opener that fails or never returns does not end the sign-in: the address works by hand. It holds no secret.
  console.error(`Sign in to Estelle at: ${url.href}`);
  await open(url.href,deadline).catch(()=>{});
  return {code:await received,redirect};
 }finally{
  clearTimeout(timer);signal?.removeEventListener('abort',stop);server.closeAllConnections();
  if(server.listening)await new Promise(resolve=>server.close(resolve));
 }
}

const publicState=(status,extra={})=>({status,...extra,capture_only:true,mcp_auth:'not_probed',
 hook_execution:'not_observed',automatic_pr_verification:'not_available',work_metrics:'not_available',
 native_auth_store:'not_read',trust:'not_changed',reload:'fresh_session_required'});

export async function runCaptureSetup({host,logout=false,home,deadline=Date.now()+LOGIN_MS}={},ports={}) {
 const platform=ports.platform||process.platform;
 if(platform==='win32'||typeof process.getuid!=='function')return publicState('pending_unsupported_platform');
 if(!hosts.has(host))return publicState('pending_unsupported_host');
 if(!Number.isFinite(deadline)||deadline<=Date.now()||deadline-Date.now()>LOGIN_MS)return publicState('pending_deadline');
 const owner=ports.owner||new CaptureCredentialOwner({home});
 try{
  return await owner.locked(async state=>{
   if(logout){
    if(!state.record)return publicState('capture_not_configured');
    const original=state.record;await state.save({...original,state:'logout_pending'});
    const result=await form('/oauth/revoke',{client_id:CAPTURE_AUTH.client,resource:CAPTURE_AUTH.resource,
     token_type_hint:'refresh_token',token:original.refresh_token},deadline,ports);
    // A person asking again after a lost reply is the retry. revoked:false is an answer too: the server no longer
    // honours this token, so nothing on this machine can use it.
    if(typeof result?.revoked!=='boolean')throw Error('capture_revoke_unknown');
    await state.remove();return publicState('capture_signed_out');
   }
   // An interrupted refresh or logout cannot be resumed, so explicit new consent replaces it. Nothing else may.
   if(state.record?.state==='active')return publicState('capture_already_configured');
   const verifier=randomBytes(48).toString('base64url'),nonce=randomBytes(32).toString('base64url');
   const challenge=createHash('sha256').update(verifier).digest('base64url');
   const {code,redirect}=await receiveCaptureCode({state:nonce,challenge,deadline,open:ports.open,
    serverFactory:ports.serverFactory,signal:ports.signal});
   if(ports.signal?.aborted)throw Error('capture_cancelled');
   const value=await form('/oauth/token',{grant_type:'authorization_code',client_id:CAPTURE_AUTH.client,
    resource:CAPTURE_AUTH.resource,redirect_uri:redirect,code,code_verifier:verifier},deadline,ports);
   await state.save(grant(value,randomBytes(16).toString('hex'),Math.floor(Date.now()/1000)));
   return publicState('capture_configured');
  },{create:!logout});
 }catch(error){
  // Our own codes only, so a person can tell a denied sign-in from a stuck lock. Never a server's words or a value.
  const code=/^capture_[a-z_]+$/.test(String(error?.message))?error.message:'capture_failed';
  return publicState('pending_capture_auth',{reason:code});
 }
}
