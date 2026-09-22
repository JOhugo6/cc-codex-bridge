'use strict';
// Opt in with CODEX_BRIDGE_LIVE=1. Uses existing Codex login, temporary state/project,
// full-access sandbox, two bounded turns and separate bridge + App Server processes.
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs/promises');
const { spawn } = require('node:child_process');

function runTurn(dir, project, message, requestId) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, 'live-smoke-turn.js')], {
      cwd: project, env: { ...process.env, CODEX_BRIDGE_STATE_DIR: path.join(dir, 'state') },
      stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: false,
    });
    let output = '', diagnostics = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { diagnostics += chunk; });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code !== 0) { reject(new Error(`Smoke process exited ${code}: ${diagnostics}`)); return; }
      try { resolve(JSON.parse(output)); } catch (err) { reject(err); }
    });
    child.stdin.end(JSON.stringify({ project, message, requestId }));
  });
}

test('live App Server: exact context survives bridge and backend process restart',
  { skip: process.env.CODEX_BRIDGE_LIVE !== '1' && 'set CODEX_BRIDGE_LIVE=1; authenticated Codex required', timeout: 210000 }, async (t) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex bridge live '));
    const project = path.join(dir, 'empty project'); await fs.mkdir(project);
    await fs.mkdir(path.join(dir, 'state'));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const magic = 'PURPLE-' + require('node:crypto').randomUUID();
    const first = await runTurn(dir, project, `Remember this exact token: ${magic}. Reply only OK. Do not use tools.`, 'first');
    assert.equal(first.result.turn, 1); assert.ok(first.result.thread_id);
    assert.ok(first.childPid); assert.ok(first.supervisorPid);
    assert.throws(() => process.kill(first.childPid, 0), { code: 'ESRCH' });
    assert.throws(() => process.kill(first.supervisorPid, 0), { code: 'ESRCH' });
    const second = await runTurn(dir, project, 'What exact token did I ask you to remember? Reply with just that token. Do not use tools.', 'second');
    assert.equal(second.result.turn, 2);
    assert.equal(second.result.thread_id, first.result.thread_id);
    assert.equal(second.result.reply.trim(), magic);
    assert.notEqual(second.childPid, first.childPid);
    assert.ok(second.childPid); assert.ok(second.supervisorPid);
    assert.throws(() => process.kill(second.childPid, 0), { code: 'ESRCH' });
    assert.throws(() => process.kill(second.supervisorPid, 0), { code: 'ESRCH' });
    // The sandbox no longer forbids writes, so this records that these two prompts caused none.
    assert.deepEqual(await fs.readdir(project), [], 'memory-only prompts write nothing into the project');
    t.diagnostic(`two separate bridge/App Server processes, thread ${first.result.thread_id}, both Codex children reaped`);
  });
