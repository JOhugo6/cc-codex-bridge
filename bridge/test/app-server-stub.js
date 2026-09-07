'use strict';
// Deterministic JSONL App Server child: disk-backed threads survive a transport restart.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const dir = process.argv[2];
const dbPath = path.join(dir, 'threads.json');
const log = (data) => fs.appendFileSync(path.join(dir, 'wire.jsonl'), JSON.stringify(data) + '\n');
const send = (data) => process.stdout.write(JSON.stringify(data) + '\n');
const notify = (method, params) => send({ method, params });
const config = () => JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
let initialized = false, handshook = false, busy = false, last = null;
log({ pid: process.pid });
if (config().descendant) {
  const child = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"],
    { stdio: 'ignore', windowsHide: true, detached: process.platform === 'win32' });
  log({ descendantPid: child.pid });
}
require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {
  const req = JSON.parse(line), mode = config().mode;
  log(req);
  if (!req.method) return; // response to unsupported server request
  const answer = (result) => send({ id: req.id, result });
  const rpcError = (message) => send({ id: req.id, error: { code: -32000, message } });
  if (req.method === 'initialize') {
    assert.equal(initialized, false);
    assert.equal(req.params.clientInfo.name, 'codex-bridge');
    if (mode === 'silent-init') return;
    if (mode === 'invalid-json') { process.stdout.write('not JSON\n'); return; }
    if (mode === 'bad-init') { answer({}); return; }
    handshook = true; answer({ userAgent: 'codex-stub/0.153.4' }); return;
  }
  if (req.method === 'initialized') { assert.ok(handshook); initialized = true; return; }
  assert.ok(initialized, 'initialize and initialized must precede all operations');
  const p = req.params;
  const db = fs.existsSync(dbPath) ? JSON.parse(fs.readFileSync(dbPath, 'utf8')) : {};
  const save = () => fs.writeFileSync(dbPath, JSON.stringify(db));
  if (req.method === 'thread/read') {
    if (mode === 'read-error' || !db[p.threadId]) { rpcError('thread not found'); return; }
    answer({ thread: { id: mode === 'read-drift' ? 'wrong-thread' : p.threadId,
      cwd: mode === 'read-no-cwd' ? null : mode === 'read-missing-dir' ? path.join(dir, 'missing') : db[p.threadId].cwd } }); return;
  }
  if (req.method === 'thread/start' || req.method === 'thread/resume') {
    assert.equal(p.approvalPolicy, 'never'); assert.equal(p.sandbox, 'read-only');
    assert.ok(path.isAbsolute(p.cwd));
    const start = req.method === 'thread/start';
    const id = start ? `thread-${Object.keys(db).length + 1}` : p.threadId;
    if (start) { db[id] = { cwd: p.cwd, prompts: [] }; save(); }
    else {
      if (mode === 'resume-error' || !db[id]) { rpcError('resume failed'); return; }
      assert.equal(p.cwd, db[id].cwd);
    }
    answer({ thread: { id: mode === 'no-thread' ? undefined : mode === 'resume-drift' && !start ? 'wrong-thread' : id },
      cwd: mode === 'cwd-drift' ? path.dirname(p.cwd) : p.cwd,
      approvalPolicy: 'never', sandbox: { type: mode === 'unsafe-policy' ? 'workspaceWrite' : 'readOnly', networkAccess: false } });
    return;
  }
  if (req.method === 'turn/interrupt') {
    answer({}); busy = false;
    notify('turn/completed', { threadId: p.threadId, turn: { id: p.turnId, status: 'interrupted', items: [] } }); return;
  }
  assert.equal(req.method, 'turn/start');
  assert.equal(busy, false, 'concurrent turns are forbidden'); busy = true;
  assert.equal(p.approvalPolicy, 'never');
  assert.deepEqual(p.sandboxPolicy, { type: 'readOnly', networkAccess: false });
  assert.equal(p.cwd, db[p.threadId].cwd);
  const prompt = p.input[0].text;
  db[p.threadId].prompts.push(prompt); save();
  const turnId = `turn-${db[p.threadId].prompts.length}`;
  const turn = { id: turnId, status: 'inProgress', items: [] };
  const scope = { threadId: p.threadId, turnId };
  if (last) { notify('item/completed', { ...last, item: { id: 'late', type: 'agentMessage', text: 'LATE GARBAGE', phase: 'final_answer' } }); }
  notify('turn/started', { threadId: p.threadId, turn });
  if (mode !== 'early-events') answer({ turn });
  if (mode === 'hang') return;
  if (mode === 'disconnect') { process.exit(7); return; }
  if (mode === 'server-request') { send({ id: 'approval', method: 'item/commandExecution/requestApproval', params: scope }); return; }
  if (mode === 'wrong-thread') { notify('item/completed', { ...scope, threadId: 'wrong-thread', item: {} }); return; }
  if (mode === 'wrong-turn') { notify('item/completed', { ...scope, turnId: 'wrong-turn', item: {} }); return; }
  if (mode === 'error-event') { notify('error', { ...scope, willRetry: false, error: { message: 'terminal event failure' } }); return; }
  if (mode === 'retry-event') notify('error', { ...scope, willRetry: true, error: { message: 'temporary' } });
  const text = mode === 'empty' ? ' \n\t' : prompt === 'recall' ? db[p.threadId].prompts[0] : '  žluťoučký 😀\r\n```diff\r\n+ exact\t \r\n```\r\n';
  const item = { id: 'answer', type: 'agentMessage', phase: 'final_answer', text };
  notify('item/completed', { ...scope, item: { id: 'progress', type: 'agentMessage', phase: 'commentary', text: 'Thinking...' } });
  for (let i = 0; i < 2; i++) notify('item/agentMessage/delta', { ...scope, itemId: item.id, delta: 'DUPLICATE PARTIAL' });
  if (mode !== 'terminal-items-only') {
    notify('item/completed', { ...scope, item });
    notify('item/completed', { ...scope, item: mode === 'conflicting-item' ? { ...item, text: 'wrong' } : item });
  }
  const completed = { threadId: p.threadId, turn: { id: turnId,
    status: mode === 'failed-turn' ? 'failed' : mode === 'interrupted-turn' ? 'interrupted' : 'completed',
    error: mode === 'failed-turn' ? { message: 'failed completion' } : null,
    items: mode === 'event-items-only' ? [] : [item] } };
  const complete = () => {
    busy = false;
    notify('turn/completed', completed);
    notify('turn/completed', completed);
    if (mode === 'early-events') answer({ turn });
    last = scope;
  };
  if (mode === 'delay') setTimeout(complete, 30); else complete();
});
