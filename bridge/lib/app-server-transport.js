'use strict';
// Native App Server JSONL transport, independent of the public MCP server.
const { spawn } = require('node:child_process');
const readline = require('node:readline');
const path = require('node:path');

function failure(code, message) { return Object.assign(new Error(message), { code }); }

class AppServerTransport {
  constructor(command, args, cwd) {
    this.pending = new Map();
    this.nextId = 1;
    this.error = null;
    this.onnotification = null;
    this.onfailure = null;
    const launch = Buffer.from(JSON.stringify({ command, args, cwd }), 'utf8').toString('base64');
    const windows = process.platform === 'win32';
    // The supervisor owns the tree/group until cleanup completes, independently of the
    // native parent's liveness. No process-name scans or remembered descendant PIDs are used.
    this.child = spawn(windows
      ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
      : process.execPath, windows
      ? ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'windows-job-runner.ps1'), '-LaunchBase64', launch]
      : [path.join(__dirname, 'posix-process-runner.js'), launch], {
      cwd, stdio: ['pipe', 'pipe', 'pipe'], shell: false, windowsHide: true,
      detached: !windows,
    });
    this.exited = new Promise((resolve) => this.child.once('close', resolve));
    this.child.on('error', (err) => this.fail(failure('BACKEND_DISCONNECTED', err.message)));
    this.child.on('exit', (code, signal) => this.fail(failure('BACKEND_DISCONNECTED', `Codex App Server exited (${code ?? signal}).`)));
    this.child.stdin.on('error', (err) => this.fail(failure('BACKEND_DISCONNECTED', err.message)));
    this.child.stdout.on('error', (err) => this.fail(failure('BACKEND_DISCONNECTED', err.message)));
    let stderrPrefix = '';
    this.child.stderr.on('data', (data) => {
      // Diagnostic-only native PID for smoke verification. Never used to select a kill target.
      if (!this.nativePid && stderrPrefix.length < 4096) {
        stderrPrefix += data.toString('utf8');
        const match = stderrPrefix.match(/(?:^|\n)codex-bridge-child-pid:(\d+)\r?\n/);
        if (match) this.nativePid = Number(match[1]);
      }
      process.stderr.write(data);
    });
    this.lines = readline.createInterface({ input: this.child.stdout, crlfDelay: Infinity });
    this.lines.on('line', (line) => {
      if (this.error) return;
      try { this.receive(JSON.parse(line)); }
      catch (err) { this.fail(err.code ? err : failure('BACKEND_PROTOCOL_ERROR', err.message)); }
    });
  }

  write(message) {
    if (this.error) throw this.error;
    this.child.stdin.write(JSON.stringify(message) + '\n');
  }

  request(method, params) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject, method });
      try { this.write({ id, method, params }); }
      catch (err) { this.pending.delete(id); reject(err); }
    });
  }

  receive(message) {
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      throw failure('BACKEND_PROTOCOL_ERROR', 'App Server returned an invalid message.');
    }
    if (message.method !== undefined) {
      if (message.id !== undefined) {
        // This unattended client never grants approvals or supplies auth tokens/tools.
        this.write({ id: message.id, error: { code: -32601, message: 'Unattended bridge does not support server requests.' } });
        throw failure('BACKEND_REQUEST_UNSUPPORTED', `Unexpected App Server request '${message.method}'.`);
      }
      this.onnotification?.(message);
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending || (('result' in message) === ('error' in message))) {
      throw failure('BACKEND_PROTOCOL_ERROR', 'App Server returned an unknown/duplicate response or invalid result.');
    }
    this.pending.delete(message.id);
    if (message.error) {
      const err = failure('CODEX_RPC_ERROR', `${pending.method}: ${message.error.message || 'App Server request failed'}`);
      err.rpcCode = message.error.code;
      pending.reject(err);
    } else pending.resolve(message.result);
  }

  fail(err) {
    if (this.error) return;
    this.error = err;
    for (const pending of this.pending.values()) pending.reject(err);
    this.pending.clear();
    this.onfailure?.(err);
  }

  async close(reason = failure('BACKEND_CLOSED', 'Codex backend closed.')) {
    if (this.closing) return this.closing;
    this.fail(reason);
    this.closing = this.stopChild();
    return this.closing;
  }

  async stopChild() {
    const child = this.child;
    this.lines.close();
    if (child.pid && child.exitCode === null && child.signalCode === null) {
      // Windows kills the owner of the sole job handle, which closes the whole job. POSIX
      // asks the still-owned supervisor to terminate its group and escalate after 500ms.
      child.kill('SIGTERM');
      await this.waitForExit(1500);
      if (child.exitCode === null && child.signalCode === null) {
        if (process.platform !== 'win32') {
          // Only signal this PGID while its original supervisor is still alive.
          try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already exited */ }
        }
        child.kill('SIGKILL');
        await this.waitForExit(500);
      }
    }
    child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
    if (child.pid && child.exitCode === null && child.signalCode === null) {
      throw failure('BACKEND_CLEANUP_FAILED', `Codex child ${child.pid} did not exit after termination.`);
    }
  }

  async waitForExit(ms) {
    let timer;
    await Promise.race([this.exited, new Promise((resolve) => { timer = setTimeout(resolve, ms); })]);
    clearTimeout(timer);
  }
}

module.exports = { AppServerTransport, failure };
