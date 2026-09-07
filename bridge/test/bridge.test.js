'use strict';
// Deterministic core tests (no Codex, no MCP transport): state persistence, resume continuity,
// concurrency safety, and the LOUD lost-session path.

const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const path = require('node:path');

const { freshStateDir, FakeBackend } = require('./helpers');
const { CodexBridge } = require('../lib/bridge');
const paths = require('../lib/paths');

test('first call starts a session and persists thread_id + turn 1', async (t) => {
  const env = freshStateDir();
  t.after(() => env.cleanup());

  const backend = new FakeBackend();
  const bridge = new CodexBridge(backend);

  const r = await bridge.turn('conv-A', 'hello');
  assert.equal(r.turn, 1);
  assert.equal(r.thread_id, 'fake-thread-1');
  assert.match(r.reply, /^started: hello$/);
  assert.equal(backend.calls.length, 1);
  assert.equal(backend.calls[0].kind, 'start');

  const state = JSON.parse(await fsp.readFile(paths.stateFile('conv-A'), 'utf8'));
  assert.equal(state.thread_id, 'fake-thread-1');
  assert.equal(state.turn, 1);
  assert.equal(state.provider, 'codex');
  assert.ok(state.created_at && state.updated_at);
});

test('second call with same conversation_id RESUMES (thread_id stable, no new session)', async (t) => {
  const env = freshStateDir();
  t.after(() => env.cleanup());

  const backend = new FakeBackend();
  const bridge = new CodexBridge(backend);

  const r1 = await bridge.turn('conv-B', 'first');
  const r2 = await bridge.turn('conv-B', 'second');

  assert.equal(r1.thread_id, r2.thread_id, 'thread_id must be stable across turns');
  assert.equal(r2.turn, 2);
  assert.equal(backend.calls[0].kind, 'start');
  assert.equal(backend.calls[1].kind, 'reply');
  assert.equal(backend.calls[1].threadId, r1.thread_id);
  // Crucially: only ONE start, ever.
  assert.equal(backend.calls.filter((c) => c.kind === 'start').length, 1);
});

test('distinct conversation_ids do not bleed threads', async (t) => {
  const env = freshStateDir();
  t.after(() => env.cleanup());

  const backend = new FakeBackend();
  const bridge = new CodexBridge(backend);

  const a = await bridge.turn('team-X', 'hi');
  const b = await bridge.turn('team-Y', 'hi');
  assert.notEqual(a.thread_id, b.thread_id);
});

test('LOUD error when session cannot be created (no silent success)', async (t) => {
  const env = freshStateDir();
  t.after(() => env.cleanup());

  const backend = new FakeBackend({ failStart: true });
  const bridge = new CodexBridge(backend);

  await assert.rejects(
    () => bridge.turn('conv-fail', 'hello'),
    (err) => {
      assert.match(err.message, /Failed to START Codex session/);
      assert.match(err.message, /Refusing to silently start a fresh session/);
      return true;
    }
  );
  // No state file should claim a healthy session.
  await assert.rejects(() => fsp.readFile(paths.stateFile('conv-fail'), 'utf8'), /ENOENT/);
});

test('LOUD error on lost session (resume fails) — NEVER silent fresh session', async (t) => {
  const env = freshStateDir();
  t.after(() => env.cleanup());

  const backend = new FakeBackend();
  const bridge = new CodexBridge(backend);

  // Establish a session.
  const r1 = await bridge.turn('conv-lost', 'first');
  assert.equal(backend.calls.filter((c) => c.kind === 'start').length, 1);

  // Now make resume fail.
  backend.failResume = true;
  await assert.rejects(
    () => bridge.turn('conv-lost', 'second'),
    (err) => {
      assert.equal(err.code, 'FAKE_RESUME_FAIL');
      assert.match(err.message, /Failed to RESUME Codex session 'fake-thread-1'/);
      assert.match(err.message, /silent amnesia/);
      return true;
    }
  );
  // The forbidden failure check: it must NOT have started a brand-new session as a fallback.
  assert.equal(
    backend.calls.filter((c) => c.kind === 'start').length,
    1,
    'must not start a fresh session on resume failure'
  );
  // Persisted thread_id must be unchanged.
  const state = JSON.parse(await fsp.readFile(paths.stateFile('conv-lost'), 'utf8'));
  assert.equal(state.thread_id, r1.thread_id);
});

test('thread_id drift on resume is treated as a lost session (loud error)', async (t) => {
  const env = freshStateDir();
  t.after(() => env.cleanup());

  const backend = new FakeBackend({ driftThreadId: 'some-other-thread' });
  const bridge = new CodexBridge(backend);

  await bridge.turn('conv-drift', 'first');
  await assert.rejects(
    () => bridge.turn('conv-drift', 'second'),
    (err) => {
      assert.equal(err.code, 'THREAD_ID_DRIFT');
      return true;
    }
  );
});

test('corrupt state file is a loud error, not a silent fresh start', async (t) => {
  const env = freshStateDir();
  t.after(() => env.cleanup());

  await fsp.writeFile(paths.stateFile('conv-corrupt'), '{ this is not json', 'utf8');
  const backend = new FakeBackend();
  const bridge = new CodexBridge(backend);

  await assert.rejects(
    () => bridge.turn('conv-corrupt', 'hello'),
    (err) => {
      assert.equal(err.code, 'CORRUPT_STATE');
      return true;
    }
  );
  // Backend must never have been called for a corrupt-state conversation.
  assert.equal(backend.calls.length, 0);
});

test('concurrent calls on same conversation_id serialize without corrupting state', async (t) => {
  const env = freshStateDir();
  t.after(() => env.cleanup());

  // Add a delay on start so the race window is real.
  const backend = new FakeBackend({ startDelayMs: 60 });
  const bridge = new CodexBridge(backend, { lockOpts: { timeoutMs: 30000, pollMs: 10 } });

  // Fire 5 turns at once on the same conversation_id.
  const results = await Promise.allSettled(
    Array.from({ length: 5 }, (_, i) => bridge.turn('conv-race', `msg-${i}`))
  );
  const ok = results.filter((r) => r.status === 'fulfilled').map((r) => r.value);
  assert.equal(ok.length, 5, 'all turns should succeed (serialized by lock)');

  // Exactly ONE start despite the race (the lock prevents two "first turns").
  assert.equal(
    backend.calls.filter((c) => c.kind === 'start').length,
    1,
    'lock must prevent multiple sessions for one conversation_id'
  );

  // Turn numbers must be the contiguous set 1..5 with no dupes (no lost updates).
  const turns = ok.map((r) => r.turn).sort((a, b) => a - b);
  assert.deepEqual(turns, [1, 2, 3, 4, 5]);

  // Final persisted turn is 5; all replies share the one thread_id.
  const state = JSON.parse(await fsp.readFile(paths.stateFile('conv-race'), 'utf8'));
  assert.equal(state.turn, 5);
  assert.ok(ok.every((r) => r.thread_id === ok[0].thread_id));
});

test('transcript.jsonl records in/out pairs per turn', async (t) => {
  const env = freshStateDir();
  t.after(() => env.cleanup());

  const backend = new FakeBackend();
  const bridge = new CodexBridge(backend);
  await bridge.turn('conv-tx', 'one');
  await bridge.turn('conv-tx', 'two');

  const raw = await fsp.readFile(paths.transcriptFile('conv-tx'), 'utf8');
  const lines = raw.trim().split('\n').map((l) => JSON.parse(l));
  // 2 turns => 2 in + 2 out = 4 lines.
  assert.equal(lines.length, 4);
  assert.deepEqual(lines.map((l) => l.direction), ['in', 'out', 'in', 'out']);
  assert.equal(lines[0].message, 'one');
  assert.equal(lines[3].turn, 2);
  // Out lines must carry the thread_id.
  assert.ok(lines[1].thread_id && lines[3].thread_id);
});

test('cross-process lock: a stale lock dir from a dead pid is reclaimed', async (t) => {
  const env = freshStateDir();
  t.after(() => env.cleanup());

  const lock = require('../lib/lock');
  lock.ensureStateDirSync(paths.stateDir());
  const lp = paths.lockDir('conv-stale');
  // Simulate a crashed holder: create the lock dir with a dead pid + old owner stamp.
  await fsp.mkdir(lp);
  await fsp.writeFile(
    path.join(lp, 'owner.json'),
    JSON.stringify({ pid: 999999999, host: 'localhost', acquiredAt: new Date(0).toISOString() }),
    'utf8'
  );
  // Backdate mtime well past staleMs.
  const old = new Date(Date.now() - 10 * 60 * 1000);
  await fsp.utimes(lp, old, old);

  const backend = new FakeBackend();
  const bridge = new CodexBridge(backend, { lockOpts: { staleMs: 1000, timeoutMs: 10000 } });
  const r = await bridge.turn('conv-stale', 'after reclaim');
  assert.equal(r.turn, 1);
});

test('invalid conversation_id is rejected before any backend call', async (t) => {
  const env = freshStateDir();
  t.after(() => env.cleanup());
  const backend = new FakeBackend();
  const bridge = new CodexBridge(backend);
  await assert.rejects(() => bridge.turn('../escape', 'x'), (e) => e.code === 'INVALID_CONVERSATION_ID');
  await assert.rejects(() => bridge.turn('a/b', 'x'), (e) => e.code === 'INVALID_CONVERSATION_ID');
  assert.equal(backend.calls.length, 0);
});

// MAJOR-9: state with correct JSON structure but wrong field types must be CORRUPT_STATE
test('state with thread_id as number is CORRUPT_STATE (not silently treated as new)', async (t) => {
  const env = freshStateDir();
  t.after(() => env.cleanup());

  // Write a structurally valid JSON object, but with wrong types.
  await fsp.writeFile(
    paths.stateFile('conv-wrong-types'),
    JSON.stringify({ thread_id: 12345, turn: 'one', provider: 'codex' }),
    'utf8'
  );

  const backend = new FakeBackend();
  const bridge = new CodexBridge(backend);

  await assert.rejects(
    () => bridge.turn('conv-wrong-types', 'hello'),
    (err) => {
      assert.equal(err.code, 'CORRUPT_STATE', `expected CORRUPT_STATE, got ${err.code}: ${err.message}`);
      return true;
    }
  );
  // Backend must never be called when state is corrupt.
  assert.equal(backend.calls.length, 0);
});

test('state with turn as string is CORRUPT_STATE', async (t) => {
  const env = freshStateDir();
  t.after(() => env.cleanup());

  await fsp.writeFile(
    paths.stateFile('conv-turn-string'),
    JSON.stringify({ thread_id: 'tid-abc', turn: 'one', provider: 'codex' }),
    'utf8'
  );

  const backend = new FakeBackend();
  const bridge = new CodexBridge(backend);

  await assert.rejects(
    () => bridge.turn('conv-turn-string', 'hello'),
    (err) => {
      assert.equal(err.code, 'CORRUPT_STATE');
      return true;
    }
  );
  assert.equal(backend.calls.length, 0);
});

test('state with turn = 0 (non-positive) is CORRUPT_STATE', async (t) => {
  const env = freshStateDir();
  t.after(() => env.cleanup());

  await fsp.writeFile(
    paths.stateFile('conv-turn-zero'),
    JSON.stringify({ thread_id: 'tid-abc', turn: 0, provider: 'codex' }),
    'utf8'
  );

  const backend = new FakeBackend();
  const bridge = new CodexBridge(backend);

  await assert.rejects(
    () => bridge.turn('conv-turn-zero', 'hello'),
    (err) => {
      assert.equal(err.code, 'CORRUPT_STATE');
      return true;
    }
  );
  assert.equal(backend.calls.length, 0);
});

// MINOR-14: Windows reserved basenames must be rejected
test('Windows reserved names are rejected as conversation_id', async (t) => {
  const env = freshStateDir();
  t.after(() => env.cleanup());

  const backend = new FakeBackend();
  const bridge = new CodexBridge(backend);

  const reserved = ['CON', 'NUL', 'PRN', 'AUX', 'COM1', 'COM9', 'LPT1', 'LPT9'];
  for (const name of reserved) {
    await assert.rejects(
      () => bridge.turn(name, 'x'),
      (err) => {
        assert.equal(
          err.code,
          'INVALID_CONVERSATION_ID',
          `expected INVALID_CONVERSATION_ID for '${name}', got ${err.code}`
        );
        return true;
      }
    );
    // Case-insensitive check
    await assert.rejects(
      () => bridge.turn(name.toLowerCase(), 'x'),
      (err) => err.code === 'INVALID_CONVERSATION_ID'
    );
  }
  // Backend must never be called for any reserved name.
  assert.equal(backend.calls.length, 0);
});

// ---------------------------------------------------------------------------
// working_dir parameter (new feature)
// ---------------------------------------------------------------------------
test('working_dir is passed as extra.cwd to backend.startSession on first turn', async (t) => {
  const env = freshStateDir();
  t.after(() => env.cleanup());

  const backend = new FakeBackend();
  const bridge = new CodexBridge(backend);

  await bridge.turn('conv-wdir', 'hello', { working_dir: env.dir });

  assert.equal(backend.calls.length, 1);
  assert.equal(backend.calls[0].kind, 'start');
  assert.deepEqual(backend.calls[0].extra, { cwd: await fsp.realpath(env.dir) });
});

test('pinned working_dir is forwarded for backend verification on subsequent turns', async (t) => {
  const env = freshStateDir();
  t.after(() => env.cleanup());

  const backend = new FakeBackend();
  const bridge = new CodexBridge(backend);

  await bridge.turn('conv-wdir2', 'first', { working_dir: env.dir });
  // Continuation must verify the existing Codex cwd against the pinned bridge directory.
  await bridge.turn('conv-wdir2', 'second', { working_dir: env.dir });

  assert.equal(backend.calls[1].kind, 'reply');
  assert.deepEqual(backend.calls[1].extra, { cwd: await fsp.realpath(env.dir) });
});

test('turn without working_dir explicitly passes the canonical launch cwd', async (t) => {
  const env = freshStateDir();
  t.after(() => env.cleanup());

  const backend = new FakeBackend();
  const bridge = new CodexBridge(backend);

  await bridge.turn('conv-no-wdir', 'hello');

  assert.equal(backend.calls[0].kind, 'start');
  assert.deepEqual(backend.calls[0].extra, { cwd: await fsp.realpath(process.cwd()) });
});

// ---------------------------------------------------------------------------
// MAJOR-10: message size limit
// ---------------------------------------------------------------------------
test('MAJOR-10: oversized message is rejected before backend call (MESSAGE_TOO_LARGE)', async (t) => {
  const env = freshStateDir();
  t.after(() => env.cleanup());

  const backend = new FakeBackend();
  const bridge = new CodexBridge(backend);

  const bigMessage = 'x'.repeat(100001);
  await assert.rejects(
    () => bridge.turn('conv-big', bigMessage),
    (err) => {
      assert.equal(err.code, 'MESSAGE_TOO_LARGE');
      return true;
    }
  );
  assert.equal(backend.calls.length, 0, 'backend must not be called for oversized message');
});

test('MAJOR-10: message exactly at the limit (100000 chars) is accepted', async (t) => {
  const env = freshStateDir();
  t.after(() => env.cleanup());

  const backend = new FakeBackend();
  const bridge = new CodexBridge(backend);

  const maxMessage = 'x'.repeat(100000);
  const r = await bridge.turn('conv-maxlen', maxMessage);
  assert.equal(r.turn, 1, 'message at exactly max length must succeed');
});
