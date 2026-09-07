#!/usr/bin/env node
'use strict';

const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
const { configFile, readRegistration } = require('./claude-config');

async function diagnose(config, { timeoutMs = 15000 } = {}) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) throw new Error('timeout must be 1..60000 ms');
  if (!config || (config.type && config.type !== 'stdio') || typeof config.command !== 'string' ||
      !Array.isArray(config.args) || config.args.some((a) => typeof a !== 'string')) {
    throw new Error('codex_bridge registration must be a stdio command with string arguments');
  }
  const transport = new StdioClientTransport({
    command: config.command, args: config.args, cwd: config.cwd,
    env: { ...process.env, ...config.env }, stderr: 'pipe',
  });
  // Always drain diagnostic stderr; a noisy failed child must not block its pipe.
  transport.stderr?.on('data', () => {});
  const client = new Client({ name: 'codex-bridge-doctor', version: '1.0.0' });
  let timer;
  try {
    return await Promise.race([
      (async () => {
        await client.connect(transport);
        const { tools } = await client.listTools();
        const turn = tools.find((tool) => tool.name === 'codex_turn');
        if (tools.length !== 1 || !turn) throw new Error('Connected server does not expose exactly codex_turn');
        const schemas = [turn.inputSchema, ...(turn.inputSchema?.oneOf || []), ...(turn.inputSchema?.anyOf || [])];
        if (!schemas.some((schema) => schema.properties?.envelope?.type === 'string')) {
          throw new Error('Connected codex_turn does not advertise the raw envelope contract');
        }
        return { connected: true, server: client.getServerVersion(), tools: ['codex_turn'],
          backend: 'not checked (lazy startup); no model call or conversation created' };
      })(),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`MCP initialize/tools check timed out after ${timeoutMs} ms`)), timeoutMs); }),
    ]);
  } finally {
    clearTimeout(timer);
    // SDK close closes stdin and escalates termination of a nonresponsive child.
    await transport.close();
  }
}

async function main(args) {
  let file = configFile();
  let timeoutMs = 15000;
  for (let i = 0; i < args.length; i += 2) {
    if (!args[i + 1]) throw new Error('Missing doctor option value');
    if (args[i] === '--config-file') file = args[i + 1];
    else if (args[i] === '--timeout-ms') timeoutMs = Number(args[i + 1]);
    else throw new Error(`Unknown option: ${args[i]}`);
  }
  process.stdout.write(JSON.stringify(await diagnose(readRegistration(file), { timeoutMs })) + '\n');
}

if (require.main === module) main(process.argv.slice(2)).catch((err) => {
  process.stderr.write(`CODEX-BRIDGE DOCTOR ERROR: ${err.message}\n`);
  process.exitCode = 1;
});

module.exports = { diagnose };
