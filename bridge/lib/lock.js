'use strict';
// Per-conversation cross-process advisory lock (design §4.1 step 1).
//
// Why mkdir: `fs.mkdir` is atomic and fails with EEXIST if the dir already exists, on both
// Windows and POSIX. That gives us a portable mutex without native deps. We write a metadata
// file inside the lock dir (pid + timestamp) so a crashed holder's lock can be reclaimed as stale.
//
// Global user scope => locks coordinate across DIFFERENT Claude Code teams/projects hitting the
// SAME conversation_id. That is the whole point: prevent thread bleed.

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const DEFAULT_OPTS = {
  // How long a WAITER blocks before giving up. A legitimate Codex turn can run 3-10 min (the
  // backend's 600s callTimeout), so a waiter must tolerate the holder working a long turn plus
  // its own turn — keep this >= callTimeout to avoid falsely timing out behind a healthy holder.
  timeoutMs: 900000,
  pollMs: 50,
  // A lock older than this is presumed orphaned by a crashed process and forcibly reclaimed.
  // MUST be >= the backend callTimeout (600s, codex-backend.js): a legitimately long turn holds
  // the lock that whole time, and the dead-pid stale guard only protects same-host with readable
  // owner meta. Set above callTimeout so a healthy long turn is never reclaimed out from under us.
  staleMs: 900000,
};

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function readLockMeta(dir) {
  try {
    const raw = await fsp.readFile(path.join(dir, 'owner.json'), 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function tryReclaimStale(dir, staleMs) {
  let stat;
  try {
    stat = await fsp.stat(dir);
  } catch {
    return; // gone already
  }
  const age = Date.now() - stat.mtimeMs;
  if (age < staleMs) return;
  // Best-effort: also check the recorded process is dead, if it's on this machine.
  const meta = await readLockMeta(dir);
  if (meta && meta.pid && meta.host === hostId()) {
    try {
      process.kill(meta.pid, 0); // throws if no such process
      return; // holder still alive — not stale, leave it
    } catch {
      /* dead -> reclaim */
    }
  }
  try {
    await fsp.rm(dir, { recursive: true, force: true });
  } catch {
    /* someone else may have reclaimed it; ignore */
  }
}

function hostId() {
  return process.env.COMPUTERNAME || process.env.HOSTNAME || 'localhost';
}

// Acquire the lock. Returns a release() function. Throws on timeout.
async function acquire(lockDirPath, opts = {}) {
  const o = { ...DEFAULT_OPTS, ...opts };
  const deadline = Date.now() + o.timeoutMs;

  for (;;) {
    try {
      await fsp.mkdir(lockDirPath, { recursive: false });
      // We own it. Stamp owner metadata for stale detection.
      const meta = { pid: process.pid, host: hostId(), acquiredAt: new Date().toISOString() };
      try {
        await fsp.writeFile(path.join(lockDirPath, 'owner.json'), JSON.stringify(meta), 'utf8');
      } catch {
        /* metadata is advisory; lock is still held */
      }
      let released = false;
      return async function release() {
        if (released) return;
        released = true;
        try {
          await fsp.rm(lockDirPath, { recursive: true, force: true });
        } catch {
          /* ignore */
        }
      };
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      // Held by someone. Maybe stale?
      await tryReclaimStale(lockDirPath, o.staleMs);
      if (Date.now() >= deadline) {
        const meta = await readLockMeta(lockDirPath);
        const e = new Error(
          `Timed out after ${o.timeoutMs}ms acquiring lock ${lockDirPath}` +
            (meta ? ` (held by pid ${meta.pid} on ${meta.host} since ${meta.acquiredAt})` : '')
        );
        e.code = 'LOCK_TIMEOUT';
        throw e;
      }
      await sleep(o.pollMs);
    }
  }
}

// Ensure the parent (state) dir exists before locking.
function ensureStateDirSync(stateDirPath) {
  fs.mkdirSync(stateDirPath, { recursive: true });
}

module.exports = { acquire, ensureStateDirSync, DEFAULT_OPTS };
