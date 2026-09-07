'use strict';
// Injectable stub backend for the over-stdio MCP server test. Behavior is controlled via env so
// the parent test can spawn `node index.js` with a deterministic, Codex-free backend.
//
// CODEX_BRIDGE_STUB_MODE:
//   'ok'         (default) -> normal start/resume
//   'fail-start'           -> startSession throws (forces a loud MCP error)
//   'fail-multiline'       -> multiline backend error for relay error serialization

const { FakeBackend } = require('./helpers');

function createBackend() {
  const mode = process.env.CODEX_BRIDGE_STUB_MODE || 'ok';
  if (mode === 'fail-multiline') return {
    async startSession() {
      throw Object.assign(new Error('first\r\nsecond\nquoted "line"\u2028last'), { code: 'MULTILINE_BACKEND_ERROR' });
    },
    async close() {},
  };
  return new FakeBackend({ failStart: mode === 'fail-start' });
}

module.exports = { createBackend };
