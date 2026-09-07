'use strict';
const fsp = require('node:fs/promises');
const path = require('node:path');

function failure(code, message) {
  return Object.assign(new Error(message), { code });
}

function assertInput(value) {
  if (value !== undefined && (typeof value !== 'string' || !value.length || value.length > 500 || value.includes('\0'))) {
    throw failure('INVALID_WORKING_DIR', 'working_dir must be a non-empty directory path of at most 500 characters.');
  }
  // Drive-relative paths depend on Windows' hidden per-drive cwd, not our captured base.
  if (process.platform === 'win32' && typeof value === 'string' && /^[A-Za-z]:(?![/\\])/.test(value)) {
    throw failure('INVALID_WORKING_DIR', 'Drive-relative working_dir paths are ambiguous; use an absolute path.');
  }
}

async function normalize(value, base) {
  // User input is validated at the turn boundary. A canonical stored/default path
  // may be longer than a caller's 500-character relative spelling.
  try {
    const resolved = await fsp.realpath(path.resolve(base, value));
    if (!(await fsp.stat(resolved)).isDirectory()) throw new Error('path is not a directory');
    return resolved;
  } catch (cause) {
    throw failure('INVALID_WORKING_DIR', `Cannot use working_dir ${JSON.stringify(value)}: ${cause.message}`);
  }
}

async function forTurn(prior, supplied, base) {
  if (!prior) return normalize(supplied === undefined ? base : supplied, base);
  if (prior.working_dir === undefined) {
    throw failure('WORKING_DIR_UNKNOWN', 'This existing thread has no verified working_dir in bridge state. ' +
      'Supplying a directory cannot establish the original Codex cwd. Preserve its state and journal; ' +
      'run recover-operation.js inspect to identify the thread and follow the runbook directory diagnostics. ' +
      'This backend has no verified cwd binding operation; a new conversation_id would be a separate conversation.');
  }
  const pinned = await normalize(prior.working_dir, base);
  if (pinned !== prior.working_dir) {
    throw failure('WORKING_DIR_MISMATCH', 'The stored working_dir now resolves to a different path. Restore the original directory before resuming.');
  }
  if (supplied !== undefined && await normalize(supplied, base) !== pinned) {
    throw failure('WORKING_DIR_MISMATCH', `Conversation is pinned to working_dir ${JSON.stringify(pinned)}; a different directory requires a new conversation_id.`);
  }
  return pinned;
}

module.exports = { assertInput, normalize, forTurn };
