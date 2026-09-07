'use strict';
// Shared test helpers: isolated temp state dir + a controllable fake Codex backend.

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');

// Create a fresh temp state dir and point the bridge at it via env. Returns { dir, cleanup }.
function freshStateDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-bridge-test-'));
  process.env.CODEX_BRIDGE_STATE_DIR = dir;
  return {
    dir,
    async cleanup() {
      delete process.env.CODEX_BRIDGE_STATE_DIR;
      await fsp.rm(dir, { recursive: true, force: true });
    },
  };
}

// A deterministic fake of the Codex backend seam. Records calls; lets a test force failures.
class FakeBackend {
  constructor(opts = {}) {
    this.calls = [];
    this.threadCounter = 0;
    this.failStart = opts.failStart || false;
    this.failResume = opts.failResume || false;
    this.startDelayMs = opts.startDelayMs || 0;
    this.driftThreadId = opts.driftThreadId || null; // force a thread_id change on resume
    this.replies = opts.replies || null; // optional array of canned replies in order
    this._replyIdx = 0;
  }

  _nextReply(fallback) {
    if (this.replies && this._replyIdx < this.replies.length) {
      return this.replies[this._replyIdx++];
    }
    return fallback;
  }

  async startSession(prompt, extra = {}) {
    this.calls.push({ kind: 'start', prompt, extra });
    if (this.startDelayMs) await new Promise((r) => setTimeout(r, this.startDelayMs));
    if (this.failStart) {
      const e = new Error('fake: cannot create session');
      e.code = 'FAKE_START_FAIL';
      throw e;
    }
    this.threadCounter += 1;
    const threadId = `fake-thread-${this.threadCounter}`;
    return { threadId, content: this._nextReply(`started: ${prompt}`) };
  }

  async continueSession(threadId, prompt, extra = {}) {
    this.calls.push({ kind: 'reply', threadId, prompt, extra });
    if (this.failResume) {
      const e = new Error('fake: lost session / cannot resume');
      e.code = 'FAKE_RESUME_FAIL';
      throw e;
    }
    const returnedThread = this.driftThreadId || threadId;
    return { threadId: returnedThread, content: this._nextReply(`continued(${threadId}): ${prompt}`) };
  }

  async close() {}
}

module.exports = { freshStateDir, FakeBackend };
