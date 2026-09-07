'use strict';
// Explicit migration only: a filename from the old case-insensitive layout is not
// sufficient evidence to silently claim an existing thread for a new identity.
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const paths = require('./paths');
const lock = require('./lock');
const store = require('./store');

function migrationError(code, id, detail) {
  const err = new Error(`${detail} Conversation '${id}' was not started. Stop old bridge processes and run node migrate-state.js '${id}' with the exact legacy ID; see the runbook.`);
  err.code = code;
  return err;
}

function conflict(id, detail) {
  return migrationError('LEGACY_IDENTITY_CONFLICT', id, detail);
}

async function readOptional(file) {
  try { return await fsp.readFile(file); }
  catch (err) { if (err.code === 'ENOENT') return null; throw err; }
}

function digest(data) {
  return data === null ? null : crypto.createHash('sha256').update(data).digest('hex');
}

// Enumerate real names: fs.exists/readFile alone would hide case aliases on Windows.
async function inspectLegacy(id) {
  paths.assertSafeConversationId(id);
  let names;
  try { names = await fsp.readdir(paths.stateDir()); }
  catch (err) { if (err.code === 'ENOENT') return null; throw err; }
  const suffixes = ['.json', '.transcript.jsonl', '.lock'];
  const matches = suffixes.map((suffix) => names.filter((name) => name.toLowerCase() === `${id}${suffix}`.toLowerCase()));
  if (matches.every((group) => group.length === 0)) return null;
  if (matches.some((group) => group.length > 1)) throw conflict(id, 'Multiple legacy files differ only by letter case.');
  const stems = matches.flatMap((group, i) => group.map((name) => name.slice(0, -suffixes[i].length)));
  if (new Set(stems).size !== 1) throw conflict(id, 'Legacy state, transcript or lock have conflicting ID casing.');
  const legacyId = stems[0];
  const files = Object.fromEntries(['state', 'transcript', 'lock'].map((key, i) => [key, path.join(paths.stateDir(), `${legacyId}${suffixes[i]}`)]));
  const raw = await readOptional(files.state);
  let data = null;
  if (raw !== null) {
    try { data = JSON.parse(raw.toString('utf8')); }
    catch { throw conflict(id, `Legacy state at ${files.state} is not valid JSON.`); }
  }
  return { legacyId, files, raw, data };
}

async function validateMarker(id, legacy) {
  const marker = legacy.data && legacy.data.bridge_migration;
  if (!marker) return false;
  if (marker.version !== 1 || marker.conversation_id !== legacy.legacyId ||
      marker.destination !== paths.identityKey(legacy.legacyId) ||
      !marker.source || !/^[0-9a-f]{64}$/.test(marker.source.state_sha256) ||
      (marker.source.transcript_sha256 !== null && !/^[0-9a-f]{64}$/.test(marker.source.transcript_sha256))) {
    throw conflict(id, 'Invalid legacy migration marker.');
  }
  const target = await store.readStateFile(paths.stateFile(legacy.legacyId), legacy.legacyId);
  if (!target || !legacy.data.original_state || target.thread_id !== legacy.data.original_state.thread_id ||
      JSON.stringify(target.legacy_migration) !== JSON.stringify(marker.source)) {
    throw conflict(id, 'Legacy migration destination is missing or does not match its marker.');
  }
  if (digest(await readOptional(legacy.files.transcript)) !== marker.source.transcript_sha256) {
    throw conflict(id, 'Legacy transcript changed after migration.');
  }
  return true;
}

async function assertLegacyResolved(id) {
  const legacy = await inspectLegacy(id);
  if (!legacy || await validateMarker(id, legacy)) return;
  if (legacy.legacyId !== id) throw conflict(id, `Legacy files belong to differently cased ID '${legacy.legacyId}'.`);
  throw migrationError('LEGACY_MIGRATION_REQUIRED', id, 'Legacy files require explicit migration before this conversation can continue.');
}

// Hold both the new mutex and the old mutex. The old one waits for an in-flight
// legacy turn; the marker then makes the old bridge reject any later resume.
async function migrateLegacy(id, opts = {}) {
  paths.assertSafeConversationId(id);
  lock.ensureStateDirSync(paths.stateDir());
  const release = await lock.acquire(paths.lockDir(id), opts.lockOpts);
  let releaseLegacy;
  try {
    let legacy = await inspectLegacy(id);
    if (!legacy) throw migrationError('NO_LEGACY_STATE', id, 'No legacy files exist.');
    if (legacy.legacyId !== id) throw conflict(id, `Use the exact legacy ID '${legacy.legacyId}'.`);
    releaseLegacy = await lock.acquire(legacy.files.lock, opts.lockOpts);
    legacy = await inspectLegacy(id);
    if (await validateMarker(id, legacy)) return { conversation_id: id, migrated: false, state_file: paths.stateFile(id) };
    const prior = await store.readStateFile(legacy.files.state, id, { legacy: true });
    if (!prior) throw conflict(id, 'Legacy transcript or lock exists without a state file; recover the original thread first.');
    const transcript = await readOptional(legacy.files.transcript);
    const source = { state_sha256: digest(legacy.raw), transcript_sha256: digest(transcript) };
    const targetFile = paths.stateFile(id);
    const target = await store.readStateFile(targetFile, id);
    const expected = { ...prior, conversation_id: id, legacy_migration: source };
    // A failed migration can be retried only while the exact source and destination
    // snapshot still agree. Never overwrite an independently established session.
    if (target && JSON.stringify(target) !== JSON.stringify(expected)) {
      throw conflict(id, 'Both legacy and hashed state exist with different contents.');
    }
    const targetTranscript = await readOptional(paths.transcriptFile(id));
    if (targetTranscript !== null && digest(targetTranscript) !== digest(transcript)) {
      throw conflict(id, 'The hashed transcript conflicts with the legacy transcript.');
    }
    // Publish the state first. If copying fails, loadState still sees the legacy
    // source and blocks; retry validates the snapshot before doing any further I/O.
    if (!target) await store.saveState(id, expected);
    if (transcript !== null && targetTranscript === null) {
      const transcriptFile = paths.transcriptFile(id);
      const tmp = `${transcriptFile}.tmp.${crypto.randomUUID()}`;
      try {
        await fsp.copyFile(legacy.files.transcript, tmp, require('node:fs').constants.COPYFILE_EXCL);
        await fsp.rename(tmp, transcriptFile);
      } finally { await fsp.rm(tmp, { force: true }); }
    }
    // Keep the original state as an audit/recovery copy. An old bridge deliberately
    // sees no thread_id here and throws CORRUPT_STATE instead of resuming stale state.
    await store.writeJsonAtomic(legacy.files.state, {
      bridge_migration: { version: 1, conversation_id: id, destination: paths.identityKey(id), source },
      original_state: prior,
    });
    return { conversation_id: id, migrated: true, state_file: targetFile };
  } finally {
    if (releaseLegacy) await releaseLegacy();
    await release();
  }
}

module.exports = { assertLegacyResolved, migrateLegacy };
