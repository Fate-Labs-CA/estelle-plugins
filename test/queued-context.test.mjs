import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rename, readFile, readdir, rm, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beginContext, saveContext, takeContext } from '../runtime/queued-context.mjs';

const MODULE = new URL('../runtime/queued-context.mjs', import.meta.url).href;
const WORKERS = 8;
const CHILD_TIMEOUT_MS = 10_000;
const MAX_OUTPUT = 16_000;

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'estelle-context-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'queue.json');
  const request = await beginContext(path, 'turn');
  assert.equal(await saveContext(path, 'turn', request, 'queued fixture', true), true);
  return { root, path, request };
}

function isolated(script, path) {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script, path], {
    encoding: 'utf8', timeout: CHILD_TIMEOUT_MS, maxBuffer: MAX_OUTPUT,
  });
  assert.equal(result.status, 0, result.stderr || String(result.error));
  return JSON.parse(result.stdout);
}

function worker(script, path) {
  const child = spawn(process.execPath, ['--input-type=module', '-e', script, path], {
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let output = '', errors = '';
  const timer = setTimeout(() => child.kill('SIGKILL'), CHILD_TIMEOUT_MS);
  child.stdout.on('data', chunk => { output += chunk; if (output.length > MAX_OUTPUT) child.kill('SIGKILL'); });
  child.stderr.on('data', chunk => { errors += chunk; if (errors.length > MAX_OUTPUT) child.kill('SIGKILL'); });
  const ready = new Promise((resolve, reject) => {
    child.once('message', resolve);
    child.once('error', reject);
    child.once('exit', () => reject(new Error('worker exited before readiness')));
  });
  const done = new Promise((resolve, reject) => {
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve(JSON.parse(output));
      else reject(new Error(`context worker failed ${code}/${signal}: ${errors}`));
    });
  });
  // Attach a handler before awaiting readiness; every rejection is still observed through done.
  done.catch(() => {});
  return { child, ready, done };
}

test('queued-context claim never overlaps same-source native rename syscalls', async t => {
  const f = await fixture(t);
  const result = isolated(`
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    import {syncBuiltinESMExports} from 'node:module';
    const rename = fs.promises.rename;
    let active=0, maximum=0, delayed=false;
    fs.promises.rename = async (from,to) => {
      if (!to.endsWith('.claimed')) return rename(from,to);
      active++; maximum=Math.max(maximum,active);
      try { if (!delayed) { delayed=true; await new Promise(resolve=>setTimeout(resolve,25)); } return await rename(from,to); }
      finally { active--; }
    };
    syncBuiltinESMExports();
    const {takeContext}=await import(${JSON.stringify(MODULE)});
    const results=await Promise.all(Array.from({length:${WORKERS}},()=>takeContext(process.argv[1],'turn')));
    assert.equal(results.filter(Boolean).length,1);
    assert.deepEqual(results.find(Boolean),{text:'queued fixture',degraded:true});
    assert.equal(maximum,1,'same-source native claim rename must be serialized');
    console.log(JSON.stringify({maximum,consumers:results.filter(Boolean).length}));
  `, f.path);
  assert.deepEqual(result, { maximum: 1, consumers: 1 });
  assert.deepEqual(await readdir(f.root), []);
});

test('independent hook processes consume queued text and degraded state exactly once', async t => {
  const f = await fixture(t);
  const script = `
    const {takeContext}=await import(${JSON.stringify(MODULE)});
    const go=new Promise(resolve=>process.once('message',resolve));
    process.send('ready'); await go;
    console.log(JSON.stringify(await takeContext(process.argv[1],'turn')));
    process.disconnect();
  `;
  const workers = Array.from({ length: WORKERS }, () => worker(script, f.path));
  t.after(() => { for (const item of workers) if (item.child.exitCode === null) item.child.kill('SIGKILL'); });
  await Promise.all(workers.map(item => item.ready));
  for (const item of workers) item.child.send('go');
  const results = await Promise.all(workers.map(item => item.done));
  assert.equal(results.filter(Boolean).length, 1);
  assert.deepEqual(results.find(Boolean), { text: 'queued fixture', degraded: true });
  assert.deepEqual(await readdir(f.root), []);
});

test('both save and take wait for a live short claim guard without losing context', async t => {
  const f = await fixture(t);
  for (const operation of ['save', 'take']) {
    const guard = `${f.path}.claim-lock`;
    await mkdir(guard);
    const owner = join(guard, `${process.pid}.${randomUUID()}.owner`);
    await writeFile(owner, '', { flag: 'wx' });
    let settled = false;
    const pending = operation === 'save'
      ? saveContext(f.path, 'turn', f.request, 'updated fixture', true) : takeContext(f.path, 'turn');
    pending.then(() => { settled = true; }, () => { settled = true; });
    await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(settled, false, 'the live guard must retain ownership until its owner releases');
    await unlink(owner);
    // The existing claimant reclaims the now-empty guard. Removing the shared path
    // here could race with its replacement owner after our owner was unlinked.
    assert.deepEqual(await pending, operation === 'save' ? true : { text: 'updated fixture', degraded: true });
  }
  assert.deepEqual(await readdir(f.root), []);
});

test('interrupted owner is reclaimed in the same session without changing the pending payload', async t => {
  const f = await fixture(t);
  const before = await readFile(f.path);
  const owner = worker(`
    import {mkdir,writeFile} from 'node:fs/promises';
    import {randomUUID} from 'node:crypto';
    const guard=process.argv[1]+'.claim-lock'; await mkdir(guard);
    await writeFile(guard+'/'+process.pid+'.'+randomUUID()+'.owner','',{flag:'wx'});
    process.send('guard-held');
    await new Promise(resolve=>process.once('message',resolve));
  `, f.path);
  t.after(() => { if (owner.child.exitCode === null) owner.child.kill('SIGKILL'); });
  await owner.ready;
  await assert.rejects(takeContext(f.path, 'turn'), /context_claim_locked/);
  await assert.rejects(saveContext(f.path, 'turn', f.request, 'must not replace'), /context_claim_locked/);
  assert.deepEqual(await readFile(f.path), before, 'a live owner cannot be taken over');
  owner.child.kill('SIGKILL');
  await assert.rejects(owner.done, /context worker failed/);
  assert.equal(await saveContext(f.path, 'turn', f.request, 'same session recovered', true), true);
  assert.deepEqual(await takeContext(f.path, 'turn'), { text: 'same session recovered', degraded: true });
  assert.deepEqual(await readdir(f.root), []);
});

test('native rename failure releases the guard and preserves the error and pending payload', async t => {
  const f = await fixture(t);
  const result = isolated(`
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    import {syncBuiltinESMExports} from 'node:module';
    const rename=fs.promises.rename;
    let failed=false;
    fs.promises.rename=async(from,to)=>{
      if(!failed && to.endsWith('.claimed')) { failed=true; throw Object.assign(new Error('fixture denied'),{code:'EACCES'}); }
      return rename(from,to);
    };
    syncBuiltinESMExports();
    const {takeContext}=await import(${JSON.stringify(MODULE)});
    const before=await fs.promises.readFile(process.argv[1]);
    await assert.rejects(takeContext(process.argv[1],'turn'),{code:'EACCES'});
    await assert.rejects(fs.promises.stat(process.argv[1]+'.claim-lock'),{code:'ENOENT'});
    assert.deepEqual(await fs.promises.readFile(process.argv[1]),before);
    assert.deepEqual(await takeContext(process.argv[1],'turn'),{text:'queued fixture',degraded:true});
    console.log(JSON.stringify({originalError:true,guardReleased:true,nextConsumer:true}));
  `, f.path);
  assert.deepEqual(result, { originalError: true, guardReleased: true, nextConsumer: true });
  assert.deepEqual(await readdir(f.root), []);
});

test('an intervening prompt wins over restore and stale requests cannot publish old text', async t => {
  const f = await fixture(t);
  const result = isolated(`
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    import {syncBuiltinESMExports} from 'node:module';
    const link=fs.promises.link;
    let replacement, replaced=false, begin;
    fs.promises.link=async(from,to)=>{
      if(!replaced) { replaced=true; replacement=await begin(process.argv[1],'next-turn'); }
      return link(from,to);
    };
    syncBuiltinESMExports();
    const queue=await import(${JSON.stringify(MODULE)}); begin=queue.beginContext;
    const old=JSON.parse(await fs.promises.readFile(process.argv[1],'utf8'));
    assert.equal(await queue.saveContext(process.argv[1],'turn',old.requestId,'old text'),false);
    assert.equal(await queue.takeContext(process.argv[1],'turn'),null);
    assert.equal(await queue.saveContext(process.argv[1],'turn',old.requestId,'stale update'),false);
    const fresh=JSON.parse(await fs.promises.readFile(process.argv[1],'utf8'));
    assert.equal(fresh.requestId,replacement); assert.equal(fresh.text,null);
    assert.equal(await queue.saveContext(process.argv[1],'next-turn',replacement,'fresh text',true),true);
    assert.deepEqual(await queue.takeContext(process.argv[1],'next-turn'),{text:'fresh text',degraded:true});
    console.log(JSON.stringify({interveningPromptPreserved:true,staleRequestRefused:true,freshDelivery:true}));
  `, f.path);
  assert.deepEqual(result, { interveningPromptPreserved: true, staleRequestRefused: true, freshDelivery: true });
  assert.deepEqual(await readdir(f.root), []);
});

test('restored hard-link aliases can be consumed before their original owner finishes unlinking', async t => {
  const f = await fixture(t);
  const result = isolated(`
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    import {syncBuiltinESMExports} from 'node:module';
    const link=fs.promises.link;
    let consume, emitted;
    fs.promises.link=async(from,to)=>{
      const value=await link(from,to);
      if(consume) { const run=consume; consume=null; emitted=await run(); }
      return value;
    };
    syncBuiltinESMExports();
    const queue=await import(${JSON.stringify(MODULE)});
    consume=()=>queue.takeContext(process.argv[1],'turn');
    assert.equal(await queue.takeContext(process.argv[1],'wrong-turn'),null);
    assert.deepEqual(emitted,{text:'queued fixture',degraded:true});
    const request=await queue.beginContext(process.argv[1],'next');
    consume=()=>queue.takeContext(process.argv[1],'next');
    assert.equal(await queue.saveContext(process.argv[1],'next',request,'updated text',true),true);
    assert.deepEqual(emitted,{text:'updated text',degraded:true});
    assert.equal(await queue.takeContext(process.argv[1],'next'),null);
    console.log(JSON.stringify({mismatchedReaderRestore:true,saverRestore:true,oneDeliveryPerRecord:true}));
  `, f.path);
  assert.deepEqual(result, { mismatchedReaderRestore: true, saverRestore: true, oneDeliveryPerRecord: true });
  assert.deepEqual(await readdir(f.root), []);
});

test('native directory publication cannot overwrite a nonempty live guard', async t => {
  const f = await fixture(t);
  const guard = `${f.path}.claim-lock`, candidate = join(f.root, 'native-candidate');
  await mkdir(guard); await mkdir(candidate);
  await writeFile(join(guard, 'live-owner'), 'unchanged');
  await writeFile(join(candidate, 'candidate-owner'), 'candidate');
  await assert.rejects(rename(candidate, guard), error => ['EEXIST', 'ENOTEMPTY', 'EPERM', 'EACCES'].includes(error.code));
  assert.equal(await readFile(join(guard, 'live-owner'), 'utf8'), 'unchanged');
  assert.equal(await readFile(join(candidate, 'candidate-owner'), 'utf8'), 'candidate');
});

test('a process killed after owner unlink leaves an empty guard that the next claim recovers', async t => {
  const f = await fixture(t);
  const owner = worker(`
    import {mkdir,writeFile,unlink} from 'node:fs/promises';
    import {randomUUID} from 'node:crypto';
    const guard=process.argv[1]+'.claim-lock'; await mkdir(guard);
    const owner=guard+'/'+process.pid+'.'+randomUUID()+'.owner';
    await writeFile(owner,'',{flag:'wx'}); await unlink(owner);
    process.send('owner-unlinked'); await new Promise(resolve=>process.once('message',resolve));
  `, f.path);
  t.after(() => { if (owner.child.exitCode === null) owner.child.kill('SIGKILL'); });
  await owner.ready;
  owner.child.kill('SIGKILL');
  await assert.rejects(owner.done, /context worker failed/);
  assert.deepEqual(await readdir(`${f.path}.claim-lock`), []);
  assert.deepEqual(await takeContext(f.path, 'turn'), { text: 'queued fixture', degraded: true });
  assert.deepEqual(await readdir(f.root), []);
});

test('competing reclaimers cannot remove a replacement owner between unlink and rmdir', async t => {
  const f = await fixture(t);
  const result = isolated(`
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    import {spawnSync} from 'node:child_process';
    import {randomUUID} from 'node:crypto';
    import {syncBuiltinESMExports} from 'node:module';
    const path=process.argv[1], guard=path+'.claim-lock', candidate=path+'.replacement';
    const dead=spawnSync(process.execPath,['-e','console.log(process.pid)'],{encoding:'utf8',timeout:3000,maxBuffer:1000});
    assert.equal(dead.status,0); const deadPid=Number(dead.stdout.trim());
    assert.throws(()=>process.kill(deadPid,0),{code:'ESRCH'});
    const old=deadPid+'.'+randomUUID()+'.owner', replacement=process.pid+'.'+randomUUID()+'.owner';
    await fs.promises.mkdir(guard); await fs.promises.writeFile(guard+'/'+old,'');
    await fs.promises.mkdir(candidate); await fs.promises.writeFile(candidate+'/'+replacement,'');
    const unlink=fs.promises.unlink, rmdir=fs.promises.rmdir, rename=fs.promises.rename;
    let entered=0, both, published, removed=0;
    const arrivals=new Promise(resolve=>both=resolve), changed=new Promise(resolve=>published=resolve);
    fs.promises.unlink=async name=>{
      if(name!==guard+'/'+old) return unlink(name);
      entered++;
      if(entered===1) {
        await arrivals; await unlink(name); await rmdir(guard); await rename(candidate,guard); published(); return;
      }
      both(); await changed; return unlink(name);
    };
    fs.promises.rmdir=async name=>{ if(name===guard) removed++; return rmdir(name); };
    syncBuiltinESMExports();
    const {takeContext}=await import(${JSON.stringify(MODULE)});
    const before=await fs.promises.readFile(path);
    const results=await Promise.allSettled([takeContext(path,'turn'),takeContext(path,'turn')]);
    assert(results.every(item=>item.status==='rejected'&&item.reason.message==='context_claim_locked'));
    assert.equal(entered,2); assert.equal(removed,1,'only successful old-owner unlink attempts rmdir');
    assert.deepEqual(await fs.promises.readdir(guard),[replacement]);
    assert.deepEqual(await fs.promises.readFile(path),before);
    await unlink(guard+'/'+replacement); await rmdir(guard);
    assert.deepEqual(await takeContext(path,'turn'),{text:'queued fixture',degraded:true});
    console.log(JSON.stringify({reclaimers:entered,replacementPreserved:true,eventualDelivery:true}));
  `, f.path);
  assert.deepEqual(result, { reclaimers: 2, replacementPreserved: true, eventualDelivery: true });
  assert.deepEqual(await readdir(f.root), []);
});

test('malformed and extra guard entries are held without deleting payloads or leaking candidates', async t => {
  const f = await fixture(t), guard = `${f.path}.claim-lock`;
  await mkdir(guard);
  await writeFile(join(guard, 'unrecognized-owner'), 'preserve');
  const before = await readFile(f.path);
  await assert.rejects(takeContext(f.path, 'turn'), /context_claim_locked/);
  await writeFile(join(guard, `${process.pid}.${randomUUID()}.owner`), '');
  await assert.rejects(saveContext(f.path, 'turn', f.request, 'refused'), /context_claim_locked/);
  assert.deepEqual(await readFile(f.path), before);
  assert.equal(await readFile(join(guard, 'unrecognized-owner'), 'utf8'), 'preserve');
  assert.deepEqual((await readdir(f.root)).sort(), ['queue.json', 'queue.json.claim-lock']);
});

test('candidate preparation and publication storage failures preserve the original error and clean only owned candidates', async t => {
  const f = await fixture(t);
  const result = isolated(`
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    import {syncBuiltinESMExports} from 'node:module';
    import {dirname} from 'node:path';
    const write=fs.promises.writeFile, rename=fs.promises.rename;
    let operation='prepare';
    fs.promises.writeFile=async(name,...rest)=>{
      if(operation==='prepare' && name.endsWith('.owner')) throw Object.assign(new Error('denied prepare'),{code:'EACCES'});
      if(operation==='partial' && name.endsWith('.owner')) {
        await write(name,...rest); throw Object.assign(new Error('partial preparation'),{code:'ENOSPC'});
      }
      return write(name,...rest);
    };
    fs.promises.rename=async(from,to)=>{
      if(operation==='publish' && to.endsWith('.claim-lock')) throw Object.assign(new Error('denied publish'),{code:'EACCES'});
      return rename(from,to);
    };
    syncBuiltinESMExports();
    const {takeContext}=await import(${JSON.stringify(MODULE)});
    const before=await fs.promises.readFile(process.argv[1]);
    for(const step of ['prepare','partial','publish']) {
      operation=step; await assert.rejects(takeContext(process.argv[1],'turn'),{code:step==='partial'?'ENOSPC':'EACCES'});
      assert.deepEqual(await fs.promises.readdir(dirname(process.argv[1])),['queue.json']);
      assert.deepEqual(await fs.promises.readFile(process.argv[1]),before);
    }
    operation='healthy'; assert.deepEqual(await takeContext(process.argv[1],'turn'),{text:'queued fixture',degraded:true});
    console.log(JSON.stringify({storageErrorsPreserved:true,ownedCandidatesCleaned:true,queuePreserved:true}));
  `, f.path);
  assert.deepEqual(result, { storageErrorsPreserved: true, ownedCandidatesCleaned: true, queuePreserved: true });
});

test('hook diagnostics identify a held claim separately from credential and HTTP failures', async t => {
  const f = await fixture(t);
  const { hash, errorCode } = await import('../runtime/io.mjs');
  const state = join(f.root, 'cli-state'), home = join(f.root, 'cli-home');
  const session = 'context-diagnostic';
  const path = join(state, 'unauthenticated', 'context', `${hash(`grok:${session}`)}.json`);
  const request = await beginContext(path, 'diagnostic-turn');
  assert.equal(await saveContext(path, 'diagnostic-turn', request, 'preserved diagnostic fixture'), true);
  const guard = `${path}.claim-lock`;
  await mkdir(guard);
  await writeFile(join(guard, `${process.pid}.${randomUUID()}.owner`), '');
  const payload = { hookEventName: 'pre_tool_use', sessionId: session, promptId: 'diagnostic-turn',
    cwd: f.root, toolName: 'Read', toolInput: { path: 'fixture.ts' }, toolUseId: 'diagnostic-tool' };
  const result = spawnSync(process.execPath, [join(import.meta.dirname, '../runtime/cli.mjs'), 'hook', 'grok'], {
    input: JSON.stringify(payload), encoding: 'utf8', timeout: CHILD_TIMEOUT_MS, maxBuffer: MAX_OUTPUT,
    env: { PATH: process.env.PATH, HOME: home, USERPROFILE: home, ESTELLE_PLUGIN_DATA: state },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '', 'local failure cannot inject successful or empty recall');
  const status = JSON.parse(await readFile(join(home, '.estelle-plugins', 'unauthenticated', 'status', 'grok-runner.json'), 'utf8'));
  assert.deepEqual({ status: status.status, code: status.code }, { status: 'failed', code: 'context_claim_locked' });
  assert.equal(errorCode(new Error('credential_missing')), 'credential_missing');
  assert.equal(errorCode(Object.assign(new Error('auth refused'), { status: 401 })), 'http_401');
  assert.equal(JSON.parse(await readFile(path, 'utf8')).text, 'preserved diagnostic fixture');
});

test('Windows permission-shaped contention retries when the owner releases before guard inspection', async t => {
  for (const code of ['EPERM', 'EACCES']) {
    for (const operation of ['take', 'save']) {
      const f = await fixture(t);
      const result = isolated(`
        import assert from 'node:assert/strict';
        import fs from 'node:fs';
        import {randomUUID} from 'node:crypto';
        import {syncBuiltinESMExports} from 'node:module';
        const guard=process.argv[1]+'.claim-lock', owner=process.pid+'.'+randomUUID()+'.owner';
        await fs.promises.mkdir(guard); await fs.promises.writeFile(guard+'/'+owner,'');
        const rename=fs.promises.rename;
        let publications=0;
        fs.promises.rename=async(from,to)=>{
          if(to!==guard) return rename(from,to);
          publications++;
          if(publications===1) {
            await assert.rejects(rename(from,to),'the actual nonempty guard must block publication');
            await fs.promises.unlink(guard+'/'+owner); await fs.promises.rmdir(guard);
            throw Object.assign(new Error('Windows conflict after owner released'),{code:${JSON.stringify(code)}});
          }
          return rename(from,to);
        };
        syncBuiltinESMExports();
        const queue=await import(${JSON.stringify(MODULE)});
        if(${JSON.stringify(operation)}==='save') {
          const pending=JSON.parse(await fs.promises.readFile(process.argv[1],'utf8'));
          assert.equal(await queue.saveContext(process.argv[1],'turn',pending.requestId,'saved after transient',true),true);
          assert.equal(publications,2,'retry the ambiguous permission result within the original bound');
          assert.deepEqual(await queue.takeContext(process.argv[1],'turn'),{text:'saved after transient',degraded:true});
        } else {
          assert.deepEqual(await queue.takeContext(process.argv[1],'turn'),{text:'queued fixture',degraded:true});
          assert.equal(publications,2,'retry the ambiguous permission result within the original bound');
        }
        console.log(JSON.stringify({code:${JSON.stringify(code)},operation:${JSON.stringify(operation)},delivered:true}));
      `, f.path);
      assert.deepEqual(result, { code, operation, delivered: true });
      assert.deepEqual(await readdir(f.root), []);
    }
  }
});

test('persistent publication permission denial retains the exact error, payload and bounded retry count', async t => {
  for (const code of ['EPERM', 'EACCES']) {
    const f = await fixture(t);
    const result = isolated(`
      import assert from 'node:assert/strict';
      import fs from 'node:fs';
      import {dirname} from 'node:path';
      import {syncBuiltinESMExports} from 'node:module';
      const rename=fs.promises.rename, denied=Object.assign(new Error('persistent publication denied'),{code:${JSON.stringify(code)}});
      let attempts=0, fail=true;
      fs.promises.rename=async(from,to)=>{
        if(fail && to.endsWith('.claim-lock')) { attempts++; throw denied; }
        return rename(from,to);
      };
      syncBuiltinESMExports();
      const queue=await import(${JSON.stringify(MODULE)});
      const before=await fs.promises.readFile(process.argv[1]), pending=JSON.parse(before);
      for(const operation of ['take','save']) {
        attempts=0;
        const run=operation==='take'?queue.takeContext(process.argv[1],'turn'):
          queue.saveContext(process.argv[1],'turn',pending.requestId,'must remain unchanged');
        await assert.rejects(run,error=>error===denied,'retain the original native error object');
        assert.equal(attempts,20,'permission retries must stop at the shared claim bound');
        assert.deepEqual(await fs.promises.readFile(process.argv[1]),before);
        assert.deepEqual(await fs.promises.readdir(dirname(process.argv[1])),['queue.json']);
      }
      fail=false; assert.deepEqual(await queue.takeContext(process.argv[1],'turn'),{text:'queued fixture',degraded:true});
      console.log(JSON.stringify({code:${JSON.stringify(code)},attemptsPerOperation:20,originalError:true,payloadPreserved:true}));
    `, f.path);
    assert.deepEqual(result, { code, attemptsPerOperation: 20, originalError: true, payloadPreserved: true });
  }
});
