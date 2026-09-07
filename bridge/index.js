#!/usr/bin/env node
'use strict';
// codex-bridge — deterministic stdio MCP server (design §4.1).
// Exposes one codex_turn tool, accepting either a raw relay envelope or structured arguments.
//
// stdout carries ONLY MCP protocol bytes (the SDK's StdioServerTransport writes raw newline-
// delimited JSON in UTF-8, no BOM). ALL diagnostics go to stderr. Do NOT console.log to stdout.

const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { ListToolsRequestSchema, CallToolRequestSchema, ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema, ReadResourceRequestSchema, McpError, ErrorCode } = require('@modelcontextprotocol/sdk/types.js');
const { z } = require('zod');

const { CodexBridge } = require('./lib/bridge');
const { CodexBackend } = require('./lib/codex-backend');
const { parseToolInput, inputJsonSchema, errorResult } = require('./lib/turn-input');
const replyArtifacts = require('./lib/reply-artifacts');

function elog(...args) {
  process.stderr.write('[codex-bridge] ' + args.map(String).join(' ') + '\n');
}

// Belt-and-suspenders: if any dependency tries to write to stdout, redirect it to stderr so it
// can never corrupt the MCP stream. The SDK transport writes via process.stdout.write directly;
// we capture the original and only let the transport through is not feasible, so instead we guard
// console.* (the common offender) to stderr.
console.log = (...a) => process.stderr.write(a.map(String).join(' ') + '\n');
console.info = console.log;
console.debug = console.log;
console.warn = (...a) => process.stderr.write(a.map(String).join(' ') + '\n');

function makeBackend() {
  // Test seam: CODEX_BRIDGE_BACKEND can point at a module exporting `createBackend()` so the
  // MCP server can be driven over stdio against a deterministic stub (no real Codex). Production
  // never sets this and uses the native `codex app-server` child.
  //
  // MINOR-15: guard this override so it cannot be used in production to load arbitrary modules.
  // Allow only when NODE_ENV !== 'production' OR when the value is an absolute path. Reject
  // relative paths and bare package names in production to prevent arbitrary module injection.
  const override = process.env.CODEX_BRIDGE_BACKEND;
  if (override) {
    const isProduction = process.env.NODE_ENV === 'production';
    const isAbsolute =
      override.startsWith('/') ||
      (process.platform === 'win32' && /^[A-Za-z]:[/\\]/.test(override));
    if (isProduction && !isAbsolute) {
      const e = new Error(
        `CODEX_BRIDGE_BACKEND is set to a non-absolute path ('${override}') in production. ` +
          'Only absolute paths are allowed in NODE_ENV=production to prevent arbitrary module loading.'
      );
      e.code = 'UNSAFE_BACKEND_OVERRIDE';
      throw e;
    }
    process.stderr.write(
      `[codex-bridge] WARNING: CODEX_BRIDGE_BACKEND override active — loading '${override}'. ` +
        'This is a test seam; do not use in production with untrusted paths.\n'
    );
    const mod = require(override);
    return mod.createBackend();
  }
  return new CodexBackend();
}

async function main() {
  const backend = makeBackend();
  const bridge = new CodexBridge(backend, { provider: 'codex' });

  const server = new Server(
    { name: 'codex-bridge', version: '1.0.0' },
    {
      capabilities: { tools: {}, resources: {} },
      instructions:
        'Deterministic bridge to OpenAI Codex CLI. Relays call codex_turn with only envelope: ' +
        'the complete incoming message unchanged. Direct callers may instead supply conversation_id, ' +
        'message and optional working_dir/request_id. Never mix these modes. The bridge owns ' +
        'thread continuity on disk; return reply verbatim or the single-line tool error unchanged. ' +
        'For exact output bytes, clients read reply_artifact.uri with resources/read and decode its base64 blob; ' +
        'verify reply_artifact.sha256 and byte_length in code. LLM relay prose has no byte guarantee.',
    }
  );

  const outputSchema = z.object({
    reply: z.string().describe('Codex reply text, verbatim.'),
    thread_id: z.string().describe('Persisted Codex thread id for this conversation.'),
    turn: z.number().int().describe('1-based turn number within this conversation.'),
    reply_artifact: z.object({
      uri: z.string(), mimeType: z.literal(replyArtifacts.MIME_TYPE),
      sha256: z.string().regex(/^[a-f0-9]{64}$/), byte_length: z.number().int().nonnegative(),
      conversation_id: z.string(), operation_id: z.string(), turn: z.number().int().positive(),
      request_id: z.string().nullable(),
    }).describe('Immutable UTF-8 reply resource with code-computed SHA-256, byte length and turn identity.'),
  });
  // The low-level SDK handlers let validation errors use the same single-line format as
  // backend errors, and advertise both strict input alternatives without SDK union coercion.
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [{
      name: 'codex_turn',
      title: 'Codex Turn',
      description:
        'Send one message to OpenAI Codex as an addressable team member and get its reply. ' +
        'Pass either {envelope} with the complete raw relay message, or direct structured ' +
        '{conversation_id, message, working_dir?, request_id?}; no mixed or unknown arguments. ' +
        'Use the same exact conversation ID throughout the exchange. The bridge persists ' +
        'thread continuity and fails loudly when a session cannot be resumed.',
      inputSchema: inputJsonSchema,
      outputSchema: z.toJSONSchema(outputSchema),
    }],
  }));
  // Links in tool results and this template expose resources without enumerating history.
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: [] }));
  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({ resourceTemplates: [{
    uriTemplate: replyArtifacts.URI_TEMPLATE, name: 'Codex reply bytes', mimeType: replyArtifacts.MIME_TYPE,
    description: 'Use the exact reply_artifact.uri returned by codex_turn. resources/read returns a base64 blob of the persisted UTF-8 reply.',
  }] }));
  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    try { return await replyArtifacts.readResource(request.params.uri); }
    catch (err) {
      const code = err.code === 'INVALID_RESOURCE_URI' ? ErrorCode.InvalidParams
        : err.code === 'RESOURCE_NOT_FOUND' ? -32002 : ErrorCode.InternalError;
      throw new McpError(code, `${err.code || 'RESOURCE_READ_FAILED'}: ${err.message}`);
    }
  });
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      try {
        if (request.params.name !== 'codex_turn') {
          throw Object.assign(new Error('Unknown tool; this server exposes only codex_turn.'), { code: 'UNKNOWN_TOOL' });
        }
        if (request.params.task) {
          throw Object.assign(new Error('codex_turn does not support task-augmented calls.'), { code: 'INVALID_ARGUMENTS' });
        }
        const { conversation_id, message, working_dir, request_id } = parseToolInput(request.params.arguments);
        const out = await bridge.turn(conversation_id, message, { working_dir, request_id, signal: extra.signal });
        outputSchema.parse(out);
        return {
          // Keep the compatible reply field/text block; expose immutable bytes directly to
          // MCP clients. A relay's generated prose is not an integrity-bearing channel.
          structuredContent: out,
          content: [{ type: 'text', text: out.reply }, {
            type: 'resource_link', uri: out.reply_artifact.uri,
            name: `Codex reply, turn ${out.turn}`, mimeType: out.reply_artifact.mimeType,
            size: out.reply_artifact.byte_length,
          }],
        };
      } catch (err) {
        elog('codex_turn FAILED:', (err && err.code) || '', (err && err.message) || err);
        return errorResult(err);
      }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  elog('codex-bridge MCP server started on stdio (tool: codex_turn)');

  let shuttingDown = false;
  const shutdown = async (sig) => {
    if (shuttingDown) return;
    shuttingDown = true;
    elog('shutting down on', sig);
    try {
      await backend.close();
    } catch {
      /* ignore */
    }
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  // The SDK's server transport listens for data/error, but does not emit onclose on EOF.
  // Handle the pipe lifecycle directly; client.close() may otherwise mask this by killing us.
  process.stdin.once('end', () => { void shutdown('stdin EOF'); });
  process.stdin.once('close', () => { void shutdown('stdin closed'); });
  if (process.stdin.readableEnded || process.stdin.destroyed) void shutdown('stdin already closed');
  const transportClosed = transport.onclose;
  transport.onclose = () => { transportClosed?.(); void shutdown('stdio closed'); };
}

main().catch((err) => {
  elog('FATAL:', err && err.stack ? err.stack : err);
  process.exit(1);
});
