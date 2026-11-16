/**
 * Builds and imports the real headless engine for Node scripts.
 *
 * The game rules live in src/engine; this helper only compiles that subtree to
 * an ESM file and loads it. Concurrent processes build to distinct temporary
 * files and rename atomically, so parallel games never corrupt each other.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {build} from 'esbuild';

const root = path.resolve(import.meta.dirname, '../..');
const buildDir = path.join(import.meta.dirname, '.build');
const bundlePath = path.join(buildDir, 'engine.mjs');
const entryPath = path.join(import.meta.dirname, 'engine-entry.ts');

export async function ensureEngineBundle() {
  await fs.mkdir(buildDir, {recursive: true});
  // Always bundle from source so a changed domain/engine rule can never be
  // shadowed by a stale cache. Each process builds to a unique path and
  // renames atomically, so parallel games stay safe.
  const temporary = path.join(buildDir, `.engine-${process.pid}-${Date.now()}.mjs`);
  await build({
    entryPoints: [entryPath],
    outfile: temporary,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    logLevel: 'silent',
  });
  await fs.rename(temporary, bundlePath);
  return bundlePath;
}

export async function loadEngine() {
  const file = await ensureEngineBundle();
  // Cache-busting lets a long-lived wrapper reload a rebuilt engine.
  return import(`${pathToFileURL(file).href}?v=${Date.now()}`);
}

export {root};
