'use strict';
// On-disk state store (design §4.2). Pure I/O, no LLM, no Codex knowledge.
// Caller MUST hold the per-conversation lock around load -> ...codex call... -> save.

const fsp = require('node:fs/promises');
const paths = require('./paths');

// Load state for a conversation_id. Returns null if no state exists yet (=> first turn).
// Throws on a CORRUPT state file rather than silently treating it as "new" — silent amnesia is
// the #1 forbidden failure (design §2, §4.1 step 4).
async function loadState(conversationId) {
  const file = paths.stateFile(conversationId);
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
    return st;
  } catch (err) {
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
  const file = paths.stateFile(conversationId);
  const tmp = `${file}.tmp.${process.pid}.${Date.now()}`;
  const data = JSON.stringify(state, null, 2);
  // Force UTF-8 (default), no BOM. This is the STATE file, not stdout — but keep it clean.
  await fsp.writeFile(tmp, data, { encoding: 'utf8' });
  await fsp.rename(tmp, file);
}

// Append one transcript line. JSONL, UTF-8, LF-terminated. Append is atomic enough for our
// single-writer-under-lock model.
async function appendTranscript(conversationId, entry) {
  const file = paths.transcriptFile(conversationId);
  const line = JSON.stringify(entry) + '\n';
  await fsp.appendFile(file, line, { encoding: 'utf8' });
}

module.exports = { loadState, saveState, appendTranscript };
