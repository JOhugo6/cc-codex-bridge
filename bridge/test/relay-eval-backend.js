'use strict';
// Deterministic backend for the relay acceptance harness; never used by default.
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
function createBackend() {
  const fixture = JSON.parse(fs.readFileSync(process.env.CODEX_BRIDGE_EVAL_FIXTURE, 'utf8'));
  const saved = path.join(process.env.CODEX_BRIDGE_STATE_DIR, 'eval-backend.json');
  function reply(threadId, prompt) {
    if (fixture.error) throw Object.assign(new Error(fixture.error.message), { code: fixture.error.code });
    return { threadId, content: fixture.recall ? JSON.parse(fs.readFileSync(saved, 'utf8')).token : fixture.reply };
  }
  return {
    async startSession(prompt) {
      const threadId = 'eval-' + randomUUID();
      fs.mkdirSync(path.dirname(saved), { recursive: true });
      fs.writeFileSync(saved, JSON.stringify({ threadId, token: fixture.token }));
      return reply(threadId, prompt);
    },
    async continueSession(threadId, prompt) {
      if (JSON.parse(fs.readFileSync(saved, 'utf8')).threadId !== threadId) throw new Error('Unknown fixture thread');
      return reply(threadId, prompt);
    },
    async close() {},
  };
}
module.exports = { createBackend };
