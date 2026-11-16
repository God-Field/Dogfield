/**
 * Append-only JSON Lines logger.
 *
 * Every record is one self-contained JSON object on one line. The schema tag in
 * the `meta` record lets an offline reader parse, aggregate, and replay runs
 * without guessing. Request bodies and auth responses are redacted so logs can
 * be shared safely.
 */
import fs from 'node:fs';
import path from 'node:path';

const SECRET_KEYS = /^(idToken|refreshToken|access_token|refresh_token|Authorization)$/i;

export function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (value instanceof Map) {
    const output = {};
    for (const [key, item] of value) output[key] = SECRET_KEYS.test(key) ? '<redacted>' : redact(item);
    return output;
  }
  if (value !== null && typeof value === 'object') {
    const output = {};
    for (const [key, item] of Object.entries(value)) {
      output[key] = SECRET_KEYS.test(key) ? '<redacted>' : redact(item);
    }
    return output;
  }
  return value;
}

export class JsonlLogger {
  constructor(file, context = {}) {
    this.file = file;
    this.context = context;
    this.sequence = 0;
    this.startedAt = Date.now();
    fs.mkdirSync(path.dirname(file), {recursive: true});
    this.stream = fs.createWriteStream(file, {flags: 'a'});
    this.stream.on('error', error => {
      process.stderr.write(`log stream failed: ${error.stack ?? error}\n`);
    });
  }

  record(type, fields = {}) {
    const entry = {
      schema: 'godfield-live-log/1',
      seq: this.sequence++,
      ts: new Date().toISOString(),
      elapsedMs: Date.now() - this.startedAt,
      type,
      ...this.context,
      ...fields,
    };
    this.stream.write(`${JSON.stringify(redact(entry))}\n`);
    return entry;
  }

  flush() {
    return new Promise(resolve => this.stream.end(resolve));
  }
}

export function logPathFor(directory, name) {
  return path.join(directory, `${name}.jsonl`);
}
