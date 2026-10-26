'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const YAML = require('yaml');

const ROOT = path.resolve(__dirname, '../..');
const skip = process.platform !== 'linux' ? 'native Linux installer test' :
  !fs.existsSync(path.join(ROOT, 'install.sh')) ? 'installer requires source checkout' : false;

test('Linux installer copies source, preserves state, registers and discovers real MCP, and updates idempotently', { skip, timeout: 180000 }, (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'linux install spaces & '));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const home = path.join(base, 'home');
  const bin = path.join(base, 'fake bin');
  const source = path.join(base, 'source checkout');
  for (const dir of [home, bin, source]) fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'install.sh'), path.join(source, 'install.sh'));
  fs.cpSync(path.join(ROOT, 'agent'), path.join(source, 'agent'), { recursive: true });
  fs.cpSync(path.join(ROOT, 'bridge'), path.join(source, 'bridge'), { recursive: true,
    filter: (p) => !['node_modules', 'state', '.state'].includes(path.basename(p)) });
  for (const name of ['state', '.state', 'node_modules']) {
    fs.mkdirSync(path.join(source, 'bridge', name), { recursive: true });
    fs.writeFileSync(path.join(source, 'bridge', name, 'DO_NOT_COPY'), name);
  }
  fs.writeFileSync(path.join(source, 'bridge', 'conversation.json'), 'private local state');
  const log = path.join(base, 'claude calls.jsonl');
  // This CLI only implements registration. The installed real doctor starts the
  // installed real bridge and performs SDK initialize/tools/list after it exits.
  fs.writeFileSync(path.join(bin, 'claude'), `#!${process.execPath}
const fs = require('node:fs'), path = require('node:path');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.INSTALL_TEST_LOG, JSON.stringify(args) + '\\n');
const file = process.env.CLAUDE_CONFIG_DIR ? path.join(process.env.CLAUDE_CONFIG_DIR, '.claude.json') : path.join(process.env.HOME, '.claude.json');
const config = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
if (args[0] !== 'mcp' || args[2] !== '--scope' || args[3] !== 'user' || args[4] !== 'codex_bridge') process.exit(2);
config.mcpServers ||= {};
if (args[1] === 'add-json') config.mcpServers.codex_bridge = JSON.parse(args[5]);
else if (args[1] === 'remove') delete config.mcpServers.codex_bridge;
else process.exit(3);
fs.mkdirSync(path.dirname(file), { recursive: true });
fs.writeFileSync(file, JSON.stringify(config));
`, { mode: 0o755 });
  const codexLog = path.join(base, 'codex called');
  fs.writeFileSync(path.join(bin, 'codex'), '#!/bin/sh\nprintf invoked > "$INSTALL_TEST_CODEX_LOG"\nexit 99\n', { mode: 0o755 });
  const env = { ...process.env, HOME: home, PATH: bin + path.delimiter + process.env.PATH,
    INSTALL_TEST_LOG: log, INSTALL_TEST_CODEX_LOG: codexLog };
  delete env.CLAUDE_CONFIG_DIR;
  delete env.CODEX_BRIDGE_STATE_DIR;
  function install(args = [], extraEnv = {}, expectedStatus = 0) {
    const result = spawnSync('/bin/sh', [path.join(source, 'install.sh'), ...args], {
      cwd: base, env: { ...env, ...extraEnv }, encoding: 'utf8', timeout: 60000,
    });
    assert.ifError(result.error);
    assert.equal(result.status, expectedStatus, result.stdout + result.stderr);
    if (expectedStatus === 0) {
      const diagnosis = result.stdout.split('\n').find(line => line.startsWith('{"connected":'));
      assert.ok(diagnosis, result.stdout);
      assert.deepEqual(JSON.parse(diagnosis).tools, ['codex_turn']);
      assert.equal(JSON.parse(diagnosis).connected, true);
      assert.equal(fs.existsSync(codexLog), false, 'MCP discovery must not invoke Codex');
    }
    return result;
  }
  const normalFile = path.join(home, '.claude.json');
  const unrelated = { theme: 'keep', mcpServers: { other: { command: 'unrelated' } } };
  fs.writeFileSync(normalFile, JSON.stringify(unrelated));
  const isolated = path.join(base, 'config spaces $&');
  fs.mkdirSync(isolated);
  fs.writeFileSync(path.join(isolated, '.claude.json'), JSON.stringify(unrelated));
  const state = path.join(isolated, 'state/codex-bridge');
  fs.mkdirSync(state, { recursive: true });
  fs.writeFileSync(path.join(state, 'existing.json'), 'keep state bytes\n');
  const overridden = path.join(base, 'ignored environment config');
  install(['--claude-config-dir', isolated], { CLAUDE_CONFIG_DIR: overridden });
  assert.equal(fs.existsSync(overridden), false, 'explicit option takes precedence over environment');
  const installed = path.join(isolated, 'bridges/codex-bridge');
  const config = JSON.parse(fs.readFileSync(path.join(isolated, '.claude.json')));
  assert.deepEqual(config.mcpServers.other, unrelated.mcpServers.other);
  assert.equal(config.theme, 'keep');
  assert.deepEqual(config.mcpServers.codex_bridge, { type: 'stdio', command: process.execPath,
    args: [path.join(installed, 'index.js')], env: { CODEX_BRIDGE_STATE_DIR: state } });
  const parsed = YAML.parse(fs.readFileSync(path.join(isolated, 'agents/codex-peer.md'), 'utf8').split(/^---\s*$/m)[1]);
  assert.deepEqual(parsed.mcpServers, [{ codex_bridge: config.mcpServers.codex_bridge }]);
  for (const helper of ['posix-process-runner.js', 'windows-job-runner.cs', 'windows-job-runner.ps1']) {
    assert.equal(fs.readFileSync(path.join(installed, 'lib', helper), 'utf8'), fs.readFileSync(path.join(source, 'bridge/lib', helper), 'utf8'));
  }
  for (const name of ['state', '.state']) assert.equal(fs.existsSync(path.join(installed, name)), false);
  assert.equal(fs.existsSync(path.join(installed, 'node_modules/DO_NOT_COPY')), false);
  assert.equal(fs.existsSync(path.join(installed, 'conversation.json')), false);
  fs.writeFileSync(path.join(installed, 'operator-note.txt'), 'preserve');
  fs.writeFileSync(path.join(installed, 'index.js'), 'outdated managed source');
  const callsBefore = fs.readFileSync(log, 'utf8');
  const rerun = install([], { CLAUDE_CONFIG_DIR: isolated });
  assert.match(rerun.stdout, /Already registered/);
  assert.equal(fs.readFileSync(log, 'utf8'), callsBefore, 'idempotent registration invokes no CLI mutation');
  assert.equal(fs.readFileSync(path.join(installed, 'index.js'), 'utf8'), fs.readFileSync(path.join(source, 'bridge/index.js'), 'utf8'));
  assert.equal(fs.readFileSync(path.join(installed, 'operator-note.txt'), 'utf8'), 'preserve');
  assert.equal(fs.readFileSync(path.join(state, 'existing.json'), 'utf8'), 'keep state bytes\n');
  assert.deepEqual(JSON.parse(fs.readFileSync(normalFile)), unrelated, 'isolated install leaves default config intact');
  // Absence of CLAUDE_CONFIG_DIR must retain Claude's normal ~/.claude.json lookup.
  install();
  const normal = JSON.parse(fs.readFileSync(normalFile));
  assert.deepEqual(normal.mcpServers.other, unrelated.mcpServers.other);
  assert.equal(normal.mcpServers.codex_bridge.env, undefined);
  assert.equal(normal.mcpServers.codex_bridge.args[0], path.join(home, '.claude/bridges/codex-bridge/index.js'));
  assert.equal(fs.existsSync(path.join(home, '.claude/.claude.json')), false);
  const rejected = install(['--claude-config-dir', path.join(source, 'bridge', 'nested')], {}, 1);
  assert.match(rejected.stderr, /must not overlap/);
  assert.equal(fs.existsSync(path.join(source, 'bridge/nested')), false);
});
