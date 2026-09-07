'use strict';
// Central place for on-disk layout (design §4.2). State lives OUTSIDE the LLM context,
// keyed by conversation_id, under the global user .claude state dir.
//
// Layout (per design §4.2):
//   <stateDir>/
//     v2@<sha256(exact conversation_id)>.json              state including original conversation_id
//     v2@<sha256(exact conversation_id)>.transcript.jsonl  transcript
//     v2@<sha256(exact conversation_id)>.operations.json   durable requests and responses
//     v2@<sha256(exact conversation_id)>.replies/<sha256(operation_id)>.utf8  immutable replies
//     v2@<sha256(exact conversation_id)>.lock              advisory file lock (mkdir-based)
// '@' cannot occur in a legacy id, keeping the two namespaces disjoint.
//
// The state dir is overridable via CODEX_BRIDGE_STATE_DIR so tests get an isolated temp dir
// and never collide with the real runtime state.

const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

function defaultStateDir() {
  // Honor a USERPROFILE / HOME so this resolves the same way the design's absolute paths do.
  const home = process.env.USERPROFILE || os.homedir();
  return path.join(home, '.claude', 'state', 'codex-bridge');
}

function stateDir() {
  return process.env.CODEX_BRIDGE_STATE_DIR || defaultStateDir();
}

// Preserve the existing public ID contract. Legacy migration still reads old filenames.
const SAFE_ID = /^[A-Za-z0-9._-]{1,200}$/;

// Windows reserved device names that are illegal as filenames (even with extensions) on Windows.
// See: https://learn.microsoft.com/en-us/windows/win32/fileio/naming-a-file
const WINDOWS_RESERVED = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i;

function assertSafeConversationId(id) {
  if (typeof id !== 'string' || !SAFE_ID.test(id)) {
    const err = new Error(
      `Invalid conversation_id. Must match ${SAFE_ID} (1-200 chars: letters, digits, '.', '_', '-').`
    );
    err.code = 'INVALID_CONVERSATION_ID';
    throw err;
  }
  // Since path separators are already rejected above, the full id IS the basename.
  // Reject Windows reserved device names: they fail as filenames on Windows even with extensions.
  if (WINDOWS_RESERVED.test(id)) {
    const err = new Error(
      `Invalid conversation_id '${id}': Windows reserved device names (CON, PRN, AUX, NUL, COM1-COM9, LPT1-LPT9) are not allowed as filenames.`
    );
    err.code = 'INVALID_CONVERSATION_ID';
    throw err;
  }
}

function identityKey(id) {
  assertSafeConversationId(id);
  return `v2@${crypto.createHash('sha256').update(id, 'utf8').digest('hex')}`;
}

function stateFile(id) {
  return path.join(stateDir(), `${identityKey(id)}.json`);
}

function transcriptFile(id) {
  return path.join(stateDir(), `${identityKey(id)}.transcript.jsonl`);
}

function operationsFile(id) {
  return path.join(stateDir(), `${identityKey(id)}.operations.json`);
}

function lockDir(id) {
  // mkdir-based lock => the lock is a directory, atomic across processes on Windows + POSIX.
  return path.join(stateDir(), `${identityKey(id)}.lock`);
}

module.exports = {
  defaultStateDir,
  stateDir,
  assertSafeConversationId,
  identityKey,
  stateFile,
  transcriptFile,
  operationsFile,
  lockDir,
  SAFE_ID,
};
