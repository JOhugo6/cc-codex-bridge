'use strict';
// The relay supplies the complete envelope; only deterministic code interprets its header.
const { z } = require('zod');
const paths = require('./paths');
const { MIN_CALL_TIMEOUT_MS, DEFAULT_CALL_TIMEOUT_MS, MAX_CALL_TIMEOUT_MS } = require('./codex-backend');
const operations = require('./operations');
const workingDir = require('./working-dir');

const MAX_HEADER_LENGTH = 4096;
const MAX_MESSAGE_LENGTH = 100000;
const MAX_ENVELOPE_LENGTH = MAX_HEADER_LENGTH + 2 + MAX_MESSAGE_LENGTH;
// Unlike $, the negative lookahead cannot match before a final line terminator.
const idSchema = z.string().min(1).max(200).regex(/^[A-Za-z0-9._-]+(?![\s\S])/);
const structuredSchema = z.strictObject({
  conversation_id: idSchema.describe('Stable, case-sensitive conversation key; keep it constant across turns.'),
  message: z.string().min(1).max(MAX_MESSAGE_LENGTH).describe('Exact message text; never trimmed.'),
  request_id: idSchema.optional().describe('Optional request ID. Reuse only to redeliver the same request.'),
  working_dir: z.string().min(1).max(500).optional().describe(
    'Existing directory, canonicalized and pinned on the first turn. Defaults to the bridge launch cwd; ' +
    'relative paths resolve there. Later turns inherit the saved directory and reject a different directory.'
  ),
  timeout_ms: z.int().min(MIN_CALL_TIMEOUT_MS).max(MAX_CALL_TIMEOUT_MS).optional().describe(
    `Wall-clock limit for this one call in ms, ${MIN_CALL_TIMEOUT_MS}-${MAX_CALL_TIMEOUT_MS}, default ` +
    `${DEFAULT_CALL_TIMEOUT_MS}. Raise it for a long analysis turn, lower it for a quick probe. It bounds ` +
    'the whole operation, not just the model turn, and applies to this call only. The MCP client has its ' +
    'own tool timeout; whichever is shorter wins.'
  ),
});
const envelopeSchema = z.strictObject({
  envelope: z.string().max(MAX_ENVELOPE_LENGTH).describe(
    'The entire incoming relay message, unchanged. First physical line: CONV_ID: <id>, optionally ' +
    '; WORKING_DIR: <JSON string>, ; REQUEST_ID: <id> and/or ; TIMEOUT_MS: <integer ms>, each at most once in any order. ' +
    'Header whitespace is ASCII space/tab only; LF or CRLF separates the nonempty body. ' +
    'Header limit 4096 and body limit 100000 UTF-16 code units. Do not pass any other arguments.'
  ),
});
const inputSchema = z.union([envelopeSchema, structuredSchema]);
// MCP requires a top-level object schema. The alternatives retain their strict object shape.
const inputJsonSchema = {
  type: 'object',
  oneOf: [z.toJSONSchema(envelopeSchema), z.toJSONSchema(structuredSchema)],
};

function failure(code, message) {
  return Object.assign(new Error(message), { code });
}

function badHeader() {
  return failure('INVALID_ENVELOPE_HEADER', 'The first physical line must be CONV_ID: <id>, with optional ' +
    '; WORKING_DIR: <JSON string>, ; REQUEST_ID: <id> and/or ; TIMEOUT_MS: <integer ms>. ' +
    'Only ASCII spaces/tabs are header whitespace; ' +
    'unknown, duplicate or malformed metadata is not allowed.');
}

function parseEnvelope(envelope) {
  if (typeof envelope !== 'string') throw failure('INVALID_ENVELOPE', 'envelope must be a string.');
  if (envelope.length > MAX_ENVELOPE_LENGTH) {
    throw failure('ENVELOPE_TOO_LARGE', `envelope exceeds ${MAX_ENVELOPE_LENGTH} UTF-16 code units.`);
  }
  const newline = envelope.indexOf('\n');
  if (newline < 0) throw failure('INVALID_ENVELOPE', 'The header must end with LF or CRLF before the nonempty message body.');
  const headerEnd = newline > 0 && envelope[newline - 1] === '\r' ? newline - 1 : newline;
  if (headerEnd > MAX_HEADER_LENGTH) {
    throw failure('ENVELOPE_HEADER_TOO_LARGE', `The header exceeds ${MAX_HEADER_LENGTH} UTF-16 code units.`);
  }
  let remaining = envelope.slice(0, headerEnd);
  const header = /^[ \t]*CONV_ID:[ \t]*([A-Za-z0-9._-]{1,200})(?=[ \t;]|$)[ \t]*/.exec(remaining);
  if (!header) throw badHeader();
  const parsed = { conversation_id: header[1], message: envelope.slice(newline + 1) };
  paths.assertSafeConversationId(parsed.conversation_id);
  remaining = remaining.slice(header[0].length);
  const seen = new Set();
  while (remaining.length) {
    const prefix = /^;[ \t]*(WORKING_DIR|REQUEST_ID|TIMEOUT_MS):[ \t]*/.exec(remaining);
    if (!prefix || seen.has(prefix[1])) throw badHeader();
    const key = prefix[1];
    seen.add(key);
    remaining = remaining.slice(prefix[0].length);
    // A JSON string may contain semicolons and header-looking text. Never split on those.
    const value = key === 'WORKING_DIR'
      ? /^"(?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"/.exec(remaining)
      : /^[A-Za-z0-9._-]{1,200}(?=[ \t;]|$)/.exec(remaining);
    if (!value) throw badHeader();
    if (key === 'WORKING_DIR') parsed.working_dir = JSON.parse(value[0]);
    else if (key === 'TIMEOUT_MS') parsed.timeout_ms = /^[0-9]{1,9}$/.test(value[0]) ? Number(value[0]) : NaN;
    else parsed.request_id = value[0];
    remaining = remaining.slice(value[0].length).replace(/^[ \t]*/, '');
  }
  if (parsed.timeout_ms !== undefined && !(Number.isInteger(parsed.timeout_ms)
      && parsed.timeout_ms >= MIN_CALL_TIMEOUT_MS && parsed.timeout_ms <= MAX_CALL_TIMEOUT_MS)) {
    throw failure('INVALID_ENVELOPE_HEADER',
      `TIMEOUT_MS must be an integer between ${MIN_CALL_TIMEOUT_MS} and ${MAX_CALL_TIMEOUT_MS}.`);
  }
  operations.assertRequestId(parsed.request_id);
  workingDir.assertInput(parsed.working_dir);
  if (!parsed.message.length) throw failure('INVALID_MESSAGE', 'message must be a non-empty string.');
  if (parsed.message.length > MAX_MESSAGE_LENGTH) {
    throw failure('MESSAGE_TOO_LARGE', `message exceeds ${MAX_MESSAGE_LENGTH} UTF-16 code units.`);
  }
  return parsed;
}

function parseToolInput(args) {
  const result = inputSchema.safeParse(args);
  if (!result.success) {
    throw failure('INVALID_ARGUMENTS', 'Input validation failed: supply either {envelope} alone or ' +
      '{conversation_id, message, working_dir?, request_id?, timeout_ms?}. Unknown keys, mixed modes, invalid types ' +
      'and values outside the advertised schema are rejected. ' + result.error.message);
  }
  return Object.hasOwn(result.data, 'envelope') ? parseEnvelope(result.data.envelope) : result.data;
}

function errorResult(err) {
  // JSON escaping preserves multiline error details without creating extra physical lines.
  const detail = JSON.stringify({
    code: typeof err?.code === 'string' ? err.code : 'CODEX_TURN_FAILED',
    message: typeof err?.message === 'string' ? err.message : String(err),
  }).replace(/[\u0085\u2028\u2029]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
  return { isError: true, content: [{ type: 'text', text: `CODEX-BRIDGE ERROR: ${detail}` }] };
}

module.exports = { parseEnvelope, parseToolInput, inputJsonSchema, errorResult,
  MAX_HEADER_LENGTH, MAX_MESSAGE_LENGTH, MAX_ENVELOPE_LENGTH };
