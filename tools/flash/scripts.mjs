import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

export function normalizeScript(source) {
  const normalized = source.replace(/\r\n?/g, '\n').split('\n').map((line) => line.trimEnd()).join('\n');
  return normalized.endsWith('\n') ? normalized : `${normalized}\n`;
}

export async function scriptPatches(directory) {
  const filenames = await readdir(directory, { recursive: true });
  return filenames.filter((filename) => filename.endsWith('.as.patch')).sort();
}

export async function extractScripts({ jar, movie, directory, filenames }) {
  await mkdir(directory, { recursive: true });
  const classes = [...new Set(filenames)].map((filename) => filename.slice(0, -3).replaceAll('/', '.'));
  const result = spawnSync('java', ['-jar', resolve(jar), '-selectclass', classes.join(','),
    '-export', 'script', resolve(directory), resolve(movie)], { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`JPEXS script extraction failed: ${result.error?.message ?? ''}\n${result.stdout}\n${result.stderr}`);
  }
  const scripts = join(directory, 'scripts');
  for (const filename of new Set(filenames)) {
    const path = join(scripts, filename);
    await writeFile(path, normalizeScript(await readFile(path, 'utf8')));
  }
  return scripts;
}

export async function applyScriptPatches(scripts, directory) {
  for (const filename of await scriptPatches(directory)) {
    const patchPath = resolve(directory, filename);
    const patch = await readFile(patchPath, 'utf8');
    const script = filename.slice(0, -6);
    const expectedHeader = `--- a/${script}\n+++ b/${script}\n`;
    if (!patch.startsWith(expectedHeader)) {
      throw new Error(`Unexpected script patch headers: ${patchPath}`);
    }
    const result = spawnSync('patch', ['--batch', '--forward', '--fuzz=0', '--no-backup-if-mismatch',
      '-p1', '-i', patchPath], { cwd: scripts, encoding: 'utf8' });
    if (result.status !== 0) {
      throw new Error(`ActionScript patch failed: ${patchPath}\n${result.error?.message ?? ''}\n${result.stdout}\n${result.stderr}`);
    }
  }
}
