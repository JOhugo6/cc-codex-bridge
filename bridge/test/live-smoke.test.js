'use strict';
// OPTIONAL live smoke test: a real 2-turn Codex exchange via the actual `codex mcp-server` backing.
// SKIPPED unless CODEX_BRIDGE_LIVE=1 (so the default `npm test` never depends on Codex auth/network).
//
//   Run with:  CODEX_BRIDGE_LIVE=1 node --test test/live-smoke.test.js
//   (PowerShell) $env:CODEX_BRIDGE_LIVE=1; node --test test/live-smoke.test.js
//
// Validates the design's acceptance core: turn 2 must REMEMBER something stated in turn 1, on the
// SAME persisted thread_id (multi-turn memory coherence — design §7).

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');

const LIVE = process.env.CODEX_BRIDGE_LIVE === '1';

test(
  'live: real 2-turn Codex exchange remembers context on a stable thread_id',
  { skip: LIVE ? false : 'set CODEX_BRIDGE_LIVE=1 to run (requires authenticated Codex)' },
  async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-bridge-live-'));
    process.env.CODEX_BRIDGE_STATE_DIR = dir;
    t.after(async () => {
      delete process.env.CODEX_BRIDGE_STATE_DIR;
      await fsp.rm(dir, { recursive: true, force: true });
    });

    const { CodexBackend } = require('../lib/codex-backend');
    const { CodexBridge } = require('../lib/bridge');
    const backend = new CodexBackend();
    const bridge = new CodexBridge(backend);
    t.after(() => backend.close());

    const conv = 'live-smoke';
    const magic = 'PURPLE-' + Math.random().toString(36).slice(2, 8).toUpperCase();

    const r1 = await bridge.turn(
      conv,
      `Remember this exact token: ${magic}. Reply only with the word OK.`
    );
    assert.ok(r1.thread_id, 'turn 1 returns a thread_id');
    assert.equal(r1.turn, 1);

    const r2 = await bridge.turn(
      conv,
      'What exact token did I ask you to remember? Reply with just the token.'
    );
    assert.equal(r2.turn, 2);
    assert.equal(r2.thread_id, r1.thread_id, 'thread_id stable across the two turns');
    assert.match(
      r2.reply,
      new RegExp(magic),
      `Codex must recall the token from turn 1. Got: ${r2.reply}`
    );
  }
);
