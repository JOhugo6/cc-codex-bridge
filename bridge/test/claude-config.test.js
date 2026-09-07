'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const YAML = require('yaml');
const { serverConfig, renderAgent, configFile, readRegistration, register } = require('../claude-config');
const { diagnose } = require('../doctor');

const ROOT = path.resolve(__dirname, '../..');
const TEMPLATE = fs.readFileSync(path.join(ROOT, 'agent/codex-peer.md.template'), 'utf8');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge config spaces & '));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('rendered YAML preserves native command, arguments and isolated state; tool lists permit reply delivery', async (t) => {
  const dir = fixture(t);
  const bridgeDir = path.join(dir, "bridge $& $$ $` $' {{NODE_ENV_JSON}}");
  fs.mkdirSync(bridgeDir);
  // Start the real bridge from a generated path containing spaces and shell punctuation.
  fs.writeFileSync(path.join(bridgeDir, 'index.js'), `require(${JSON.stringify(path.join(ROOT, 'bridge/index.js'))});`);
  const config = serverConfig(bridgeDir, process.execPath, path.join(dir, 'private state'));
  const rendered = renderAgent(TEMPLATE, config);
  const parsed = YAML.parse(rendered.split(/^---\s*$/m)[1]);
  assert.deepEqual(parsed.mcpServers, [{ codex_bridge: config }]);
  const allowed = parsed.tools.split(/,\s*/);
  const denied = parsed.disallowedTools.split(/,\s*/);
  assert.deepEqual(allowed.sort(), ['SendMessage', 'mcp__codex_bridge__codex_turn']);
  assert.ok(allowed.every((tool) => !denied.includes(tool)));
  const result = await diagnose(parsed.mcpServers[0].codex_bridge);
  assert.equal(result.connected, true);
  assert.deepEqual(result.tools, ['codex_turn']);
  assert.equal(fs.existsSync(config.env.CODEX_BRIDGE_STATE_DIR), false, 'doctor must not create state');
});

test('rendering uses YAML escaping, including quotes and line breaks in path data', () => {
  const config = { type: 'stdio', command: '/native/a "quote"/node', args: ['/bridge/a\nline/index.js'], env: { CODEX_BRIDGE_STATE_DIR: '/state/\\data' } };
  const parsed = YAML.parse(renderAgent(TEMPLATE, config).split(/^---\s*$/m)[1]);
  assert.deepEqual(parsed.mcpServers[0].codex_bridge, config);
});

test('parsed YAML retains dollar substitution sequences and template-looking path data literally', () => {
  const literals = ['$$', '$&', '$`', "$'", '$1', '$99', '$<name>',
    '{{NODE_COMMAND_JSON}}', '{{NODE_ARGS_JSON}}', '{{NODE_ENV_JSON}}'];
  for (const literal of literals) {
    const config = {
      type: 'stdio',
      command: `C:\\native\\${literal}\\node.exe`,
      args: [`C:\\bridge\\${literal}\\index.js`],
      env: { CODEX_BRIDGE_STATE_DIR: `C:\\state\\${literal}` },
    };
    const parsed = YAML.parse(renderAgent(TEMPLATE, config).split(/^---\s*$/m)[1]);
    assert.deepEqual(parsed.mcpServers[0].codex_bridge, config, `literal ${literal}`);
  }
});

test('normal config lookup remains outside .claude; explicit and environment directories are isolated', () => {
  assert.equal(configFile(''), path.join(os.homedir(), '.claude.json'));
  assert.equal(configFile(path.join(os.homedir(), '.claude')), path.join(os.homedir(), '.claude', '.claude.json'));
  assert.equal(serverConfig(ROOT).env, undefined);
});

test('child environment retains normal user JSON lookup unless CLAUDE_CONFIG_DIR is supplied', (t) => {
  const dir = fixture(t);
  const script = path.join(dir, 'lookup.js');
  fs.writeFileSync(script, `
    const { configFile } = require(${JSON.stringify(path.join(ROOT, 'bridge/claude-config.js'))});
    process.stdout.write(JSON.stringify({ file: configFile(), home: require('node:os').homedir() }));
  `);
  const env = { ...process.env, USERPROFILE: dir, HOME: dir };
  delete env.CLAUDE_CONFIG_DIR;
  const normal = spawnSync(process.execPath, [script], { encoding: 'utf8', env, windowsHide: true, timeout: 5000 });
  assert.equal(normal.status, 0, normal.stderr);
  assert.deepEqual(JSON.parse(normal.stdout), { home: dir, file: path.join(dir, '.claude.json') });
  const explicit = spawnSync(process.execPath, [script], {
    encoding: 'utf8', env: { ...env, CLAUDE_CONFIG_DIR: path.join(dir, '.claude') }, windowsHide: true, timeout: 5000,
  });
  assert.equal(explicit.status, 0, explicit.stderr);
  assert.deepEqual(JSON.parse(explicit.stdout), { home: dir, file: path.join(dir, '.claude', '.claude.json') });
  assert.deepEqual(fs.readdirSync(dir), ['lookup.js']);
});

// This executable fixture receives the same add-json/remove argv as Claude. Its
// filesystem effects exercise preservation, rollback and quoted argument delivery.
function cliFixture(dir) {
  const file = path.join(dir, 'fake claude.js');
  fs.writeFileSync(file, `
    const fs = require('node:fs'), path = require('node:path');
    const args = process.argv.slice(2), file = path.join(process.env.CLAUDE_CONFIG_DIR, '.claude.json');
    const data = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
    if (args[0] !== 'mcp' || args[2] !== '--scope' || args[3] !== 'user') process.exit(9);
    data.mcpServers ||= {};
    if (args[1] === 'remove') delete data.mcpServers[args[4]];
    else if (args[1] === 'add-json') data.mcpServers[args[4]] = JSON.parse(args[5]);
    else process.exit(8);
    fs.writeFileSync(file, JSON.stringify(data));
  `);
  return (exe, args, env) => spawnSync(process.execPath, [file, ...args], { encoding: 'utf8', env, windowsHide: true, timeout: 5000 });
}

test('registration adds, updates and repeats idempotently without changing unrelated config', (t) => {
  const dir = fixture(t);
  const run = cliFixture(dir);
  const file = configFile(dir);
  fs.writeFileSync(file, JSON.stringify({ setting: 'keep', mcpServers: { unrelated: { command: 'keep' } } }));
  const options = { claudeExe: 'fixture.exe', bridgeDir: path.join(dir, 'one & bridge'), configDir: dir, run };
  assert.equal(register(options).changed, true);
  const first = fs.readFileSync(file, 'utf8');
  assert.equal(register(options).changed, false);
  assert.equal(fs.readFileSync(file, 'utf8'), first);
  assert.equal(register({ ...options, bridgeDir: path.join(dir, 'updated bridge') }).changed, true);
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(data.setting, 'keep');
  assert.deepEqual(data.mcpServers.unrelated, { command: 'keep' });
  assert.equal(data.mcpServers.codex_bridge.env.CODEX_BRIDGE_STATE_DIR, path.join(dir, 'state', 'codex-bridge'));
  assert.equal(data.mcpServers.codex_bridge.command, process.execPath);
});

test('failed replacement restores previous registration and corrupt config is never overwritten', (t) => {
  const dir = fixture(t);
  const run = cliFixture(dir);
  const options = { claudeExe: 'fixture.exe', bridgeDir: dir, configDir: dir, run };
  register(options);
  const old = readRegistration(configFile(dir));
  let adds = 0;
  const failing = (exe, args, env) => {
    if (args[1] === 'add-json' && ++adds === 1) throw new Error('timed out');
    return run(exe, args, env);
  };
  assert.throws(() => register({ ...options, bridgeDir: path.join(dir, 'updated'), run: failing }), /Previous registration restored/);
  assert.deepEqual(readRegistration(configFile(dir)), old);
  fs.writeFileSync(configFile(dir), '{broken');
  assert.throws(() => register(options), SyntaxError);
  assert.equal(fs.readFileSync(configFile(dir), 'utf8'), '{broken');
});

test('doctor fails on absent registration and a registered but nonexistent command', async (t) => {
  const dir = fixture(t);
  const file = path.join(dir, 'empty.json');
  fs.writeFileSync(file, '{}');
  assert.throws(() => readRegistration(file), /not registered/);
  await assert.rejects(diagnose({ command: path.join(dir, 'missing.exe'), args: [] }), /ENOENT|not found|Connection closed/);
});

test('doctor rejects incompatible tools over an actual MCP protocol connection', async (t) => {
  const dir = fixture(t);
  const file = path.join(dir, 'protocol stub.js');
  fs.writeFileSync(file, `
    const readline = require('node:readline');
    readline.createInterface({ input: process.stdin }).on('line', (line) => {
      const r = JSON.parse(line); if (r.id === undefined) return;
      const result = r.method === 'initialize' ? {
        protocolVersion: r.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'wrong', version: '1' }
      } : { tools: [] };
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: r.id, result }) + '\\n');
    });
  `);
  await assert.rejects(diagnose({ command: process.execPath, args: [file] }), /does not expose exactly codex_turn/);
});

test('doctor bounds a hanging initialize and terminates its child', async (t) => {
  const dir = fixture(t);
  const pidFile = path.join(dir, 'pid');
  const file = path.join(dir, 'hang.js');
  fs.writeFileSync(file, `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); process.stdin.resume(); setInterval(() => {}, 100);`);
  const started = Date.now();
  await assert.rejects(diagnose({ command: process.execPath, args: [file] }, { timeoutMs: 1000 }), /timed out/);
  assert.ok(Date.now() - started < 5000);
  const pid = Number(fs.readFileSync(pidFile, 'utf8'));
  assert.throws(() => process.kill(pid, 0), /ESRCH/);
});

test('Windows PowerShell 5.1 parses both installation scripts', { skip: process.platform !== 'win32' }, () => {
  const script = `
    $errorsFound = @()
    foreach ($file in $args) {
      $parseErrors = $null
      $null = [System.Management.Automation.Language.Parser]::ParseFile($file, [ref]$null, [ref]$parseErrors)
      $errorsFound += $parseErrors
    }
    if ($errorsFound.Count) { $errorsFound | Out-String | Write-Output; exit 1 }
  `;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-ps-parse-'));
  try {
    const runner = path.join(dir, 'parse.ps1');
    fs.writeFileSync(runner, script);
    const result = spawnSync(path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', runner, path.join(ROOT, 'install.ps1'), path.join(ROOT, 'bridge/register.ps1')],
      { encoding: 'utf8', windowsHide: true, timeout: 10000 });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
