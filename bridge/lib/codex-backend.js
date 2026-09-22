'use strict';
// Native Codex App Server v2 over stdio JSONL (CLI 0.153.4, re-verified against 0.155.1).
// Public codex_turn stays MCP. Threads run with approvalPolicy 'never' and the
// danger-full-access sandbox: Codex 0.155.1 auto-approves MCP tool calls only under full
// access. In any sandboxed mode it rejects them internally under 'never' - the client is
// never asked - and the approval it wants can only be granted under 'on-request', which
// needs a client that answers mcpServer/elicitation/request. Callers therefore get an
// unsandboxed Codex with write and network capability, not a read-only reader. Note the
// guard below only checks thread/start's echo; turn/start returns no policy, so the
// sandbox actually in force for a turn cannot be verified through this protocol.
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { AppServerTransport, failure } = require('./app-server-transport');
const workingDir = require('./working-dir');

function executable(file) { try { fs.accessSync(file, fs.constants.X_OK); return true; } catch { return false; } }

function pickCommand(overrideCommand, overrideArgs) {
  if (overrideCommand) {
    if (!path.isAbsolute(overrideCommand)) throw failure('CODEX_NOT_FOUND', 'Backend command override must be an absolute executable path.');
    return { command: overrideCommand, args: overrideArgs || ['app-server'], useShell: false };
  }
  for (const entry of (process.env.PATH || process.env.Path || '').split(path.delimiter)) {
    const dir = entry.replace(/^"|"$/g, '');
    if (!path.isAbsolute(dir)) continue;
    const native = path.join(dir, process.platform === 'win32' ? 'codex.exe' : 'codex');
    if (executable(native)) return { command: native, args: ['app-server'], useShell: false };
    if (process.platform !== 'win32' || !executable(path.join(dir, 'codex.cmd'))) continue;
    // npm .cmd launchers require a shell. Resolve the package's native executable instead,
    // avoiding quoting and an intermediate process that can orphan Codex on Windows.
    const pkg = path.join(dir, 'node_modules', '@openai', 'codex', 'package.json');
    if (!fs.existsSync(pkg)) continue;
    const target = { x64: 'x86_64', arm64: 'aarch64' }[process.arch];
    if (!target) continue;
    const triple = `${target}-pc-windows-msvc`;
    let vendor;
    try { vendor = path.join(path.dirname(createRequire(pkg).resolve(`@openai/codex-win32-${process.arch}/package.json`)), 'vendor'); }
    catch { vendor = path.join(path.dirname(pkg), 'vendor'); }
    for (const subdir of ['bin', 'codex']) {
      const command = path.join(vendor, triple, subdir, 'codex.exe');
      if (executable(command)) return { command, args: ['app-server'], useShell: false };
    }
  }
  throw failure('CODEX_NOT_FOUND', 'Cannot resolve native Codex on PATH. Install @openai/codex including its platform package, or put codex.exe on PATH.');
}

function requireId(value, code, label) {
  if (typeof value !== 'string' || !value) throw failure(code, `App Server returned no ${label}.`);
  return value;
}

class CodexBackend {
  constructor(opts = {}) {
    this._transport = null;
    this._active = null;
    this._closed = false;
    this._callMutexTail = Promise.resolve();
    this._callTimeoutMs = opts.callTimeoutMs ?? 600000;
    this._readinessTimeoutMs = opts.readinessTimeoutMs ?? 60000;
    this._interruptTimeoutMs = opts.interruptTimeoutMs ?? 1000;
    this._overrideCommand = opts.command;
    this._overrideArgs = opts.args;
    this._cwd = opts.cwd || process.cwd();
  }

  async _bounded(promise, ms, signal) {
    let timer, abort;
    const stop = new Promise((_, reject) => {
      timer = setTimeout(() => reject(failure('TIMEOUT', `App Server operation exceeded ${ms}ms.`)), ms);
      abort = () => reject(failure('CANCELLED', 'Codex request cancelled.'));
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
    });
    try { return await Promise.race([promise, stop]); }
    finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
  }

  async _ensureConnected() {
    if (this._transport && !this._transport.error) return this._transport;
    if (this._transport) await this._transport.close();
    if (this._closed) throw failure('BACKEND_CLOSED', 'Codex backend is closed.');
    const picked = pickCommand(this._overrideCommand, this._overrideArgs);
    const conn = new AppServerTransport(picked.command, picked.args, this._cwd);
    this._transport = conn;
    conn.finishedTurns = new Set();
    try {
      const result = await this._bounded(conn.request('initialize', {
        clientInfo: { name: 'codex-bridge', title: 'Codex Bridge', version: '1.0.0' },
      }), this._readinessTimeoutMs);
      if (typeof result?.userAgent !== 'string' || !result.userAgent) throw failure('BACKEND_PROTOCOL_ERROR', 'Invalid App Server initialize response.');
      conn.write({ method: 'initialized', params: {} });
      return conn;
    } catch (err) {
      await conn.close(err);
      throw failure('BACKEND_NOT_READY', `Codex App Server initialization failed: ${err.message}`);
    }
  }

  _serial(action, signal) {
    const queued = this._callMutexTail.then(async () => {
      if (this._closed) throw failure('BACKEND_CLOSED', 'Codex backend is closed.');
      if (signal?.aborted) throw failure('CANCELLED', 'Codex request cancelled.');
      try {
        return await this._bounded((async () => action(await this._ensureConnected()))(), this._callTimeoutMs, signal);
      } catch (err) {
        const conn = this._transport;
        if (conn) {
          // An interrupt is best effort, never evidence that an uncertain turn is safe to retry.
          if (this._active?.turnId && !conn.error) {
            await this._bounded(conn.request('turn/interrupt', {
              threadId: this._active.threadId, turnId: this._active.turnId,
            }), this._interruptTimeoutMs).catch(() => {});
          }
          await conn.close(err);
        }
        throw err;
      } finally { this._active = null; }
    });
    this._callMutexTail = queued.catch(() => {});
    return queued;
  }

  async _readThread(conn, threadId) {
    const result = await conn.request('thread/read', { threadId, includeTurns: false });
    const id = requireId(result?.thread?.id, 'NO_THREAD_ID_ON_RESUME', 'thread id on read');
    if (id !== threadId) throw failure('THREAD_ID_DRIFT', `thread/read returned '${id}' instead of '${threadId}'.`);
    const cwd = result.thread.cwd;
    if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) throw failure('WORKING_DIR_UNKNOWN', `Thread '${threadId}' has no absolute cwd in App Server metadata.`);
    return workingDir.normalize(cwd, this._cwd);
  }

  getThreadWorkingDir(threadId, extra = {}) {
    return this._serial((conn) => this._readThread(conn, threadId), extra.signal);
  }

  startSession(prompt, extra = {}) { return this._session(null, prompt, extra); }
  continueSession(threadId, prompt, extra = {}) { return this._session(threadId, prompt, extra); }

  _session(priorThreadId, prompt, extra) {
    return this._serial(async (conn) => {
      let cwd;
      if (priorThreadId) {
        cwd = await this._readThread(conn, priorThreadId);
        if (extra.cwd && await workingDir.normalize(extra.cwd, this._cwd) !== cwd) {
          throw failure('WORKING_DIR_MISMATCH', 'Saved bridge cwd differs from existing Codex thread metadata.');
        }
      } else cwd = await workingDir.normalize(extra.cwd || this._cwd, this._cwd);
      const result = await conn.request(priorThreadId ? 'thread/resume' : 'thread/start', {
        ...(priorThreadId ? { threadId: priorThreadId } : { ephemeral: false }),
        cwd, approvalPolicy: 'never', sandbox: 'danger-full-access',
        ...(extra.model ? { model: extra.model } : {}),
      });
      const threadId = requireId(result?.thread?.id, priorThreadId ? 'NO_THREAD_ID_ON_RESUME' : 'NO_THREAD_ID', 'thread id');
      if (priorThreadId && threadId !== priorThreadId) throw failure('THREAD_ID_DRIFT', 'thread/resume returned a different thread id.');
      if (typeof result.cwd !== 'string' || !path.isAbsolute(result.cwd) || await workingDir.normalize(result.cwd, this._cwd) !== cwd) {
        throw failure('WORKING_DIR_MISMATCH', 'App Server did not confirm the requested cwd.');
      }
      if (result.approvalPolicy !== 'never' || result.sandbox?.type !== 'dangerFullAccess') {
        throw failure('BACKEND_POLICY_MISMATCH', 'App Server did not confirm full-access sandbox and approval never.');
      }
      return this._turn(conn, threadId, prompt, cwd);
    }, extra.signal);
  }

  async _turn(conn, threadId, prompt, cwd) {
    const ctx = { threadId, turnId: null, early: [], items: new Map(), terminal: null };
    this._active = ctx;
    let finish, fail;
    const completed = new Promise((resolve, reject) => { finish = resolve; fail = reject; });
    // Events/errors may arrive before the turn/start response.
    completed.catch(() => {});
    const acceptItem = (item) => {
      if (item?.type !== 'agentMessage') return;
      requireId(item.id, 'BACKEND_PROTOCOL_ERROR', 'agent message id');
      if (typeof item.text !== 'string') throw failure('BACKEND_PROTOCOL_ERROR', 'Agent message has no text.');
      const prior = ctx.items.get(item.id);
      if (prior && (prior.text !== item.text || prior.phase !== item.phase)) throw failure('BACKEND_PROTOCOL_ERROR', 'Conflicting duplicate agent message.');
      ctx.items.set(item.id, item);
    };
    const event = ({ method, params: p }) => {
      if (!['turn/started', 'turn/completed', 'item/completed', 'item/agentMessage/delta', 'error'].includes(method)) return;
      const eventTurnId = p?.turnId ?? p?.turn?.id;
      if (conn.finishedTurns.has(JSON.stringify([p?.threadId, eventTurnId]))) return; // stale completed turn
      if (p?.threadId !== threadId) throw failure('THREAD_ID_DRIFT', 'App Server event belongs to a different thread.');
      requireId(eventTurnId, 'BACKEND_PROTOCOL_ERROR', 'event turn id');
      if (!ctx.turnId) {
        if (ctx.early.length >= 10000) throw failure('BACKEND_PROTOCOL_ERROR', 'Too many events before turn/start response.');
        ctx.early.push({ method, params: p }); return;
      }
      if (eventTurnId !== ctx.turnId) throw failure('TURN_ID_DRIFT', 'App Server event belongs to an unexpected turn.');
      if (ctx.terminal) return;
      if (method === 'item/completed') acceptItem(p.item);
      // Completed item text is authoritative. Repeated deltas must not corrupt reply bytes.
      if (method === 'error' && p.willRetry !== true) throw failure('CODEX_TURN_FAILED', p.error?.message || 'Codex turn failed.');
      if (method === 'turn/completed') {
        const turn = p.turn;
        if (turn.status !== 'completed') throw failure(turn.status === 'interrupted' ? 'CANCELLED' : 'CODEX_TURN_FAILED', turn.error?.message || `Codex turn ended with status '${turn.status}'.`);
        if (!Array.isArray(turn.items)) throw failure('BACKEND_PROTOCOL_ERROR', 'Completed turn has no items array.');
        for (const item of turn.items) acceptItem(item);
        const messages = [...ctx.items.values()];
        const finals = messages.filter((item) => item.phase === 'final_answer');
        const content = (finals.length ? finals : messages.filter((item) => !item.phase)).map((item) => item.text).join('');
        if (!content.trim()) throw failure('EMPTY_REPLY', 'Codex returned a completed turn without a final answer.');
        ctx.terminal = turn;
        conn.finishedTurns.add(JSON.stringify([threadId, ctx.turnId]));
        finish({ threadId, content });
      }
    };
    conn.onnotification = (message) => { try { event(message); } catch (err) { fail(err); } };
    conn.onfailure = fail;
    try {
      const result = await conn.request('turn/start', {
        threadId, input: [{ type: 'text', text: prompt }], cwd,
        approvalPolicy: 'never', sandboxPolicy: { type: 'dangerFullAccess' },
      });
      ctx.turnId = requireId(result?.turn?.id, 'BACKEND_PROTOCOL_ERROR', 'turn id');
      if (conn.finishedTurns.has(JSON.stringify([threadId, ctx.turnId]))) throw failure('TURN_ID_DRIFT', 'turn/start reused an already completed turn id.');
      for (const message of ctx.early) event(message);
      ctx.early = [];
      return await completed;
    } finally {
      conn.onnotification = null;
      conn.onfailure = null;
    }
  }

  async close() {
    this._closed = true;
    if (this._transport) await this._transport.close();
    await this._callMutexTail;
  }
}

module.exports = { CodexBackend, pickCommand };
