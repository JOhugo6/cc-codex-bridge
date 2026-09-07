'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { CodexBackend, pickCommand } = require('../lib/codex-backend');
const { CodexBridge } = require('../lib/bridge');
const store = require('../lib/store');
const operations = require('../lib/operations');
const paths = require('../lib/paths');

function setup(t, mode = 'normal', options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'app server ž '));
  const project = path.join(dir, 'project with spaces'); fs.mkdirSync(project);
  const config = (mode, extra = {}) => fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ mode, ...extra }));
  config(mode, options);
  const make = () => new CodexBackend({ command: process.execPath,
    args: [path.join(__dirname, 'app-server-stub.js'), dir], cwd: dir,
    readinessTimeoutMs: 2000, callTimeoutMs: 4000, interruptTimeoutMs: 300, ...options });
  const backends = [];
  const backend = () => { const b = make(); backends.push(b); return b; };
  const wire = () => fs.readFileSync(path.join(dir, 'wire.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  t.after(async () => { for (const b of backends) await b.close(); await fsp.rm(dir, { recursive: true, force: true }); });
  return { dir, project, config, backend, wire };
}
const exact = '  žluťoučký 😀\r\n```diff\r\n+ exact\t \r\n```\r\n';
function dead(pid) { assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' }); }
async function until(check) {
  const end = Date.now() + 4000;
  while (!check()) {
    assert.ok(Date.now() < end, 'timed out waiting for child checkpoint');
    await new Promise((r) => setTimeout(r, 10));
  }
}

for (const mode of ['normal', 'early-events', 'terminal-items-only', 'event-items-only', 'retry-event']) {
  test(`JSONL ${mode}: preserve exact final output, discard progress/deltas and deduplicate completed items`, async (t) => {
    const env = setup(t, mode); const b = env.backend();
    const out = await b.startSession('token', { cwd: env.project });
    assert.equal(out.content, exact);
    assert.equal((await b.continueSession(out.threadId, 'recall', { cwd: env.project })).content, 'token');
    const methods = env.wire().filter((x) => x.method).map((x) => x.method);
    assert.deepEqual(methods, ['initialize', 'initialized', 'thread/start', 'turn/start', 'thread/read', 'thread/resume', 'turn/start']);
  });
}

test('persisted threads resume across backend/process restart; no new thread is created', async (t) => {
  const env = setup(t); const first = env.backend();
  const out = await first.startSession('private token', { cwd: env.project });
  await first.close(); dead(env.wire()[0].pid);
  const next = env.backend();
  assert.deepEqual(await next.continueSession(out.threadId, 'recall'), { threadId: out.threadId, content: 'private token' });
  assert.equal(env.wire().filter((x) => x.method === 'thread/start').length, 1);
  assert.equal(env.wire().filter((x) => x.method === 'initialize').length, 2);
});

for (const [mode, code] of [
  ['no-thread', 'NO_THREAD_ID'], ['unsafe-policy', 'BACKEND_POLICY_MISMATCH'], ['cwd-drift', 'WORKING_DIR_MISMATCH'],
  ['wrong-thread', 'THREAD_ID_DRIFT'], ['wrong-turn', 'TURN_ID_DRIFT'], ['conflicting-item', 'BACKEND_PROTOCOL_ERROR'],
  ['empty', 'EMPTY_REPLY'], ['failed-turn', 'CODEX_TURN_FAILED'], ['interrupted-turn', 'CANCELLED'],
  ['error-event', 'CODEX_TURN_FAILED'], ['server-request', 'BACKEND_REQUEST_UNSUPPORTED'], ['disconnect', 'BACKEND_DISCONNECTED'],
]) {
  test(`JSONL ${mode}: fail explicitly and reap child`, async (t) => {
    const env = setup(t, mode); const b = env.backend();
    await assert.rejects(b.startSession('test', { cwd: env.project }), { code });
    dead(env.wire()[0].pid);
  });
}

for (const mode of ['silent-init', 'bad-init', 'invalid-json']) {
  test(`JSONL ${mode}: bounded failed handshake cleans parent and descendant`, async (t) => {
    const env = setup(t, mode, { readinessTimeoutMs: 1000, descendant: true });
    await assert.rejects(env.backend().startSession('test'), { code: 'BACKEND_NOT_READY' });
    for (const row of env.wire()) { if (row.pid) dead(row.pid); if (row.descendantPid) dead(row.descendantPid); }
  });
}

test('turn timeout sends interrupt, reaps tree and reconnects without retrying uncertain turn', async (t) => {
  const env = setup(t, 'hang', { callTimeoutMs: 1200, descendant: true }); const b = env.backend();
  await assert.rejects(b.startSession('test', { cwd: env.project }), { code: 'TIMEOUT' });
  assert.equal(env.wire().filter((x) => x.method === 'turn/interrupt').length, 1);
  for (const row of env.wire()) { if (row.pid) dead(row.pid); if (row.descendantPid) dead(row.descendantPid); }
  env.config('normal');
  assert.equal((await b.continueSession('thread-1', 'recall')).content, 'test');
  assert.equal(env.wire().filter((x) => x.method === 'thread/start').length, 1);
});

test('AbortSignal cancels active turn and queued abort never starts another turn', async (t) => {
  const env = setup(t, 'hang'); const b = env.backend();
  const first = new AbortController(), second = new AbortController();
  const a = b.startSession('first', { signal: first.signal });
  const c = b.startSession('queued', { signal: second.signal });
  const checks = [assert.rejects(a, { code: 'CANCELLED' }), assert.rejects(c, { code: 'CANCELLED' })];
  await until(() => fs.existsSync(path.join(env.dir, 'threads.json')) && env.wire().some((x) => x.method === 'turn/start'));
  second.abort(); first.abort();
  await Promise.all(checks);
  assert.equal(env.wire().filter((x) => x.method === 'turn/start').length, 1);
  assert.equal(env.wire().filter((x) => x.method === 'turn/interrupt').length, 1);
});

test('concurrent callers serialize complete turns; close reaps child and permanently rejects new calls', async (t) => {
  const env = setup(t, 'delay', { descendant: true }); const b = env.backend();
  const outputs = await Promise.all(['a', 'b', 'c'].map((prompt) => b.startSession(prompt)));
  assert.equal(new Set(outputs.map((x) => x.threadId)).size, 3);
  await b.close();
  for (const row of env.wire()) { if (row.pid) dead(row.pid); if (row.descendantPid) dead(row.descendantPid); }
  await assert.rejects(b.startSession('closed'), { code: 'BACKEND_CLOSED' });
});

test('legacy no-cwd journal gains metadata-verified cwd only through a normal durable resumed turn', async (t) => {
  const env = setup(t); process.env.CODEX_BRIDGE_STATE_DIR = env.dir;
  t.after(() => { delete process.env.CODEX_BRIDGE_STATE_DIR; });
  const b = env.backend(); const old = await b.startSession('legacy context', { cwd: env.project });
  let journal = await operations.begin('legacy', null, null, { message: 'old', working_dir: null, provider: 'codex' }, 'old-request');
  await operations.receive('legacy', journal, { reply: 'old reply', thread_id: old.threadId, turn: 1 });
  await operations.finish('legacy', journal, null);
  const oldOp = structuredClone((await operations.load('legacy')).operations[0]);
  await b.close();
  const bridge = new CodexBridge(env.backend());
  const out = await bridge.turn('legacy', 'recall', { request_id: 'new-request' });
  assert.equal(out.thread_id, old.threadId); assert.equal(out.turn, 2); assert.equal(out.reply, 'legacy context');
  assert.equal((await store.loadState('legacy')).working_dir, await fsp.realpath(env.project));
  journal = await operations.load('legacy'); assert.deepEqual(journal.operations[0], oldOp);
  assert.equal(journal.operations[1].before.working_dir, undefined);
  assert.equal(journal.operations[1].input.working_dir, await fsp.realpath(env.project));
  const calls = env.wire().length;
  assert.deepEqual(await bridge.turn('legacy', 'recall', { request_id: 'new-request' }), out);
  assert.equal(env.wire().length, calls);
  assert.equal(env.wire().filter((x) => x.method === 'thread/start').length, 1);
});

for (const [mode, code] of [['read-no-cwd', 'WORKING_DIR_UNKNOWN'], ['read-drift', 'THREAD_ID_DRIFT'], ['read-missing-dir', 'INVALID_WORKING_DIR'], ['read-error', 'CODEX_RPC_ERROR']]) {
  test(`legacy metadata ${mode} leaves state/journal intact and does not create a turn`, async (t) => {
    const env = setup(t); process.env.CODEX_BRIDGE_STATE_DIR = env.dir;
    t.after(() => { delete process.env.CODEX_BRIDGE_STATE_DIR; });
    const b = env.backend(); const old = await b.startSession('legacy', { cwd: env.project });
    const prior = { conversation_id: 'legacy', thread_id: old.threadId, turn: 1, provider: 'codex' };
    await store.saveState('legacy', prior);
    env.config(mode);
    await assert.rejects(new CodexBridge(b).turn('legacy', 'next'), { code });
    assert.deepEqual(await store.loadState('legacy'), prior);
    await assert.rejects(fsp.access(paths.operationsFile('legacy')), { code: 'ENOENT' });
    assert.equal(env.wire().filter((x) => x.method === 'turn/start').length, 1);
  });
}

test('legacy supplied cwd must match metadata; resume identity must match saved thread', async (t) => {
  const env = setup(t); const b = env.backend();
  const old = await b.startSession('legacy', { cwd: env.project });
  await assert.rejects(b.continueSession(old.threadId, 'no', { cwd: env.dir }), { code: 'WORKING_DIR_MISMATCH' });
  env.config('resume-drift');
  await assert.rejects(b.continueSession(old.threadId, 'no'), { code: 'THREAD_ID_DRIFT' });
  env.config('no-thread');
  await assert.rejects(b.continueSession(old.threadId, 'no'), { code: 'NO_THREAD_ID_ON_RESUME' });
  env.config('resume-error');
  await assert.rejects(b.continueSession(old.threadId, 'no'), { code: 'CODEX_RPC_ERROR' });
  assert.equal(env.wire().filter((x) => x.method === 'turn/start').length, 1);
});

test('explicit executable launch accepts spaces and never invokes a shell', () => {
  assert.deepEqual(pickCommand(process.execPath, ['app-server']), { command: process.execPath, args: ['app-server'], useShell: false });
  assert.throws(() => pickCommand('relative.cmd'), { code: 'CODEX_NOT_FOUND' });
});

test('native turn timeout leaves durable pending intent and forbids automatic retry/reconnect for that conversation', async (t) => {
  const env = setup(t, 'hang', { callTimeoutMs: 1200 }); process.env.CODEX_BRIDGE_STATE_DIR = env.dir;
  t.after(() => { delete process.env.CODEX_BRIDGE_STATE_DIR; });
  const bridge = new CodexBridge(env.backend());
  await assert.rejects(bridge.turn('uncertain', 'first', { request_id: 'r1' }), { code: 'TIMEOUT' });
  assert.equal((await operations.load('uncertain')).operations[0].status, 'pending');
  env.config('normal'); const before = env.wire().length;
  await assert.rejects(bridge.turn('uncertain', 'first', { request_id: 'r1' }), { code: 'OPERATION_UNCERTAIN' });
  await assert.rejects(bridge.turn('uncertain', 'next'), { code: 'OPERATION_UNCERTAIN' });
  assert.equal(env.wire().length, before);
});

test('verified legacy cwd binding remains recoverable after state persistence fails', async (t) => {
  const env = setup(t); process.env.CODEX_BRIDGE_STATE_DIR = env.dir;
  t.after(() => { delete process.env.CODEX_BRIDGE_STATE_DIR; });
  const b = env.backend(); const old = await b.startSession('old memory', { cwd: env.project });
  const prior = { conversation_id: 'legacy-recovery', thread_id: old.threadId, turn: 1, provider: 'codex' };
  await store.saveState('legacy-recovery', prior);
  const patched = t.mock.method(store, 'saveState', async () => { throw new Error('injected disk failure'); });
  await assert.rejects(new CodexBridge(b).turn('legacy-recovery', 'recall'), { code: 'OPERATION_PERSISTENCE_FAILED' });
  patched.mock.restore();
  assert.equal((await operations.load('legacy-recovery')).operations.at(-1).status, 'received');
  const calls = env.wire().length;
  await require('../recover-operation').recover('finish', 'legacy-recovery');
  assert.equal((await store.loadState('legacy-recovery')).working_dir, await fsp.realpath(env.project));
  assert.equal(env.wire().length, calls);
});

test('real MCP cancellation interrupts native transport; stdio close reaps native child', async (t) => {
  const env = setup(t, 'hang');
  const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [path.join(__dirname, '..', 'index.js')], stderr: 'pipe', env: { ...process.env,
      CODEX_BRIDGE_BACKEND: path.join(__dirname, 'app-server-backend.js'),
      CODEX_BRIDGE_STUB_DIR: env.dir, CODEX_BRIDGE_STATE_DIR: env.dir } });
  const client = new Client({ name: 'backend-integration', version: '1' }, { capabilities: {} });
  t.after(() => client.close());
  await client.connect(transport);
  const signal = new AbortController();
  const call = client.callTool({ name: 'codex_turn', arguments: { conversation_id: 'cancelled', message: 'wait' } }, undefined, { signal: signal.signal });
  const rejection = assert.rejects(call);
  await until(() => fs.existsSync(path.join(env.dir, 'wire.jsonl')) && env.wire().some((x) => x.method === 'turn/start'));
  signal.abort(); await rejection;
  await until(() => env.wire().some((x) => x.method === 'turn/interrupt'));
  await until(() => { try { process.kill(env.wire()[0].pid, 0); return false; } catch (err) { return err.code === 'ESRCH'; } });
  // A separate conversation may reconnect; closing MCP stdio must close that new child too.
  env.config('normal');
  const result = await client.callTool({ name: 'codex_turn', arguments: { conversation_id: 'next', message: 'ok' } });
  assert.equal(result.isError, undefined);
  const pid = env.wire().filter((x) => x.pid).at(-1).pid;
  await client.close();
  await until(() => { try { process.kill(pid, 0); return false; } catch (err) { return err.code === 'ESRCH'; } });
});

test('unexpected native parent exit reaps surviving detached Windows / inherited POSIX descendants', async (t) => {
  const env = setup(t, 'disconnect', { descendant: true }); const b = env.backend();
  await assert.rejects(b.startSession('crash'), { code: 'BACKEND_DISCONNECTED' });
  await b.close();
  for (const row of env.wire()) { if (row.pid) dead(row.pid); if (row.descendantPid) dead(row.descendantPid); }
});

test('supervisor termination closes the Windows job / escalates the owned POSIX group', async (t) => {
  const env = setup(t, 'hang', { descendant: true }); const b = env.backend();
  const turn = b.startSession('wait');
  const rejected = assert.rejects(turn, { code: 'BACKEND_DISCONNECTED' });
  await until(() => fs.existsSync(path.join(env.dir, 'wire.jsonl')) && env.wire().some((x) => x.method === 'turn/start'));
  // Windows kill-on-close must work even when the owner cannot run any cleanup code.
  b._transport.child.kill(process.platform === 'win32' ? 'SIGKILL' : 'SIGTERM');
  await rejected; await b.close();
  for (const row of env.wire()) { if (row.pid) dead(row.pid); if (row.descendantPid) dead(row.descendantPid); }
});

test('raw MCP stdin EOF exits bridge and owned child tree without client-side kill', async (t) => {
  const env = setup(t, 'normal', { descendant: true });
  const { spawn } = require('node:child_process');
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'index.js')], {
    stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: false, env: { ...process.env,
      CODEX_BRIDGE_BACKEND: path.join(__dirname, 'app-server-backend.js'),
      CODEX_BRIDGE_STUB_DIR: env.dir, CODEX_BRIDGE_STATE_DIR: env.dir } });
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); }); // cleanup only after assertions
  const responses = new Map(); let nextId = 1, diagnostics = '';
  child.stderr.on('data', (data) => { diagnostics += data; });
  require('node:readline').createInterface({ input: child.stdout }).on('line', (line) => {
    const message = JSON.parse(line); responses.get(message.id)?.(message);
  });
  const send = (method, params) => new Promise((resolve) => {
    const id = nextId++; responses.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  await send('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'raw-eof-test', version: '1' } });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  const answer = await send('tools/call', { name: 'codex_turn', arguments: { conversation_id: 'eof', message: 'one' } });
  assert.equal(answer.result.structuredContent.reply, exact);
  child.stdin.end(); // the ONLY shutdown action before verifying all process exits
  await until(() => child.exitCode !== null);
  assert.equal(child.exitCode, 0);
  assert.match(diagnostics, /shutting down on stdin EOF/);
  for (const row of env.wire()) { if (row.pid) dead(row.pid); if (row.descendantPid) dead(row.descendantPid); }
});
