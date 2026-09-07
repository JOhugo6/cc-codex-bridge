'use strict';
// Durable write-ahead journal. Mutations/turn coordination require the conversation lock;
// load alone also supports atomic read-only snapshots for immutable resources. A backend
// error is ambiguous: the remote side may have executed before the response was lost.
const fsp = require('node:fs/promises');
const crypto = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const paths = require('./paths');
const path = require('node:path');
const store = require('./store');
const replyArtifacts = require('./reply-artifacts');

function failure(code, message) {
  return Object.assign(new Error(message), { code });
}

function assertRequestId(id) {
  if (id !== undefined && (typeof id !== 'string' || !paths.SAFE_ID.test(id))) {
    throw failure('INVALID_REQUEST_ID', 'request_id must contain 1-200 letters, digits, dots, underscores or hyphens.');
  }
}

function validState(state, id) {
  return state && state.conversation_id === id && typeof state.thread_id === 'string' &&
    state.thread_id.length > 0 && Number.isInteger(state.turn) && state.turn > 0 &&
    (state.working_dir === undefined || (typeof state.working_dir === 'string' && path.isAbsolute(state.working_dir)));
}

async function load(conversationId) {
  let raw;
  try { raw = await fsp.readFile(paths.operationsFile(conversationId), 'utf8'); }
  catch (err) { if (err.code === 'ENOENT') return null; throw err; }
  try {
    const journal = JSON.parse(raw);
    if (journal.version !== 1 || journal.conversation_id !== conversationId ||
        !Array.isArray(journal.operations) || !journal.operations.length) throw new Error('invalid journal header');
    const requests = new Set();
    const ids = new Set();
    for (let i = 0; i < journal.operations.length; i++) {
      const op = journal.operations[i];
      assertRequestId(op.request_id === null ? undefined : op.request_id);
      if (!(op.request_id === null || typeof op.request_id === 'string') ||
          typeof op.operation_id !== 'string' || !op.operation_id || ids.has(op.operation_id) ||
          !['pending', 'received', 'completed'].includes(op.status) ||
          (i < journal.operations.length - 1 && op.status !== 'completed') ||
          typeof op.created_at !== 'string' || typeof op.input?.message !== 'string' || !op.input.message ||
          typeof op.input.provider !== 'string' || !op.input.provider ||
          !(op.input.working_dir === null || typeof op.input.working_dir === 'string') ||
          !(op.input.working_dir_policy === undefined || (op.input.working_dir_policy === 'pinned' &&
            typeof op.input.working_dir === 'string' && path.isAbsolute(op.input.working_dir))) ||
          // Legacy state may gain its first cwd after authoritative thread/read verification.
          // Once present, a pinned directory still cannot change between operations.
          (op.input.working_dir_policy === 'pinned' && op.before?.working_dir !== undefined && op.before.working_dir !== op.input.working_dir) ||
          !(op.before === null || validState(op.before, conversationId)) ||
          (i > 0 && !isDeepStrictEqual(op.before, journal.operations[i - 1].after))) {
        throw new Error('invalid operation or discontinuous history');
      }
      ids.add(op.operation_id);
      if (op.request_id !== null) {
        if (requests.has(op.request_id)) throw new Error('duplicate request_id');
        requests.add(op.request_id);
      }
      if (op.status !== 'pending') {
        if (typeof op.result?.reply !== 'string' || !validState(op.after, conversationId) ||
            op.result.thread_id !== op.after.thread_id || op.result.turn !== op.after.turn ||
            op.after.turn !== (op.before?.turn || 0) + 1 ||
            (op.before && op.result.thread_id !== op.before.thread_id) ||
            op.after.last_operation_id !== op.operation_id || op.after.journal_version !== 1 ||
            (op.input.working_dir_policy === 'pinned' && op.after.working_dir !== op.input.working_dir) ||
            typeof op.received_at !== 'string') throw new Error('invalid recorded result');
        replyArtifacts.assertMetadata(conversationId, op);
      }
    }
    return journal;
  } catch (cause) {
    throw failure('CORRUPT_OPERATIONS', `Invalid operations journal for '${conversationId}': ${cause.message}. Refusing to call Codex.`);
  }
}

async function save(conversationId, journal) {
  await store.writeJsonAtomic(paths.operationsFile(conversationId), journal);
}

function assertState(journal, state) {
  if (!journal) {
    if (state?.journal_version) throw failure('MISSING_OPERATIONS', 'State references a missing operations journal. Restore a consistent backup; do not retry Codex.');
    return;
  }
  const op = journal.operations.at(-1);
  const matchesBefore = op.status !== 'completed' && isDeepStrictEqual(state, op.before);
  const matchesAfter = op.status !== 'pending' && isDeepStrictEqual(state, op.after);
  if (!matchesBefore && !matchesAfter) {
    throw failure('OPERATION_STATE_CONFLICT', 'State does not match the operations journal. Preserve both files and restore verified state before recovery.');
  }
}

async function findReplay(journal, requestId, input) {
  if (!journal || requestId === undefined) return null;
  const op = journal.operations.find((item) => item.request_id === requestId);
  if (!op) return null;
  if (!isDeepStrictEqual(op.input, input)) {
    throw failure('REQUEST_ID_CONFLICT', `request_id '${requestId}' was already used with different input.`);
  }
  return op.status === 'completed' ? ensureReply(journal.conversation_id, journal, op) : null;
}

async function ensureReply(conversationId, journal, op) {
  const descriptor = await replyArtifacts.ensure(conversationId, op);
  // Completed journals from older versions gain an artifact without a new backend turn,
  // transcript entry or state rewind. Failed local upgrades are safe to repeat.
  if (op.result.reply_artifact === undefined) {
    op.result.reply_artifact = descriptor;
    await save(conversationId, journal);
  }
  return structuredClone(op.result);
}

function assertComplete(journal, conversationId) {
  const op = journal?.operations.at(-1);
  if (op && op.status !== 'completed') {
    throw failure(op.status === 'received' ? 'OPERATION_INCOMPLETE' : 'OPERATION_UNCERTAIN',
      `Conversation '${conversationId}' has ${op.status} operation '${op.operation_id}'. ` +
      `No further Codex call is safe. Run node recover-operation.js inspect '${conversationId}' from the bridge directory.`);
  }
}

async function begin(conversationId, journal, before, input, requestId) {
  journal ||= { version: 1, conversation_id: conversationId, operations: [] };
  journal.operations.push({
    operation_id: crypto.randomUUID(), request_id: requestId ?? null, status: 'pending',
    created_at: new Date().toISOString(), input, before,
  });
  await save(conversationId, journal); // MUST finish before any backend side effect.
  return journal;
}

function transcriptEntry(op, direction) {
  return {
    ts: direction === 'in' ? op.created_at : op.received_at,
    direction, operation_id: op.operation_id, request_id: op.request_id,
    turn: (op.before?.turn || 0) + 1,
    thread_id: direction === 'in' ? op.before?.thread_id || null : op.result.thread_id,
    message: direction === 'in' ? op.input.message : op.result.reply,
    provider: op.input.provider,
  };
}

async function receive(conversationId, journal, result) {
  const op = journal.operations.at(-1);
  const ts = new Date().toISOString();
  op.status = 'received';
  op.received_at = ts;
  op.result = result;
  op.result.reply_artifact = replyArtifacts.describe(conversationId, op);
  op.after = {
    ...(op.before?.legacy_migration ? { legacy_migration: op.before.legacy_migration } : {}),
    conversation_id: conversationId, thread_id: result.thread_id, turn: result.turn,
    provider: op.input.provider, created_at: op.before?.created_at || ts, updated_at: ts,
    journal_version: 1, last_operation_id: op.operation_id,
    ...(op.input.working_dir_policy === 'pinned' ? { working_dir: op.input.working_dir } : {}),
  };
  await save(conversationId, journal);
}

async function finish(conversationId, journal, state) {
  assertState(journal, state);
  const op = journal.operations.at(-1);
  if (op.status === 'completed') return ensureReply(conversationId, journal, op);
  if (op.status !== 'received') assertComplete(journal, conversationId);
  // Every step is repeatable after an I/O error or restart; the backend is never involved.
  await ensureReply(conversationId, journal, op);
  await store.ensureTranscriptEntry(conversationId, transcriptEntry(op, 'in'));
  if (!isDeepStrictEqual(state, op.after)) await store.saveState(conversationId, op.after);
  await store.ensureTranscriptEntry(conversationId, transcriptEntry(op, 'out'));
  op.status = 'completed';
  await save(conversationId, journal);
  return structuredClone(op.result);
}

module.exports = { assertRequestId, load, assertState, findReplay, assertComplete, begin, receive, finish, transcriptEntry };
