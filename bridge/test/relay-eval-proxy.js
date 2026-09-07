'use strict';
// Transparent JSONL observer. Records the actual MCP requests/results on each side;
// neither chooses tool arguments nor synthesizes responses for Claude.
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { spawn } = require('node:child_process');
const audit = process.env.CODEX_BRIDGE_EVAL_AUDIT;
function record(direction, message) { fs.appendFileSync(audit, JSON.stringify({ direction, message }) + '\n'); }
const child = spawn(process.execPath, [path.join(__dirname, '..', 'index.js')], {
  stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true, shell: false,
});
record('process', { proxyPid: process.pid, bridgePid: child.pid });
child.on('error', (err) => { process.stderr.write(err.message + '\n'); process.exitCode = 1; });
child.stdin.on('error', () => {});
const incoming = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
incoming.on('line', (line) => { record('request', JSON.parse(line)); child.stdin.write(line + '\n'); });
incoming.on('close', () => child.stdin.end());
readline.createInterface({ input: child.stdout, crlfDelay: Infinity }).on('line', (line) => {
  record('response', JSON.parse(line)); process.stdout.write(line + '\n');
});
child.on('close', (code) => { incoming.close(); process.exit(code || 0); });
