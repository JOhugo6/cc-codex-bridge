#!/usr/bin/env node
'use strict';
// Offline recovery only. Never loads a Codex backend or sends a prompt.
const paths = require('./lib/paths');
const lock = require('./lib/lock');
const store = require('./lib/store');
const operations = require('./lib/operations');

async function recover(action, conversationId) {
  if (!['inspect', 'finish'].includes(action)) throw new Error('Usage: node recover-operation.js <inspect|finish> <conversation_id>');
  paths.assertSafeConversationId(conversationId);
  lock.ensureStateDirSync(paths.stateDir());
  const release = await lock.acquire(paths.lockDir(conversationId));
  try {
    const state = await store.loadState(conversationId);
    const journal = await operations.load(conversationId);
    if (action === 'inspect') {
      return { state_path: paths.stateFile(conversationId), journal_path: paths.operationsFile(conversationId), state, journal };
    }
    if (!journal) throw Object.assign(new Error('No recorded operation to finish.'), { code: 'NO_RECORDED_OPERATION' });
    return await operations.finish(conversationId, journal, state);
  } finally {
    await release();
  }
}

if (require.main === module) {
  const [action, id, ...extra] = process.argv.slice(2);
  Promise.resolve().then(() => {
    if (extra.length) throw new Error('Unexpected arguments. Usage: node recover-operation.js <inspect|finish> <conversation_id>');
    return recover(action, id);
  }).then((out) => process.stdout.write(JSON.stringify(out, null, 2) + '\n')).catch((err) => {
    process.stderr.write(`${err.code || 'RECOVERY_FAILED'}: ${err.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { recover };
