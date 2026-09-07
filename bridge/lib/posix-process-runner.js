'use strict';
// Keep the process-group leader alive until escalation, even if Codex has already exited.
// This avoids signaling a recycled PGID after the original group has disappeared.
// Descendants that deliberately create a new session are outside this group boundary.
const { spawn } = require('node:child_process');
const launch = JSON.parse(Buffer.from(process.argv[2], 'base64').toString('utf8'));
let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  process.kill(-process.pid, 'SIGTERM');
  // Stay alive to own the group identity until SIGKILL, including stubborn descendants.
  setTimeout(() => process.kill(-process.pid, 'SIGKILL'), 500);
}
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
const child = spawn(launch.command, launch.args, { cwd: launch.cwd, stdio: 'inherit', shell: false });
if (child.pid) process.stderr.write(`codex-bridge-child-pid:${child.pid}\n`);
child.on('error', (err) => { process.stderr.write(`Codex process supervisor: ${err.message}\n`); stop(); });
child.on('exit', stop);
