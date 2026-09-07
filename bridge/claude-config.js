'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const SERVER_NAME = 'codex_bridge';

function serverConfig(bridgeDir, nodeExe = process.execPath, stateDir) {
  const config = { type: 'stdio', command: path.resolve(nodeExe), args: [path.resolve(bridgeDir, 'index.js')] };
  if (stateDir) config.env = { CODEX_BRIDGE_STATE_DIR: path.resolve(stateDir) };
  return config;
}

function renderAgent(template, config) {
  // JSON quoted strings are valid YAML scalars, including paths with spaces,
  // quotes and backslashes. Never interpolate an unescaped path into YAML.
  const replacements = {
    NODE_COMMAND_JSON: JSON.stringify(config.command),
    NODE_ARGS_JSON: JSON.stringify(config.args),
    NODE_ENV_JSON: JSON.stringify(config.env || {}),
  };
  // Match only the original template once. A callback inserts literal values:
  // dollar replacement syntax and token-looking path data must not be expanded.
  return template.replace(/\{\{(NODE_COMMAND_JSON|NODE_ARGS_JSON|NODE_ENV_JSON)\}\}/g,
    (_, token) => replacements[token]);
}

function configFile(configDir = process.env.CLAUDE_CONFIG_DIR) {
  return configDir ? path.resolve(configDir, '.claude.json') : path.join(os.homedir(), '.claude.json');
}

function readRegistration(file, name = SERVER_NAME) {
  const config = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  const server = config.mcpServers?.[name];
  if (!server) throw new Error(`MCP server '${name}' is not registered in ${file}`);
  return server;
}

function runClaude(claudeExe, args, env) {
  // A native executable needs no cmd /c wrapper. In particular, never pass JSON
  // through PowerShell 5.1's legacy native argument quoting or a command shell.
  if (process.platform === 'win32' && path.extname(claudeExe).toLowerCase() !== '.exe') {
    throw new Error('Registration requires the native Claude Code .exe on Windows.');
  }
  const result = spawnSync(claudeExe, args, {
    shell: false, windowsHide: true, encoding: 'utf8', env, timeout: 30000, maxBuffer: 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.signal) throw new Error(`Claude registration command terminated: ${result.signal}`);
  return result;
}

function register({ claudeExe, bridgeDir, configDir = process.env.CLAUDE_CONFIG_DIR, nodeExe = process.execPath, run = runClaude }) {
  const config = serverConfig(bridgeDir, nodeExe, configDir && path.resolve(configDir, 'state', 'codex-bridge'));
  const file = configFile(configDir);
  const env = { ...process.env };
  if (configDir) env.CLAUDE_CONFIG_DIR = path.resolve(configDir);
  // Read before changing anything; corrupt config must not be treated as absent.
  const prior = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')) : {};
  const oldServer = prior.mcpServers?.[SERVER_NAME];
  if (oldServer && JSON.stringify(oldServer) === JSON.stringify(config)) return { file, config, changed: false };
  if (oldServer) {
    const removed = run(claudeExe, ['mcp', 'remove', '--scope', 'user', SERVER_NAME], env);
    if (removed.status !== 0) throw new Error(`Claude MCP remove failed: ${removed.stderr || removed.stdout}`);
  }
  const addArgs = ['mcp', 'add-json', '--scope', 'user', SERVER_NAME, JSON.stringify(config)];
  let added;
  try { added = run(claudeExe, addArgs, env); }
  catch (err) { added = { status: 1, stderr: err.message }; }
  if (added.status !== 0) {
    let restored = '';
    if (oldServer) {
      try {
        const rollback = run(claudeExe, [...addArgs.slice(0, -1), JSON.stringify(oldServer)], env);
        restored = rollback.status === 0 ? ' Previous registration restored.' : ' Could not restore previous registration.';
      } catch { restored = ' Could not restore previous registration.'; }
    }
    throw new Error(`Claude MCP add failed: ${added.stderr || added.stdout}${restored}`);
  }
  const actual = readRegistration(file);
  if (actual.command !== config.command || JSON.stringify(actual.args) !== JSON.stringify(config.args) ||
      JSON.stringify(actual.env || {}) !== JSON.stringify(config.env || {})) {
    throw new Error(`Claude wrote an unexpected registration to ${file}`);
  }
  return { file, config: actual, changed: true };
}

async function main(args) {
  const [action, ...rest] = args;
  if (action === 'render' && rest.length >= 3 && rest.length <= 4) {
    const [template, bridgeDir, output, stateDir] = rest;
    fs.writeFileSync(output, renderAgent(fs.readFileSync(template, 'utf8'), serverConfig(bridgeDir, process.execPath, stateDir)), 'utf8');
  } else if (action === 'register' && rest.length >= 2 && rest.length <= 3) {
    const [claudeExe, bridgeDir, configDir] = rest;
    const { file, changed } = register({ claudeExe, bridgeDir, configDir });
    process.stdout.write(`${changed ? 'Registered' : 'Already registered'} ${SERVER_NAME}: ${file}\n`);
    const { diagnose } = require('./doctor');
    const result = await diagnose(readRegistration(file));
    process.stdout.write(JSON.stringify(result) + '\n');
  } else throw new Error('Usage: claude-config.js render <template> <bridge-dir> <output> [state-dir] | register <claude-exe> <bridge-dir> [claude-config-dir]');
}

module.exports = { SERVER_NAME, serverConfig, renderAgent, configFile, readRegistration, register };

if (require.main === module) main(process.argv.slice(2)).catch((err) => {
  process.stderr.write(`CODEX-BRIDGE CONFIG ERROR: ${err.message}\n`);
  process.exitCode = 1;
});
