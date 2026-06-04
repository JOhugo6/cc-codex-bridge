'use strict';
// Injectable stub backend for the over-stdio MCP server test. Behavior is controlled via env so
// the parent test can spawn `node index.js` with a deterministic, Codex-free backend.
//
// CODEX_BRIDGE_STUB_MODE:
//   'ok'         (default) -> normal start/resume
//   'fail-start'           -> startSession throws (forces a loud MCP error)

const { FakeBackend } = require('./helpers');

function createBackend() {
  const mode = process.env.CODEX_BRIDGE_STUB_MODE || 'ok';
  return new FakeBackend({ failStart: mode === 'fail-start' });
}

module.exports = { createBackend };
