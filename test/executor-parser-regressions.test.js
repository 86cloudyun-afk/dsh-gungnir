import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseCmdline } from '../executors/parse-cmdline.mjs';

test('argv lexical spans concatenate inside a token', () => {
  assert.deepEqual(parseCmdline(`node --label="hello world" 'a'"b"c tail`),
    ['node', '--label=hello world', 'abc', 'tail']);
  assert.deepEqual(parseCmdline(`node pre''post ""`), ['node', 'prepost', '']);
});

test('unmatched inline quotes fail before any invocation', () => {
  for (const input of [`node --label="unfinished`, `node a'b`, `node "a"b'c`]) {
    assert.throws(() => parseCmdline(input), /引号未闭合/);
  }
});

test('quoted UNC paths and consecutive backslashes remain literal', () => {
  assert.deepEqual(parseCmdline(String.raw`node "\\server\share\folder name" '\\server\share'`),
    ['node', String.raw`\\server\share\folder name`, String.raw`\\server\share`]);
  assert.deepEqual(parseCmdline(String.raw`node C:\tools\run.mjs "a\\b"`),
    ['node', String.raw`C:\tools\run.mjs`, String.raw`a\\b`]);
});

test('only an active quote has a backslash escape; shell syntax stays literal', () => {
  assert.deepEqual(parseCmdline(String.raw`node "say \"hi\"" 'it\'s' "\n\t" $HOME ; |`),
    ['node', 'say "hi"', "it's", String.raw`\n\t`, '$HOME', ';', '|']);
  assert.deepEqual(parseCmdline('node a\\ b'), ['node', 'a\\', 'b']);
  assert.throws(() => parseCmdline(String.raw`node "C:\folder\"`), /引号未闭合/);
});

test('JSON argv preserves escaped paths, Unicode, and newlines', () => {
  assert.deepEqual(parseCmdline('["node","\\\\\\\\server\\\\share","引号\\\"\\n尾"]'),
    ['node', String.raw`\\server\share`, '引号"\n尾']);
});

test('consecutive backslashes directly before a quote require unambiguous JSON argv', () => {
  for (const input of [String.raw`node "path\\"tail"`, String.raw`node 'path\\\'tail'`]) {
    assert.throws(() => parseCmdline(input), /歧义.*JSON/);
  }
  assert.deepEqual(parseCmdline(JSON.stringify(['node', 'path\\"tail'])), ['node', 'path\\"tail']);
});

test('invalid argv fails without including input data', () => {
  for (const input of ['', ' ', '[]', '[1]', '["node", ""]', '["node", null]',
    '["node", "PRIVATE_PAYLOAD"', '["   "]', 'node "\0"', null, 5, {}]) {
    assert.throws(() => parseCmdline(input), (error) => !error.message.includes('PRIVATE_PAYLOAD'));
  }
});

function invoke(t, template, job, rawInput, fixtureBody) {
  const dir = mkdtempSync(join(tmpdir(), 'wr-literal-argv-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const fixture = join(dir, 'argv recorder.mjs');
  const marker = join(dir, 'started');
  writeFileSync(fixture, `import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(marker)}, 'started');
${fixtureBody ?? 'process.stdout.write(JSON.stringify({members:[{payload:{argv:process.argv.slice(2)}}],resources:[]}));'}`);
  const config = template?.({ fixture, dir });
  const result = spawnSync(process.execPath, ['executors/dsh-plugin-cmd.example.mjs'], {
    input: rawInput ?? JSON.stringify(job), encoding: 'utf8',
    env: { ...process.env, GUNGNIR_DSH_TOOL_CMD: config ?? '' },
    timeout: 10000,
  });
  return { ...result, started: existsSync(marker), dir };
}

const baseJob = { role: 'recon', external_id: 'literal-1',
  contract: { intent: 'inspect', action_class: 'readonly', targets: ['example.test'] } };

test('quoted trusted template keeps task spaces, quotes, slashes, Unicode and newlines in one argument', (t) => {
  const role = 'a "quoted" \\\\server\\share 中文\nnext ; $HOME $(echo literal)';
  const result = invoke(t, ({ fixture }) => `"${process.execPath}" "${fixture}" --role={role} --intent="{intent}"`,
    { ...baseJob, role, contract: { ...baseJob.contract, intent: "it's literal" } });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).members[0].payload.argv,
    ['--role=' + role, "--intent=it's literal"]);
});

test('JSON template is parsed before task data substitution', (t) => {
  const intent = '"],"extra argument","\\network\n中文';
  const result = invoke(t, ({ fixture }) => JSON.stringify([process.execPath, fixture, '{intent}', '{targets}']),
    { ...baseJob, contract: { ...baseJob.contract, intent, targets: ['a b', 'c"d', String.raw`\\server\share`] } });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).members[0].payload.argv,
    [intent, 'a b,c"d,' + String.raw`\\server\share`]);
});

test('placeholder replacement is simultaneous and never rescans task text or dollar patterns', (t) => {
  const result = invoke(t, ({ fixture }) => JSON.stringify([process.execPath, fixture, '{role}', '{intent}', '{external_id}']),
    { ...baseJob, role: '{intent} $& $$ $`', external_id: '{role}',
      contract: { ...baseJob.contract, intent: '{targets}' } });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).members[0].payload.argv,
    ['{intent} $& $$ $`', '{targets}', '{role}']);
});

test('leading dashes remain literal data without automatic option rewriting', (t) => {
  const result = invoke(t, ({ fixture }) => JSON.stringify([process.execPath, fixture, '{role}', '{intent}']),
    { ...baseJob, role: '--literal-flag', contract: { ...baseJob.contract, intent: '-x "quoted" \\path' } });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).members[0].payload.argv, ['--literal-flag', '-x "quoted" \\path']);
});

test('absent fields retain defaults and empty data occupies its original argv slot', (t) => {
  const result = invoke(t, ({ fixture }) => JSON.stringify([process.execPath, fixture,
    '{role}', '{intent}', '{action_class}', '{targets}', '{external_id}']), {});
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).members[0].payload.argv, ['recon', 'recon', 'readonly', '', '']);
});

test('task-derived executable is rejected even when it names the harmless Node fixture', (t) => {
  for (const template of [({ fixture }) => JSON.stringify(['{role}', fixture]),
    ({ fixture }) => `"${process.execPath}{external_id}" "${fixture}"`]) {
    const result = invoke(t, template, { ...baseJob, role: process.execPath, external_id: '' });
    assert.equal(result.status, 4);
    assert.equal(result.started, false);
    assert.match(result.stderr, /可执行文件.*占位符/);
  }
});

test('invalid job values fail clearly without starting a process or dumping payloads', (t) => {
  const cases = [null, [], { role: { private: 'PRIVATE_PAYLOAD' } },
    { role: 1 }, { contract: 'PRIVATE_PAYLOAD' }, { contract: { intent: 1 } },
    { contract: { action_class: {} } }, { external_id: {} },
    { contract: { targets: 'PRIVATE_PAYLOAD' } }, { contract: { targets: [1] } },
    { role: '\0PRIVATE_PAYLOAD' }];
  for (const job of cases) {
    const result = invoke(t, ({ fixture }) => JSON.stringify([process.execPath, fixture,
      '{role}', '{intent}', '{action_class}', '{targets}', '{external_id}']), job);
    assert.equal(result.status, 4);
    assert.equal(result.started, false);
    assert.doesNotMatch(result.stderr, /PRIVATE_PAYLOAD/);
    assert.match(result.stderr, /job|参数/);
  }
});

test('malformed job JSON has a static diagnostic and never starts the fixture', (t) => {
  const result = invoke(t, ({ fixture }) => JSON.stringify([process.execPath, fixture]), undefined,
    '{"role":"PRIVATE_PAYLOAD');
  assert.equal(result.status, 2);
  assert.equal(result.started, false);
  assert.match(result.stderr, /job JSON 解析失败/);
  assert.doesNotMatch(result.stderr, /PRIVATE_PAYLOAD/);
});

test('invocation and response errors omit substituted task text and echoed child payloads', (t) => {
  for (const body of [
    `process.stderr.write(process.argv[2]); process.exit(7);`,
    `process.stdout.write(process.argv[2]);`,
  ]) {
    const result = invoke(t, ({ fixture }) => JSON.stringify([process.execPath, fixture, '{role}']),
      { ...baseJob, role: 'PRIVATE_PAYLOAD' }, undefined, body);
    assert.equal(result.status, 4);
    assert.equal(result.started, true);
    assert.doesNotMatch(result.stderr, /PRIVATE_PAYLOAD/);
    assert.match(result.stderr, /派单命令失败.*exit=7|派单命令输出非 JSON/);
  }
});

test('invalid trusted template and missing configuration fail before starting a process', (t) => {
  for (const value of ['[]', '[1]', '["node", ""]', '["node",', `node --x="unfinished`,
    JSON.stringify([process.execPath, '{unsupported_field}'])]) {
    const result = invoke(t, () => value, baseJob);
    assert.equal(result.status, 4);
    assert.equal(result.started, false);
  }
  const missing = invoke(t, undefined, baseJob);
  assert.equal(missing.status, 3);
  assert.equal(missing.started, false);
});
