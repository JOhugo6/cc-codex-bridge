#!/usr/bin/env node
'use strict';
// codex-bridge — deterministic stdio MCP server (design §4.1).
// Exposes exactly ONE tool: codex_turn(conversation_id, message) -> { reply, thread_id, turn }.
//
// stdout carries ONLY MCP protocol bytes (the SDK's StdioServerTransport writes raw newline-
// delimited JSON in UTF-8, no BOM). ALL diagnostics go to stderr. Do NOT console.log to stdout.

const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');

const { CodexBridge } = require('./lib/bridge');
const { CodexBackend } = require('./lib/codex-backend');

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
  // never sets this and uses the native `codex mcp-server` child.
  const override = process.env.CODEX_BRIDGE_BACKEND;
  if (override) {
    elog('using injected backend from', override);
    const mod = require(override);
    return mod.createBackend();
  }
  return new CodexBackend();
}

async function main() {
  const backend = makeBackend();
  const bridge = new CodexBridge(backend, { provider: 'codex' });

  const server = new McpServer(
    { name: 'codex-bridge', version: '1.0.0' },
    {
      capabilities: { tools: {} },
      instructions:
        'Deterministic bridge to OpenAI Codex CLI. Call codex_turn with a STABLE conversation_id ' +
        'for the whole exchange; the bridge owns Codex thread continuity on disk. Return the ' +
        'reply field verbatim.',
    }
  );

  server.registerTool(
    'codex_turn',
    {
      title: 'Codex Turn',
      description:
        'Send one message to OpenAI Codex as an addressable team member and get its reply. ' +
        'Use a STABLE conversation_id for the entire multi-turn exchange — the bridge persists ' +
        'the Codex thread_id on disk and resumes it. On a lost/unresumable session it returns a ' +
        'loud error rather than silently starting fresh.',
      inputSchema: {
        conversation_id: z
          .string()
          .min(1)
          .max(200)
          .regex(/^[A-Za-z0-9._-]+$/)
          .describe(
            'Stable per-conversation key (letters, digits, ., _, -). Keep constant for the whole exchange.'
          ),
        message: z.string().min(1).describe('The message to send to Codex this turn.'),
      },
      outputSchema: {
        reply: z.string().describe('Codex reply text, verbatim.'),
        thread_id: z.string().describe('Persisted Codex thread id for this conversation.'),
        turn: z.number().int().describe('1-based turn number within this conversation.'),
      },
    },
    async ({ conversation_id, message }) => {
      try {
        const out = await bridge.turn(conversation_id, message);
        return {
          // structuredContent is the fidelity-bearing channel (design §2: fidelity from tool
          // result, not relay prose). Also mirror to a text block for clients that ignore it.
          structuredContent: out,
          content: [{ type: 'text', text: out.reply }],
        };
      } catch (err) {
        elog('codex_turn FAILED:', (err && err.code) || '', (err && err.message) || err);
        // LOUD MCP error — surfaces to the calling agent as a tool error, never a silent success.
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text:
                `codex_turn failed for conversation '${conversation_id}'` +
                (err && err.code ? ` [${err.code}]` : '') +
                `: ${err && err.message ? err.message : String(err)}`,
            },
          ],
        };
      }
    }
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
  elog('codex-bridge MCP server started on stdio (tool: codex_turn)');

  const shutdown = async (sig) => {
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
}

main().catch((err) => {
  elog('FATAL:', err && err.stack ? err.stack : err);
  process.exit(1);
});
