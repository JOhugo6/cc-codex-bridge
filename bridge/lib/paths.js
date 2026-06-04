'use strict';
// Central place for on-disk layout (design §4.2). State lives OUTSIDE the LLM context,
// keyed by conversation_id, under the global user .claude state dir.
//
// Layout (per design §4.2):
//   <stateDir>/
//     <conversation_id>.json              { thread_id, turn, created_at, updated_at, provider }
//     <conversation_id>.transcript.jsonl  1 line per direction: {ts, direction, message, thread_id, turn}
//     <conversation_id>.lock              advisory file lock (mkdir-based)
//
// The state dir is overridable via CODEX_BRIDGE_STATE_DIR so tests get an isolated temp dir
// and never collide with the real runtime state.

const os = require('node:os');
const path = require('node:path');

function defaultStateDir() {
  // Honor a USERPROFILE / HOME so this resolves the same way the design's absolute paths do.
  const home = process.env.USERPROFILE || os.homedir();
  return path.join(home, '.claude', 'state', 'codex-bridge');
}

function stateDir() {
  return process.env.CODEX_BRIDGE_STATE_DIR || defaultStateDir();
}

// conversation_id is attacker-adjacent (comes from a relay agent / orchestrator) and is used
// directly in filenames. Reject anything that could escape the state dir or break the filesystem.
const SAFE_ID = /^[A-Za-z0-9._-]{1,200}$/;

function assertSafeConversationId(id) {
  if (typeof id !== 'string' || !SAFE_ID.test(id)) {
    const err = new Error(
      `Invalid conversation_id. Must match ${SAFE_ID} (1-200 chars: letters, digits, '.', '_', '-').`
    );
    err.code = 'INVALID_CONVERSATION_ID';
    throw err;
  }
}

function stateFile(id) {
  assertSafeConversationId(id);
  return path.join(stateDir(), `${id}.json`);
}

function transcriptFile(id) {
  assertSafeConversationId(id);
  return path.join(stateDir(), `${id}.transcript.jsonl`);
}

function lockDir(id) {
  assertSafeConversationId(id);
  // mkdir-based lock => the lock is a directory, atomic across processes on Windows + POSIX.
  return path.join(stateDir(), `${id}.lock`);
}

module.exports = {
  defaultStateDir,
  stateDir,
  assertSafeConversationId,
  stateFile,
  transcriptFile,
  lockDir,
  SAFE_ID,
};
