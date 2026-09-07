'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const crypto = require('node:crypto');
const path = require('node:path');
const { freshStateDir, FakeBackend } = require('./helpers');
const { CodexBridge } = require('../lib/bridge');
const artifacts = require('../lib/reply-artifacts');
const operations = require('../lib/operations');
const paths = require('../lib/paths');
const store = require('../lib/store');
const { recover } = require('../recover-operation');

async function assertBytes(result, reply) {
  assert.equal(result.reply, reply);
  const expected = Buffer.from(reply, 'utf8');
  const a = result.reply_artifact;
  assert.equal(a.byte_length, expected.length);
  assert.equal(a.sha256, crypto.createHash('sha256').update(expected).digest('hex'));
  assert.deepEqual(await fsp.readFile(artifacts.fileFor(a.conversation_id, a.operation_id)), expected);
  const resource = await artifacts.readResource(a.uri);
  assert.equal(resource.contents[0].uri, a.uri);
  assert.equal(resource.contents[0].mimeType, artifacts.MIME_TYPE);
  assert.deepEqual(Buffer.from(resource.contents[0].blob, 'base64'), expected);
}

test('exact diff, Unicode, mixed newlines, whitespace, NUL and empty UTF-8 payloads have durable identity', async (t) => {
  const env = freshStateDir(); t.after(() => env.cleanup());
  const replies = [
    '\uFEFFdiff --git a/a b/a\r\n@@ -1 +1 @@\r\n- staré\t \r\n+ 新しい 😀 e\u0301\t  \r\n\n',
    'no final newline 😀', '\n\t\r\n  ', '\0control\0\n', '',
  ];
  const backend = new FakeBackend({ replies }); const bridge = new CodexBridge(backend);
  const seen = new Set();
  for (let i = 0; i < replies.length; i++) {
    const result = await bridge.turn('Reply-A', 'next', i % 2 ? {} : { request_id: `r${i}` });
    const op = (await operations.load('Reply-A')).operations[i];
    assert.equal(result.reply_artifact.conversation_id, 'Reply-A');
    assert.equal(result.reply_artifact.operation_id, op.operation_id);
    assert.equal(result.reply_artifact.turn, i + 1);
    assert.equal(result.reply_artifact.request_id, i % 2 ? null : `r${i}`);
    assert.equal(seen.has(result.reply_artifact.uri), false); seen.add(result.reply_artifact.uri);
    await assertBytes(result, replies[i]);
  }
});

test('concurrent duplicate delivery, later turns and a new bridge keep the same artifact and metadata', async (t) => {
  const env = freshStateDir(); t.after(() => env.cleanup());
  const backend = new FakeBackend({ replies: ['same\r\n😀\t\n', 'later'] }); const bridge = new CodexBridge(backend);
  const opts = { request_id: 'r1' };
  const [first, duplicate] = await Promise.all([bridge.turn('replay', 'first', opts), bridge.turn('replay', 'first', opts)]);
  assert.deepEqual(duplicate, first);
  await bridge.turn('replay', 'next');
  assert.deepEqual(await new CodexBridge(backend).turn('replay', 'first', opts), first);
  await assertBytes(first, first.reply);
  assert.equal((await store.loadState('replay')).turn, 2);
  assert.equal(backend.calls.length, 2);
});

test('partial artifact write leaves the received response recoverable and never repeats the backend', async (t) => {
  const env = freshStateDir(); t.after(() => env.cleanup());
  const backend = new FakeBackend({ replies: ['exact\r\n😀\t  \n'] }); const bridge = new CodexBridge(backend);
  const open = fsp.open;
  const fault = t.mock.method(fsp, 'open', async (file, ...args) => {
    const handle = await open(file, ...args);
    if (String(file).includes('.utf8.tmp.')) {
      const write = handle.writeFile.bind(handle);
      handle.writeFile = async (bytes) => {
        await write(bytes.subarray(0, 3));
        throw Object.assign(new Error('injected disk full'), { code: 'ENOSPC' });
      };
    }
    return handle;
  });
  await assert.rejects(bridge.turn('write-failure', 'first', { request_id: 'r1' }), { code: 'OPERATION_PERSISTENCE_FAILED' });
  fault.mock.restore();
  const op = (await operations.load('write-failure')).operations[0];
  assert.equal(op.status, 'received');
  assert.equal(op.result.reply, 'exact\r\n😀\t  \n');
  assert.equal(await store.loadState('write-failure'), null);
  assert.deepEqual(await fsp.readdir(path.dirname(artifacts.fileFor('write-failure', op.operation_id))), []);
  await assert.rejects(artifacts.readResource(op.result.reply_artifact.uri), { code: 'RESOURCE_NOT_FOUND' });
  await assert.rejects(bridge.turn('write-failure', 'first', { request_id: 'r1' }), { code: 'OPERATION_INCOMPLETE' });
  await assert.rejects(bridge.turn('write-failure', 'next'), { code: 'OPERATION_INCOMPLETE' });
  const recovered = await recover('finish', 'write-failure');
  assert.deepEqual(recovered, op.result);
  await assertBytes(recovered, recovered.reply);
  assert.deepEqual(await bridge.turn('write-failure', 'first', { request_id: 'r1' }), recovered);
  assert.equal(backend.calls.length, 1);
});

test('publication failure and failure after publication both recover without overwriting bytes', async (t) => {
  const env = freshStateDir(); t.after(() => env.cleanup());
  const backend = new FakeBackend(); const bridge = new CodexBridge(backend);
  for (const after of [false, true]) {
    const id = `publication-${after}`;
    const link = fsp.link;
    const fault = t.mock.method(fsp, 'link', async (...args) => {
      if (after) await link(...args);
      throw Object.assign(new Error('publication fault'), { code: 'EIO' });
    });
    await assert.rejects(bridge.turn(id, 'first'), { code: 'OPERATION_PERSISTENCE_FAILED' });
    fault.mock.restore();
    const op = (await operations.load(id)).operations[0];
    assert.equal(op.status, 'received');
    const recovered = await recover('finish', id);
    await assertBytes(recovered, 'started: first');
    assert.deepEqual(await recover('finish', id), recovered);
  }
  assert.equal(backend.calls.length, 2);
});

test('conflicting bytes are preserved and rejected by resource read, replay and offline recovery', async (t) => {
  const env = freshStateDir(); t.after(() => env.cleanup());
  const backend = new FakeBackend(); const bridge = new CodexBridge(backend);
  const result = await bridge.turn('corrupt', 'first', { request_id: 'r1' });
  const file = artifacts.fileFor('corrupt', result.reply_artifact.operation_id);
  // Keep length equal to prove checking byte count alone is insufficient.
  const bad = Buffer.alloc(result.reply_artifact.byte_length, 120);
  await fsp.writeFile(file, bad);
  await assert.rejects(artifacts.readResource(result.reply_artifact.uri), { code: 'CORRUPT_REPLY_ARTIFACT' });
  await assert.rejects(bridge.turn('corrupt', 'first', { request_id: 'r1' }), { code: 'CORRUPT_REPLY_ARTIFACT' });
  await assert.rejects(recover('finish', 'corrupt'), { code: 'CORRUPT_REPLY_ARTIFACT' });
  assert.deepEqual(await fsp.readFile(file), bad);
  assert.equal(backend.calls.length, 1);
});

test('missing artifacts are explicitly reported on read and reconstructed from the journal on replay', async (t) => {
  const env = freshStateDir(); t.after(() => env.cleanup());
  const backend = new FakeBackend(); const bridge = new CodexBridge(backend);
  const result = await bridge.turn('missing', 'first', { request_id: 'r1' });
  await bridge.turn('missing', 'next');
  await fsp.unlink(artifacts.fileFor('missing', result.reply_artifact.operation_id));
  await assert.rejects(artifacts.readResource(result.reply_artifact.uri), { code: 'REPLY_ARTIFACT_MISSING' });
  assert.deepEqual(await bridge.turn('missing', 'first', { request_id: 'r1' }), result);
  await assertBytes(result, result.reply);
  assert.equal((await store.loadState('missing')).turn, 2);
  assert.equal(backend.calls.length, 2);
});

test('pre-artifact completed responses gain stable metadata on replay, including failed local upgrade', async (t) => {
  const env = freshStateDir(); t.after(() => env.cleanup());
  const backend = new FakeBackend(); const bridge = new CodexBridge(backend);
  const first = await bridge.turn('upgrade', 'first', { request_id: 'r1' });
  await bridge.turn('upgrade', 'second');
  const journal = await operations.load('upgrade');
  delete journal.operations[0].result.reply_artifact;
  await store.writeJsonAtomic(paths.operationsFile('upgrade'), journal);
  await fsp.unlink(artifacts.fileFor('upgrade', first.reply_artifact.operation_id));
  const originalState = await fsp.readFile(paths.stateFile('upgrade'));
  const originalTranscript = await fsp.readFile(paths.transcriptFile('upgrade'));
  const fault = t.mock.method(store, 'writeJsonAtomic', async () => { throw new Error('upgrade save failed'); });
  await assert.rejects(bridge.turn('upgrade', 'first', { request_id: 'r1' }), /upgrade save failed/);
  fault.mock.restore();
  assert.equal((await operations.load('upgrade')).operations[0].result.reply_artifact, undefined);
  assert.deepEqual(await bridge.turn('upgrade', 'first', { request_id: 'r1' }), first);
  await assertBytes(first, first.reply);
  assert.deepEqual(await fsp.readFile(paths.stateFile('upgrade')), originalState);
  assert.deepEqual(await fsp.readFile(paths.transcriptFile('upgrade')), originalTranscript);
  assert.equal(backend.calls.length, 2);
});

test('malformed, unknown and differently cased resource identities never create files', async (t) => {
  const env = freshStateDir(); t.after(() => env.cleanup());
  const key = 'a'.repeat(64);
  for (const uri of [null, '', 'file:///etc/passwd', `codex-bridge://reply/c-x/${key}\n`,
    `codex-bridge://reply/c-x/${key}?x=1`, `codex-bridge://reply/c-x/../${key}`,
    `codex-bridge://reply/c-%78/${key}`, `codex-bridge://reply/c-x/${key.toUpperCase()}`]) {
    await assert.rejects(artifacts.readResource(uri), { code: 'INVALID_RESOURCE_URI' });
  }
  await assert.rejects(artifacts.readResource(`codex-bridge://reply/c-unknown/${key}`), { code: 'RESOURCE_NOT_FOUND' });
  assert.deepEqual(await fsp.readdir(env.dir), []);
  const result = await new CodexBridge(new FakeBackend()).turn('Case-A', 'first');
  await assert.rejects(artifacts.readResource(result.reply_artifact.uri.replace('Case-A', 'case-a')), { code: 'RESOURCE_NOT_FOUND' });
  const dotId = await new CodexBridge(new FakeBackend()).turn('..', 'first');
  await assertBytes(dotId, dotId.reply);
});

test('journal artifact metadata corruption is rejected before backend calls and resource reads', async (t) => {
  const env = freshStateDir(); t.after(() => env.cleanup());
  const backend = new FakeBackend(); const bridge = new CodexBridge(backend);
  const result = await bridge.turn('metadata', 'first', { request_id: 'r1' });
  const journal = await operations.load('metadata');
  journal.operations[0].result.reply_artifact.sha256 = '0'.repeat(64);
  await store.writeJsonAtomic(paths.operationsFile('metadata'), journal);
  await assert.rejects(artifacts.readResource(result.reply_artifact.uri), { code: 'CORRUPT_OPERATIONS' });
  await assert.rejects(bridge.turn('metadata', 'next'), { code: 'CORRUPT_OPERATIONS' });
  assert.equal(backend.calls.length, 1);
});
