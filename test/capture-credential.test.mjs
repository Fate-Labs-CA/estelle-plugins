import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { CAPTURE_AUTH, CaptureCredentialOwner, captureRecord } from '../runtime/auth.mjs';

async function unsupportedWindows(t) {
 if(process.platform!=='win32')return false;
 const {owner}=await fixture(t);await assert.rejects(owner.read(),/capture_unsupported_platform/);
 await assert.rejects(owner.locked(()=>assert.fail('Windows must not enter private mutation')),
  /capture_unsupported_platform/);return true;
}

const record = () => ({ schema:1, issuer:'https://api.fatelabs.ca',
 client_id:'https://api.fatelabs.ca/oauth/clients/plugin',
 resource:'https://api.fatelabs.ca/mcp', scope:'estelle:mcp estelle:capture offline_access',
 access_token:'synthetic-access-token', refresh_token:'synthetic-refresh-token',
 expires_at:2000, partition:'a'.repeat(32), state:'active' });
async function fixture(t) {
 const home=await fs.mkdtemp(join(tmpdir(),'estelle-capture-private-'));
 t.after(()=>fs.rm(home,{recursive:true,force:true}));
 return {home,owner:new CaptureCredentialOwner({home})};
}

test('one private credential roundtrips, uses separate random partition, and absence does not provision',async t=>{
 if(await unsupportedWindows(t))return;
 const {home,owner}=await fixture(t);
 assert.equal(await owner.read(),null);
 await assert.rejects(fs.stat(join(home,'.estelle-plugins')), {code:'ENOENT'});
 await owner.locked(async state=>{assert.equal(state.record,null);await state.save(record());},{create:true});
 const saved=await owner.read();assert.deepEqual(saved,record());
 assert.equal((await fs.stat(join(home,'.estelle-plugins/capture-auth/credential.json'))).mode&0o077,0);
 await owner.locked(async state=>{await state.remove();});
 assert.equal(await owner.read(),null);
});

test('typed credential rejects wider resources/scopes, foreign fields and malformed values',()=>{
 assert.deepEqual(captureRecord(record()),record());
 for(const delta of [{schema:true},{scope:'estelle:mcp'},{resource:'https://api.fatelabs.ca/session/events'},
  {client_id:'foreign'},{issuer:'https://foreign.invalid'},{state:'complete'},
  {expires_at:Infinity},{expires_at:2.5},{partition:'not-an-account'},
  {access_token:'newline\nvalue'},{refresh_token:''},{foreign:true}]){
  assert.throws(()=>captureRecord({...record(),...delta}),/capture_record/);
 }
});

test('pending refresh is persisted before a callback and another claimant cannot bypass its lock',async t=>{
 if(await unsupportedWindows(t))return;
 const {owner}=await fixture(t);
 await owner.locked(async state=>{await state.save(record());},{create:true});
 await owner.locked(async state=>{
  await state.save({...state.record,state:'refresh_pending'});
  await assert.rejects(owner.locked(async()=>assert.fail('duplicate permission')),/capture_busy/);
  assert.equal((await owner.read()).state,'refresh_pending');
 });
 assert.equal((await owner.read()).state,'refresh_pending');
});

test('a lock left by a killed process clears by age, and a live one never does',async t=>{
 if(await unsupportedWindows(t))return;
 const {owner,home}=await fixture(t);
 await owner.locked(async state=>{await state.save(record());},{create:true});
 const path=join(home,'.estelle-plugins/capture-auth/credential.lock');
 await fs.writeFile(path,'',{mode:0o600});
 const edge=new Date(Date.now()-CAPTURE_AUTH.loginMs);await fs.utimes(path,edge,edge);
 await assert.rejects(owner.locked(async()=>assert.fail('took a live lock')),/capture_busy/);
 const dead=new Date(Date.now()-CAPTURE_AUTH.loginMs-61000);await fs.utimes(path,dead,dead);
 assert.equal(await owner.locked(async state=>state.record.state),'active');
 await assert.rejects(fs.stat(path),{code:'ENOENT'});
});

test('symlink, public mode, changed file and short read all refuse without overwriting bytes',async t=>{
 if(await unsupportedWindows(t))return;
 const {home,owner}=await fixture(t);
 await owner.locked(async state=>{await state.save(record());},{create:true});
 const path=join(home,'.estelle-plugins/capture-auth/credential.json');
 await fs.chmod(path,0o644);await assert.rejects(owner.read(),/capture_private/);await fs.chmod(path,0o600);
 const original=await fs.readFile(path);await fs.rename(path,path+'.original');await fs.symlink(path+'.original',path);
 await assert.rejects(owner.read());await fs.unlink(path);await fs.rename(path+'.original',path);
 const malformed=Buffer.concat([original,Buffer.from('\nUNREAD_MALFORMED_SUFFIX')]);await fs.writeFile(path,malformed);
 const port={...fs,open:async(...args)=>{
  const file=await fs.open(...args);if(args[0]===path){const read=file.read.bind(file);file.read=(b,o,l,p)=>read(b,o,Math.min(l,original.length),p);}return file;
 }};
 await assert.rejects(new CaptureCredentialOwner({home,fs:port}).read(),/capture_incomplete/);
 assert.deepEqual(await fs.readFile(path),malformed);await fs.writeFile(path,original);
 await assert.rejects(owner.locked(async state=>{
  await fs.writeFile(path,JSON.stringify({...record(),state:'logout_pending'}));
  await state.save({...record(),access_token:'must-not-overwrite'});
 }),/capture_conflict/);
 assert.equal(JSON.parse(await fs.readFile(path)).state,'logout_pending');
});

test('actual private credential FIFO refuses without blocking; regular positive remains usable',async t=>{
 if(await unsupportedWindows(t))return;
 const {home,owner}=await fixture(t);
 await owner.locked(async state=>{await state.save(record());},{create:true});
 assert.equal((await owner.read()).state,'active');
 const path=join(home,'.estelle-plugins/capture-auth/credential.json');await fs.unlink(path);
 const made=spawnSync('mkfifo',[path],{encoding:'utf8',timeout:1000});assert.equal(made.status,0);
 const script=`import {CaptureCredentialOwner} from ${JSON.stringify(new URL('../runtime/auth.mjs',import.meta.url).href)};
try{await new CaptureCredentialOwner({home:${JSON.stringify(home)}}).read();console.log('accepted');}
catch{console.log('refused');}`;
 const child=spawnSync(process.execPath,['--input-type=module','-e',script],
  {env:{PATH:process.env.PATH,HOME:home},encoding:'utf8',timeout:1500,maxBuffer:1000});
 assert.equal(child.error,undefined);assert.equal(child.status,0);assert.equal(child.stdout.trim(),'refused');
 assert.equal(child.stderr,'');
});
