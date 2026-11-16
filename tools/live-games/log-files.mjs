import { access, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { gunzip } from 'node:zlib';
import { promisify } from 'node:util';

const gunzipAsync = promisify(gunzip);

export function isJsonlLog(fileName) {
  return fileName.endsWith('.jsonl') || fileName.endsWith('.jsonl.gz');
}

export async function readLogText(filePath) {
  const contents = await readFile(filePath);
  if (!filePath.endsWith('.gz')) {
    return contents.toString('utf8');
  }
  return (await gunzipAsync(contents)).toString('utf8');
}

export function readJsonlText(text) {
  const records = [];
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      // A live logger may be appending a partial final line.
    }
  }
  return records;
}

export async function readJsonl(filePath) {
  return readJsonlText(await readLogText(filePath));
}

export async function findLogFiles(directory, { recursive = true } = {}) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (recursive) files.push(...await findLogFiles(entryPath, { recursive }));
      continue;
    }
    if (isJsonlLog(entry.name)) files.push(entryPath);
  }
  return files.sort();
}

export async function findMatchingLogFiles(directory, pattern) {
  const entries = await readdir(directory, { withFileTypes: true });
  return entries
    .filter(entry => entry.isFile() && isJsonlLog(entry.name) && pattern.test(entry.name))
    .map(entry => path.join(directory, entry.name))
    .sort();
}

export async function findNamedLog(directory, baseName) {
  for (const suffix of ['.jsonl', '.jsonl.gz']) {
    const candidate = path.join(directory, `${baseName}${suffix}`);
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Try the next suffix.
    }
  }
  return null;
}
