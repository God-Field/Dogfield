import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = fileURLToPath(new URL('../..', import.meta.url));
const sources = process.argv.filter((argument) => argument.startsWith('--source=')).map((argument) => resolve(argument.slice(9)));
if (!sources.length) {
  throw new Error('Pass --source=/path/to/decompiled/scripts (repeat for each client). This audit uses only local files.');
}
const serverDirectory = resolve(repository, 'server/flash');
const serverFiles = (await readdir(serverDirectory, { recursive: true })).filter((filename) => filename.endsWith('.ts'));
const server = (await Promise.all(serverFiles.map((filename) => readFile(resolve(serverDirectory, filename), 'utf8')))).join('\n');
const emitted = new Set([...server.matchAll(/\b(?:element|send)\(\s*['"]([A-Z][A-Z_]*)['"]/g)].map((match) => match[1]));
const rejectionType = server.match(/type ModeEntryRejection = ([\s\S]*?);/)[1];
const rejections = [...rejectionType.matchAll(/'([^']+)'/g)].map((match) => match[1]);
const reports = [];
for (const source of sources) {
  const files = (await readdir(source, { recursive: true })).filter((filename) => filename.endsWith('.as'));
  const scripts = (await Promise.all(files.map((filename) => readFile(resolve(source, filename), 'utf8')))).join('\n');
  const responses = [...scripts.matchAll(/public static const ([A-Z_]+):Response/g)].map((match) => match[1]);
  const references = new Set([...scripts.matchAll(/Response\.([A-Z_]+)/g)].map((match) => match[1]));
  const errors = [...new Set([...scripts.matchAll(/xml\.message\s*==\s*['"]([^'"]+)['"]/g)].map((match) => match[1]))];
  reports.push({
    source,
    recognizedResponses: responses.filter((name) => references.has(name)),
    missingEmitters: responses.filter((name) => references.has(name) && !emitted.has(name)),
    unreferencedEnumValues: responses.filter((name) => !references.has(name)),
    recognizedErrors: errors,
    missingErrorNames: errors.filter((name) => !server.includes(`'${name}'`)),
  });
}
console.log(JSON.stringify({
  note: 'Static emitter/reference audit. Runtime ordering and trigger coverage are verified by the offline and browser checks.',
  modeEntryRejections: rejections,
  serverEmitters: [...emitted].sort(),
  clients: reports,
}, null, 2));
