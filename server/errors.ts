import { STATUS_CODES } from 'node:http';
export class HttpError extends Error {
  constructor(public readonly status = 400) {
    super(`${status} ${STATUS_CODES[status] ?? 'Error'}\n`);
  }
}
export function requireValue(
  condition: unknown,
  status = 400,
): asserts condition {
  if (!condition) {
    throw new HttpError(status);
  }
}
