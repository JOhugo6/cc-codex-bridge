'use strict';
// The deterministic core (design §4.1). NO LLM. Ties together: lock -> load state -> call backend
// (start or continue) -> append transcript -> save state -> unlock -> return {reply, thread_id, turn}.
//
// The backend is injected so this is fully unit-testable without spawning real Codex.

const lock = require('./lock');
const store = require('./store');
const paths = require('./paths');
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
  }

  // Deterministic single turn. Throws LOUDLY on any failure to create/resume a session — never
  // silently starts fresh (design §4.1 step 4, §2).
  // opts.working_dir — passed as extra.cwd to backend.startSession() on the first turn only.
  // Falls back to process.cwd() (the existing default in the backend) when not provided.
  async turn(conversationId, message, opts = {}) {
    paths.assertSafeConversationId(conversationId);
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
      const isNew = !prior || !prior.thread_id;
      const turnNumber = (prior && Number.isInteger(prior.turn) ? prior.turn : 0) + 1;

      // Record the inbound message first, so a crash mid-turn still leaves an audit trail.
      await store.appendTranscript(conversationId, {
        ts: nowIso(),
        direction: 'in',
        turn: turnNumber,
        thread_id: prior ? prior.thread_id || null : null,
        message,
        provider: this.provider,
      });

      let result;
      try {
        // Read the token written into owner.json so heartbeat can verify ownership.
        const lockMeta = await readLockMeta(lockDirPath);
        if (lockMeta && lockMeta.token) startHeartbeat(lockMeta.token);

        if (isNew) {
          // Pass working_dir as extra.cwd so Codex can read project files directly.
          const extra = opts.working_dir ? { cwd: opts.working_dir } : {};
          result = await this.backend.startSession(message, extra);
        } else {
          result = await this.backend.continueSession(prior.thread_id, message);
        }
      } catch (err) {
        // LOUD failure. We do NOT fall back to a fresh session on a resume failure.
        await store.appendTranscript(conversationId, {
          ts: nowIso(),
          direction: 'error',
          turn: turnNumber,
          thread_id: prior ? prior.thread_id || null : null,
          error: err && err.message,
          code: err && err.code,
          provider: this.provider,
        });
        const wrapped = new Error(
          (isNew
            ? `Failed to START Codex session for conversation '${conversationId}': `
            : `Failed to RESUME Codex session '${prior.thread_id}' for conversation '${conversationId}': `) +
            (err && err.message ? err.message : String(err)) +
            '. Refusing to silently start a fresh session (would be silent amnesia).'
        );
        wrapped.code = err && err.code ? err.code : 'CODEX_CALL_FAILED';
        wrapped.cause = err;
        throw wrapped;
      }

      const threadId = result.threadId;
      const reply = typeof result.content === 'string' ? result.content : String(result.content);

      // MINOR-13: wrap post-call validation so any validation error also gets an 'error' transcript
      // entry before being rethrown — same pattern as the backend-call failure path above.
      try {
        if (!threadId) {
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
          turn: turnNumber,
          thread_id: prior ? prior.thread_id || null : null,
          error: validationErr && validationErr.message,
          code: validationErr && validationErr.code,
          provider: this.provider,
        });
        throw validationErr;
      }

      const newState = {
        thread_id: threadId,
        turn: turnNumber,
        provider: this.provider,
        created_at: prior && prior.created_at ? prior.created_at : nowIso(),
        updated_at: nowIso(),
      };
      await store.saveState(conversationId, newState);

      await store.appendTranscript(conversationId, {
        ts: nowIso(),
        direction: 'out',
        turn: turnNumber,
        thread_id: threadId,
        message: reply,
        provider: this.provider,
      });

      return { reply, thread_id: threadId, turn: turnNumber };
    } finally {
      stopHeartbeat();
      await release();
    }
  }
}

module.exports = { CodexBridge };
