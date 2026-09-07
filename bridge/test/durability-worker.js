'use strict';
// Real process-crash fixture. It deliberately exits without releasing the conversation lock.
const fs = require('node:fs');
const path = require('node:path');
const store = require('../lib/store');
const { CodexBridge } = require('../lib/bridge');
const [id, fault = '', message = 'hello', requestId = 'request-1'] = process.argv.slice(2);

function crash(point) { if (fault === point) process.exit(73); }
const write = store.writeJsonAtomic;
store.writeJsonAtomic = async (file, data) => {
  const stage = file.endsWith('.operations.json') ? data.operations.at(-1).status : 'state';
  crash(`${stage}:before`);
  await write(file, data);
  crash(`${stage}:after`);
};
const append = store.appendTranscript;
const saveState = store.saveState;
store.saveState = async (...args) => {
  crash('state:before');
  await saveState(...args);
  crash('state:after');
};
store.appendTranscript = async (conversationId, entry) => {
  crash(`${entry.direction}:before`);
  await append(conversationId, entry);
  crash(`${entry.direction}:after`);
};
function call(kind, threadId, prompt) {
  fs.appendFileSync(path.join(process.env.CODEX_BRIDGE_STATE_DIR, 'backend-calls.jsonl'), JSON.stringify({ kind, threadId, prompt }) + '\n');
  crash('backend:after');
  return { threadId, content: `exact\r\n${prompt}\n\těšč 🦦\n` };
}
const backend = {
  async startSession(prompt) { return call('start', 'durable-thread', prompt); },
  async continueSession(threadId, prompt) { return call('resume', threadId, prompt); },
};
new CodexBridge(backend, { lockOpts: { staleMs: 0, timeoutMs: 3000, pollMs: 5 } })
  .turn(id, message, requestId === '-' ? {} : { request_id: requestId })
  .then((result) => process.stdout.write(JSON.stringify(result)))
  .catch((err) => { process.stderr.write(`${err.code}: ${err.message}`); process.exitCode = 1; });
