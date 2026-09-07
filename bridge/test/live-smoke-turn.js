'use strict';
// One live smoke turn per bridge process. Parent supplies only temporary project/state paths.
const { CodexBackend } = require('../lib/codex-backend');
const { CodexBridge } = require('../lib/bridge');
async function main() {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  const req = JSON.parse(input);
  const backend = new CodexBackend({ cwd: req.project, readinessTimeoutMs: 30000, callTimeoutMs: 90000 });
  try {
    const result = await new CodexBridge(backend).turn('live-smoke', req.message, { working_dir: req.project, request_id: req.requestId });
    process.stdout.write(JSON.stringify({ result, childPid: backend._transport.nativePid, supervisorPid: backend._transport.child.pid }) + '\n');
  } finally { await backend.close(); }
}
main().catch((err) => { process.stderr.write(`${err.code}: ${err.message}\n`); process.exitCode = 1; });
