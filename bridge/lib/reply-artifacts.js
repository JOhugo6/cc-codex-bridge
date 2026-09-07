'use strict';
// Authoritative bytes are the UTF-8 encoding of the backend reply string, without a BOM
// added, newline conversion or an LLM pass. Files are published atomically, never overwritten.
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const paths = require('./paths');

const MIME_TYPE = 'text/plain; charset=utf-8';
const URI_TEMPLATE = 'codex-bridge://reply/c-{conversation_id}/{operation_key}';
function failure(code, message) { return Object.assign(new Error(message), { code }); }
function sha256(value) { return crypto.createHash('sha256').update(value).digest('hex'); }

function describe(conversationId, op) {
  paths.assertSafeConversationId(conversationId);
  const bytes = Buffer.from(op.result.reply, 'utf8');
  return {
    uri: `codex-bridge://reply/c-${conversationId}/${sha256(op.operation_id)}`,
    mimeType: MIME_TYPE, sha256: sha256(bytes), byte_length: bytes.length,
    conversation_id: conversationId, operation_id: op.operation_id,
    turn: op.result.turn, request_id: op.request_id,
  };
}

function assertMetadata(conversationId, op) {
  const expected = describe(conversationId, op);
  if (op.result.reply_artifact !== undefined && !isDeepStrictEqual(op.result.reply_artifact, expected)) {
    throw failure('CORRUPT_REPLY_ARTIFACT', 'Reply artifact metadata does not match its journal response and identity.');
  }
  return expected;
}

function fileFor(conversationId, operationId) {
  return path.join(paths.stateDir(), `${paths.identityKey(conversationId)}.replies`, `${sha256(operationId)}.utf8`);
}

async function readVerified(conversationId, op) {
  const descriptor = assertMetadata(conversationId, op);
  const bytes = await fsp.readFile(fileFor(conversationId, op.operation_id));
  if (bytes.length !== descriptor.byte_length || sha256(bytes) !== descriptor.sha256) {
    throw failure('CORRUPT_REPLY_ARTIFACT', 'Reply artifact bytes do not match the journal SHA-256 and length. Preserve the file and restore a verified copy.');
  }
  return bytes;
}

// Caller holds the conversation lock. Repeating after a crash is safe. A missing file may
// be reconstructed from the recorded response; a conflicting file is preserved and rejected.
async function ensure(conversationId, op) {
  const descriptor = assertMetadata(conversationId, op);
  try {
    await readVerified(conversationId, op);
    return descriptor;
  } catch (err) { if (err.code !== 'ENOENT') throw err; }
  const file = fileFor(conversationId, op.operation_id);
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp.${process.pid}.${crypto.randomUUID()}`;
  try {
    const handle = await fsp.open(tmp, 'wx');
    try {
      await handle.writeFile(Buffer.from(op.result.reply, 'utf8'));
      await handle.sync();
    } finally { await handle.close(); }
    // link is an atomic, no-replace publication on NTFS/POSIX. No reader sees a partial
    // destination, and even a race cannot overwrite a conflicting immutable artifact.
    try { await fsp.link(tmp, file); }
    catch (err) { if (err.code !== 'EEXIST') throw err; }
    if (process.platform !== 'win32') {
      const dir = await fsp.open(path.dirname(file), 'r');
      try { await dir.sync(); } finally { await dir.close(); }
    }
    await readVerified(conversationId, op);
    return descriptor;
  } finally { await fsp.rm(tmp, { force: true }); }
}

function parseUri(uri) {
  // Do not normalize URLs: exact case and spelling are part of identity. The c- prefix
  // keeps valid IDs such as '..' out of URL dot-segment semantics. No path is user supplied.
  const match = typeof uri === 'string' && /^codex-bridge:\/\/reply\/c-([A-Za-z0-9._-]{1,200})\/([a-f0-9]{64})$/.exec(uri);
  if (!match || match[0] !== uri) throw failure('INVALID_RESOURCE_URI', 'Expected a canonical codex-bridge reply resource URI.');
  try { paths.assertSafeConversationId(match[1]); }
  catch { throw failure('INVALID_RESOURCE_URI', 'Invalid conversation identity in reply resource URI.'); }
  return { conversationId: match[1], operationKey: match[2] };
}

async function readResource(uri) {
  const { conversationId, operationKey } = parseUri(uri);
  // Pure snapshot read: journals are replaced atomically and completed response records
  // never change. Reading an earlier reply need not wait for a newer backend turn's lock.
  const journal = await require('./operations').load(conversationId);
  const op = journal?.operations.find((entry) => sha256(entry.operation_id) === operationKey);
  if (!op || op.status !== 'completed' || !op.result.reply_artifact) {
    throw failure('RESOURCE_NOT_FOUND', 'No completed reply artifact exists for this URI.');
  }
  let bytes;
  try { bytes = await readVerified(conversationId, op); }
  catch (err) {
    if (err.code === 'ENOENT') throw failure('REPLY_ARTIFACT_MISSING', 'Reply artifact is missing. Replay its request_id or finish offline recovery to recreate it from the journal, without calling Codex.');
    throw err;
  }
  return { contents: [{ uri, mimeType: MIME_TYPE, blob: bytes.toString('base64') }] };
}

module.exports = { MIME_TYPE, URI_TEMPLATE, describe, assertMetadata, fileFor, ensure, readResource };
