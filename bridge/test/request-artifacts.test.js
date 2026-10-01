'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { freshStateDir, FakeBackend } = require('./helpers');
const { CodexBridge } = require('../lib/bridge');
const artifacts = require('../lib/request-artifacts');
const operations = require('../lib/operations');
const paths = require('../lib/paths');
const store = require('../lib/store');
const { recover } = require('../recover-operation');
const { parseToolInput, parseEnvelope, MAX_MESSAGE_LENGTH } = require('../lib/turn-input');

// Explicit bytes, independent of checkout newline conversion: BOM, CRLF, lone CR,
// LF, NUL, Czech, CJK and a supplementary Unicode character.
const literal = Buffer.from([0xef, 0xbb, 0xbf, 0x61, 0x0d, 0x0a, 0x62, 0x0d, 0x63, 0x0a,
  0x00, 0xc4, 0x8d, 0xe6, 0x96, 0xb0, 0xf0, 0x9f, 0x98, 0x80]);
const digest = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
async function setup(t, bytes = literal) {
  const env = freshStateDir(); t.after(() => env.cleanup());
  const file = path.join(env.dir, 'member.utf8'); await fsp.writeFile(file, bytes);
  const backend = new FakeBackend({ replies: ['OK', 'NEXT'] });
  const bridge = new CodexBridge(backend);
  const opts = { working_dir: env.dir, request_id: 'r1', attachments: [{ id: 'member', path: './member.utf8' }] };
  return { env, file, backend, bridge, opts };
}

test('one turn delivers a >=200097-unit member with byte fidelity and no recursive placeholder substitution', async (t) => {
  const bytes = Buffer.concat([literal, Buffer.from('x'.repeat(200097) + '{{attachment:member}}')]);
  const { env, backend, bridge, opts } = await setup(t, bytes);
  const result = await bridge.turn('large', 'BEGIN\r\n{{attachment:member}}\nEND', opts);
  assert.equal(backend.calls.length, 1);
  assert.deepEqual(Buffer.from(backend.calls[0].prompt), Buffer.concat([Buffer.from('BEGIN\r\n'), bytes, Buffer.from('\nEND')]));
  assert.ok(backend.calls[0].prompt.length > 200097);
  const a = result.request_artifacts[0];
  assert.equal(a.sha256, digest(bytes)); assert.equal(a.byte_length, bytes.length);
  assert.equal(a.path, path.join(await fsp.realpath(env.dir), 'member.utf8'));
  assert.equal(a.id, 'member'); assert.equal(a.conversation_id, 'large'); assert.equal(a.request_id, 'r1'); assert.equal(a.turn, 1);
  const op = (await operations.load('large')).operations[0];
  assert.equal(a.operation_id, op.operation_id); assert.equal(op.input.message, 'BEGIN\r\n{{attachment:member}}\nEND');
  assert.deepEqual(await artifacts.readVerified('large', op, 'member'), bytes);
  const transcript = (await fsp.readFile(paths.transcriptFile('large'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(transcript[0].message, backend.calls[0].prompt);
});

test('hash and delivery use one raw source read even when the file changes immediately afterwards', async (t) => {
  const { file, backend, bridge, opts } = await setup(t);
  const open = fsp.open; let reads = 0;
  t.mock.method(fsp, 'open', async (target, ...args) => {
    const handle = await open(target, ...args);
    if (String(target) === file && args[0] === 'r') {
      const read = handle.readFile.bind(handle);
      handle.readFile = async (...readArgs) => { reads++; const bytes = await read(...readArgs); await fsp.writeFile(file, 'changed'); return bytes; };
    }
    return handle;
  });
  opts.attachments[0].expected_sha256 = digest(literal);
  const result = await bridge.turn('single-read', '{{attachment:member}}', opts);
  assert.equal(reads, 1); assert.deepEqual(Buffer.from(backend.calls[0].prompt), literal);
  assert.equal(result.request_artifacts[0].sha256, digest(literal)); assert.equal(await fsp.readFile(file, 'utf8'), 'changed');
});

test('invalid UTF-8 and pinned digest mismatch fail closed before journal/backend creation', async (t) => {
  const { env, file, backend, bridge, opts } = await setup(t);
  for (const invalid of [Buffer.from([0xc3, 0x28]), Buffer.from([0xed, 0xa0, 0x80]), Buffer.from([0xf0, 0x9f])]) {
    await fsp.writeFile(file, invalid);
    await assert.rejects(bridge.turn('bad-utf8', '{{attachment:member}}', opts), { code: 'ATTACHMENT_INVALID_UTF8' });
    assert.equal(await operations.load('bad-utf8'), null);
  }
  await fsp.writeFile(file, literal); opts.attachments[0].expected_sha256 = '0'.repeat(64);
  await assert.rejects(bridge.turn('bad-pin', '{{attachment:member}}', opts), { code: 'ATTACHMENT_DIGEST_MISMATCH' });
  assert.equal(await operations.load('bad-pin'), null); assert.equal(backend.calls.length, 0);
  assert.deepEqual(await fsp.readdir(env.dir), ['member.utf8']);
});

test('reference placement and strict nested schema reject all deviations before source reads', async (t) => {
  const { backend, bridge, opts } = await setup(t);
  const cases = [
    ['{{attachment:unknown}}', opts.attachments, 'UNKNOWN_ATTACHMENT_REFERENCE'],
    ['{{attachment:member}}{{attachment:member}}', opts.attachments, 'DUPLICATE_ATTACHMENT_REFERENCE'],
    ['no placeholder', opts.attachments, 'UNREFERENCED_ATTACHMENT'],
    ['{{attachment:member}}', [...opts.attachments, ...opts.attachments], 'DUPLICATE_ATTACHMENT_ID'],
    ['{{attachment:member', opts.attachments, 'INVALID_ATTACHMENT_REFERENCE'],
    ['{{attachment:member\n}}', opts.attachments, 'INVALID_ATTACHMENT_REFERENCE'],
    ['{{attachment:member}}', [], 'UNKNOWN_ATTACHMENT_REFERENCE'],
    ['{{attachment:member}}', [{ ...opts.attachments[0], unexpected: true }], 'INVALID_ATTACHMENTS'],
  ];
  for (const [message, attachments, code] of cases) await assert.rejects(bridge.turn('references', message, { ...opts, attachments }), { code });
  assert.equal(backend.calls.length, 0);
  assert.throws(() => parseToolInput({ conversation_id: 'schema', message: 'x', attachments: [{ id: 'a', path: 'x', extra: true }] }), { code: 'INVALID_ARGUMENTS' });
  assert.throws(() => parseToolInput({ envelope: 'CONV_ID: schema\nx', attachments: [] }), { code: 'INVALID_ARGUMENTS' });
});

test('all three caller message guards retain 100000 units and absent attachments preserve literal tokens', async (t) => {
  const { env, backend, bridge, opts } = await setup(t);
  // Pin the bound this test's name claims; deriving it from the constant alone would stay green if it moved.
  assert.equal(MAX_MESSAGE_LENGTH, 100000);
  const oversized = 'x'.repeat(MAX_MESSAGE_LENGTH + 1);
  assert.throws(() => parseToolInput({ conversation_id: 'bounds', message: oversized, attachments: opts.attachments }), { code: 'INVALID_ARGUMENTS' });
  assert.throws(() => parseEnvelope('CONV_ID: bounds\n' + oversized), { code: 'MESSAGE_TOO_LARGE' });
  await assert.rejects(bridge.turn('bounds', oversized, opts), { code: 'MESSAGE_TOO_LARGE' });
  assert.equal(backend.calls.length, 0); assert.deepEqual(await fsp.readdir(env.dir), ['member.utf8']);
  const raw = '{{attachment:missing}} {{attachment:malformed';
  const result = await bridge.turn('literal-tokens', raw, { working_dir: env.dir, request_id: 'literal' });
  assert.equal(backend.calls[0].prompt, raw); assert.deepEqual(result.request_artifacts, []);
  assert.deepEqual(await bridge.turn('literal-tokens', raw, { request_id: 'literal' }), result);
});

test('pinned-cwd path resolution rejects escapes, directories, missing paths, NUL and symlink escapes', async (t) => {
  const { env, file, backend, bridge, opts } = await setup(t);
  const outside = path.join(path.dirname(env.dir), `${path.basename(env.dir)}-outside`);
  await fsp.writeFile(outside, literal); t.after(() => fsp.rm(outside, { force: true }));
  for (const [source, code] of [[outside, 'ATTACHMENT_PATH_OUTSIDE_WORKING_DIR'], [env.dir, 'ATTACHMENT_PATH_OUTSIDE_WORKING_DIR'], ['\0bad', 'ATTACHMENT_PATH_INVALID'], ['absent', 'ATTACHMENT_PATH_INVALID']]) {
    await assert.rejects(bridge.turn('paths', '{{attachment:member}}', { ...opts, attachments: [{ id: 'member', path: source }] }), { code });
  }
  const subdir = path.join(env.dir, 'directory'); await fsp.mkdir(subdir);
  await assert.rejects(bridge.turn('directory', '{{attachment:member}}', { ...opts, attachments: [{ id: 'member', path: subdir }] }), { code: 'ATTACHMENT_READ_FAILED' });
  const alias = path.join(env.dir, 'escape');
  try { await fsp.symlink(outside, alias, 'file'); } catch (err) { if (!['EPERM', 'EACCES'].includes(err.code)) throw err; }
  if (await fsp.lstat(alias).catch(() => null)) await assert.rejects(bridge.turn('symlink', '{{attachment:member}}', { ...opts, attachments: [{ id: 'member', path: alias }] }), { code: 'ATTACHMENT_PATH_OUTSIDE_WORKING_DIR' });
  const result = await bridge.turn('paths-ok', '{{attachment:member}}', opts);
  assert.equal(result.request_artifacts[0].path, await fsp.realpath(file)); assert.equal(backend.calls.length, 1);
});

test('completed replay is identity-bound and survives changed/deleted source, later turns and missing artifact', async (t) => {
  const { file, backend, bridge, opts } = await setup(t); opts.attachments[0].expected_sha256 = digest(literal);
  const first = await bridge.turn('replay', '{{attachment:member}}', opts);
  await fsp.writeFile(file, 'changed');
  assert.deepEqual(await bridge.turn('replay', '{{attachment:member}}', { ...opts, working_dir: undefined }), first);
  await bridge.turn('replay', 'later'); await fsp.unlink(file);
  const artifact = artifacts.fileFor('replay', first.request_artifacts[0].operation_id, 'member'); await fsp.unlink(artifact);
  await assert.rejects(artifacts.readVerified('replay', (await operations.load('replay')).operations[0], 'member'), { code: 'REQUEST_ARTIFACT_MISSING' });
  assert.deepEqual(await new CodexBridge(backend).turn('replay', '{{attachment:member}}', { ...opts, working_dir: undefined }), first);
  assert.deepEqual(await fsp.readFile(artifact), literal);
  for (const attachments of [undefined, [{ ...opts.attachments[0], expected_sha256: undefined }], [{ ...opts.attachments[0], expected_sha256: '0'.repeat(64) }]]) {
    await assert.rejects(bridge.turn('replay', '{{attachment:member}}', { ...opts, attachments }), { code: 'REQUEST_ID_CONFLICT' });
  }
  assert.equal(backend.calls.length, 2); assert.equal((await store.loadState('replay')).turn, 2);
});

test('partial request writes and publication failures never call backend and are safely retryable before intent', async (t) => {
  const { backend, bridge, opts } = await setup(t); const open = fsp.open;
  const fault = t.mock.method(fsp, 'open', async (file, ...args) => {
    const handle = await open(file, ...args);
    if (String(file).includes('.requests') && String(file).includes('.tmp.')) {
      const write = handle.writeFile.bind(handle);
      handle.writeFile = async (bytes) => { await write(bytes.subarray(0, 3)); throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); };
    }
    return handle;
  });
  await assert.rejects(bridge.turn('partial', '{{attachment:member}}', opts), { code: 'ENOSPC' });
  fault.mock.restore(); assert.equal(await operations.load('partial'), null);
  for (const published of [false, true]) {
    const link = fsp.link;
    const publication = t.mock.method(fsp, 'link', async (...args) => {
      if (String(args[1]).includes('.requests')) { if (published) await link(...args); throw Object.assign(new Error('publication fault'), { code: 'EIO' }); }
      return link(...args);
    });
    await assert.rejects(bridge.turn(`publish-${published}`, '{{attachment:member}}', opts), { code: 'EIO' });
    publication.mock.restore(); assert.equal(await operations.load(`publish-${published}`), null);
  }
  assert.equal(backend.calls.length, 0); await bridge.turn('partial', '{{attachment:member}}', opts); assert.equal(backend.calls.length, 1);
});

test('no-replace publication preserves racing conflicting bytes and rejects them before backend use', async (t) => {
  const { backend, bridge, opts } = await setup(t); const link = fsp.link; let conflict;
  t.mock.method(fsp, 'link', async (source, target) => {
    if (String(target).includes('.requests')) { conflict = String(target); await fsp.writeFile(target, Buffer.alloc(literal.length, 120)); }
    return link(source, target);
  });
  await assert.rejects(bridge.turn('race', '{{attachment:member}}', opts), { code: 'CORRUPT_REQUEST_ARTIFACT' });
  assert.deepEqual(await fsp.readFile(conflict), Buffer.alloc(literal.length, 120));
  assert.equal(await operations.load('race'), null); assert.equal(backend.calls.length, 0);
});

test('received recovery restores request bytes from the journal without source or another backend call', async (t) => {
  const { file, backend, bridge, opts } = await setup(t);
  const fault = t.mock.method(store, 'saveState', async () => { throw new Error('state write failure'); });
  await assert.rejects(bridge.turn('recover', '{{attachment:member}}', opts), { code: 'OPERATION_PERSISTENCE_FAILED' });
  fault.mock.restore();
  const op = (await operations.load('recover')).operations[0]; assert.equal(op.status, 'received');
  await fsp.unlink(file); await fsp.unlink(artifacts.fileFor('recover', op.operation_id, 'member'));
  await assert.rejects(bridge.turn('recover', '{{attachment:member}}', opts), { code: 'OPERATION_INCOMPLETE' });
  const result = await recover('finish', 'recover');
  assert.deepEqual(await artifacts.readVerified('recover', (await operations.load('recover')).operations[0], 'member'), literal);
  assert.deepEqual(await bridge.turn('recover', '{{attachment:member}}', opts), result); assert.equal(backend.calls.length, 1);
});

test('corrupt artifact bytes and independent journal descriptor/payload mutations fail closed', async (t) => {
  const { backend, bridge, opts } = await setup(t);
  const first = await bridge.turn('corrupt', '{{attachment:member}}', opts);
  const artifact = artifacts.fileFor('corrupt', first.request_artifacts[0].operation_id, 'member');
  const bad = Buffer.alloc(literal.length, 120); await fsp.writeFile(artifact, bad);
  await assert.rejects(bridge.turn('corrupt', '{{attachment:member}}', opts), { code: 'CORRUPT_REQUEST_ARTIFACT' });
  await assert.rejects(recover('finish', 'corrupt'), { code: 'CORRUPT_REQUEST_ARTIFACT' }); assert.deepEqual(await fsp.readFile(artifact), bad);
  const pristine = await operations.load('corrupt');
  await fsp.writeFile(artifact, literal.subarray(0, literal.length - 1));
  await assert.rejects(bridge.turn('corrupt', '{{attachment:member}}', opts), { code: 'CORRUPT_REQUEST_ARTIFACT' });
  for (const mutate of [
    (op) => { op.result.request_artifacts[0].operation_id = 'different'; },
    (op) => { delete op.result.request_artifacts; },
    (op) => { op.input.attachments[0].sha256 = '0'.repeat(64); },
    (op) => { op.input.attachments[0].byte_length++; },
    (op) => { op.input.attachments[0].text = 'changed'; },
  ]) {
    const journal = structuredClone(pristine); mutate(journal.operations[0]);
    await store.writeJsonAtomic(paths.operationsFile('corrupt'), journal);
    await assert.rejects(bridge.turn('corrupt', 'later'), { code: 'CORRUPT_OPERATIONS' });
    await assert.rejects(recover('finish', 'corrupt'), { code: 'CORRUPT_OPERATIONS' });
  }
  assert.equal(backend.calls.length, 1);
});

test('backend uncertainty with attachments blocks replay and offline finish without another call', async (t) => {
  const { backend, bridge, opts } = await setup(t); backend.failStart = true;
  await assert.rejects(bridge.turn('uncertain', '{{attachment:member}}', opts), { code: 'FAKE_START_FAIL' });
  const op = (await operations.load('uncertain')).operations[0]; assert.equal(op.status, 'pending');
  assert.deepEqual(await artifacts.readVerified('uncertain', op, 'member'), literal);
  await assert.rejects(bridge.turn('uncertain', '{{attachment:member}}', opts), { code: 'OPERATION_UNCERTAIN' });
  await assert.rejects(recover('finish', 'uncertain'), { code: 'OPERATION_UNCERTAIN' }); assert.equal(backend.calls.length, 1);
});

test('empty files and multiple attachments insert in message order and report all descriptors', async (t) => {
  const { env, backend, bridge, opts } = await setup(t, Buffer.alloc(0)); await fsp.writeFile(path.join(env.dir, 'second'), literal);
  const result = await bridge.turn('multiple', 'A{{attachment:second}}B{{attachment:member}}C', { ...opts, attachments: [...opts.attachments, { id: 'second', path: 'second' }] });
  assert.deepEqual(Buffer.from(backend.calls[0].prompt), Buffer.concat([Buffer.from('A'), literal, Buffer.from('BC')]));
  assert.equal(result.request_artifacts.length, 2); assert.equal(result.request_artifacts[0].byte_length, 0);
  assert.equal(result.request_artifacts[0].sha256, digest(Buffer.alloc(0)));
});
