'use strict';
// Drives the REAL MCP server (index.js) over stdio as an MCP client, with a deterministic stub
// backend injected (no real Codex). Asserts: the codex_turn tool exists with the right schema,
// a turn round-trips with structuredContent, resume keeps thread_id stable, and a forced
// start-failure surfaces as a LOUD MCP tool error (isError), not a silent success.

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');

const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');

const INDEX = path.join(__dirname, '..', 'index.js');
const STUB = path.join(__dirname, 'stub-backend.js');

async function startClient({ stateDir, stubMode }) {
  const transport = new StdioClientTransport({
    command: process.execPath, // node
    args: [INDEX],
    stderr: 'pipe',
    env: {
      ...process.env,
      CODEX_BRIDGE_BACKEND: STUB,
      CODEX_BRIDGE_STATE_DIR: stateDir,
      CODEX_BRIDGE_STUB_MODE: stubMode || 'ok',
    },
  });
  const client = new Client({ name: 'test-client', version: '0.0.0' }, { capabilities: {} });
  // Surface server stderr if something goes wrong.
  await client.connect(transport);
  return { client, transport };
}

function freshDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'codex-bridge-mcp-'));
}

test('codex_turn tool is listed with the correct input/output schema', async (t) => {
  const dir = freshDir();
  const { client } = await startClient({ stateDir: dir });
  t.after(async () => {
    await client.close();
    await fsp.rm(dir, { recursive: true, force: true });
  });

  const { tools } = await client.listTools();
  const tool = tools.find((x) => x.name === 'codex_turn');
  assert.ok(tool, 'codex_turn tool must be exposed');

  const props = tool.inputSchema.properties;
  assert.ok(props.conversation_id, 'has conversation_id');
  assert.ok(props.message, 'has message');
  assert.deepEqual(
    [...tool.inputSchema.required].sort(),
    ['conversation_id', 'message'],
    'both inputs required'
  );
  // Output schema advertises reply/thread_id/turn.
  assert.ok(tool.outputSchema, 'has outputSchema');
  const out = tool.outputSchema.properties;
  assert.ok(out.reply && out.thread_id && out.turn, 'output has reply, thread_id, turn');
});

test('a turn round-trips with structuredContent {reply, thread_id, turn}', async (t) => {
  const dir = freshDir();
  const { client } = await startClient({ stateDir: dir });
  t.after(async () => {
    await client.close();
    await fsp.rm(dir, { recursive: true, force: true });
  });

  const res = await client.callTool({
    name: 'codex_turn',
    arguments: { conversation_id: 'mcp-conv-1', message: 'ping' },
  });
  assert.notEqual(res.isError, true, 'should not be an error');
  assert.ok(res.structuredContent, 'has structuredContent');
  assert.equal(res.structuredContent.turn, 1);
  assert.ok(res.structuredContent.thread_id);
  assert.match(res.structuredContent.reply, /started: ping/);
  // Mirrored text content for clients ignoring structuredContent.
  assert.equal(res.content[0].text, res.structuredContent.reply);
});

test('resume over MCP keeps thread_id stable across calls', async (t) => {
  const dir = freshDir();
  const { client } = await startClient({ stateDir: dir });
  t.after(async () => {
    await client.close();
    await fsp.rm(dir, { recursive: true, force: true });
  });

  const r1 = await client.callTool({
    name: 'codex_turn',
    arguments: { conversation_id: 'mcp-conv-2', message: 'first' },
  });
  const r2 = await client.callTool({
    name: 'codex_turn',
    arguments: { conversation_id: 'mcp-conv-2', message: 'second' },
  });
  assert.equal(r1.structuredContent.thread_id, r2.structuredContent.thread_id);
  assert.equal(r2.structuredContent.turn, 2);
  assert.match(r2.structuredContent.reply, /continued/);
});

test('forced start failure surfaces as a LOUD MCP tool error (isError), not silent success', async (t) => {
  const dir = freshDir();
  const { client } = await startClient({ stateDir: dir, stubMode: 'fail-start' });
  t.after(async () => {
    await client.close();
    await fsp.rm(dir, { recursive: true, force: true });
  });

  const res = await client.callTool({
    name: 'codex_turn',
    arguments: { conversation_id: 'mcp-conv-fail', message: 'hello' },
  });
  assert.equal(res.isError, true, 'must be a loud tool error');
  assert.match(res.content[0].text, /failed/i);
  assert.ok(!res.structuredContent, 'no structuredContent on failure');
});

test('invalid conversation_id is rejected by input validation', async (t) => {
  const dir = freshDir();
  const { client } = await startClient({ stateDir: dir });
  t.after(async () => {
    await client.close();
    await fsp.rm(dir, { recursive: true, force: true });
  });

  // The SDK enforces the zod input schema and surfaces a LOUD validation error as an isError
  // tool result (the backend is never reached).
  const res = await client.callTool({
    name: 'codex_turn',
    arguments: { conversation_id: '../escape', message: 'x' },
  });
  assert.equal(res.isError, true, 'invalid input must be a loud error');
  assert.match(res.content[0].text, /validation|conversation_id|pattern/i);
  assert.ok(!res.structuredContent, 'no structuredContent on validation failure');
});
