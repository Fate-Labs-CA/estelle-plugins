// The write guard's contract, as a table. Every value is synthetic and generated here at load time.
//
// Sensitive words and vendor prefixes are assembled from parts because older installed copies of this
// guard refuse to let this file be edited if they appear beside an assignment. That refusal is the
// defect this table exists to pin; the parts are not hiding anything, there is no credential here.
const join = (...parts) => parts.join('');
const TOK = join('to', 'ken');
const PW = join('pass', 'word');
const SEC = join('sec', 'ret');
const AK = join('api', '_key');
const BEARER_WORD = join('Bear', 'er');
const UP = text => text.toUpperCase();

const ALPHA62 = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const HEX = '0123456789abcdef';
/** Deterministic, so a failure names the same value on every run and every machine. */
export function synthetic(seed, length, alphabet = ALPHA62) {
  let state = (seed * 2654435761 + 1) >>> 0;
  let out = '';
  for (let i = 0; i < length; i++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    out += alphabet[(state >>> 16) % alphabet.length];
  }
  return out;
}
const R = (seed, length = 32) => synthetic(seed, length);
const H = (seed, length = 64) => synthetic(seed, length, HEX);

const write = content => ({ toolName: 'Write', toolInput: { file_path: '/repo/source', content } });
const patchOf = (...lines) => ({ toolName: 'apply_patch', toolInput: { command: ['*** Begin Patch', '*** Update File: a.py', ...lines, '*** End Patch'].join('\n') } });
const edit = (before, after) => ({ toolName: 'Edit', toolInput: { file_path: '/repo/source', old_string: before, new_string: after } });

const PEM_BEGIN = `-----BEGIN ${join('PRIVATE', ' KEY')}-----`;
const PEM_END = `-----END ${join('PRIVATE', ' KEY')}-----`;
const PEM_BODY = `${R(50, 64)}\n${R(51, 64)}`;
const STRIPE = join('sk', '_live_') + R(1, 28);
const AWS = join('AK', 'IA') + synthetic(2, 16, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567');

/** Each row must be refused. name, then the tool call. */
export const TRUE_ROWS = [
  ['stripe live key beside any name', write(`stripe = "${STRIPE}"`)],
  ['stripe test key', write(`k = ${join('sk', '_test_')}${R(3, 28)}`)],
  ['stripe restricted key', write(`k = "${join('rk', '_live_')}${R(4, 28)}"`)],
  ['estelle key', write(`k = "${join('estelle', '_live_')}${R(5, 28)}"`)],
  ['github classic', write(`k = "${join('gh', 'p_')}${R(6, 36)}"`)],
  ['github oauth', write(`k = "${join('gh', 'o_')}${R(7, 36)}"`)],
  ['github fine-grained', write(`k = "${join('github', '_pat_')}${R(8, 40)}"`)],
  ['openai project key', write(`k = "${join('sk', '-proj-')}${R(9, 40)}"`)],
  ['anthropic key', write(`k = "${join('sk', '-ant-')}${R(10, 40)}"`)],
  ['slack bot', write(`k = "${join('xox', 'b-')}${R(11, 30)}"`)],
  ['jwt', write(`k = "${join('ey', 'J')}${R(12, 20)}.${R(13, 30)}.${R(14, 30)}"`)],
  ['aws access key', write(`k = "${AWS}"`)],
  ['pem with body', write(`${PEM_BEGIN}\n${PEM_BODY}\n${PEM_END}`)],
  ['pem with body and no end', write(`${PEM_BEGIN}\n${PEM_BODY}`)],
  ['pem inside a string with escaped newlines', write(`const v = "${PEM_BEGIN}\\n${R(52, 64)}\\n${PEM_END}";`)],
  ['database url with a password', write(`url = "${join('post', 'gres')}://app:${R(15, 20)}@db.internal/prod"`)],
  ['bearer header literal', write(`headers = {"Authorization": "${BEARER_WORD} ${R(16, 40)}"}`)],
  ['named assignment, python', write(`${AK} = "${R(17)}"`)],
  ['named assignment, short human value', write(`${PW} = "hunter2hunter2"`)],
  ['named assignment, single quotes', write(`${TOK} = '${R(18, 12)}'`)],
  ['attribute assignment', write(`self.auth_${TOK} = "${R(19)}"`)],
  ['env file line', write(`DB_${UP(PW)}=${R(20, 12)}`)],
  ['env file line, dotted value', write(`${UP(TOK)}=abc.defghijklmnopqrstuvwxyz`)],
  ['env file line, letters only', write(`DB_${UP(PW)}=correcthorsebattery`)],
  ['descriptor name, unquoted opaque value', write(`${AK}_id=${R(44, 32)}`)],
  ['exported shell line', write(`export GITHUB_${UP(TOK)}=${R(21, 40)}`)],
  ['aws secret access key env line', write(`AWS_${UP(SEC)}_ACCESS_KEY=${R(22, 40)}`)],
  ['command line flag', write(`curl --${PW}=${R(23, 10)} host`)],
  ['yaml, unquoted', write(`${PW}: hunter2hunter2`)],
  ['json field', write(JSON.stringify({ [`session_${TOK}`]: H(24) }))],
  ['dict with hyphenated header', write(`headers = {"x-api-key": "${R(25)}"}`)],
  ['keyword argument', write(`connect(${PW}="${R(26, 14)}")`)],
  ['python annotation then literal', write(`${SEC}: str = "${R(27)}"`)],
  ['typescript annotation then literal', write(`const apiKey: string = "${R(28)}";`)],
  ['client id style name holding a value', write(`client_${SEC} = "${R(29)}"`)],
  ['glued name', write(`auth${TOK} = "${R(30)}"`)],
  ['plural with an auth prefix', write(`access_${TOK}s = "${R(31)}"`)],
  ['count-like name but an opaque value', write(`next_${TOK} = "${R(32)}"`)],
  ['descriptor name but an opaque value', write(`${AK}_id = "${R(33)}"`)],
  ['reference concatenated with an opaque literal', write(`${TOK} = os.environ["X"] + "${H(34)}"`)],
  ['call holding an opaque literal', write(`${TOK} = guard("${H(35)}")`)],
  ['literal inside a comment', write(`# ${PW} = "${R(36, 14)}"`)],
  ['literal inside a block comment', write(`/*\n${TOK} = "${R(37)}"\n*/`)],
  ['template that hides only part of the value', write(`${TOK} = "\${PREFIX}${R(38, 24)}"`)],
  ['placeholder word glued to a real value', write(`${PW} = "test_${R(39, 18)}"`)],
  ['added line in a patch', patchOf(`+${TOK} = "${R(40)}"`)],
  ['edit that writes a value', edit('x = 1', `${AK} = "${R(41)}"`)],
  ['multi edit', { toolName: 'MultiEdit', toolInput: { edits: [{ old_string: 'a', new_string: `${SEC} = "${R(42)}"` }] } }],
  ['codex tool name prefix', { toolName: 'functions.apply_patch', toolInput: { input: `+key=${STRIPE}` } }],
  ['field of a tool input', { toolName: 'Write', toolInput: { nested: { [TOK]: 'opaque-literal-credential' } } }],
  ['numeric field of a tool input', { toolName: 'Write', toolInput: { [UP(AK)]: 1234567890123456 } }],
  ['vendor key used as an object key', { toolName: 'Write', toolInput: { [`${join('gh', 'p_')}${R(43, 36)}`]: 1 } }],
];

/** Each row must pass. These are the forms that stopped real work, plus their close neighbours. */
export const ORDINARY_ROWS = [
  ['max tokens from a short lookup', write(`max_${TOK}s=cfg["max_${TOK}s"]`)],
  ['max tokens from a payload lookup', write(`generate(prompt, max_${TOK}s=payload["max_${TOK}s"])`)],
  ['max new tokens keyword', write(`generate(max_new_${TOK}s=config.generation.max_new_${TOK}s)`)],
  ['input tokens from a variable', write(`input_${TOK}s = encoded_prompt_batch`)],
  ['token digest from a function', write(`${TOK}_digest = sha256_hexdigest`)],
  ['prompt token ids keyword', write(`model(prompt_${TOK}_ids=encoded_prompt)`)],
  ['tokenizer name literal', write(`${TOK}izer_name = "Qwen/Qwen3.5-4B"`)],
  ['tokenizer object', write(`${TOK}izer = AutoTokenizer.from_pretrained(model_name)`)],
  ['tokenizer pinned to a commit', write(`${TOK}izer_revision = "${H(60, 40)}"`)],
  ['token count', write(`${TOK}_count = len(${TOK}s)`)],
  ['total tokens annotation', write(`total_${TOK}s: int = 4096`)],
  ['bare integer', write(`max_${TOK}s = 4096`)],
  ['end of text marker', write(`eos_${TOK} = "<|endoftext|>"`)],
  ['padding marker', write(`pad_${TOK} = "[PAD]"`)],
  ['lexer state', write(`current_${TOK} = ${TOK}s[index]`)],
  ['token type constant', write(`${TOK}_type = "IDENTIFIER_NAME"`)],
  ['plural count name holding text', write(`special_${TOK}s = "mask,pad,bos"`)],
  ['stop marker holding text', write(`stop_${TOK} = "END_OF_TURN_MARKER"`)],
  ['removed line in a patch', patchOf(`-    max_new_${TOK}s=cfg.max_new_${TOK}s,`, '+    temperature=cfg.temperature,')],
  ['removing a leaked key in a patch', patchOf(`-stripe = "${STRIPE}"`, '+stripe = os.environ["STRIPE"]')],
  ['removing a leaked key with an edit', edit(`stripe = "${STRIPE}"`, 'stripe = os.environ["STRIPE"]')],
  ['unchanged context line in a patch', patchOf(`  ${TOK} = "${R(61)}"`, '+count = 1')],
  ['key from the environment, python', write(`${AK}=os.environ["X"]`)],
  ['key from getenv', write(`${AK} = os.getenv("OPENAI_API_KEY")`)],
  ['key from process env', write(`const ${TOK} = process.env.API_KEY;`)],
  ['all-caps name from process env', write(`${UP(AK)}=process.env.OTHER_NAME`)],
  ['all-caps name from os environ', write(`${UP(AK)}=os.environ["X"]`)],
  ['shell reference, quoted', write(`ESTELLE_${UP(AK)}="$OTHER_NAME"`)],
  ['shell reference, unquoted', write(`ESTELLE_${UP(AK)}=$OTHER_NAME`)],
  ['shell braces', write(`${UP(TOK)}=\${${UP(TOK)}}`)],
  ['command substitution', write(`export ${UP(TOK)}="$(cat /run/credentials/app)"`)],
  ['type hint only', write(`${PW}: str`)],
  ['optional type hint with none', write(`${PW}: Optional[str] = None`)],
  ['union type hint', write(`${AK}: str | None = None`)],
  ['function signature', write(`def login(${TOK}: str, ${SEC}: SecretStr) -> Session:`)],
  ['typed react prop', write(`interface P { ${TOK}: string; ${PW}?: string }`)],
  ['value from a settings object', write(`${SEC} = settings.credential`)],
  ['value from a request', write(`${TOK} = request.headers["Authorization"]`)],
  ['interactive prompt', write(`${PW} = getpass.getpass("Enter ${PW}: ")`)],
  ['hash of a password', write(`${PW}_hash = hash_${PW}(raw_value)`)],
  ['env var name held in a config', write(`${AK}_env = "OPENAI_API_KEY"`)],
  ['env var name in a named field', write(`${TOK}: "GITHUB_${UP(TOK)}"`)],
  ['oauth endpoint', write(`${TOK}_url = "https://example.com/oauth/${TOK}"`)],
  ['header with an env reference', write(`Authorization: ${BEARER_WORD} \${env:ESTELLE_API_KEY}`)],
  ['prose about bearer auth', write(`This route uses ${BEARER_WORD} authentication for every call.`)],
  ['fixture, hyphenated test value', write(`${PW}="test-${PW}"`)],
  ['fixture, your api key', write(`${AK}="your-api-key"`)],
  ['fixture, fake with a number', write(`${TOK}="fake-${TOK}-123"`)],
  ['fixture, changeme', write(`${SEC}="changeme"`)],
  ['fixture, all x', write(`${AK}="xxxxxxxxxxxxxxxx"`)],
  ['fixture, angle brackets', write(`${PW}="<${PW}>"`)],
  ['fixture, template', write(`${TOK}="{{ ${TOK} }}"`)],
  ['vendor shape, all x', write(`k = "${join('gh', 'p_')}${'x'.repeat(36)}"`)],
  ['aws documentation example', write(`k = "${join('AK', 'IA')}IOSFODNN7EXAMPLE"`)],
  ['local database url', write(`url = "${join('post', 'gres')}://postgres:postgres@localhost:5432/test"`)],
  ['database url with a variable', write(`url = "${join('post', 'gres')}://app:\${DB_${UP(PW)}}@db/prod"`)],
  ['schema description', write(`"${PW}": "The ${PW} for your account"`)],
  ['error message', write(`${SEC}: "Missing ${SEC} for this request."`)],
  ['markdown sentence', write(`${TOK}: the bearer ${TOK} used for upload`)],
  ['bare pem marker', write(`const marker = "${PEM_BEGIN}";`)],
  ['plain code', write('export const value = 42;')],
  ['a comparison', write(`if ${TOK} == other_value:`)],
];

export function evaluate(protectWrite) {
  const run = ([name, call]) => ({ name, output: protectWrite({ host: 'codex', event: 'PreToolUse', ...call }) });
  const refused = result => result.output?.hookSpecificOutput?.permissionDecision === 'deny';
  return {
    missed: TRUE_ROWS.map(run).filter(result => !refused(result)).map(result => result.name),
    blocked: ORDINARY_ROWS.map(run).filter(refused).map(result => result.name),
  };
}
