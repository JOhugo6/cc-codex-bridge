'use strict';
// The backing onto Codex (design §4.1). Chosen mechanism: spawn the native `codex mcp-server`
// as a child process and speak stdio MCP to it.
//   - codex(prompt)              -> structuredContent { threadId, content }   [start session]
//   - codex-reply(threadId, ...) -> structuredContent { threadId, content }   [continue session]
// Verified live against codex-cli 0.133.0 (see test/probe-codex-mcp.js).
//
// We deliberately use the MCP server backing (NOT `codex exec resume`, which has a known hang
// bug — design §4.1 / sources §10). The thread keeps the conversation AND the working-file state
// coherent across turns.
//
// Windows launch: `codex` on disk is `codex` (PS shim) + `codex.cmd` + `codex.ps1`. A bare
// spawn('codex') hits the .ps1 shim / fails. We resolve the absolute path to codex.cmd at
// startup using a PATH walk (MAJOR-5: prevents PATH hijacking) and spawn with shell:false.
// All of Codex's own chatter goes to ITS stderr, which we forward to OUR stderr — never to our
// stdout (which carries only our MCP protocol bytes).
//
// This module is the SEAM: index.js depends on the interface { startSession, continueSession,
// close }, and tests inject a fake. No file/disk/lock logic lives here.

const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
const path = require('node:path');
const fs = require('node:fs');

function log(...args) {
  // Diagnostics ALWAYS to stderr.
  process.stderr.write('[codex-backend] ' + args.join(' ') + '\n');
}

// MAJOR-5: Resolve the absolute path to a command by walking PATH entries. Returns the resolved
// absolute path or null if not found. Never uses shell:true or relies on ambient PATH resolution
// at spawn time — that would allow any codex.cmd in the working directory (or earlier PATH entry)
// to shadow the real one.
function resolveCommandAbsolute(commandName) {
  const pathDirs = (process.env.PATH || process.env.Path || '').split(path.delimiter);
  for (const dir of pathDirs) {
    if (!dir) continue;
    const candidate = path.join(dir, commandName);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // not executable here — try next entry
    }
  }
  return null;
}

// Resolve the codex command once at module load time so startup errors are surfaced early.
// On Windows we look for codex.cmd; on POSIX we look for codex. If not found, we record the
// error and throw CODEX_NOT_FOUND at first use (rather than crashing the module load, which
// would break the MCP server startup even when a test injects a fake backend).
let _resolvedCodexPath = null;
let _resolveError = null;

function pickCommand(overrideCommand, overrideArgs) {
  // Test / alt-launch override: caller provides an explicit absolute path.
  if (overrideCommand) {
    return { command: overrideCommand, args: overrideArgs || ['mcp-server'], useShell: false };
  }

  // MAJOR-5: resolve absolute path at startup, spawn with shell:false.
  if (_resolveError) {
    throw _resolveError;
  }
  if (!_resolvedCodexPath) {
    const commandName = process.platform === 'win32' ? 'codex.cmd' : 'codex';
    const resolved = resolveCommandAbsolute(commandName);
    if (!resolved) {
      const e = new Error(
        `Cannot find '${commandName}' on PATH. ` +
          'Install codex-cli (npm install -g @openai/codex) and ensure it is on PATH.'
      );
      e.code = 'CODEX_NOT_FOUND';
      _resolveError = e;
      throw e;
    }
    _resolvedCodexPath = resolved;
    log(`resolved codex: ${_resolvedCodexPath}`);
  }
  // shell:false — we use the resolved absolute path, not a bare name.
  return { command: _resolvedCodexPath, args: ['mcp-server'], useShell: false };
}

class CodexBackend {
  constructor(opts = {}) {
    this._client = null;
    this._transport = null;
    this._connecting = null;
    this._callTimeoutMs = opts.callTimeoutMs || 600000; // upstream turns can be slow
    // Bounded downstream-readiness probe after the transport handshake. connect() only proves the
    // pipe opened; a tools/list round-trip proves the Codex child is actually serving requests.
    this._readinessTimeoutMs = opts.readinessTimeoutMs || 60000;
    this._overrideCommand = opts.command; // for tests / alt launch
    this._overrideArgs = opts.args;
    this._cwd = opts.cwd || process.cwd();

    // MAJOR-4: backend-level serialiser — only one callTool in-flight at a time. The Codex CLI
    // mcp-server is not tested for concurrent calls from different conversations. This mutex is
    // independent of the per-conversation lock in bridge.js (which serialises within one conversation).
    // We use a simple promise-chain queue: each call waits for the previous tail before running.
    this._callMutexTail = Promise.resolve();
  }

  // Race a promise against a timeout. Rejects with a TIMEOUT-coded error if the timer wins.
  _withTimeout(promise, ms) {
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        const e = new Error(`operation exceeded ${ms}ms`);
        e.code = 'TIMEOUT';
        reject(e);
      }, ms);
      if (timer.unref) timer.unref();
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
  }

  // MAJOR-3: null out _client and _transport so the next call triggers a fresh _ensureConnected().
  // This is a best-effort reconnect — the per-conversation state on disk remains valid and the
  // next codex_turn call will restart the backend transparently.
  _resetConnection(reason) {
    log('resetting connection:', reason);
    this._client = null;
    this._transport = null;
  }

  async _ensureConnected() {
    if (this._client) return this._client;
    if (this._connecting) return this._connecting;
    this._connecting = (async () => {
      // MAJOR-5: pickCommand now resolves the absolute path and uses shell:false.
      const picked = pickCommand(this._overrideCommand, this._overrideArgs);
      const command = picked.command;
      const args = picked.args;
      log(`spawning backend: ${command} ${args.join(' ')} (cwd=${this._cwd})`);

      const transport = new StdioClientTransport({
        command,
        args,
        cwd: this._cwd,
        // shell:false — we always use the resolved absolute path (MAJOR-5).
        shell: false,
        // Forward the child's stderr to ours so Codex diagnostics are visible, not lost.
        stderr: 'pipe',
        env: process.env,
      });

      const client = new Client(
        { name: 'codex-bridge', version: '1.0.0' },
        { capabilities: {} }
      );

      // MAJOR-3: on transport error or close, null out the connection references so the next
      // call triggers a fresh _ensureConnected(). Best-effort reconnect — disk state is intact.
      // StdioClientTransport is NOT an EventEmitter — wire callbacks via property assignment,
      // identical to the onerror pattern already used by the SDK.
      transport.onerror = (err) => {
        log('transport error:', err && err.message);
        this._resetConnection('transport error');
      };
      transport.onclose = () => this._resetConnection('transport closed');

      // Pipe child stderr to our stderr as soon as the transport exists.
      if (transport.stderr) {
        transport.stderr.on('data', (d) =>
          process.stderr.write('[codex stderr] ' + d.toString('utf8'))
        );
      }

      // M1: bounded cold-start backstop. BOTH the MCP handshake (client.connect -> initialize) AND a
      // downstream tools/list round-trip must complete within readinessTimeoutMs. A non-MCP / half-
      // spawned child hangs the initialize itself, so we race connect against a timer too — otherwise
      // the SDK's own 60s default (or worse) leaks through as a raw -32001 instead of our hard error.
      try {
        await this._withTimeout(
          (async () => {
            await client.connect(transport);
            // MINOR-12: A real round-trip proves the child is serving requests. Also assert that
            // the required tools (codex and codex-reply) are actually advertised.
            const { tools } = await client.listTools(undefined, { timeout: this._readinessTimeoutMs });
            const names = (tools || []).map((t) => t.name);
            const missing = ['codex', 'codex-reply'].filter((n) => !names.includes(n));
            if (missing.length > 0) {
              const e = new Error(
                `Codex mcp-server is missing required tools: ${missing.join(', ')}. ` +
                  `Available: [${names.join(', ')}].`
              );
              e.code = 'BACKEND_NOT_READY';
              throw e;
            }
          })(),
          this._readinessTimeoutMs
        );
      } catch (err) {
        try {
          await client.close();
        } catch {
          /* ignore */
        }
        const wrapped = new Error(
          `Codex mcp-server did not become ready within ${this._readinessTimeoutMs}ms ` +
            `(${err && err.message ? err.message : String(err)}).`
        );
        wrapped.code = 'BACKEND_NOT_READY';
        throw wrapped;
      }

      this._client = client;
      this._transport = transport;
      log('backend connected and ready');
      return client;
    })();
    try {
      return await this._connecting;
    } finally {
      this._connecting = null;
    }
  }

  // Extract { threadId, content } from an MCP callTool result, tolerating shape drift.
  // `mode` is 'start' or 'continue'; `priorThreadId` is the thread we asked to resume (continue only).
  //
  // CRITICAL (B1): on a CONTINUE, a missing/empty threadId in the response must HARD-ERROR. We must
  // NEVER borrow priorThreadId to manufacture a same-thread resume — that would launder a lost or
  // ambiguous session as a healthy one (the #1 forbidden failure). priorThreadId is used ONLY as a
  // benign fallback on START, where there is no prior session to lie about.
  _extractReply(result, { mode, priorThreadId } = {}) {
    const sc = result && result.structuredContent;
    let threadId = sc && (sc.threadId || sc.thread_id);
    let content = sc && sc.content;

    // Fall back to text content blocks if structuredContent is missing the text.
    if (content == null && result && Array.isArray(result.content)) {
      content = result.content
        .filter((c) => c && c.type === 'text' && typeof c.text === 'string')
        .map((c) => c.text)
        .join('');
    }

    // Surface an explicit tool error first.
    if (result && result.isError) {
      const text =
        (Array.isArray(result.content) &&
          result.content.map((c) => c.text).filter(Boolean).join('\n')) ||
        'unknown error';
      const e = new Error(`Codex tool returned an error: ${text}`);
      e.code = 'CODEX_TOOL_ERROR';
      throw e;
    }

    if (!threadId) {
      if (mode === 'continue') {
        // B1: do NOT borrow priorThreadId. A resume that doesn't echo a threadId is a lost/ambiguous
        // session — fail loudly so bridge.js treats it as a resume failure, not a healthy turn.
        const e = new Error(
          `Codex codex-reply for thread '${priorThreadId}' returned no threadId — session is lost or ` +
            `ambiguous. Refusing to assume the same thread (would be silent amnesia).`
        );
        e.code = 'NO_THREAD_ID_ON_RESUME';
        throw e;
      }
      // START only: a brand-new session with no echoed threadId can't be persisted.
      const e = new Error('Codex response did not include a threadId — cannot persist session.');
      e.code = 'NO_THREAD_ID';
      throw e;
    }

    if (typeof content !== 'string') content = content == null ? '' : String(content);

    // M2: a non-error result with empty/whitespace-only content is silence-that-looks-like-an-answer
    // on a fidelity-bearing channel. Reject it loudly rather than persisting a clean empty turn.
    if (content.trim().length === 0) {
      const e = new Error(
        `Codex returned a successful result with empty content (thread '${threadId}', mode '${mode}'). ` +
          `Treating empty-as-answer as a failure on a fidelity-bearing channel.`
      );
      e.code = 'EMPTY_REPLY';
      throw e;
    }

    return { threadId: String(threadId), content };
  }

  // MAJOR-4: Serialise all callTool invocations through a promise-chain mutex. Codex CLI's
  // mcp-server is not tested for concurrent calls from different conversations; this ensures only
  // one callTool is in-flight at any time regardless of how many conversations are active.
  _serialisedCallTool(client, req, opts) {
    const tail = this._callMutexTail.then(() => client.callTool(req, undefined, opts));
    // Keep the chain alive even if this call fails, so later calls are not blocked forever.
    this._callMutexTail = tail.then(
      () => {},
      () => {}
    );
    return tail;
  }

  // Start a brand-new Codex session. Returns { threadId, content }.
  async startSession(prompt, extra = {}) {
    const client = await this._ensureConnected();
    const result = await this._serialisedCallTool(
      client,
      {
        name: 'codex',
        arguments: {
          prompt,
          // Safe default: don't let an unattended team member do destructive shell ops.
          // The orchestrator owns escalation (design §4.4 / §6 sandbox note).
          'approval-policy': extra.approvalPolicy || 'never',
          sandbox: extra.sandbox || 'read-only',
          ...(extra.model ? { model: extra.model } : {}),
          ...(extra.cwd ? { cwd: extra.cwd } : {}),
          ...(extra.config ? { config: extra.config } : {}),
        },
      },
      { timeout: this._callTimeoutMs }
    );
    return this._extractReply(result, { mode: 'start', priorThreadId: null });
  }

  // Continue an existing Codex session by threadId. Returns { threadId, content }.
  // If Codex cannot resume the thread, callTool rejects / returns isError => caller hard-errors.
  async continueSession(threadId, prompt) {
    const client = await this._ensureConnected();
    const result = await this._serialisedCallTool(
      client,
      { name: 'codex-reply', arguments: { threadId, prompt } },
      { timeout: this._callTimeoutMs }
    );
    return this._extractReply(result, { mode: 'continue', priorThreadId: threadId });
  }

  async close() {
    try {
      if (this._client) await this._client.close();
    } catch (e) {
      log('error closing client:', e && e.message);
    }
    this._client = null;
    this._transport = null;
  }
}

module.exports = { CodexBackend, pickCommand };
