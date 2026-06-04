'use strict';
// The deterministic core (design §4.1). NO LLM. Ties together: lock -> load state -> call backend
// (start or continue) -> append transcript -> save state -> unlock -> return {reply, thread_id, turn}.
//
// The backend is injected so this is fully unit-testable without spawning real Codex.

const lock = require('./lock');
const store = require('./store');
const paths = require('./paths');

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
  async turn(conversationId, message) {
    paths.assertSafeConversationId(conversationId);
    if (typeof message !== 'string' || message.length === 0) {
      const e = new Error('message must be a non-empty string');
      e.code = 'INVALID_MESSAGE';
      throw e;
    }

    lock.ensureStateDirSync(paths.stateDir());
    const release = await lock.acquire(paths.lockDir(conversationId), this.lockOpts);
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
        if (isNew) {
          result = await this.backend.startSession(message);
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
      await release();
    }
  }
}

module.exports = { CodexBridge };
