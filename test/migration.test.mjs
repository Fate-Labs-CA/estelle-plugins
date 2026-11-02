import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, symlink, stat } from 'node:fs/promises';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { planHooks, inspectHooks, commitHooks, legacyCommand } from '../runtime/migration.mjs';
import { runSetup } from '../runtime/setup.mjs';
const raw = value => Buffer.from(JSON.stringify(value));
const legacy = (mode, event, extra={}) => ({ type:'command', command:`estelle hook ${mode} --event ${event}`, ...extra });
async function fixture(t, value) {
 const dir=await mkdtemp(join(tmpdir(),'estelle-setup-owned-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const file=join(dir,'hooks.json');await writeFile(file,raw(value),{mode:0o600});return {dir,file};
}
const mixed=()=>({ extra:{keep:true},hooks:{PreToolUse:[{matcher:'Write|Edit', custom:'preserve', hooks:[legacy('ground','PreToolUse'),{type:'command',command:'security-check --strict',timeout:5}]}],Stop:[{hooks:[legacy('checkpoint','Stop'),{type:'command',command:'node "${PLUGIN_ROOT}/runtime/cli.mjs" hook codex'}]}]}});
async function unsupportedApply(file) {
 const before=await readFile(file);let effects=0;
 const env=new Proxy({},{get(){effects++;throw Error('Windows apply must not read credentials');}});
 const result=await runSetup({host:'codex',apply:true,home:tmpdir(),env},{
  native:async()=>{effects++;throw Error('Windows apply must not invoke native commands');},
  authenticate:async()=>{effects++;return true;}});
 assert.equal(result.status,'pending_unsupported_platform');assert.equal(effects,0);
 assert.deepEqual(await readFile(file),before);
}
test('exact owned commands only: no shell, basename, package or mismatched event inference',()=>{
 assert(legacyCommand('estelle hook ground --event PreToolUse','PreToolUse'));
 assert(legacyCommand('npx -y --package=@fatelabs/estelle@latest -- estelle hook checkpoint --event Stop','Stop'));
 for(const command of ['echo estelle hook ground','/foreign/estelle hook ground','estelle hook ground && security-check','estelle hook ground --api-key literal','npx -y @foreign/estelle hook ground','estelle hook ground --event Stop'])assert(!legacyCommand(command,'PreToolUse'),command);
});
test('planner removes own rows, retaining every foreign value, option and order',()=>{
 const input=mixed(),before=structuredClone(input),plan=planHooks(raw(input));assert.equal(plan.removed,2);
 const after=JSON.parse(plan.bytes);assert.deepEqual(after.extra,before.extra);
 assert.equal(after.hooks.PreToolUse[0].custom,'preserve');assert.equal(after.hooks.PreToolUse[0].matcher,'Write|Edit');
 assert.deepEqual(after.hooks.PreToolUse[0].hooks,[before.hooks.PreToolUse[0].hooks[1]]);
 assert.deepEqual(after.hooks.Stop[0].hooks,[before.hooks.Stop[0].hooks[1]]);assert.deepEqual(input,before);
 assert.equal(planHooks(plan.bytes).removed,0);
});
test('missing hooks is a byte-preserving no-op, malformed and duplicate keys refuse',()=>{
 const body=Buffer.from('{ "foreign": true }');assert.deepEqual(planHooks(body).bytes,body);
 for(const text of ['[]','{"hooks":1}','{"hooks":{"Stop":[{"hooks":[null]}]}}','{"foreign":1,"foreign":2}','{"hooks":{},"hooks":{}}'])assert.throws(()=>planHooks(Buffer.from(text)));
 assert.throws(()=>planHooks(Buffer.alloc(262145,32)));assert.throws(()=>planHooks(Buffer.from([0xff])));
});
test('actual owned file commit is private, idempotent and preserves foreign hooks',async t=>{
 if(process.platform==='win32'){const {file}=await fixture(t,mixed());await unsupportedApply(file);return;}
 const {file}=await fixture(t,mixed());const snapshot=await inspectHooks(file);const result=await commitHooks(file,snapshot);
 assert.equal(result.status,'applied');assert.equal(result.removed,2);assert.equal(planHooks(await readFile(file)).removed,0);
 assert.equal((await stat(file)).mode&0o077,0);assert.equal((await commitHooks(file,await inspectHooks(file))).status,'unchanged');
});
test('stale content and replaced inode refuse without touching the new file',async t=>{
 const {file}=await fixture(t,mixed());const snapshot=await inspectHooks(file);const replacement=raw({hooks:{},foreign:'latest'});
 await writeFile(file,replacement);await assert.rejects(commitHooks(file,snapshot),/conflict/);assert.deepEqual(await readFile(file),replacement);
 const old=await inspectHooks(file);await rm(file);await writeFile(file,replacement);await assert.rejects(commitHooks(file,old),/conflict/);
});
test('symlink/absent/nonregular and lock conflict never overwrite',async t=>{
 if(process.platform==='win32'){const {file}=await fixture(t,mixed());await unsupportedApply(file);return;}
 const {dir,file}=await fixture(t,mixed());const alias=join(dir,'alias');await symlink(file,alias);
 await assert.rejects(inspectHooks(alias));assert.equal(await inspectHooks(join(dir,'absent')),null);
 await assert.rejects(inspectHooks(dir));const snapshot=await inspectHooks(file);await writeFile(file+'.estelle-setup.lock','owned other setup');
 await assert.rejects(commitHooks(file,snapshot),/busy/);assert.equal(planHooks(await readFile(file)).removed,2);
});
test('rename ACK loss is unknown, not success or retry; committed bytes remain inspectable',async t=>{
 const {file}=await fixture(t,mixed());let renames=0;
 const port={...fs,rename:async(...args)=>{renames++;await fs.rename(...args);throw Error('synthetic ack lost');}};
 const result=await commitHooks(file,await inspectHooks(file),{fs:port});assert.equal(result.status,'unknown');assert.equal(renames,1);
 assert.equal(planHooks(await readFile(file)).removed,0);assert.equal((await commitHooks(file,await inspectHooks(file))).status,'unchanged');
});

test('bounded parser refuses deep/large hooks and preserves unusual foreign values',()=>{
 assert.equal(legacyCommand('estelle hook constructor','Stop'),false);
 assert.throws(()=>planHooks(raw({foreign:Array.from({length:35}).reduce(x=>[x],null)})),/bound/);
 assert.throws(()=>planHooks(raw({hooks:{Stop:[{hooks:Array.from({length:1025},()=>({type:'command',command:'foreign'}))}]}})),/bound/);
 const value=mixed();value.foreign={credentials:'synthetic-foreign-secret-not-output',nested:['preserve',null,false]};
 const result=JSON.parse(planHooks(raw(value)).bytes);assert.deepEqual(result.foreign,value.foreign);
});
test('failure before rename leaves original bytes and removes owned temporary/lock files',async t=>{
 const {file,dir}=await fixture(t,mixed()),snapshot=await inspectHooks(file);let renames=0;
 const port={...fs,rename:async()=>{renames++;throw Error('synthetic not committed');}};
 assert.equal((await commitHooks(file,snapshot,{fs:port})).status,'unknown');
 assert.equal(renames,1);assert.deepEqual(await readFile(file),snapshot.bytes);assert.deepEqual(await fs.readdir(dir),['hooks.json']);
});
test('changed target during temporary preparation refuses without overwriting foreign update',async t=>{
 const {file}=await fixture(t,mixed()),snapshot=await inspectHooks(file),foreign=raw({hooks:{},foreign:'concurrent'});
 const port={...fs,open:async(path,...args)=>{
  const handle=await fs.open(path,...args);
  if(String(path).endsWith('.tmp')){const sync=handle.sync.bind(handle);handle.sync=async()=>{await sync();await fs.writeFile(file,foreign);};}
  return handle;
 }};
 await assert.rejects(commitHooks(file,snapshot,{fs:port}),/conflict/);assert.deepEqual(await readFile(file),foreign);
});
test('precommit write failure leaves original configuration byte-exact',async t=>{
 const {file,dir}=await fixture(t,mixed()),snapshot=await inspectHooks(file);let renames=0;
 const port={...fs,rename:async(...args)=>{renames++;return fs.rename(...args);},open:async(path,...args)=>{
  const handle=await fs.open(path,...args);if(String(path).endsWith('.tmp'))handle.sync=async()=>{throw Error('synthetic fsync refusal');};return handle;
 }};
 await assert.rejects(commitHooks(file,snapshot,{fs:port}));assert.equal(renames,0);
 assert.deepEqual(await readFile(file),snapshot.bytes);assert.deepEqual(await fs.readdir(dir),['hooks.json']);
});
test('fourteen source-owned registrations are removed while public and foreign security rows survive',()=>{
 const pairs=[['ground','PreToolUse'],['guard','PreToolUse'],['pull','PreToolUse'],['shift','PostToolUse'],
  ['sync','PostToolUse'],['distil','PostToolUse'],['welcome','SessionStart'],['context','UserPromptSubmit'],
  ['context','SubagentStart'],['checkpoint','Stop'],['checkpoint','SubagentStop'],['checkpoint','PreCompact'],
  ['checkpoint','SessionEnd'],['stream','PostToolUse']];
 const hooks={};for(const [mode,event] of pairs)(hooks[event]??=[]).push({hooks:[legacy(mode,event)]});
 const preserved=[{type:'command',command:'foreign-check',option:{preserve:true}},
  {type:'command',command:'node "${PLUGIN_ROOT}/runtime/cli.mjs" hook codex'}];
 hooks.PreToolUse.push({matcher:'*',hooks:preserved});const plan=planHooks(raw({hooks}));
 assert.equal(plan.removed,14);assert.deepEqual(JSON.parse(plan.bytes).hooks.PreToolUse.at(-1).hooks,preserved);
});
test('post-rename directory flush opens only a nonblocking nonsymlink directory',async t=>{
 if(process.platform==='win32'){const {file}=await fixture(t,mixed());await unsupportedApply(file);return;}
 const {constants}=await import('node:fs');const {file,dir}=await fixture(t,mixed());let inspected=false;
 const port={...fs,open:async(path,flags,...args)=>{
  if(path===dir){for(const flag of [constants.O_DIRECTORY,constants.O_NOFOLLOW,constants.O_NONBLOCK])assert.equal(flags&flag,flag);inspected=true;}
  return fs.open(path,flags,...args);
 }};
 assert.equal((await commitHooks(file,await inspectHooks(file),{fs:port})).status,'applied');assert.equal(inspected,true);
});
test('short regular-file reads cannot authorize overwriting unread configuration',async t=>{
 const {file}=await fixture(t,mixed());const full=await inspectHooks(file);
 if(process.platform==='win32')await unsupportedApply(file);
 else{assert.equal((await commitHooks(file,full)).status,'applied');assert.equal(planHooks(await readFile(file)).removed,0);}
 const prefix=raw({hooks:{PreToolUse:[{hooks:[{type:'command',command:'estelle hook ground'}]}]}});
 const original=Buffer.concat([prefix,Buffer.from('\nUNSUPPORTED_TRAILING_BYTES')]);await writeFile(file,original);
 assert.throws(()=>planHooks(original));let refused=false,outcome;
 const port={...fs,open:async(...args)=>{
  const handle=await fs.open(...args);if(args[0]===file){const read=handle.read.bind(handle);handle.read=(buffer,offset,length,position)=>read(buffer,offset,Math.min(prefix.length,length),position);}return handle;
 }};
 try{const snapshot=await inspectHooks(file,{fs:port});outcome=await commitHooks(file,snapshot,{fs:port});}catch{refused=true;}
 assert.deepEqual(await readFile(file),original);assert.equal(refused,true);assert.equal(outcome,undefined);
});
