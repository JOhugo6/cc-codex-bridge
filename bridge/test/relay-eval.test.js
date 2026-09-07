'use strict';
// Real stdio bridge/proxy/resources with a deterministic backend. These tests do
// not execute Claude or prove that any LLM follows the relay instructions.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
const { cases, configFor, readAudit, assess, verifyArtifact, runOwned, runScenarios,
  captureLaunchPid, processEvidence, continuityEvidence, UNAVAILABLE } = require('../relay-eval');

async function sandbox(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'relay eval test '));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}
async function call(config, envelope) {
  const client = new Client({ name: 'deterministic-relay-eval', version: '1' }, {});
  const transport = new StdioClientTransport({ ...config, env: { ...process.env, ...config.env }, stderr: 'pipe' });
  try {
    await client.connect(transport);
    return await client.callTool({ name: 'codex_turn', arguments: { envelope } });
  } finally { await client.close(); }
}
function events(envelope, result, output) {
  return [{ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'mcp__codex_bridge__codex_turn', input: { envelope } }] } },
    { type: 'result', result: output ?? (result.isError ? result.content[0].text : result.structuredContent.reply) }];
}

test('eval fixtures traverse real MCP: exact diff/resources, injected data and single-line errors', async (t) => {
  const root = await sandbox(t);
  for (const scenario of cases(root).filter(x => !x.unavailable)) {
    const dir = path.join(root, scenario.name); await fs.mkdir(dir);
    const config = await configFor(dir, scenario);
    const result = await call(config, scenario.envelope);
    const audit = await readAudit(config.env.CODEX_BRIDGE_EVAL_AUDIT);
    const evaluated = assess(scenario, events(scenario.envelope, result), audit);
    assert.equal(evaluated.passed, true, scenario.name);
    if (scenario.fixture.error || scenario.name === 'malformed-envelope') {
      assert.equal(result.isError, true);
      assert.doesNotMatch(result.content[0].text, /[\r\n\u2028]/);
      if (scenario.fixture.error) assert.equal(JSON.parse(result.content[0].text.slice('CODEX-BRIDGE ERROR: '.length)).code, scenario.fixture.error.code);
    } else {
      assert.equal(result.structuredContent.reply, scenario.fixture.reply);
      assert.equal(await verifyArtifact(config, result), true);
    }
  }
});

test('eval observes disk continuity across new proxy/bridge processes without carrying the token', async (t) => {
  const root = await sandbox(t);
  const token = require('node:crypto').randomUUID();
  let first, firstPid;
  for (let turn = 1; turn <= 2; turn++) {
    const dir = path.join(root, String(turn)); await fs.mkdir(dir);
    const config = await configFor(dir, { fixture: turn === 1 ? { reply: 'OK', token } : { recall: true } });
    config.env.CODEX_BRIDGE_STATE_DIR = path.join(root, 'shared-state');
    const envelope = `CONV_ID: restart; REQUEST_ID: turn-${turn}\n${turn === 1 ? token : 'Recall the prior token.'}`;
    const result = (await call(config, envelope)).structuredContent;
    const audit = await readAudit(config.env.CODEX_BRIDGE_EVAL_AUDIT);
    const pid = audit.find(x => x.direction === 'process').message.bridgePid;
    assert.equal(result.turn, turn);
    if (turn === 1) { first = result; firstPid = pid; }
    else { assert.equal(result.thread_id, first.thread_id); assert.equal(result.reply, token); assert.notEqual(pid, firstPid); }
  }
});

test('eval rejects changed envelope, additional calls and whitespace loss instead of normalizing', () => {
  const scenario = { name: 'negative', envelope: 'CONV_ID: x\r\n message \n' };
  const result = { structuredContent: { reply: '+new\r\n\n' } };
  const audit = [{ direction: 'request', message: { id: 1, method: 'tools/call', params: { name: 'codex_turn', arguments: { envelope: scenario.envelope } } } },
    { direction: 'response', message: { id: 1, result } }];
  assert.equal(assess(scenario, events(scenario.envelope, result), audit).passed, true);
  assert.equal(assess(scenario, events(scenario.envelope, result, '+new'), audit).checks.exact_reply, false);
  const altered = structuredClone(audit); altered[0].message.params.arguments.envelope = scenario.envelope.trim();
  assert.equal(assess(scenario, events(scenario.envelope, result), altered).checks.envelope_unchanged, false);
  assert.equal(assess(scenario, events(scenario.envelope, result), [...audit, audit[0]]).checks.call_count, false);
  assert.equal(assess({ unavailable: true, expected: UNAVAILABLE }, [{ type: 'result', result: UNAVAILABLE }], []).passed, true);
  assert.equal(assess({ unavailable: true, expected: UNAVAILABLE }, [{ type: 'result', result: 'Noted.' }], []).passed, false);
});

test('owned eval process preserves quoted Unicode input and bounds a hung process', { timeout: 15000 }, async (t) => {
  const root = await sandbox(t);
  const input = 'quoted "value"\r\nUnicode 😀 e\u0301\n';
  const run = await runOwned(process.execPath, ['-e', 'process.stdin.pipe(process.stdout)'], { cwd: root, input, timeoutMs: 5000 });
  assert.equal(run.stdout, input); assert.equal(run.timedOut, false);
  assert.throws(() => process.kill(run.supervisor_pid, 0), { code: 'ESRCH' });
  const hung = await runOwned(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { cwd: root, input: '', timeoutMs: 2000 });
  assert.equal(hung.timedOut, true);
  assert.throws(() => process.kill(hung.supervisor_pid, 0), { code: 'ESRCH' });
});

test('an infrastructure failure stops model calls and explicitly marks remaining cases unrun', async () => {
  let called = 0;
  const result = await runScenarios([{ name: 'first' }, { name: 'next' }], async scenario => {
    called++; return { name: scenario.name, checks: { claude_completed: false }, passed: false };
  });
  assert.equal(called, 1); assert.equal(result.rounds.length, 1);
  assert.equal(result.skipped[0].name, 'next');
});

test('restart evidence fails when either session/process identity is absent, invalid or unchanged', () => {
  const first = { session_id: 'c6a3a3a1-98fb-459e-b416-024232212cfe', processes: { claude: 121, bridgePid: 122 },
    tool_result: { structuredContent: { thread_id: 'fixture-thread', turn: 1, reply: 'OK' } } };
  const second = { session_id: '75cf51fd-f4bc-4ee1-91b6-8c3dffb058c2', processes: { claude: 221, bridgePid: 222 },
    tool_result: { structuredContent: { thread_id: 'fixture-thread', turn: 2, reply: 'TOKEN' } } };
  assert.equal(Object.values(continuityEvidence(first, second, 'TOKEN')).every(Boolean), true);
  for (const target of [0, 1]) {
    for (const [field, check, badValues] of [
      ['session_id', 'fresh_claude', [undefined, null, '', ' ', 'not-a-session', 123, {}]],
      ['claude', 'fresh_claude_process', [undefined, null, '', '221', 0, -1, 2.5, NaN, Infinity, 0x100000000]],
      ['bridgePid', 'fresh_bridge', [undefined, null, '', '222', 0, -1, 2.5, NaN, Infinity, 0x100000000]],
    ]) {
      for (const value of badValues) {
        const pair = [structuredClone(first), structuredClone(second)];
        if (field === 'session_id') pair[target][field] = value; else pair[target].processes[field] = value;
        assert.equal(continuityEvidence(...pair, 'TOKEN')[check], false, `${target}/${field}/${String(value)}`);
      }
    }
  }
  const missing = { ...second, session_id: undefined, processes: {} };
  const result = continuityEvidence(first, missing, 'TOKEN');
  assert.equal(result.fresh_claude, false); assert.equal(result.fresh_claude_process, false); assert.equal(result.fresh_bridge, false);
  const unchanged = continuityEvidence(first, { ...second, session_id: first.session_id.toUpperCase(), processes: first.processes }, 'TOKEN');
  assert.equal(unchanged.fresh_claude, false); assert.equal(unchanged.fresh_claude_process, false); assert.equal(unchanged.fresh_bridge, false);
});

test('supervisor PID capture survives split chunks and large diagnostics; missing evidence fails', () => {
  const capture = captureLaunchPid();
  assert.equal(capture('codex-bridge-chi'), undefined);
  assert.equal(capture('ld-pid:12'), undefined);
  assert.equal(capture('34\r'), undefined);
  assert.equal(capture('\n' + 'x'.repeat(70000)), 1234);
  assert.equal(capture('codex-bridge-child-pid:9876\n'), 1234, 'later child diagnostics cannot replace supervisor launch evidence');
  assert.equal(captureLaunchPid()('early diagnostics\ncodex-bridge-child-pid:9876\n'), 9876);
  for (const child_pid of [undefined, null, 0, -1, '1234', NaN]) {
    assert.deepEqual(processEvidence({ supervisor_pid: process.pid, child_pid }, [], false).checks,
      { process_evidence: false, processes_reaped: false });
  }
  assert.equal(processEvidence({ supervisor_pid: 1, child_pid: 2 }, [], true).checks.process_evidence, false);
  assert.equal(processEvidence({ supervisor_pid: 1, child_pid: 2 }, [{ direction: 'process', message: { proxyPid: 3 } }], true).checks.process_evidence, false);
});

test('early POSIX child diagnostics cannot hide a later supervisor marker, including without LF', () => {
  const marker = 'codex-bridge-child-pid:4294967295\r\n';
  for (const prefix of ['early diagnostics\n', 'early diagnostics', 'x'.repeat(70000) + '\n', 'x'.repeat(70000)]) {
    for (let split = 0; split <= marker.length; split++) {
      const capture = captureLaunchPid();
      capture(prefix + marker.slice(0, split));
      assert.equal(capture(marker.slice(split) + 'y'.repeat(70000)), 4294967295, `prefix length ${prefix.length}, split ${split}`);
      assert.equal(capture('later diagnostics'), 4294967295);
    }
  }
  const capture = captureLaunchPid();
  assert.equal(capture('x'.repeat(70000)), undefined, 'missing marker remains missing evidence');
  assert.equal(capture('codex-bridge-child-pid:0\ncodex-bridge-child-pid:4294967296\n'), undefined);
  assert.equal(capture('codex-bridge-child-pid:1234\n'), 1234);
});

test('70KB stderr cannot erase the launched process PID or its explicit reaping check', { timeout: 10000 }, async (t) => {
  const root = await sandbox(t);
  const run = await runOwned(process.execPath, ['-e', 'process.stderr.write("x".repeat(70000)); process.stdout.write(String(process.pid))'],
    { cwd: root, input: '', timeoutMs: 5000 });
  assert.equal(run.timedOut, false);
  assert.equal(run.child_pid, Number(run.stdout));
  assert.deepEqual(run.owned_pids, [Number(run.stdout)]);
  assert.equal(run.stderr.length, 65536);
  assert.doesNotMatch(run.stderr, /codex-bridge-child-pid/);
  assert.deepEqual(processEvidence(run, [], false).checks, { process_evidence: true, processes_reaped: true });
  assert.throws(() => process.kill(run.child_pid, 0), { code: 'ESRCH' });
});
