#!/usr/bin/env node
/**
 * Gzip old JSONL logs while keeping the .jsonl.gz suffix readable by the
 * analysis tools.
 *
 *   node tools/live-games/gzip-logs.mjs --root logs/experiments
 *   node tools/live-games/gzip-logs.mjs --run logs/experiments/melee/old-run
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { gzip } from 'node:zlib';
import { promisify } from 'node:util';

const gzipAsync = promisify(gzip);

function parseArguments(argv) {
  const options = {
    root: path.resolve('logs/experiments'),
    minAgeMinutes: 30,
    keepOriginals: false,
  };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    const next = () => {
      const value = argv[++index];
      if (value === undefined) throw new Error(`Missing value for ${argument}`);
      return value;
    };
    switch (argument) {
      case '--root': options.root = path.resolve(next()); break;
      case '--run': options.root = path.resolve(next()); break;
      case '--min-age-minutes': options.minAgeMinutes = Number(next()); break;
      case '--keep-originals': options.keepOriginals = true; break;
      case '--help':
        process.stdout.write(
          'Usage: gzip-logs.mjs --root DIR [--min-age-minutes N] [--keep-originals]\n',
        );
        return null;
      default: throw new Error(`Unknown argument: ${argument}`);
    }
  }
  return options;
}

async function collectJsonlFiles(directory, files) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await collectJsonlFiles(entryPath, files);
      continue;
    }
    if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      files.push(entryPath);
    }
  }
}

const options = parseArguments(process.argv.slice(2));
if (options === null) process.exit(0);

const cutoff = Date.now() - options.minAgeMinutes * 60 * 1000;
const files = [];
await collectJsonlFiles(options.root, files);

let compressed = 0;
let skipped = 0;
let inputBytes = 0;
let outputBytes = 0;
for (const file of files) {
  let stats;
  try {
    stats = await fs.stat(file);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      skipped++;
      continue;
    }
    throw error;
  }
  if (stats.mtimeMs > cutoff) {
    skipped++;
    continue;
  }
  const target = `${file}.gz`;
  const temporary = `${target}.${process.pid}.tmp`;
  try {
    const contents = await fs.readFile(file);
    const compressedContents = await gzipAsync(contents, { level: 9 });
    await fs.writeFile(temporary, compressedContents);
    await fs.rename(temporary, target);
    if (!options.keepOriginals) {
      await fs.unlink(file);
    }
    compressed++;
    inputBytes += contents.length;
    outputBytes += compressedContents.length;
  } catch (error) {
    if (error?.code === 'ENOENT') {
      skipped++;
      continue;
    }
    throw error;
  }
}

process.stdout.write(
  `compressed ${compressed} file(s), skipped ${skipped}, ` +
  `${inputBytes} -> ${outputBytes} bytes\n`,
);
