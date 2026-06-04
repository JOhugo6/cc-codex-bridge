'use strict';
// Unit tests for lib/lock.js: release safety (token-mismatch) and heartbeat.

const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const lock = require('../lib/lock');

function freshTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'lock-test-'));
}

test('release is a no-op when the token no longer matches (stale reclaim race)', async (t) => {
  const dir = freshTmpDir();
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));

  const lockDir = path.join(dir, 'conv-token.lock');

  // Acquire and immediately capture the release function without calling it.
  const release = await lock.acquire(lockDir);

  // Simulate a stale reclaim: another process deletes the lock and re-acquires it with a
  // different token (different UUID). We do this by manually rewriting owner.json.
  const impostor = { pid: 42, host: 'other-host', acquiredAt: new Date().toISOString(), token: 'impostor-token' };
  await fsp.writeFile(path.join(lockDir, 'owner.json'), JSON.stringify(impostor), 'utf8');

  // Capture stderr to verify the warning is emitted.
  const stderrChunks = [];
  const origWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk, ...rest) => {
    stderrChunks.push(typeof chunk === 'string' ? chunk : chunk.toString());
    return origWrite(chunk, ...rest);
  };

  try {
    await release();
  } finally {
    process.stderr.write = origWrite;
  }

  // The lock dir must still exist — release must NOT have deleted the impostor's lock.
  const stillExists = await fsp.stat(lockDir).then(() => true).catch(() => false);
  assert.ok(stillExists, 'lock dir must still exist after token-mismatch release');

  // A warning must have been written to stderr.
  const warning = stderrChunks.join('');
  assert.match(warning, /token mismatch/, 'stderr must mention token mismatch');
  assert.match(warning, /release skipped/, 'stderr must say release was skipped');
});

test('release removes the lock dir when the token still matches (normal path)', async (t) => {
  const dir = freshTmpDir();
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));

  const lockDir = path.join(dir, 'conv-normal.lock');
  const release = await lock.acquire(lockDir);
  await release();

  const gone = await fsp.stat(lockDir).then(() => false).catch((e) => e.code === 'ENOENT');
  assert.ok(gone, 'lock dir must be removed after normal release');
});

test('release is idempotent (double-release does not throw)', async (t) => {
  const dir = freshTmpDir();
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));

  const lockDir = path.join(dir, 'conv-idem.lock');
  const release = await lock.acquire(lockDir);
  await release();
  await assert.doesNotReject(() => release());
});

test('heartbeat() refreshes owner.json timestamp when token matches', async (t) => {
  const dir = freshTmpDir();
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));

  const lockDir = path.join(dir, 'conv-hb.lock');
  const release = await lock.acquire(lockDir);
  t.after(() => release());

  const ownerFile = path.join(lockDir, 'owner.json');
  const before = JSON.parse(await fsp.readFile(ownerFile, 'utf8'));

  // Small delay to guarantee timestamp difference.
  await new Promise((r) => setTimeout(r, 10));
  await lock.heartbeat(lockDir, before.token);

  const after = JSON.parse(await fsp.readFile(ownerFile, 'utf8'));
  assert.ok(after.heartbeatAt, 'heartbeatAt must be set after heartbeat()');
  assert.equal(after.token, before.token, 'token must not change after heartbeat');
});

test('heartbeat() is a no-op and does not throw when token does not match', async (t) => {
  const dir = freshTmpDir();
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));

  const lockDir = path.join(dir, 'conv-hb-mismatch.lock');
  const release = await lock.acquire(lockDir);
  t.after(() => release());

  // Call heartbeat with wrong token — must not throw, must not modify the file.
  const ownerFile = path.join(lockDir, 'owner.json');
  const before = await fsp.readFile(ownerFile, 'utf8');

  await assert.doesNotReject(() => lock.heartbeat(lockDir, 'wrong-token'));

  const after = await fsp.readFile(ownerFile, 'utf8');
  assert.equal(after, before, 'owner.json must be unchanged after heartbeat with wrong token');
});

test('heartbeat() does not throw when the lock dir does not exist', async () => {
  const dir = freshTmpDir();
  const lockDir = path.join(dir, 'nonexistent.lock');
  await assert.doesNotReject(() => lock.heartbeat(lockDir, 'any-token'));
});
