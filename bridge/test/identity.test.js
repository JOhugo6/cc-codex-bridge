'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { freshStateDir, FakeBackend } = require('./helpers');
const { CodexBridge } = require('../lib/bridge');
const { migrateLegacy } = require('../lib/migration');
const paths = require('../lib/paths');
const store = require('../lib/store');
const lock = require('../lib/lock');

async function legacyFixture(dir, id, state = { thread_id: 'legacy-thread', turn: 4 }) {
  const stateFile = path.join(dir, `${id}.json`);
  const transcriptFile = path.join(dir, `${id}.transcript.jsonl`);
  const transcript = Buffer.from('{"direction":"out","message":"příliš žluťoučký\\n  diff","turn":4}\r\n');
  await fsp.writeFile(stateFile, JSON.stringify(state));
  await fsp.writeFile(transcriptFile, transcript);
  return { stateFile, transcriptFile, transcript, state };
}

test('case-distinct IDs use independent state, transcript and locks and resume after recreation', async (t) => {
  const env = freshStateDir();
  t.after(() => env.cleanup());
  const backend = new FakeBackend();
  const bridge = new CodexBridge(backend);
  for (const getPath of [paths.stateFile, paths.transcriptFile, paths.lockDir]) {
    assert.notEqual(getPath('Review-A').toLowerCase(), getPath('review-a').toLowerCase());
    assert.match(path.basename(getPath('Review-A')), /^v2@[0-9a-f]{64}\./);
  }
  const upper = await bridge.turn('Review-A', 'upper first');
  const lower = await bridge.turn('review-a', 'lower first');
  assert.notEqual(upper.thread_id, lower.thread_id);
  const restarted = new CodexBridge(backend);
  const upperNext = await restarted.turn('Review-A', 'upper next');
  const lowerNext = await restarted.turn('review-a', 'lower next');
  assert.deepEqual([upperNext.thread_id, lowerNext.thread_id], [upper.thread_id, lower.thread_id]);
  assert.deepEqual([upperNext.turn, lowerNext.turn], [2, 2]);
  for (const id of ['Review-A', 'review-a']) {
    assert.equal((await store.loadState(id)).conversation_id, id);
    const transcript = await fsp.readFile(paths.transcriptFile(id), 'utf8');
    assert.ok(transcript.trim().split('\n').every((line) => JSON.parse(line).conversation_id === id));
  }
  const release = await lock.acquire(paths.lockDir('Review-A'));
  try {
    const releaseLower = await lock.acquire(paths.lockDir('review-a'), { timeoutMs: 20 });
    await releaseLower();
  } finally { await release(); }
});

test('missing or mismatched original identity blocks backend calls and writes', async (t) => {
  const env = freshStateDir();
  t.after(() => env.cleanup());
  const backend = new FakeBackend();
  const bridge = new CodexBridge(backend);
  for (const conversation_id of [undefined, 'review-a']) {
    await fsp.writeFile(paths.stateFile('Review-A'), JSON.stringify({ thread_id: 'tid', turn: 1, conversation_id }));
    await assert.rejects(bridge.turn('Review-A', 'x'), { code: 'STATE_IDENTITY_MISMATCH' });
  }
  await assert.rejects(store.saveState('Review-A', { conversation_id: 'review-a' }), { code: 'STATE_IDENTITY_MISMATCH' });
  assert.equal(backend.calls.length, 0);
});

test('legacy session is blocked until explicit migration, which preserves transcript and thread', async (t) => {
  const env = freshStateDir();
  t.after(() => env.cleanup());
  const legacy = await legacyFixture(env.dir, 'Review-A', { thread_id: 'legacy-thread', turn: 4, working_dir: await fsp.realpath(env.dir) });
  const other = await legacyFixture(env.dir, 'unrelated');
  const backend = new FakeBackend();
  const bridge = new CodexBridge(backend);
  await assert.rejects(bridge.turn('Review-A', 'x'), { code: 'LEGACY_MIGRATION_REQUIRED' });
  await assert.rejects(bridge.turn('review-a', 'x'), { code: 'LEGACY_IDENTITY_CONFLICT' });
  await assert.rejects(migrateLegacy('review-a'), { code: 'LEGACY_IDENTITY_CONFLICT' });
  assert.equal(backend.calls.length, 0);
  assert.equal((await migrateLegacy('Review-A')).migrated, true);
  assert.deepEqual(await fsp.readFile(paths.transcriptFile('Review-A')), legacy.transcript);
  assert.deepEqual(await fsp.readFile(legacy.transcriptFile), legacy.transcript);
  assert.deepEqual(JSON.parse(await fsp.readFile(legacy.stateFile, 'utf8')).original_state, legacy.state);
  // The legacy bridge's validation rejects this guard instead of using stale state.
  await assert.rejects(store.readStateFile(legacy.stateFile, 'Review-A', { legacy: true }), { code: 'CORRUPT_STATE' });
  assert.equal((await migrateLegacy('Review-A')).migrated, false);
  const resumed = await bridge.turn('Review-A', 'next');
  assert.equal(resumed.thread_id, 'legacy-thread');
  assert.equal(resumed.turn, 5);
  assert.equal((await bridge.turn('Review-A', 'next again')).turn, 6);
  assert.equal((await bridge.turn('review-a', 'new distinct ID')).turn, 1);
  assert.deepEqual(JSON.parse(await fsp.readFile(other.stateFile, 'utf8')), other.state);
  assert.deepEqual(await fsp.readFile(other.transcriptFile), other.transcript);
});

test('legacy identity mismatch, mixed artifact casing and orphan transcript are rejected', async (t) => {
  const env = freshStateDir();
  t.after(() => env.cleanup());
  await legacyFixture(env.dir, 'bad-id', { conversation_id: 'another-id', thread_id: 'tid', turn: 1 });
  await assert.rejects(migrateLegacy('bad-id'), { code: 'STATE_IDENTITY_MISMATCH' });
  await fsp.writeFile(path.join(env.dir, 'Mixed.json'), '{"thread_id":"tid","turn":1}');
  await fsp.writeFile(path.join(env.dir, 'mixed.transcript.jsonl'), '');
  await assert.rejects(migrateLegacy('Mixed'), { code: 'LEGACY_IDENTITY_CONFLICT' });
  await fsp.writeFile(path.join(env.dir, 'orphan.transcript.jsonl'), '{}\n');
  await assert.rejects(new CodexBridge(new FakeBackend()).turn('orphan', 'x'), { code: 'LEGACY_MIGRATION_REQUIRED' });
  await assert.rejects(migrateLegacy('orphan'), { code: 'LEGACY_IDENTITY_CONFLICT' });
});

test('conflicting hashed state or transcript never overwrites either session', async (t) => {
  const env = freshStateDir();
  t.after(() => env.cleanup());
  const legacy = await legacyFixture(env.dir, 'conflict');
  await store.saveState('conflict', { thread_id: 'independent', turn: 2 });
  await assert.rejects(migrateLegacy('conflict'), { code: 'LEGACY_IDENTITY_CONFLICT' });
  assert.equal(JSON.parse(await fsp.readFile(paths.stateFile('conflict'), 'utf8')).thread_id, 'independent');
  assert.deepEqual(JSON.parse(await fsp.readFile(legacy.stateFile, 'utf8')), legacy.state);
  await legacyFixture(env.dir, 'tx-conflict');
  await fsp.writeFile(paths.transcriptFile('tx-conflict'), 'different transcript');
  await assert.rejects(migrateLegacy('tx-conflict'), { code: 'LEGACY_IDENTITY_CONFLICT' });
  assert.equal(await fsp.readFile(paths.transcriptFile('tx-conflict'), 'utf8'), 'different transcript');
});

test('case-sensitive legacy directory containing two case aliases is rejected before writes', async (t) => {
  const env = freshStateDir();
  t.after(() => env.cleanup());
  const legacy = await legacyFixture(env.dir, 'Review-A');
  const readdir = fsp.readdir.bind(fsp);
  // Simulate a case-sensitive volume on every test platform, including Windows.
  const listing = t.mock.method(fsp, 'readdir', async (...args) => [...await readdir(...args), 'review-a.json']);
  await assert.rejects(migrateLegacy('Review-A'), { code: 'LEGACY_IDENTITY_CONFLICT' });
  listing.mock.restore();
  assert.deepEqual(JSON.parse(await fsp.readFile(legacy.stateFile, 'utf8')), legacy.state);
  await assert.rejects(fsp.access(paths.stateFile('Review-A')), { code: 'ENOENT' });
});

test('interrupted migration blocks turns and can safely resume its exact snapshot', async (t) => {
  const env = freshStateDir();
  t.after(() => env.cleanup());
  await legacyFixture(env.dir, 'retry', { thread_id: 'legacy-thread', turn: 4, working_dir: await fsp.realpath(env.dir) });
  const copy = t.mock.method(fsp, 'copyFile', async () => { throw new Error('injected copy failure'); });
  await assert.rejects(migrateLegacy('retry'), /injected copy failure/);
  copy.mock.restore();
  const backend = new FakeBackend();
  const bridge = new CodexBridge(backend);
  await assert.rejects(bridge.turn('retry', 'x'), { code: 'LEGACY_MIGRATION_REQUIRED' });
  assert.equal(backend.calls.length, 0);
  await migrateLegacy('retry');
  assert.equal((await bridge.turn('retry', 'x')).thread_id, 'legacy-thread');
});

test('missing migration destination and modified legacy transcript remain loud errors', async (t) => {
  const env = freshStateDir();
  t.after(() => env.cleanup());
  await legacyFixture(env.dir, 'lost-target');
  await migrateLegacy('lost-target');
  await fsp.unlink(paths.stateFile('lost-target'));
  await assert.rejects(store.loadState('lost-target'), { code: 'LEGACY_IDENTITY_CONFLICT' });
  const legacy = await legacyFixture(env.dir, 'changed-tx');
  await migrateLegacy('changed-tx');
  await fsp.appendFile(legacy.transcriptFile, '{}\n');
  await assert.rejects(store.loadState('changed-tx'), { code: 'LEGACY_IDENTITY_CONFLICT' });
});

test('migration CLI waits for a legacy process lock and reads its final state', async (t) => {
  const env = freshStateDir();
  t.after(() => env.cleanup());
  const legacy = await legacyFixture(env.dir, 'process-lock');
  const release = await lock.acquire(path.join(env.dir, 'process-lock.lock'));
  t.after(release);
  const child = spawn(process.execPath, [path.resolve(__dirname, '../migrate-state.js'), 'process-lock'], { env: process.env, windowsHide: true });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  let stdout = '', stderr = '', exited = false;
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const completed = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) => { exited = true; resolve(code); });
  });
  const deadline = Date.now() + 5000;
  while (!(await fsp.stat(paths.lockDir('process-lock')).catch(() => null))) {
    assert.ok(Date.now() < deadline, `child did not acquire new lock: ${stderr}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(exited, false);
  await fsp.writeFile(legacy.stateFile, JSON.stringify({ thread_id: 'legacy-thread', turn: 8 }));
  await release();
  assert.equal(await completed, 0, stderr);
  assert.equal(JSON.parse(stdout).migrated, true);
  assert.equal((await store.loadState('process-lock')).turn, 8);
});
