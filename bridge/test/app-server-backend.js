'use strict';
// Test injection for the REAL public MCP server and REAL native backend transport.
const path = require('node:path');
const { CodexBackend } = require('../lib/codex-backend');
exports.createBackend = () => new CodexBackend({ command: process.execPath,
  args: [path.join(__dirname, 'app-server-stub.js'), process.env.CODEX_BRIDGE_STUB_DIR],
  cwd: process.env.CODEX_BRIDGE_STUB_DIR, readinessTimeoutMs: 2000, callTimeoutMs: 5000 });
