'use strict';
// Test injection for the REAL public MCP server and REAL native backend transport.
const path = require('node:path');
const fs = require('node:fs');
const { CodexBackend } = require('../lib/codex-backend');
exports.createBackend = () => {
  const backend = new CodexBackend({ command: process.execPath,
    args: [path.join(__dirname, 'app-server-stub.js'), process.env.CODEX_BRIDGE_STUB_DIR],
    cwd: process.env.CODEX_BRIDGE_STUB_DIR, readinessTimeoutMs: 2000, callTimeoutMs: 5000 });
  const turn = backend._turn.bind(backend);
  backend._turn = (conn, ...args) => {
    const pending = turn(conn, ...args);
    const notification = conn.onnotification;
    conn.onnotification = (message) => {
      notification(message);
      // Causal readiness for cross-process cancellation tests: the bridge has
      // accepted a turn identity, rather than the stub merely reading turn/start.
      if (message.method === 'turn/started' && conn.activeTurn?.startedTurnId) {
        fs.writeFileSync(path.join(process.env.CODEX_BRIDGE_STUB_DIR, 'turn-ready'), conn.activeTurn.startedTurnId);
      }
    };
    return pending;
  };
  return backend;
};
