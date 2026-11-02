import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mutatingTool, protectWrite } from '../runtime/protect.mjs';

test('local credential protection refuses a real shape without echoing its value', () => {
  const token = 'ghp_' + 'a'.repeat(30);
  for (const host of ['claude-code', 'codex', 'kimi', 'grok']) {
    const output = protectWrite({ host, event: 'PreToolUse', toolName: 'functions.apply_patch', toolInput: { input: `+key=${token}` } });
    assert.equal(output.hookSpecificOutput.permissionDecision, 'deny');
    assert(!JSON.stringify(output).includes(token));
  }
});

test('ordinary edits survive and reads are never treated as writes', () => {
  assert(mutatingTool('functions.apply_patch'));
  assert(!mutatingTool('Read'));
  assert.equal(protectWrite({ event: 'PreToolUse', toolName: 'Write', toolInput: { content: 'export const value = 42;' } }), null);
  assert.equal(protectWrite({ event: 'PreToolUse', toolName: 'Read', toolInput: { path: '/source' } }), null);
  assert.equal(protectWrite({ event: 'PostToolUse', toolName: 'Write', toolInput: { content: 'token=' + 'x'.repeat(20) } }), null);
});

test('JSON source credentials are detected inside Write content and Edit new_string before serialization', () => {
  const proof = 'a4'.repeat(32);
  const source = JSON.stringify({ session_token: proof });
  for (const toolInput of [{ content: source }, { new_string: source }, { edits: [{ new_string: source }] }]) {
    const output = protectWrite({ host: 'codex', event: 'PreToolUse', toolName: 'Edit', toolInput });
    assert.equal(output?.hookSpecificOutput.permissionDecision, 'deny');
    assert(!JSON.stringify(output).includes(proof));
  }
});

test('an input beyond the scanner traversal bound is explicitly unscanned rather than clear', () => {
  const output = protectWrite({ host: 'codex', event: 'PreToolUse', toolName: 'Write',
    toolInput: Array.from({ length: 10_001 }, () => 'ordinary') });
  assert.deepEqual(output, { unscanned: true });
});

test('source environment and property references carry no credential literal', () => {
  for (const source of ['const token = process.env.ESTELLE_API_KEY;',
    'const api_key = process.env["ESTELLE_API_KEY"];', 'const secret = settings.credential;',
    'const password = options["PASSWORD"];']) {
    assert.equal(protectWrite({ host: 'codex', event: 'PreToolUse', toolName: 'functions.apply_patch',
      toolInput: { input: source } }), null, source);
  }
});

test('empty public PEM syntax is allowed while body-bearing PEM remains protected', () => {
  const marker = '-----BEGIN PRIVATE KEY-----';
  const end = '-----END PRIVATE KEY-----';
  for (const source of [marker, `const marker = "${marker}";`, `const private_key = "${marker}\\n${end}";`,
    `const pattern = /${marker}/;`, JSON.stringify({ content: `const marker = "${marker}";` })]) {
    assert.equal(protectWrite({ host: 'codex', event: 'PreToolUse', toolName: 'Write', toolInput: { content: source } }), null);
  }
  for (const body of ['\nQUJDREVGR0hJSktMTU5PUA==\n', '\\nQUJDREVGR0hJSktMTU5PUA==\\n']) {
    for (const source of [marker + body, marker + body + end, `const value = "${marker}${body}${end}";`]) {
      assert.equal(protectWrite({ host: 'codex', event: 'PreToolUse', toolName: 'Write',
        toolInput: { content: source } })?.hookSpecificOutput.permissionDecision, 'deny');
    }
  }
});

test('safe references never waive credentials elsewhere or within the reference', () => {
  const prefix = 'ghp_' + 'b'.repeat(30), opaque = 'c7'.repeat(32);
  for (const source of [`const token = process.env.ESTELLE_API_KEY; const other = "${prefix}";`,
    `const token = process.env.${prefix};`, `const secret = settings.credential; const session_token = "${opaque}";`,
    JSON.stringify({ content: 'const token = process.env.ESTELLE_API_KEY;', session_token: opaque }),
    `const token = process.env.KEY + "${prefix}";`]) {
    const result = protectWrite({ host: 'codex', event: 'PreToolUse', toolName: 'Edit', toolInput: { new_string: source } });
    assert.equal(result?.hookSpecificOutput.permissionDecision, 'deny');
    assert(!JSON.stringify(result).includes(prefix) && !JSON.stringify(result).includes(opaque));
  }
});

test('malformed or passive inputs produce no control JSON or success claim', () => {
  for (const input of [null, undefined, [], {}, {event:'PostToolUse',toolName:'Write'},
    { event:'PreToolUse',toolName:'Read',toolInput:{content:'ordinary'} }]) {
    assert.equal(protectWrite(input), null);
  }
});

test('native adapter normalization feeds the same protection and never emits post-tool decisions', async () => {
  for (const [host, file] of [['claude-code', 'claude'], ['codex', 'codex'], ['kimi', 'kimi'], ['grok', 'grok']]) {
    const { normalize } = await import(`../adapters/${file}.mjs`);
    const make = (event, source) => ({ hook_event_name: event, hookEventName: event,
      session_id: 'owned-test', sessionId: 'owned-test', cwd: '/owned-fixture', transcript_path: null,
      model: 'fixture', turn_id: 'turn', permission_mode: 'default', tool_use_id: 'call',
      tool_name: 'Write', toolName: 'Write', tool_input: { content: source },
      toolInput: { content: source }, tool_response: {}, toolResult: {} });
    assert.equal(protectWrite(normalize(make('PreToolUse', 'const token = process.env.API_KEY;'))), null);
    const denial = protectWrite(normalize(make('PreToolUse', 'const session_token = "' + 'd8'.repeat(32) + '";')));
    const encoded = JSON.stringify(denial), parsed = JSON.parse(encoded);
    assert.deepEqual(Object.keys(parsed), ['hookSpecificOutput']);
    assert.equal(parsed.hookSpecificOutput.permissionDecision, 'deny');
    assert.equal(typeof parsed.hookSpecificOutput.permissionDecisionReason, 'string');
    assert(!encoded.includes('d8'.repeat(32)));
    assert.equal(parsed.hookSpecificOutput.hookEventName, host === 'grok' ? undefined : 'PreToolUse');
    assert.equal(protectWrite(normalize(make('PostToolUse', 'const session_token = "' + 'd8'.repeat(32) + '";'))), null);
  }
});

test('quoted lookalike source is still a literal credential and cannot be normalized away', () => {
  for (const content of ['const password = "token=process.env.KEY";',
    'const secret = "prefix token=process.env.KEY";',
    'const password = `token=process.env.KEY`;',
    JSON.stringify({ session_token: 'e9'.repeat(32) }),
    'const password = "safe\\\" token=process.env.KEY";']) {
    assert.equal(protectWrite({ host:'codex',event:'PreToolUse',toolName:'Write',toolInput:{content} })
      ?.hookSpecificOutput.permissionDecision, 'deny');
  }
});


test('actual Codex runner emits silence for ordinary post-tool and malformed input, valid JSON for a secret refusal', async t => {
  const home = await mkdtemp(join(tmpdir(), 'estelle-protect-cli-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const counter = join(home, 'calls.json'), guard = join(home, 'network-guard.mjs');
  await writeFile(guard, `import http from 'node:http'; import https from 'node:https';
    import net from 'node:net'; import dns from 'node:dns'; import fs from 'node:fs';
    import {syncBuiltinESMExports} from 'node:module';
    let calls=0; const deny=()=>{calls++;throw new Error('test_network_denied')};
    http.request=deny;https.request=deny;net.Socket.prototype.connect=deny;dns.lookup=deny;
    syncBuiltinESMExports(); process.on('exit',()=>fs.writeFileSync(${JSON.stringify(counter)},JSON.stringify(calls)));`);
  const base = {session_id:'owned-test',cwd:home,transcript_path:null,model:'fixture',turn_id:'turn',
    permission_mode:'default',tool_use_id:'call',tool_name:'Write'};
  for (const [event, input, expected] of [['PostToolUse',{content:'ordinary'},'silent'],
    ['PreToolUse',{content:'const token = process.env.API_KEY;'},'silent'],
    ['PreToolUse',{content:'const token = "'+'ghp_'+'f'.repeat(30)+'";'},'deny'],
    ['UnknownEvent',{},'silent']]) {
    const payload = {...base,hook_event_name:event,tool_input:input,tool_response:{}};
    const result = spawnSync(process.execPath, ['--import', pathToFileURL(guard).href,
      fileURLToPath(new URL('../runtime/cli.mjs',import.meta.url)),'hook','codex'], {
      input:JSON.stringify(payload),encoding:'utf8',timeout:3000,maxBuffer:100_000,
      env:{PATH:process.env.PATH,HOME:home,ESTELLE_PLUGIN_DATA:join(home,'state')},cwd:home,
    });
    assert.equal(result.status,0,result.stderr);
    assert.equal(JSON.parse(await readFile(counter,'utf8')),0);
    if(expected==='silent') assert.equal(result.stdout,'');
    else assert.equal(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision,'deny');
    assert(!result.stdout.includes('looks good') && !result.stdout.includes('verify edited'));
  }
});

test('an unquoted dotted credential value is not assumed to be a source reference', () => {
  const output = protectWrite({host:'codex',event:'PreToolUse',toolName:'Write',
    toolInput:{content:'TOKEN=abc.defghijklmnopqrstuvwxyz'}});
  assert.equal(output?.hookSpecificOutput.permissionDecision,'deny');
});

test('source references without a semicolon remain references before JSON serialization', () => {
  for (const content of ['const token = process.env.API_KEY', 'const secret = settings.credential',
    'token = process.env["API_KEY"]']) {
    assert.equal(protectWrite({host:'codex',event:'PreToolUse',toolName:'Write',toolInput:{content}}),null);
  }
});


test('multiline source references are not turned into credential literals by JSON transport', () => {
  for (const separator of ['\n','\r\n']) {
    const source='const token = process.env.API_KEY'+separator+'const count = 1';
    for (const input of [{input:source},JSON.parse(JSON.stringify({input:source})),
      {edits:[{new_string:source}]}]) {
      assert.equal(protectWrite({host:'codex',event:'PreToolUse',toolName:'functions.apply_patch',toolInput:input}),null);
    }
    const mixed=source+separator+'const session_token = "'+'a3'.repeat(32)+'";';
    assert.equal(protectWrite({host:'codex',event:'PreToolUse',toolName:'Write',toolInput:{content:mixed}})
      ?.hookSpecificOutput.permissionDecision,'deny');
  }
  for (const input of [{session_token:'a3'.repeat(32)},{nested:{token:'opaque-literal-credential'}},
    {API_KEY:1234567890123456},{['ghp_'+'g'.repeat(30)]:1}]) {
    assert.equal(protectWrite({host:'codex',event:'PreToolUse',toolName:'Write',toolInput:input})
      ?.hookSpecificOutput.permissionDecision,'deny');
  }
});


test('actual sensitive primitive values are never treated as source expressions', () => {
  const source='const token = process.env.KEY\nconst count = 1';
  assert.equal(protectWrite({host:'codex',event:'PreToolUse',toolName:'Write',toolInput:{content:source}}),null);
  for(const input of [{session_token:'token=process.env.KEY'},
    JSON.parse(JSON.stringify({session_token:'token=process.env.KEY'})),
    {content:source,nested:{session_token:'token=process.env.KEY'}}]) {
    assert.equal(protectWrite({host:'codex',event:'PreToolUse',toolName:'Write',toolInput:input})
      ?.hookSpecificOutput.permissionDecision,'deny');
  }
});
