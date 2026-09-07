'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { freshStateDir, FakeBackend } = require('./helpers');
const { CodexBridge } = require('../lib/bridge');
const { migrateLegacy } = require('../lib/migration');
const { recover } = require('../recover-operation');
const store = require('../lib/store');
const paths = require('../lib/paths');

test('cwd is canonicalized, persisted and inherited after restart in a different launch directory', async (t) => {
  const env = freshStateDir(); t.after(() => env.cleanup());
  const project = path.join(env.dir, 'Project with spaces ž');
  await fsp.mkdir(project);
  const canonical = await fsp.realpath(project);
  const launch = process.cwd();
  const backend = new FakeBackend();
  const bridge = new CodexBridge(backend);
  const first = await bridge.turn('pinned', 'first', { working_dir: path.relative(launch, project) + path.sep });
  assert.deepEqual(backend.calls[0].extra, { cwd: canonical });
  assert.equal((await store.loadState('pinned')).working_dir, canonical);
  let restarted;
  try { process.chdir(env.dir); restarted = new CodexBridge(backend); }
  finally { process.chdir(launch); }
  const second = await restarted.turn('pinned', 'second');
  assert.equal(second.thread_id, first.thread_id);
  await restarted.turn('pinned', 'third', { working_dir: './Project with spaces ž/../Project with spaces ž/' });
  assert.equal((await store.loadState('pinned')).working_dir, canonical);
});

test('omitted cwd defaults to the captured launch directory even after chdir', async (t) => {
  const env = freshStateDir(); t.after(() => env.cleanup());
  const launch = process.cwd(); const backend = new FakeBackend();
  const bridge = new CodexBridge(backend);
  try { process.chdir(env.dir); await bridge.turn('default', 'first'); }
  finally { process.chdir(launch); }
  assert.equal(backend.calls[0].extra.cwd, await fsp.realpath(launch));
  assert.equal((await store.loadState('default')).working_dir, await fsp.realpath(launch));
});

test('different, missing, empty, file and invalid directory inputs never reach the backend', async (t) => {
  const env = freshStateDir(); t.after(() => env.cleanup());
  const backend = new FakeBackend(); const bridge = new CodexBridge(backend);
  const file = path.join(env.dir, 'file'); await fsp.writeFile(file, 'x');
  const invalid = ['', null, 123, 'x'.repeat(501), 'bad\0path', file, path.join(env.dir, 'missing')];
  if (process.platform === 'win32') invalid.push('C:relative');
  for (const working_dir of invalid) {
    await assert.rejects(bridge.turn('invalid-dir', 'x', { working_dir }), { code: 'INVALID_WORKING_DIR' });
  }
  assert.equal(backend.calls.length, 0);
  await assert.rejects(fsp.access(paths.operationsFile('invalid-dir')), { code: 'ENOENT' });
  await bridge.turn('different-dir', 'first', { working_dir: env.dir });
  const before = await fsp.readFile(paths.operationsFile('different-dir'));
  await assert.rejects(bridge.turn('different-dir', 'second', { working_dir: process.cwd() }), { code: 'WORKING_DIR_MISMATCH' });
  assert.equal(backend.calls.length, 1);
  assert.deepEqual(await fsp.readFile(paths.operationsFile('different-dir')), before);
});

test('directory links resolve to the target and cannot later redirect a pinned thread', async (t) => {
  const env = freshStateDir(); t.after(() => env.cleanup());
  const target = path.join(env.dir, 'target'), other = path.join(env.dir, 'other'), alias = path.join(env.dir, 'alias');
  await fsp.mkdir(target); await fsp.mkdir(other);
  await fsp.symlink(target, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const backend = new FakeBackend(); const bridge = new CodexBridge(backend);
  await bridge.turn('links', 'first', { working_dir: alias });
  await bridge.turn('links', 'second', { working_dir: target });
  await fsp.unlink(alias);
  await fsp.symlink(other, alias, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(bridge.turn('links', 'wrong', { working_dir: alias }), { code: 'WORKING_DIR_MISMATCH' });
  await bridge.turn('links', 'inherited');
  assert.equal(backend.calls.length, 3);
  assert.equal((await store.loadState('links')).working_dir, await fsp.realpath(target));
});

test('Windows path casing and slash variants identify the same actual directory', { skip: process.platform !== 'win32' }, async (t) => {
  const env = freshStateDir(); t.after(() => env.cleanup());
  const backend = new FakeBackend(); const bridge = new CodexBridge(backend);
  await bridge.turn('case-path', 'first', { working_dir: env.dir });
  await bridge.turn('case-path', 'second', { working_dir: env.dir.toUpperCase().replaceAll('\\', '/') + '/' });
  assert.equal(backend.calls.length, 2);
});

test('replay uses normalized pinned cwd across omitted, relative and explicit spellings', async (t) => {
  const env = freshStateDir(); t.after(() => env.cleanup());
  const backend = new FakeBackend(); const bridge = new CodexBridge(backend);
  const first = await bridge.turn('replay-dir', 'first', { working_dir: env.dir, request_id: 'r1' });
  for (const working_dir of [undefined, env.dir + path.sep, path.relative(process.cwd(), env.dir)]) {
    assert.deepEqual(await bridge.turn('replay-dir', 'first', { working_dir, request_id: 'r1' }), first);
  }
  const defaulted = await bridge.turn('replay-default', 'first', { request_id: 'r1' });
  assert.deepEqual(await bridge.turn('replay-default', 'first', { working_dir: process.cwd(), request_id: 'r1' }), defaulted);
  await assert.rejects(bridge.turn('replay-dir', 'first', { working_dir: process.cwd(), request_id: 'r1' }), { code: 'REQUEST_ID_CONFLICT' });
  const launch = process.cwd(); let restarted;
  try { process.chdir(env.dir); restarted = new CodexBridge(backend); }
  finally { process.chdir(launch); }
  assert.deepEqual(await restarted.turn('replay-default', 'first', { request_id: 'r1' }), defaulted);
  assert.equal(backend.calls.length, 2);
});

test('missing pinned directory blocks continuation but completed omitted-cwd replay stays available', async (t) => {
  const env = freshStateDir(); t.after(() => env.cleanup());
  const project = path.join(env.dir, 'removed'); await fsp.mkdir(project);
  const backend = new FakeBackend(); const bridge = new CodexBridge(backend);
  const first = await bridge.turn('removed-dir', 'first', { working_dir: project, request_id: 'r1' });
  await fsp.rmdir(project);
  await assert.rejects(bridge.turn('removed-dir', 'next'), { code: 'INVALID_WORKING_DIR' });
  assert.deepEqual(await bridge.turn('removed-dir', 'first', { request_id: 'r1' }), first);
  assert.equal(backend.calls.length, 1);
});

test('legacy unknown cwd blocks resume even when supplied explicitly; migration does not invent it', async (t) => {
  const env = freshStateDir(); t.after(() => env.cleanup());
  await fsp.writeFile(path.join(env.dir, 'legacy-dir.json'), JSON.stringify({ thread_id: 'old-thread', turn: 4 }));
  await migrateLegacy('legacy-dir');
  const before = await store.loadState('legacy-dir');
  const backend = new FakeBackend(); const bridge = new CodexBridge(backend);
  for (const working_dir of [undefined, env.dir]) {
    await assert.rejects(bridge.turn('legacy-dir', 'next', { working_dir }), { code: 'WORKING_DIR_UNKNOWN' });
  }
  assert.deepEqual(await store.loadState('legacy-dir'), before);
  assert.equal(backend.calls.length, 0);
});

test('legacy raw-input request replay remains compatible without allowing an unknown-cwd continuation', async (t) => {
  const env = freshStateDir(); t.after(() => env.cleanup());
  const operations = require('../lib/operations');
  // Construct an actual pre-cwd-policy journal using the unchanged journal primitives.
  let journal = await operations.begin('legacy-replay', null, null, { message: 'first', working_dir: null, provider: 'codex' }, 'r1');
  const result = { reply: 'old reply\n', thread_id: 'old-thread', turn: 1 };
  await operations.receive('legacy-replay', journal, result);
  await operations.finish('legacy-replay', journal, null);
  const backend = new FakeBackend(); const bridge = new CodexBridge(backend);
  assert.deepEqual(await bridge.turn('legacy-replay', 'first', { request_id: 'r1' }), result);
  await assert.rejects(bridge.turn('legacy-replay', 'first', { request_id: 'r1', working_dir: env.dir }), { code: 'REQUEST_ID_CONFLICT' });
  await assert.rejects(bridge.turn('legacy-replay', 'next'), { code: 'WORKING_DIR_UNKNOWN' });
  assert.equal(backend.calls.length, 0);
});

test('recovering local persistence retains the cwd that was sent to the backend', async (t) => {
  const env = freshStateDir(); t.after(() => env.cleanup());
  const backend = new FakeBackend(); const bridge = new CodexBridge(backend);
  const save = t.mock.method(store, 'saveState', async () => { throw new Error('injected'); });
  await assert.rejects(bridge.turn('cwd-recovery', 'first', { working_dir: env.dir }), { code: 'OPERATION_PERSISTENCE_FAILED' });
  save.mock.restore();
  await recover('finish', 'cwd-recovery');
  assert.equal((await store.loadState('cwd-recovery')).working_dir, await fsp.realpath(env.dir));
  assert.equal(backend.calls.length, 1);
});
