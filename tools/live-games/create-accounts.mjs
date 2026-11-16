#!/usr/bin/env node
/**
 * Creates reusable anonymous live-service accounts with the same browser
 * headers as the game transport. Tokens are written to a private JSON pool so
 * later runs can refresh them instead of creating a new signup burst.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import {LiveTransport} from './transport.mjs';
import {root} from './engine.mjs';

function parseArguments(argv) {
  const options = {
    count: 9,
    pool: path.join(root, 'logs', 'live', 'account-pool.json'),
    delayMs: 750,
  };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    const next = () => {
      const value = argv[++index];
      if (value === undefined) throw new Error(`Missing value for ${argument}`);
      return value;
    };
    switch (argument) {
      case '--count': options.count = Number(next()); break;
      case '--pool': options.pool = path.resolve(next()); break;
      case '--delay-ms': options.delayMs = Number(next()); break;
      case '--help':
        process.stdout.write('Usage: create-accounts.mjs [--count N] [--pool FILE] [--delay-ms N]\n');
        return null;
      default: throw new Error(`Unknown argument: ${argument}`);
    }
  }
  return options;
}

async function loadPool(poolPath) {
  try {
    const parsed = JSON.parse(await fs.readFile(poolPath, 'utf8'));
    return parsed.filter(account => account?.userId && account?.refreshToken);
  } catch {
    return [];
  }
}

async function savePool(poolPath, accounts) {
  await fs.mkdir(path.dirname(poolPath), {recursive: true});
  const temporary = `${poolPath}.${process.pid}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(accounts, null, 2)}\n`, {mode: 0o600});
  await fs.rename(temporary, poolPath);
}

const options = parseArguments(process.argv.slice(2));
if (options === null) process.exit(0);

const pool = await loadPool(options.pool);
const knownUserIds = new Set(pool.map(account => account.userId));
process.stdout.write(`account pool ${pool.length}/${options.count}\n`);

while (pool.length < options.count) {
  const transport = new LiveTransport({logger: {record: () => {}}});
  try {
    const userId = await transport.signIn();
    if (!knownUserIds.has(userId)) {
      pool.push({userId, refreshToken: transport.refreshToken});
      knownUserIds.add(userId);
      await savePool(options.pool, pool);
      process.stdout.write(`created account ${pool.length}/${options.count}\n`);
    }
    await new Promise(resolve => setTimeout(resolve, options.delayMs));
  } catch (error) {
    process.stdout.write(`signup failed: ${error.message}; waiting\n`);
    await new Promise(resolve => setTimeout(resolve, 60000));
  }
}

process.stdout.write('account pool ready\n');
