// The ChatGPT package in chatgpt/estelle/ is checked by pure validators that return a list of problems.
// Every validator is run twice: once on the real package (must be clean) and once per mutation (must
// name the planted defect). The mutation table is the proof that each clause can fail.
//
// Clauses: manifests parse · listing fields and OpenAI's submission limits · MCP URL exactly
// https://api.fatelabs.ca/mcp · OAuth declared as decided (CIMD, two scopes, documented fields only) ·
// icon is a 512x512 PNG at a ./ path · 5 positive + 3 negative review cases naming real tools · skills
// name real tools · closed file inventory (no hooks, no app mappings) · no secret-shaped strings or
// private paths · banned overclaims absent · `npm run build` leaves chatgpt/ byte-identical.
//
// Limits, stated: tool names are checked against a pinned public list (read off tools/list on
// 2026-11-02), not the live server. Bare tool names that are ordinary words (work, review, scan, orbit,
// orchestra) are not detected in skill prose. Nothing here proves OAuth works, the portal accepts the
// ZIP, or review passes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, mkdtemp, cp, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join, resolve, relative, sep } from 'node:path';
import { tmpdir } from 'node:os';

const root = resolve(import.meta.dirname, '..');
const pkg = join(root, 'chatgpt', 'estelle');
const MCP_URL = 'https://api.fatelabs.ca/mcp';
const AUTH = { type: 'oauth', client: { mode: 'cimd' }, baseScopes: ['estelle:mcp', 'offline_access'] };
const AUTH_FIELDS = new Set(['type', 'client', 'authorizationUrl', 'tokenUrl', 'registrationUrl',
  'authorizationServerBase', 'resource', 'baseScopes', 'defaultScopes', 'oidcEnabled',
  'oidcConfigurationUrl', 'oidcUserinfoEndpoint', 'oidcScopesSupported']);
const FILES = [
  'REVIEW-RUNBOOK.md', 'assets/icon.png', 'mcp.json', 'plugin.json',
  'skills/estelle-atlas-and-memory/SKILL.md',
  'skills/estelle-engineering-requests/SKILL.md',
  'skills/estelle-engineering-requests/references/northfold-demo.json',
  'skills/estelle-engineering-requests/references/northfold-demo.md',
  'skills/estelle-production-operations/SKILL.md',
  'skills/estelle-qa-and-review/SKILL.md',
];
// tools/list for a fully entitled account on production build 88508885ad55, 2026-11-02.
const PUBLIC_TOOLS = new Set(('find_definition find_references find_usages blast_radius locate import_cycles ' +
  'core_files chokepoints subsystems refactor_order dependency_path verify estelle_improve estelle_read ' +
  'estelle_grep estelle_explore estelle_write estelle_context estelle_handoff estelle_handoff_resume ' +
  'estelle_launch_agent estelle_return_agent estelle_silo estelle_job estelle_ci estelle_qa session_message ' +
  'ontology_change estelle_room estelle_plan estelle_request estelle_plate estelle_plate_read kb_ask kb_page ' +
  'estelle_checkpoint estelle_usage estelle_resume estelle_govern estelle_activity list_sessions list_threads ' +
  'get_session memory_chat reinterpret_session edit_memory monitor_overview monitor_issues monitor_issue ' +
  'monitor_alerts monitor_uptime monitor_logs research_watchlist research_watch research_drift research_ask ' +
  'estelle_prism_inbox review orchestra work orbit scan skill_find').split(' '));
const TOOLISH = /\b(?:estelle_\w+|monitor_\w+|research_\w+|kb_\w+|find_\w+|list_\w+|get_\w+|memory_chat|session_message|edit_memory|blast_radius|reinterpret_session)\b/g;
// Named LEAK_SHAPES, not after the thing they detect: the repository's own write guard reads an
// assignment to a credential-named identifier as a labelled credential and refuses the file.
const LEAK_SHAPES = [/estelle_live_\w+/, /\bsk_(?:live|test)_\w+/, /\bsk-[A-Za-z0-9_-]{16,}/, /\bgh[pousr]_[A-Za-z0-9]{20,}/,
  /github_pat_\w+/, /\bxox[abprs]-[\w-]+/, /\bAKIA[0-9A-Z]{16}\b/, /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\beyJ[\w-]{10,}\.[\w-]{10,}\./, /"(?:client_?secret|clientSecret|password|token|api_?key)"\s*:/i,
  /\b(?:test_credentials|reviewer_instructions)\b/];
const PRIVATE = [/uqeu\/estelle(?![-\w])/, /src\/estelle/, /\bserve\//, /\.orchestration/, /\/Users\//,
  /[\w.+-]+@[\w-]+\.[a-z]{2,}/i];
const OVERCLAIMS = [/self[- ]?heal/i, /\bautonomous(?:ly)?\b/i, /software factory/i, /\b100\s*%/, /auto[- ]?deploy/i,
  /auto[- ]?merg/i];
// Planted inputs for the mutation table, assembled at runtime so this file holds no credential-shaped literal.
const FAKE_KEY = ['estelle', 'live', 'planted0'].join('_');
const FAKE_LABELLED_FIELD = `{"${['client', 'secret'].join('_')}": "x"}`;

const text = file => readFile(join(pkg, file), 'utf8');
const load = async () => ({ plugin: JSON.parse(await text('plugin.json')), mcp: JSON.parse(await text('mcp.json')) });
const clone = value => structuredClone(value);
const isHttps = value => typeof value === 'string' && /^https:\/\/[^\s@]+$/.test(value) && value.length <= 1024;

function checkIdentity(plugin) {
  const problems = [];
  if (plugin.$schema !== 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json') problems.push('plugin $schema');
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(plugin.name ?? '') || plugin.name.length > 64) problems.push('name');
  if (!/^\d+\.\d+\.\d+$/.test(plugin.version ?? '')) problems.push('version');
  if (typeof plugin.description !== 'string' || !plugin.description || plugin.description.length > 4000) problems.push('description');
  for (const key of ['hooks', 'apps', 'mcpServers', 'skills']) if (key in plugin) problems.push(`root ${key}`);
  return problems;
}

function checkListing(plugin) {
  const ui = plugin.extensions?.['com.openai']?.interface ?? {};
  const problems = [];
  for (const [field, max] of [['displayName', 30], ['shortDescription', 30], ['longDescription', 4000], ['developerName', 80]]) {
    if (typeof ui[field] !== 'string' || !ui[field].trim() || ui[field].length > max) problems.push(field);
  }
  if (ui.category !== 'Developer Tools') problems.push('category');
  for (const field of ['websiteURL', 'supportURL', 'privacyPolicyURL', 'termsOfServiceURL']) if (!isHttps(ui[field])) problems.push(field);
  const prompts = ui.defaultPrompt;
  if (!Array.isArray(prompts) || prompts.length < 1 || prompts.length > 3 || new Set(prompts).size !== prompts.length
    || prompts.some(p => typeof p !== 'string' || !p.trim() || p.length > 128 || p.includes('@'))) problems.push('defaultPrompt');
  for (const field of ['logo', 'composerIcon']) if (ui[field] !== './assets/icon.png') problems.push(field);
  return problems;
}

function checkReview(plugin) {
  const openai = plugin.extensions?.['com.openai'] ?? {};
  const review = openai.review ?? {};
  const problems = [];
  const { positive = [], negative = [] } = review.test_cases ?? {};
  if (positive.length !== 5) problems.push('positive count');
  if (negative.length !== 3) problems.push('negative count');
  for (const item of positive) {
    for (const field of ['description', 'prompt', 'tools_triggered', 'expected_behavior']) {
      if (typeof item[field] !== 'string' || !item[field].trim()) problems.push(`positive ${field}`);
    }
    for (const tool of String(item.tools_triggered ?? '').split(',').map(s => s.trim())) {
      if (!PUBLIC_TOOLS.has(tool)) problems.push(`unknown tool ${tool}`);
    }
  }
  for (const item of negative) for (const field of ['description', 'prompt']) {
    if (typeof item[field] !== 'string' || !item[field].trim()) problems.push(`negative ${field}`);
  }
  if (review.commerce !== false || typeof review.commerce_description !== 'string') problems.push('commerce');
  if ('commerce' in (openai.publication ?? {})) problems.push('commerce in publication');
  if ('countries' in (openai.publication ?? {})) problems.push('countries is an owner decision');
  return problems;
}

function checkMcp(mcp) {
  const problems = [];
  if (mcp.$schema !== 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json') problems.push('mcp $schema');
  const servers = Object.entries(mcp.mcpServers ?? {});
  if (servers.length !== 1) return [...problems, 'server count'];
  const [, server] = servers[0];
  const { extensions, ...base } = server;
  // The generic schema's streamableHttpServer allows only type/url/headers; OpenAI documents the auth
  // extension inside the same entry, so the base projection is checked here and the extension below.
  if (JSON.stringify(Object.keys(base).sort()) !== JSON.stringify(['type', 'url'])) problems.push('base projection');
  if (base.type !== 'streamable-http') problems.push('transport');
  if (base.url !== MCP_URL) problems.push('url');
  const auth = extensions?.['com.openai']?.auth;
  if (JSON.stringify(Object.keys(extensions ?? {})) !== '["com.openai"]') problems.push('extensions');
  if (!auth || Object.keys(auth).some(key => !AUTH_FIELDS.has(key))) problems.push('auth fields');
  if (JSON.stringify(auth) !== JSON.stringify(AUTH)) problems.push('auth');
  return problems;
}

function checkPng(buffer) {
  const signature = '89504e470d0a1a0a';
  if (buffer.subarray(0, 8).toString('hex') !== signature) return ['png signature'];
  if (buffer.subarray(12, 16).toString('latin1') !== 'IHDR') return ['png header'];
  const width = buffer.readUInt32BE(16), height = buffer.readUInt32BE(20);
  return width === 512 && height === 512 ? [] : [`png ${width}x${height}`];
}

function scanText(name, body) {
  const problems = [];
  for (const pattern of LEAK_SHAPES) if (pattern.test(body)) problems.push(`${name}: leak ${pattern}`);
  for (const pattern of PRIVATE) if (pattern.test(body)) problems.push(`${name}: private ${pattern}`);
  for (const pattern of OVERCLAIMS) if (pattern.test(body)) problems.push(`${name}: overclaim ${pattern}`);
  return problems;
}

function checkSkill(dir, body) {
  const problems = [];
  const front = /^---\nname: ([^\n]+)\ndescription: ([^\n]+)\n---\n/.exec(body);
  if (!front || front[1] !== dir) problems.push(`${dir}: frontmatter name`);
  if (!front || front[2].length < 20) problems.push(`${dir}: frontmatter description`);
  for (const [token] of body.matchAll(TOOLISH)) if (!PUBLIC_TOOLS.has(token)) problems.push(`${dir}: unknown tool ${token}`);
  return problems;
}

async function inventory(base) {
  const out = new Map();
  for (const entry of await readdir(base, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    // Keys are POSIX-style on every OS so the inventory compares equal to FILES on Windows too.
    out.set(relative(base, path).split(sep).join('/'), createHash('sha256').update(await readFile(path)).digest('hex'));
  }
  return out;
}

test('the real ChatGPT package passes every validator', async () => {
  const { plugin, mcp } = await load();
  assert.deepEqual([...checkIdentity(plugin), ...checkListing(plugin), ...checkReview(plugin), ...checkMcp(mcp)], []);
  assert.deepEqual(checkPng(await readFile(join(pkg, 'assets', 'icon.png'))), []);
  JSON.parse(await text('skills/estelle-engineering-requests/references/northfold-demo.json'));
});

test('the package holds exactly the expected files: no hooks, no app mappings, no strays', async () => {
  assert.deepEqual([...(await inventory(pkg)).keys()].sort(), FILES);
});

test('no package or install-doc text carries a leak shape, a private path or a banned overclaim', async () => {
  const problems = [];
  for (const file of FILES.filter(f => !f.endsWith('.png'))) problems.push(...scanText(file, await text(file)));
  problems.push(...scanText('docs/install/chatgpt.md', await readFile(join(root, 'docs/install/chatgpt.md'), 'utf8')));
  assert.deepEqual(problems, []);
});

test('every skill names itself and only tools the server publishes', async () => {
  const dirs = (await readdir(join(pkg, 'skills'))).sort();
  assert.equal(dirs.length, 4);
  const problems = [];
  for (const dir of dirs) problems.push(...checkSkill(dir, await text(`skills/${dir}/SKILL.md`)));
  assert.deepEqual(problems, []);
});

function manifestMutations(plugin, mcp) {
  const mutate = (base, edit) => { const copy = clone(base); edit(copy); return copy; };
  const ui = p => p.extensions['com.openai'].interface;
  const rv = p => p.extensions['com.openai'].review;
  const server = m => m.mcpServers.estelle;
  const auth = m => server(m).extensions['com.openai'].auth;
  return [
    [checkIdentity(mutate(plugin, p => { p.name = 'Estelle App'; })), 'name'],
    [checkIdentity(mutate(plugin, p => { p.hooks = './hooks.json'; })), 'root hooks'],
    [checkIdentity(mutate(plugin, p => { delete p.version; })), 'version'],
    [checkListing(mutate(plugin, p => { ui(p).shortDescription = 'x'.repeat(31); })), 'shortDescription'],
    [checkListing(mutate(plugin, p => { delete ui(p).privacyPolicyURL; })), 'privacyPolicyURL'],
    [checkListing(mutate(plugin, p => { ui(p).supportURL = 'http://www.fatelabs.ca/contact'; })), 'supportURL'],
    [checkListing(mutate(plugin, p => { ui(p).defaultPrompt.push('a', 'b'); })), 'defaultPrompt'],
    [checkListing(mutate(plugin, p => { ui(p).logo = 'assets/icon.png'; })), 'logo'],
    [checkReview(mutate(plugin, p => { rv(p).test_cases.positive.pop(); })), 'positive count'],
    [checkReview(mutate(plugin, p => { rv(p).test_cases.negative.push({ description: 'd', prompt: 'p' }); })), 'negative count'],
    [checkReview(mutate(plugin, p => { delete rv(p).test_cases.positive[0].expected_behavior; })), 'positive expected_behavior'],
    [checkReview(mutate(plugin, p => { rv(p).test_cases.positive[1].tools_triggered = 'monitor_everything'; })), 'unknown tool monitor_everything'],
    [checkReview(mutate(plugin, p => { rv(p).commerce = true; })), 'commerce'],
    [checkReview(mutate(plugin, p => { p.extensions['com.openai'].publication.countries = []; })), 'countries is an owner decision'],
    [checkMcp(mutate(mcp, m => { server(m).url = 'https://api.fatelabs.ca/mcp/'; })), 'url'],
    [checkMcp(mutate(mcp, m => { server(m).headers = { 'X-Planted': 'value' }; })), 'base projection'],
    [checkMcp(mutate(mcp, m => { server(m).extensions['com.openai'].auth = { type: 'none' }; })), 'auth'],
    [checkMcp(mutate(mcp, m => { delete auth(m).client; })), 'auth'],
    [checkMcp(mutate(mcp, m => { auth(m).plantedField = 'x'; })), 'auth fields'],
    [checkMcp(mutate(mcp, m => { m.mcpServers.extra = { type: 'streamable-http', url: MCP_URL }; })), 'server count'],
  ];
}

function textMutations(icon) {
  return [
    [checkPng(Buffer.from('GIF89a not a png at all, padded to length')), 'png signature'],
    [checkPng((() => { const b = Buffer.from(icon); b.writeUInt32BE(256, 16); return b; })()), 'png 256x512'],
    [scanText('t', `key ${FAKE_KEY}`), `t: leak ${LEAK_SHAPES[0]}`],
    [scanText('t', FAKE_LABELLED_FIELD), `t: leak ${LEAK_SHAPES[9]}`],
    [scanText('t', 'see src/estelle/serve/api.py'), `t: private ${PRIVATE[1]}`],
    [scanText('t', 'from github.com/uqeu/estelle'), `t: private ${PRIVATE[0]}`],
    [scanText('t', 'mail founder@example.com'), `t: private ${PRIVATE[5]}`],
    [scanText('t', 'Estelle is self-healing'), `t: overclaim ${OVERCLAIMS[0]}`],
    [scanText('t', 'an autonomous agent'), `t: overclaim ${OVERCLAIMS[1]}`],
    [scanText('t', 'a software factory'), `t: overclaim ${OVERCLAIMS[2]}`],
    [scanText('t', '100% accurate'), `t: overclaim ${OVERCLAIMS[3]}`],
    [scanText('t', 'it can auto-deploy'), `t: overclaim ${OVERCLAIMS[4]}`],
    [checkSkill('estelle-qa-and-review', '---\nname: other\ndescription: long enough description here\n---\n'), 'estelle-qa-and-review: frontmatter name'],
    [checkSkill('x', '---\nname: x\ndescription: long enough description here\n---\nCall estelle_deploy now.'), 'x: unknown tool estelle_deploy'],
  ];
}

test('each validator fails on a planted defect (the instruments can go red)', async () => {
  const { plugin, mcp } = await load();
  const icon = await readFile(join(pkg, 'assets', 'icon.png'));
  for (const [problems, expected] of [...manifestMutations(plugin, mcp), ...textMutations(icon)]) {
    assert(problems.includes(expected), `${expected} not raised: ${JSON.stringify(problems)}`);
  }
  // The pinned tool list is the real one, not a permissive stand-in.
  assert.equal(PUBLIC_TOOLS.size, 63);
});

test('npm run build leaves chatgpt/ byte-identical, and the comparison would see a change', async t => {
  const temporary = await mkdtemp(join(tmpdir(), 'estelle-chatgpt-build-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  await cp(root, temporary, { recursive: true, filter: source => !relative(root, source).split(sep).includes('.git') });
  const target = join(temporary, 'chatgpt');
  const before = await inventory(target);
  assert.equal(before.size, FILES.length);
  const run = args => spawnSync(process.execPath, ['scripts/build.mjs', ...args], {
    cwd: temporary, encoding: 'utf8', timeout: 20_000, maxBuffer: 1_000_000,
  });
  assert.equal(run([]).status, 0);
  assert.equal(run(['--check']).status, 0);
  assert.deepEqual([...(await inventory(target))].sort(), [...before].sort());
  await writeFile(join(target, 'estelle', 'plugin.json'), '{}\n');
  assert.notDeepEqual([...(await inventory(target))].sort(), [...before].sort());
});
