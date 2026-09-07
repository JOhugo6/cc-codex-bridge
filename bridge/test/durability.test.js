'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { freshStateDir, FakeBackend } = require('./helpers');
const { CodexBridge } = require('../lib/bridge');
const { recover } = require('../recover-operation');
const paths = require('../lib/paths');
const store = require('../lib/store');
const operations = require('../lib/operations');

function worker(id, fault = '', message = 'hello', requestId = 'request-1') {
  return spawnSync(process.execPath, [path.join(__dirname, 'durability-worker.js'), id, fault, message, requestId],
    { env: process.env, encoding: 'utf8', timeout: 10000, windowsHide: true });
}

test('request_id replays the exact completed result across processes, even after later turns', async (t) => {
  const env = freshStateDir(); t.after(() => env.cleanup());
  const first = worker('replay');
  assert.equal(first.status, 0, first.stderr);
  assert.equal(worker('replay', '', 'next', 'request-2').status, 0);
  const replay = worker('replay');
  assert.equal(replay.status, 0, replay.stderr);
  assert.equal(replay.stdout, first.stdout);
  const calls = (await fsp.readFile(path.join(env.dir, 'backend-calls.jsonl'), 'utf8')).trim().split('\n');
  assert.equal(calls.length, 2, 'no backend call on replay');
  assert.equal((await store.loadState('replay')).turn, 2, 'replay does not rewind state');
});

test('request_id is scoped by exact conversation, rejects changed message/cwd/provider, and accepts concurrent retries', async (t) => {
  const env = freshStateDir(); t.after(() => env.cleanup());
  const backend = new FakeBackend();
  const bridge = new CodexBridge(backend);
  const opts = { request_id: 'Case-A', working_dir: '/project' };
  const results = await Promise.all([bridge.turn('requests', 'hello', opts), bridge.turn('requests', 'hello', opts)]);
  assert.deepEqual(results[0], results[1]);
  assert.equal(backend.calls.length, 1);
  for (const [message, changed] of [['other', opts], ['hello', { ...opts, working_dir: '/other' }], ['hello', { request_id: opts.request_id }]]) {
    await assert.rejects(bridge.turn('requests', message, changed), { code: 'REQUEST_ID_CONFLICT' });
  }
  await assert.rejects(new CodexBridge(backend, { provider: 'other' }).turn('requests', 'hello', opts), { code: 'REQUEST_ID_CONFLICT' });
  await bridge.turn('requests', 'hello', { ...opts, request_id: 'case-a' });
  await bridge.turn('Requests', 'hello', opts);
  assert.equal(backend.calls.length, 3);
});

test('invalid request IDs never reach disk or backend', async (t) => {
  const env = freshStateDir(); t.after(() => env.cleanup());
  const backend = new FakeBackend(); const bridge = new CodexBridge(backend);
  for (const request_id of ['', null, 123, 'has space', 'x'.repeat(201)]) {
    await assert.rejects(bridge.turn('invalid-request', 'hello', { request_id }), { code: 'INVALID_REQUEST_ID' });
  }
  assert.equal(backend.calls.length, 0);
  assert.deepEqual(await fsp.readdir(env.dir), []);
});

for (const fault of ['pending:after', 'in:before', 'in:after', 'backend:after', 'received:before']) {
  test(`restart after crash at ${fault} blocks all backend calls without a known response`, async (t) => {
    const env = freshStateDir(); t.after(() => env.cleanup());
    assert.equal(worker('uncertain', fault).status, 73);
    const before = await fsp.readFile(path.join(env.dir, 'backend-calls.jsonl'), 'utf8').catch(() => '');
    const retry = worker('uncertain');
    assert.equal(retry.status, 1);
    assert.match(retry.stderr, /OPERATION_UNCERTAIN/);
    assert.equal(worker('uncertain', '', 'different', 'request-2').status, 1);
    assert.equal(worker('uncertain', '', 'anonymous', '-').status, 1);
    assert.equal(await fsp.readFile(path.join(env.dir, 'backend-calls.jsonl'), 'utf8').catch(() => ''), before);
    await assert.rejects(recover('finish', 'uncertain'), { code: 'OPERATION_UNCERTAIN' });
    assert.equal((await recover('inspect', 'uncertain')).journal.operations[0].status, 'pending');
  });
}

for (const fault of ['received:after', 'state:before', 'state:after', 'out:before', 'out:after', 'completed:before', 'completed:after']) {
  test(`restart after crash at ${fault} finishes only local writes and preserves exact reply`, async (t) => {
    const env = freshStateDir(); t.after(() => env.cleanup());
    assert.equal(worker('recoverable', fault).status, 73);
    const retry = worker('recoverable'); // also reclaims the dead process lock
    if (fault !== 'completed:after') {
      assert.equal(retry.status, 1);
      assert.match(retry.stderr, /OPERATION_INCOMPLETE/);
    } else assert.equal(retry.status, 0, retry.stderr);
    const recorded = (await operations.load('recoverable')).operations[0].result;
    assert.deepEqual(await recover('finish', 'recoverable'), recorded);
    assert.deepEqual(await recover('finish', 'recoverable'), recorded, 'recovery is idempotent');
    const replay = worker('recoverable');
    assert.equal(replay.status, 0, replay.stderr);
    assert.deepEqual(JSON.parse(replay.stdout), recorded);
    const lines = (await fsp.readFile(paths.transcriptFile('recoverable'), 'utf8')).trim().split('\n').map(JSON.parse);
    assert.deepEqual(lines.map((entry) => entry.direction), ['in', 'out'], 'no duplicate transcript entries');
    assert.equal(lines[1].message, recorded.reply);
    assert.equal((await store.loadState('recoverable')).thread_id, recorded.thread_id);
    assert.equal((await fsp.readFile(path.join(env.dir, 'backend-calls.jsonl'), 'utf8')).trim().split('\n').length, 1);
    assert.equal(worker('recoverable', '', 'next', 'request-2').status, 0);
    assert.equal((await store.loadState('recoverable')).turn, 2);
  });
}

test('failed intent write does not call backend and is safe to retry when no intent was published', async (t) => {
  const env = freshStateDir(); t.after(() => env.cleanup());
  assert.equal(worker('no-intent', 'pending:before').status, 73);
  assert.equal(await operations.load('no-intent'), null);
  assert.equal(worker('no-intent').status, 0);
  assert.equal((await fsp.readFile(path.join(env.dir, 'backend-calls.jsonl'), 'utf8')).trim().split('\n').length, 1);
});

test('offline recovery CLI prints diagnostics and finishes the recorded response', async (t) => {
  const env = freshStateDir(); t.after(() => env.cleanup());
  assert.equal(worker('cli-recovery', 'out:after').status, 73);
  assert.equal(worker('cli-recovery').status, 1); // reclaim dead fixture lock
  const command = path.join(__dirname, '..', 'recover-operation.js');
  function run(action) {
    return spawnSync(process.execPath, [command, action, 'cli-recovery'],
      { env: process.env, encoding: 'utf8', timeout: 10000, windowsHide: true });
  }
  const inspected = run('inspect');
  assert.equal(inspected.status, 0, inspected.stderr);
  const report = JSON.parse(inspected.stdout);
  assert.equal(report.journal.operations[0].status, 'received');
  assert.equal(report.journal_path, paths.operationsFile('cli-recovery'));
  const finished = run('finish');
  assert.equal(finished.status, 0, finished.stderr);
  assert.deepEqual(JSON.parse(finished.stdout), report.journal.operations[0].result);
  assert.equal((await fsp.readFile(path.join(env.dir, 'backend-calls.jsonl'), 'utf8')).trim().split('\n').length, 1);
});

test('resume failure after a backend side effect blocks duplicate and anonymous retries', async (t) => {
  const env = freshStateDir(); t.after(() => env.cleanup());
  assert.equal(worker('resume').status, 0);
  assert.equal(worker('resume', 'backend:after', 'next', 'request-2').status, 73);
  assert.equal(worker('resume', '', 'next', 'request-2').status, 1);
  assert.equal(worker('resume', '', 'third', '-').status, 1);
  assert.equal((await store.loadState('resume')).turn, 1);
  const calls = (await fsp.readFile(path.join(env.dir, 'backend-calls.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(calls.map((call) => call.kind), ['start', 'resume']);
});

test('state-save exception after backend response remains recoverable for calls without request_id', async (t) => {
  const env = freshStateDir(); t.after(() => env.cleanup());
  const backend = new FakeBackend(); const bridge = new CodexBridge(backend);
  const original = store.saveState;
  store.saveState = async () => { throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); };
  try { await assert.rejects(bridge.turn('anonymous', 'hello'), { code: 'OPERATION_PERSISTENCE_FAILED' }); }
  finally { store.saveState = original; }
  await assert.rejects(new CodexBridge(backend).turn('anonymous', 'hello'), { code: 'OPERATION_INCOMPLETE' });
  const recovered = await recover('finish', 'anonymous');
  assert.equal(recovered.turn, 1);
  assert.equal(backend.calls.length, 1);
  assert.equal((await bridge.turn('anonymous', 'next')).turn, 2);
  assert.equal(backend.calls[1].kind, 'reply');
});

test('torn transcript is preserved and blocks recovery; no backend call is repeated', async (t) => {
  const env = freshStateDir(); t.after(() => env.cleanup());
  const backend = new FakeBackend(); const bridge = new CodexBridge(backend);
  const original = store.appendTranscript;
  store.appendTranscript = async (id, entry) => {
    if (entry.direction === 'out') {
      await fsp.appendFile(paths.transcriptFile(id), '{"torn":');
      throw new Error('partial write');
    }
    return original(id, entry);
  };
  try { await assert.rejects(bridge.turn('torn', 'hello', { request_id: 'r1' }), { code: 'OPERATION_PERSISTENCE_FAILED' }); }
  finally { store.appendTranscript = original; }
  const before = await fsp.readFile(paths.transcriptFile('torn'), 'utf8');
  await assert.rejects(recover('finish', 'torn'), { code: 'CORRUPT_TRANSCRIPT' });
  assert.equal(await fsp.readFile(paths.transcriptFile('torn'), 'utf8'), before);
  await assert.rejects(bridge.turn('torn', 'hello', { request_id: 'r1' }), { code: 'OPERATION_INCOMPLETE' });
  assert.equal(backend.calls.length, 1);
});

test('missing state or journal and corrupted request records fail closed', async (t) => {
  const env = freshStateDir(); t.after(() => env.cleanup());
  const backend = new FakeBackend(); const bridge = new CodexBridge(backend);
  for (const id of ['lost-state', 'lost-journal', 'bad-journal', 'wrong-id']) await bridge.turn(id, 'hello', { request_id: 'r1' });
  await fsp.rm(paths.stateFile('lost-state'));
  await fsp.rm(paths.operationsFile('lost-journal'));
  const bad = await operations.load('bad-journal'); delete bad.operations[0].result;
  await store.writeJsonAtomic(paths.operationsFile('bad-journal'), bad);
  const wrong = await operations.load('wrong-id'); wrong.conversation_id = 'other';
  await store.writeJsonAtomic(paths.operationsFile('wrong-id'), wrong);
  for (const [id, code] of [['lost-state', 'OPERATION_STATE_CONFLICT'], ['lost-journal', 'MISSING_OPERATIONS'], ['bad-journal', 'CORRUPT_OPERATIONS'], ['wrong-id', 'CORRUPT_OPERATIONS']]) {
    await assert.rejects(bridge.turn(id, 'next'), { code });
  }
  await fsp.writeFile(paths.transcriptFile('old-orphan'), '{"direction":"in"}\n');
  await assert.rejects(bridge.turn('old-orphan', 'next'), { code: 'OPERATION_UNCERTAIN' });
  assert.equal(backend.calls.length, 4);
});
