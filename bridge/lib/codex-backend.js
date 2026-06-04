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
// spawn('codex') hits the .ps1 shim / fails. We spawn `codex.cmd` with shell:true so cmd.exe
// resolves the shim correctly (design §6). All of Codex's own chatter goes to ITS stderr, which
// we forward to OUR stderr — never to our stdout (which carries only our MCP protocol bytes).
//
// This module is the SEAM: index.js depends on the interface { startSession, continueSession,
// close }, and tests inject a fake. No file/disk/lock logic lives here.

const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');

function log(...args) {
  // Diagnostics ALWAYS to stderr.
  process.stderr.write('[codex-backend] ' + args.join(' ') + '\n');
}

function pickCommand() {
  // On Windows, launch the .cmd shim via the shell so cmd.exe resolves it. On POSIX, plain `codex`.
  if (process.platform === 'win32') {
    return { command: 'codex.cmd', args: ['mcp-server'], useShell: true };
  }
  return { command: 'codex', args: ['mcp-server'], useShell: false };
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

  async _ensureConnected() {
    if (this._client) return this._client;
    if (this._connecting) return this._connecting;
    this._connecting = (async () => {
      const picked = pickCommand();
      const command = this._overrideCommand || picked.command;
      const args = this._overrideArgs || picked.args;
      log(`spawning backend: ${command} ${args.join(' ')} (cwd=${this._cwd})`);

      const transport = new StdioClientTransport({
        command,
        args,
        cwd: this._cwd,
        // shell:true lets cmd.exe resolve the .cmd shim on Windows.
        shell: this._overrideCommand ? false : picked.useShell,
        // Forward the child's stderr to ours so Codex diagnostics are visible, not lost.
        stderr: 'pipe',
        env: process.env,
      });

      const client = new Client(
        { name: 'codex-bridge', version: '1.0.0' },
        { capabilities: {} }
      );

      transport.onerror = (err) => log('transport error:', err && err.message);

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
            // A real round-trip proves the child is serving requests, not just that the pipe opened.
            await client.listTools(undefined, { timeout: this._readinessTimeoutMs });
          })(),
          this._readinessTimeoutMs
        );
      } catch (err) {
        try {
          await client.close();
        } catch {
          /* ignore */
        }
        const e = new Error(
          `Codex mcp-server did not become ready within ${this._readinessTimeoutMs}ms ` +
            `(${err && err.message ? err.message : String(err)}).`
        );
        e.code = 'BACKEND_NOT_READY';
        throw e;
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

  // Start a brand-new Codex session. Returns { threadId, content }.
  async startSession(prompt, extra = {}) {
    const client = await this._ensureConnected();
    const result = await client.callTool(
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
      undefined,
      { timeout: this._callTimeoutMs }
    );
    return this._extractReply(result, { mode: 'start', priorThreadId: null });
  }

  // Continue an existing Codex session by threadId. Returns { threadId, content }.
  // If Codex cannot resume the thread, callTool rejects / returns isError => caller hard-errors.
  async continueSession(threadId, prompt) {
    const client = await this._ensureConnected();
    const result = await client.callTool(
      { name: 'codex-reply', arguments: { threadId, prompt } },
      undefined,
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
