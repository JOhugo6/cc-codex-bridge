'use strict';
// The deterministic core: lock -> verify state/journal -> persist intent -> call backend ->
// persist response -> commit state/transcript -> mark completed -> unlock -> return result.
//
// The backend is injected so this is fully unit-testable without spawning real Codex.

const lock = require('./lock');
const store = require('./store');
const paths = require('./paths');
const operations = require('./operations');
const workingDir = require('./working-dir');
const fsp = require('node:fs/promises');

// Read the owner metadata from a lock dir (mirrors lock.js#readLockMeta without re-exporting it).
async function readLockMeta(dir) {
  const path = require('node:path');
  try {
    const raw = await fsp.readFile(path.join(dir, 'owner.json'), 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function nowIso() {
  return new Date().toISOString();
}

class CodexBridge {
  // backend must implement: startSession(prompt) -> {threadId, content},
  //                         continueSession(threadId, prompt) -> {threadId, content}
  constructor(backend, opts = {}) {
    if (!backend || typeof backend.startSession !== 'function') {
      throw new Error('CodexBridge requires a backend with startSession/continueSession');
    }
    this.backend = backend;
    this.provider = opts.provider || 'codex';
    this.lockOpts = opts.lockOpts || {};
    // Capture once: later chdir calls cannot change the default or relative-path base.
    this.defaultWorkingDir = process.cwd();
  }

  // Deterministic single turn. Throws LOUDLY on any failure to create/resume a session — never
  // silently starts fresh (design §4.1 step 4, §2).
  // New sessions pin a validated canonical cwd. Resumes inherit it and reject changes.
  async turn(conversationId, message, opts = {}) {
    paths.assertSafeConversationId(conversationId);
    operations.assertRequestId(opts.request_id);
    workingDir.assertInput(opts.working_dir);
    if (typeof message !== 'string' || message.length === 0) {
      const e = new Error('message must be a non-empty string');
      e.code = 'INVALID_MESSAGE';
      throw e;
    }
    // MAJOR-10 (defence-in-depth): reject oversized messages before touching disk or the backend.
    // The primary limit is the Zod maxLength(100000) in index.js; this guard covers direct callers.
    const MAX_MESSAGE_LENGTH = 100000;
    if (message.length > MAX_MESSAGE_LENGTH) {
      const e = new Error(
        `message exceeds maximum length of ${MAX_MESSAGE_LENGTH} characters (got ${message.length}).`
      );
      e.code = 'MESSAGE_TOO_LARGE';
      throw e;
    }

    lock.ensureStateDirSync(paths.stateDir());
    const lockDirPath = paths.lockDir(conversationId);
    const release = await lock.acquire(lockDirPath, this.lockOpts);
    // Start a heartbeat so stale detection does not reclaim the lock during a long Codex turn.
    // Fire-and-forget: errors in the heartbeat must not propagate.
    const HEARTBEAT_INTERVAL_MS = 30000;
    let heartbeatTimer = null;
    const startHeartbeat = (token) => {
      heartbeatTimer = setInterval(() => {
        lock.heartbeat(lockDirPath, token).catch(() => {});
      }, HEARTBEAT_INTERVAL_MS);
      if (heartbeatTimer.unref) heartbeatTimer.unref(); // don't keep the event loop alive
    };
    const stopHeartbeat = () => {
      if (heartbeatTimer !== null) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
    };
    try {
      const prior = await store.loadState(conversationId); // throws on corrupt state
      let journal = await operations.load(conversationId);
      operations.assertState(journal, prior);
      if (!prior && !journal) {
        const transcript = await fsp.stat(paths.transcriptFile(conversationId)).catch((err) => {
          if (err.code === 'ENOENT') return null;
          throw err;
        });
        if (transcript?.size) {
          throw Object.assign(new Error('Transcript exists without state or operations journal. Preserve it and recover the original thread before continuing.'), { code: 'OPERATION_UNCERTAIN' });
        }
      }
      const recorded = opts.request_id === undefined ? null : journal?.operations.find((op) => op.request_id === opts.request_id);
      if (recorded) {
        // Old journals retain their exact raw-input replay contract. New requests compare
        // effective paths, so omission and equivalent spellings identify the same request.
        const replayInput = recorded.input.working_dir_policy === 'pinned'
          ? { message, provider: this.provider, working_dir_policy: 'pinned', working_dir: opts.working_dir === undefined
            ? recorded.input.working_dir : await workingDir.normalize(opts.working_dir, this.defaultWorkingDir) }
          : { message, provider: this.provider, working_dir: opts.working_dir ?? null };
        const replay = await operations.findReplay(journal, opts.request_id, replayInput);
        if (replay) return replay;
      }
      operations.assertComplete(journal, conversationId);
      const cwd = await workingDir.forTurn(prior, opts.working_dir, this.defaultWorkingDir);
      const input = { message, working_dir: cwd, working_dir_policy: 'pinned', provider: this.provider };
      const isNew = !prior || !prior.thread_id;
      const turnNumber = (prior && Number.isInteger(prior.turn) ? prior.turn : 0) + 1;

      journal = await operations.begin(conversationId, journal, prior, input, opts.request_id);
      const operation = journal.operations.at(-1);
      await store.ensureTranscriptEntry(conversationId, operations.transcriptEntry(operation, 'in'));

      let result;
      try {
        // Read the token written into owner.json so heartbeat can verify ownership.
        const lockMeta = await readLockMeta(lockDirPath);
        if (lockMeta && lockMeta.token) startHeartbeat(lockMeta.token);

        if (isNew) {
          result = await this.backend.startSession(message, { cwd });
        } else {
          result = await this.backend.continueSession(prior.thread_id, message);
        }
      } catch (err) {
        // LOUD failure. We do NOT fall back to a fresh session on a resume failure.
        await store.appendTranscript(conversationId, {
          ts: nowIso(),
          direction: 'error',
          operation_id: operation.operation_id,
          request_id: operation.request_id,
          turn: turnNumber,
          thread_id: prior ? prior.thread_id || null : null,
          error: err && err.message,
          code: err && err.code,
          provider: this.provider,
        }).catch(() => {}); // The durable pending operation still blocks unsafe retries.
        const wrapped = new Error(
          (isNew
            ? `Failed to START Codex session for conversation '${conversationId}': `
            : `Failed to RESUME Codex session '${prior.thread_id}' for conversation '${conversationId}': `) +
            (err && err.message ? err.message : String(err)) +
            '. Refusing to silently start a fresh session (would be silent amnesia). ' +
            'Operation remains uncertain; inspect it with recover-operation.js before continuing.'
        );
        wrapped.code = err && err.code ? err.code : 'CODEX_CALL_FAILED';
        wrapped.cause = err;
        throw wrapped;
      }

      const threadId = result && result.threadId;
      const reply = typeof result?.content === 'string' ? result.content : String(result?.content);

      // MINOR-13: wrap post-call validation so any validation error also gets an 'error' transcript
      // entry before being rethrown — same pattern as the backend-call failure path above.
      try {
        if (typeof threadId !== 'string' || !threadId) {
          const e = new Error('Codex did not return a thread_id; cannot guarantee session continuity.');
          e.code = 'NO_THREAD_ID';
          throw e;
        }
        // If we were resuming, the thread_id must not silently change underneath us.
        if (!isNew && prior.thread_id && threadId !== prior.thread_id) {
          const e = new Error(
            `Codex thread_id changed mid-conversation for '${conversationId}' ` +
              `(${prior.thread_id} -> ${threadId}). Treating as lost session.`
          );
          e.code = 'THREAD_ID_DRIFT';
          throw e;
        }
      } catch (validationErr) {
        await store.appendTranscript(conversationId, {
          ts: nowIso(),
          direction: 'error',
          operation_id: operation.operation_id,
          request_id: operation.request_id,
          turn: turnNumber,
          thread_id: prior ? prior.thread_id || null : null,
          error: validationErr && validationErr.message,
          code: validationErr && validationErr.code,
          provider: this.provider,
        }).catch(() => {});
        throw validationErr;
      }

      try {
        await operations.receive(conversationId, journal, { reply, thread_id: threadId, turn: turnNumber });
        return await operations.finish(conversationId, journal, prior);
      } catch (cause) {
        const err = new Error(`Codex answered but local persistence failed for '${conversationId}': ${cause.message}. ` +
          'Do not repeat the backend call. Run recover-operation.js inspect and finish to recover a recorded response.');
        err.code = 'OPERATION_PERSISTENCE_FAILED';
        err.cause = cause;
        throw err;
      }
    } finally {
      stopHeartbeat();
      await release();
    }
  }
}

module.exports = { CodexBridge };
