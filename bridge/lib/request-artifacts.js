'use strict';
// Request twin of reply-artifacts: one raw source read, exact UTF-8 and immutable,
// operation-bound files. Restricting sources to the pinned cwd is hygiene, not a
// sandbox: the Codex backend retains its existing filesystem/network capabilities.
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const { z } = require('zod');
const paths = require('./paths');

const ID = /^[A-Za-z0-9._-]{1,200}(?![\s\S])/;
const DIGEST = /^[a-f0-9]{64}(?![\s\S])/;
const attachmentSchema = z.strictObject({
  id: z.string().min(1).max(200).regex(ID).describe('Stable attachment ID; exactly one {{attachment:<id>}} in message.'),
  path: z.string().min(1).describe('UTF-8 regular file inside the pinned working_dir; relative paths resolve there.'),
  expected_sha256: z.string().regex(DIGEST).optional().describe('Optional pinned SHA-256 of the full source bytes; a mismatch sends nothing.'),
});
function failure(code, message) { return Object.assign(new Error(message), { code }); }
function sha256(value) { return crypto.createHash('sha256').update(value).digest('hex'); }

function references(message, attachments) {
  const ids = new Set();
  for (const attachment of attachments) {
    if (ids.has(attachment.id)) throw failure('DUPLICATE_ATTACHMENT_ID', `Duplicate attachment ID ${JSON.stringify(attachment.id)}.`);
    ids.add(attachment.id);
  }
  const seen = new Set();
  const matches = [...message.matchAll(/\{\{attachment:([^{}]*)\}\}/g)];
  if (matches.length !== message.split('{{attachment:').length - 1) {
    throw failure('INVALID_ATTACHMENT_REFERENCE', 'Every reserved {{attachment: token must be a complete {{attachment:<id>}} placeholder.');
  }
  for (const match of matches) {
    const id = match[1];
    if (!ID.test(id)) throw failure('INVALID_ATTACHMENT_REFERENCE', 'Attachment placeholders must contain a valid attachment ID.');
    if (!ids.has(id)) throw failure('UNKNOWN_ATTACHMENT_REFERENCE', `No attachment is supplied for ${JSON.stringify(id)}.`);
    if (seen.has(id)) throw failure('DUPLICATE_ATTACHMENT_REFERENCE', `Attachment ${JSON.stringify(id)} is referenced more than once.`);
    seen.add(id);
  }
  for (const id of ids) {
    if (!seen.has(id)) throw failure('UNREFERENCED_ATTACHMENT', `Attachment ${JSON.stringify(id)} has no placeholder in message.`);
  }
}

function assertInput(message, attachments) {
  if (attachments !== undefined && !z.array(attachmentSchema).safeParse(attachments).success) {
    throw failure('INVALID_ATTACHMENTS', 'attachments must be an array of strict {id, path, expected_sha256?} objects.');
  }
  if (attachments !== undefined) references(message, attachments);
}

function inside(cwd, file) {
  const relative = path.relative(cwd, file);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function canonicalPath(value, cwd, recordedPath) {
  if (value.includes('\0') || (process.platform === 'win32' && /^[A-Za-z]:(?![/\\])/.test(value))) {
    throw failure('ATTACHMENT_PATH_INVALID', 'Attachment paths cannot contain NUL or ambiguous drive-relative paths.');
  }
  const resolved = path.resolve(cwd, value);
  let canonical;
  try { canonical = await fsp.realpath(resolved); }
  catch (cause) {
    // Completed replays can outlive their source. A missing source only matches when
    // its resolved spelling is the recorded canonical identity; never guess an alias.
    if (cause.code === 'ENOENT' && resolved === recordedPath) canonical = recordedPath;
    else throw failure('ATTACHMENT_PATH_INVALID', `Cannot resolve attachment path ${JSON.stringify(value)}: ${cause.message}`);
  }
  if (!inside(cwd, canonical)) {
    throw failure('ATTACHMENT_PATH_OUTSIDE_WORKING_DIR', 'Attachment source must resolve to a file inside the pinned working_dir.');
  }
  return canonical;
}

function decode(bytes) {
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { throw failure('ATTACHMENT_INVALID_UTF8', 'Attachment bytes are not valid UTF-8; no lossy decoding is allowed.'); }
  if (!Buffer.from(text, 'utf8').equals(bytes)) {
    throw failure('ATTACHMENT_INVALID_UTF8', 'Attachment UTF-8 decoding did not preserve the original bytes.');
  }
  return text;
}

async function prepare(message, attachments, cwd) {
  assertInput(message, attachments);
  if (attachments === undefined || attachments.length === 0) return undefined;
  const prepared = [];
  for (const attachment of attachments) {
    const file = await canonicalPath(attachment.path, cwd);
    let bytes;
    try {
      const handle = await fsp.open(file, 'r');
      try {
        if (!(await handle.stat()).isFile()) throw new Error('source is not a regular file');
        bytes = await handle.readFile(); // hash and decode this buffer; never reread the source.
      } finally { await handle.close(); }
    } catch (cause) { throw failure('ATTACHMENT_READ_FAILED', `Cannot read attachment ${JSON.stringify(attachment.id)}: ${cause.message}`); }
    const digest = sha256(bytes);
    if (attachment.expected_sha256 !== undefined && attachment.expected_sha256 !== digest) {
      throw failure('ATTACHMENT_DIGEST_MISMATCH', `Attachment ${JSON.stringify(attachment.id)} no longer matches expected_sha256.`);
    }
    prepared.push({ id: attachment.id, path: file,
      ...(attachment.expected_sha256 === undefined ? {} : { expected_sha256: attachment.expected_sha256 }),
      sha256: digest, byte_length: bytes.length, text: decode(bytes) });
  }
  return prepared;
}

async function forReplay(message, attachments, input) {
  assertInput(message, attachments);
  if (!attachments?.length) return undefined;
  const saved = input.attachments || [];
  const prepared = [];
  for (const attachment of attachments) {
    const prior = saved.find((item) => item.id === attachment.id);
    const canonical = await canonicalPath(attachment.path, input.working_dir, prior?.path);
    // Keep the recorded payload only for an exact caller identity. A mismatch will
    // fail the journal's full input comparison, without reading new source bytes.
    prepared.push({ ...(prior || {}), id: attachment.id, path: canonical });
    const current = prepared.at(-1);
    if (attachment.expected_sha256 === undefined) delete current.expected_sha256;
    else current.expected_sha256 = attachment.expected_sha256;
  }
  return prepared;
}

function render(input) {
  if (input.attachments === undefined) return input.message;
  const attachments = new Map((input.attachments || []).map((item) => [item.id, item.text]));
  // One pass over the caller template; inserted contents are never scanned again.
  return input.message.replace(/\{\{attachment:([^{}]*)\}\}/g, (_, id) => attachments.get(id));
}

function describe(conversationId, op) {
  paths.assertSafeConversationId(conversationId);
  return (op.input.attachments || []).map((item) => ({
    id: item.id, path: item.path, sha256: item.sha256, byte_length: item.byte_length,
    conversation_id: conversationId, operation_id: op.operation_id,
    turn: (op.before?.turn || 0) + 1, request_id: op.request_id,
  }));
}

function assertMetadata(conversationId, op) {
  const attachments = op.input.attachments;
  try {
    if (attachments !== undefined) {
      if (!Array.isArray(attachments) || !attachments.length || op.input.working_dir_policy !== 'pinned') throw new Error('invalid recorded attachments');
      references(op.input.message, attachments);
      for (const item of attachments) {
        if (!item || typeof item.id !== 'string' || !ID.test(item.id) || typeof item.path !== 'string' || !path.isAbsolute(item.path) ||
            !inside(op.input.working_dir, item.path) || typeof item.text !== 'string' ||
            !DIGEST.test(item.sha256) || !Number.isSafeInteger(item.byte_length) || item.byte_length < 0 ||
            !(item.expected_sha256 === undefined || (DIGEST.test(item.expected_sha256) && item.expected_sha256 === item.sha256)) ||
            Object.keys(item).some((key) => !['id', 'path', 'expected_sha256', 'sha256', 'byte_length', 'text'].includes(key))) {
          throw new Error('invalid attachment identity');
        }
        const bytes = Buffer.from(item.text, 'utf8');
        if (bytes.length !== item.byte_length || sha256(bytes) !== item.sha256 || decode(bytes) !== item.text) throw new Error('recorded attachment bytes differ');
      }
    }
    const expected = describe(conversationId, op);
    if (attachments !== undefined && op.status !== 'pending' && op.result?.request_artifacts === undefined) throw new Error('missing result descriptors');
    if (op.result?.request_artifacts !== undefined && !isDeepStrictEqual(op.result.request_artifacts, expected)) throw new Error('result descriptors differ');
    return expected;
  } catch (cause) {
    throw failure('CORRUPT_REQUEST_ARTIFACT', `Request artifact metadata does not match its journal payload and operation identity: ${cause.message}`);
  }
}

function fileFor(conversationId, operationId, attachmentId) {
  return path.join(paths.stateDir(), `${paths.identityKey(conversationId)}.requests`, sha256(operationId), `${sha256(attachmentId)}.utf8`);
}

async function readVerified(conversationId, op, id) {
  const descriptor = assertMetadata(conversationId, op).find((item) => item.id === id);
  if (!descriptor) throw failure('REQUEST_ARTIFACT_NOT_FOUND', 'No attachment with this ID exists in the operation.');
  let bytes;
  try { bytes = await fsp.readFile(fileFor(conversationId, op.operation_id, id)); }
  catch (err) {
    if (err.code === 'ENOENT') throw failure('REQUEST_ARTIFACT_MISSING', 'Request artifact is missing. Replay its completed request_id or finish offline recovery to recreate recorded bytes without calling Codex.');
    throw err;
  }
  if (bytes.length !== descriptor.byte_length || sha256(bytes) !== descriptor.sha256) {
    throw failure('CORRUPT_REQUEST_ARTIFACT', 'Request artifact bytes do not match the journal SHA-256 and length. Preserve the file and restore a verified copy.');
  }
  return bytes;
}

async function ensure(conversationId, op) {
  const descriptors = assertMetadata(conversationId, op);
  for (const descriptor of descriptors) {
    try { await readVerified(conversationId, op, descriptor.id); continue; }
    catch (err) { if (err.code !== 'REQUEST_ARTIFACT_MISSING') throw err; }
    const file = fileFor(conversationId, op.operation_id, descriptor.id);
    await fsp.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp.${process.pid}.${crypto.randomUUID()}`;
    try {
      const handle = await fsp.open(tmp, 'wx');
      try {
        await handle.writeFile(Buffer.from(op.input.attachments.find((item) => item.id === descriptor.id).text, 'utf8'));
        await handle.sync();
      } finally { await handle.close(); }
      // Atomic no-replace publication on NTFS/POSIX, exactly as reply-artifacts.
      try { await fsp.link(tmp, file); }
      catch (err) { if (err.code !== 'EEXIST') throw err; }
      if (process.platform !== 'win32') {
        const dir = await fsp.open(path.dirname(file), 'r');
        try { await dir.sync(); } finally { await dir.close(); }
      }
      await readVerified(conversationId, op, descriptor.id);
    } finally { await fsp.rm(tmp, { force: true }); }
  }
  return descriptors;
}

module.exports = { attachmentSchema, assertInput, prepare, forReplay, render, describe, assertMetadata, fileFor, readVerified, ensure };
