#!/usr/bin/env node
'use strict';
const { migrateLegacy } = require('./lib/migration');

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 1) throw new Error('Usage: node migrate-state.js <exact-conversation-id>');
  const result = await migrateLegacy(args[0]);
  process.stdout.write(JSON.stringify(result) + '\n');
}

main().catch((err) => {
  process.stderr.write(`${err.code || 'MIGRATION_FAILED'}: ${err.message}\n`);
  process.exitCode = 1;
});
