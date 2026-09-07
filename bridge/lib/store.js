'use strict';
// On-disk state store (design §4.2). Pure I/O, no LLM, no Codex knowledge.
// Caller MUST hold the per-conversation lock around load -> ...codex call... -> save.

const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const paths = require('./paths');

// Load state for a conversation_id. Returns null if no state exists yet (=> first turn).
// Throws on a CORRUPT state file rather than silently treating it as "new" — silent amnesia is
// the #1 forbidden failure (design §2, §4.1 step 4).
async function loadState(conversationId) {
  await require('./migration').assertLegacyResolved(conversationId);
  return readStateFile(paths.stateFile(conversationId), conversationId);
}

async function readStateFile(file, conversationId, { legacy = false } = {}) {
  let raw;
  try {
    raw = await fsp.readFile(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
  try {
    const st = JSON.parse(raw);
    if (!st || typeof st !== 'object') throw new Error('state is not an object');
    // Validate required fields have correct types. A valid-JSON-but-wrong-type state would
    // propagate silently and cause subtle corruption (e.g. numeric thread_id, string turn).
    if (typeof st.thread_id !== 'string' || st.thread_id.length === 0) {
      throw new Error(`thread_id must be a non-empty string, got ${JSON.stringify(st.thread_id)}`);
    }
    if (!Number.isInteger(st.turn) || st.turn < 1) {
      throw new Error(`turn must be a positive integer (>=1), got ${JSON.stringify(st.turn)}`);
    }
    if ((!legacy || st.conversation_id !== undefined) && st.conversation_id !== conversationId) {
      const err = new Error(`Stored conversation_id ${JSON.stringify(st.conversation_id)} does not match ${JSON.stringify(conversationId)} at ${file}.`);
      err.code = 'STATE_IDENTITY_MISMATCH';
      throw err;
    }
    return st;
  } catch (err) {
    if (err.code === 'STATE_IDENTITY_MISMATCH') throw err;
    const e = new Error(
      `Corrupt state file for conversation '${conversationId}' at ${file}: ${err.message}. ` +
        `Refusing to start a fresh session silently (would lose the existing Codex thread).`
    );
    e.code = 'CORRUPT_STATE';
    throw e;
  }
}

// Atomically persist state (write temp + rename) so a crash mid-write can't corrupt it.
async function saveState(conversationId, state) {
  if (state.conversation_id !== undefined && state.conversation_id !== conversationId) {
    const err = new Error('Refusing to save state with a different conversation_id.');
    err.code = 'STATE_IDENTITY_MISMATCH';
    throw err;
  }
  const file = paths.stateFile(conversationId);
  await writeJsonAtomic(file, { ...state, conversation_id: conversationId });
}

async function writeJsonAtomic(file, state) {
  const tmp = `${file}.tmp.${process.pid}.${crypto.randomUUID()}`;
  const data = JSON.stringify(state, null, 2);
  // Force UTF-8 (default), no BOM. This is the STATE file, not stdout — but keep it clean.
  try {
    const handle = await fsp.open(tmp, 'wx');
    try {
      await handle.writeFile(data, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fsp.rename(tmp, file);
    // POSIX permits flushing the directory entry after rename. Windows does not expose
    // portable directory fsync; file contents are flushed, but power-loss guarantees depend
    // on the filesystem/OS. Process crashes and restarts remain covered on both platforms.
    if (process.platform !== 'win32') {
      const dir = await fsp.open(path.dirname(file), 'r');
      try { await dir.sync(); } finally { await dir.close(); }
    }
  } finally {
    await fsp.rm(tmp, { force: true });
  }
}

// Append one transcript line. JSONL, UTF-8, LF-terminated. Append is atomic enough for our
// single-writer-under-lock model.
async function appendTranscript(conversationId, entry) {
  const file = paths.transcriptFile(conversationId);
  const line = JSON.stringify({ ...entry, conversation_id: conversationId }) + '\n';
  const handle = await fsp.open(file, 'a');
  try {
    await handle.writeFile(line, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

// Recovery may run after append succeeded but its caller saw an error. Never duplicate a
// known entry, and never append after a torn/corrupt line (preserve evidence for diagnosis).
async function ensureTranscriptEntry(conversationId, entry) {
  let raw;
  try { raw = await fsp.readFile(paths.transcriptFile(conversationId), 'utf8'); }
  catch (err) { if (err.code !== 'ENOENT') throw err; raw = ''; }
  try {
    if (raw && !raw.endsWith('\n')) throw new Error('unterminated transcript line');
    const entries = raw ? raw.slice(0, -1).split('\n').map((line) => JSON.parse(line)) : [];
    const matches = entries.filter((item) => item.operation_id === entry.operation_id && item.direction === entry.direction);
    if (matches.length) {
      if (matches.length !== 1 || !isDeepStrictEqual(matches[0], { ...entry, conversation_id: conversationId })) {
        throw new Error('conflicting operation transcript entry');
      }
      return;
    }
  } catch (cause) {
    const err = new Error(`Cannot reconcile transcript for '${conversationId}': ${cause.message}. Preserve the file and restore it from verified evidence before recovery.`);
    err.code = 'CORRUPT_TRANSCRIPT';
    throw err;
  }
  await module.exports.appendTranscript(conversationId, entry);
}

module.exports = { loadState, readStateFile, saveState, writeJsonAtomic, appendTranscript, ensureTranscriptEntry };
