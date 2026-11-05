/** Explicit setup only: exact legacy registrations, never hook-time configuration mutation. */
import * as nativeFs from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, basename, join } from 'node:path';

export const MIGRATION_LIMITS = Object.freeze({ bytes:262144, rows:1024, depth:32 });
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const EVENTS = Object.freeze({ ground:['PreToolUse'],guard:['PreToolUse'],pull:['PreToolUse'],
 shift:['PostToolUse'],sync:['PostToolUse'],distil:['PostToolUse'],welcome:['SessionStart'],
 context:['UserPromptSubmit','SubagentStart'],checkpoint:['Stop','SubagentStop','PreCompact','SessionEnd'],
 stream:['UserPromptSubmit','PostToolUse','Stop','SessionEnd'] });

export function legacyCommand(command,event) {
 if(typeof command !== 'string' || command.length>512)return false;
 const match=/^(?:estelle|npx -y @fatelabs\/estelle(?:@(?:[0-9]+(?:\.[0-9]+){0,2}|latest|v0-latest))?|npx -y --package=@fatelabs\/estelle(?:@(?:[0-9]+(?:\.[0-9]+){0,2}|latest|v0-latest))? -- estelle) hook ([a-z-]+)(?: --event ([A-Za-z]+))?$/.exec(command);
 return Boolean(match && Object.hasOwn(EVENTS,match[1]) && EVENTS[match[1]].includes(event) && (!match[2] || match[2]===event));
}

/** JSON.parse alone silently discards duplicate keys; never rewrite such an ambiguous document. */
function checkedJson(bytes) {
 if(!Buffer.isBuffer(bytes) || bytes.length>MIGRATION_LIMITS.bytes)throw Error('hooks_bound');
 const text=new TextDecoder('utf-8',{fatal:true}).decode(bytes), value=JSON.parse(text),stack=[];
 for(const token of text.matchAll(/"(?:\\[\s\S]|[^"\\])*"|[{}\[\]]/g)) {
  const word=token[0];
  if(word==='{' || word==='[')stack.push(word==='{'?new Set():null);
  else if(word==='}' || word===']')stack.pop();
  else if(/^\s*:/.test(text.slice(token.index+word.length))) {
   const keys=stack.at(-1),key=JSON.parse(word);
   if(!keys || keys.has(key))throw Error('hooks_schema');keys.add(key);
  }
  if(stack.length>MIGRATION_LIMITS.depth)throw Error('hooks_bound');
 }
 if(!object(value))throw Error('hooks_schema');return value;
}

export function planHooks(bytes) {
 const value=checkedJson(bytes);let removed=0,rows=0;
 if(!Object.hasOwn(value,'hooks'))return {bytes,removed,hash:digest(bytes)};
 if(!object(value.hooks))throw Error('hooks_schema');
 for(const [event,groups] of Object.entries(value.hooks)) {
  if(!Array.isArray(groups))throw Error('hooks_schema');
  for(const group of groups) {
   if(!object(group) || !Array.isArray(group.hooks))throw Error('hooks_schema');
   group.hooks=group.hooks.filter(hook=>{
    if(++rows>MIGRATION_LIMITS.rows || !object(hook))throw Error('hooks_bound');
    const own=hook.type==='command' && legacyCommand(hook.command,event);
    if(own)removed++;return !own;
   });
  }
 }
 const output=removed?Buffer.from(JSON.stringify(value,null,2)+'\n'):bytes;
 if(output.length>MIGRATION_LIMITS.bytes)throw Error('hooks_bound');
 return {bytes:output,removed,hash:digest(bytes)};
}

const identity = info => [info.dev,info.ino,info.size,info.mtimeNs,info.ctimeNs].map(String).join(':');
export async function inspectHooks(path,{fs=nativeFs}={}) {
 let file;
 try{file=await fs.open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);}
 catch(error){if(error.code==='ENOENT')return null;throw Error('hooks_unavailable');}
 try{
  const info=await file.stat({bigint:true});
  if(!info.isFile() || info.size>BigInt(MIGRATION_LIMITS.bytes))throw Error('hooks_bound');
  const bytes=Buffer.alloc(MIGRATION_LIMITS.bytes+1),result=await file.read(bytes,0,bytes.length,0);
  if(result.bytesRead>MIGRATION_LIMITS.bytes)throw Error('hooks_bound');
  if(result.bytesRead!==Number(info.size))throw Error('hooks_incomplete');
  if(identity(await file.stat({bigint:true}))!==identity(info))throw Error('hooks_conflict');
  const data=bytes.subarray(0,result.bytesRead);planHooks(data);
  return {bytes:data,hash:digest(data),identity:identity(info)};
 }finally{await file.close();}
}

async function sameSnapshot(path,expected,fs) {
 const current=await inspectHooks(path,{fs});
 if(!current || current.hash!==expected?.hash || current.identity!==expected?.identity)throw Error('hooks_conflict');
 return current;
}

async function releaseLock(path,file,fs) {
 try{
  const held=await file.stat({bigint:true}),current=await fs.lstat(path,{bigint:true});
  if(held.dev!==current.dev || held.ino!==current.ino)return false;
  await fs.unlink(path);return true;
 }catch{return false;}
 finally{await file.close();}
}

/** Optimistic conflict checks + atomic replacement; foreign writers must serialize setup changes. */
export async function commitHooks(path,expected,{fs=nativeFs}={}) {
 let lock;
 try{lock=await fs.open(path+'.estelle-setup.lock','wx',0o600);}
 catch{throw Error('hooks_busy');}
 const temporary=join(dirname(path),`.${basename(path)}.estelle-${randomUUID()}.tmp`);
 let replacement=null,renameStarted=false,result;
 try{
  const current=await sameSnapshot(path,expected,fs),plan=planHooks(current.bytes);
  if(!plan.removed){result={status:'unchanged',removed:0};return result;}
  replacement=await fs.open(temporary,'wx',0o600);await replacement.writeFile(plan.bytes);await replacement.sync();
  await replacement.close();replacement=null;
  await sameSnapshot(path,expected,fs);
  renameStarted=true;await fs.rename(temporary,path);
  const directory=await fs.open(dirname(path),constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK|constants.O_DIRECTORY);
  try{await directory.sync();}finally{await directory.close();}
  const saved=await inspectHooks(path,{fs});if(saved?.hash!==digest(plan.bytes))throw Error('hooks_ack');
  result={status:'applied',removed:plan.removed};
 }catch(error){
  if(!renameStarted)throw error;
  result={status:'unknown',removed:null};
 }finally{
  if(replacement)await replacement.close().catch(()=>{});
  await fs.unlink(temporary).catch(()=>{});
  const unlocked=await releaseLock(path+'.estelle-setup.lock',lock,fs);
  if(result && !unlocked)result.cleanup='unknown';
 }
 return result;
}
