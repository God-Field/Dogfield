export const UNSET = Symbol('uninitialized');
export const identity = <T>(value: T): T => value;
export const isInteger = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value);
export const isBoolean = (value: unknown): value is boolean => typeof value === 'boolean';
export const isPresent = (value: unknown): boolean => value != null;
export function requireBoolean(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new TypeError('Expected boolean');
  return value;
}
export function requireNumber(value: unknown): number {
  if (typeof value !== 'number') throw new TypeError('Expected number');
  return value;
}
export function notNull<T>(value: T | null | undefined): T {
  if (value == null) throw new TypeError('Unexpected null');
  return value;
}
export const stringify = (value: unknown): string => String(value ?? null);
export function tryParseInteger(value: string): number | null {
  const trimmed = value.trim();
  if (!/^[+-]?(?:0[xX][0-9a-fA-F]+|\d+)$/.test(trimmed)) return null;
  const number = /^[+-]?0[xX]/.test(trimmed) ? (trimmed[0] === '-' ? -1 : 1) * parseInt(trimmed.replace(/^[+-]/, ''), 16) : Number(trimmed);
  return Number.isFinite(number) ? Math.trunc(number) : null;
}
export function parseInteger(value: string): number {
  const result = tryParseInteger(value);
  if (result === null) throw new Error(`Invalid integer: ${value}`);
  return result;
}
export function parseDouble(value: string): number {
  if (value.trim() === '') throw new Error('Invalid double');
  const parsed = Number(value);
  if (Number.isNaN(parsed) && value.trim() !== 'NaN') throw new Error(`Invalid double: ${value}`);
  return parsed;
}
export const replaceFirst = (text: string, search: string, replacement: string): string => {
  const index = text.indexOf(search);
  return index < 0 ? text : text.substring(0, index) + replacement + text.substring(index + search.length);
};
export const replaceAll = (text: string, search: string, replacement: string): string => search === '' ? replacement + text.split('').join(replacement) + (text ? replacement : '') : text.split(search).join(replacement);
export const trimText = (text: string): string => text.replace(/^[\s\u0085]+|[\s\u0085]+$/g, '');
export function modulo(value: number, divisor: number): number {
  const result = value % divisor;
  return result < 0 ? result + divisor : result === 0 ? 0 : result;
}
export function truncateDivide(value: number, divisor: number): number {
  const result = Math.trunc(value / divisor);
  if (!Number.isFinite(result)) throw new RangeError('Invalid truncating division');
  return result;
}
export const compare = (left: number, right: number): number => left === right ? 0 : left < right ? -1 : 1;
export const randomIndex = (length: number): number => Math.floor(Math.random() * length);
export const padTwo = (value: number): string => value.toString().padStart(2, '0');
export const charCodes = (text: string): number[] => Array.from({ length: text.length }, (_, index) => text.charCodeAt(index));
export const fromCharCodes = (values: Iterable<number>, start = 0, end?: number): string => String.fromCharCode(...Array.from(values).slice(start, end));
export const stateError = (message: string): Error => new Error(message);
export const argumentError = (message: string): Error => new TypeError(message);
export const formatError = (value: string): Error => new Error(`Invalid format: ${value}`);
export const uninitializedError = (name: string): Error => new Error(`Field '${name}' has not been initialized.`);
export const initializedError = (name: string): Error => new Error(`Local '${name}' has already been initialized.`);
export function uninitialized(name: string): never { throw uninitializedError(name); }
export function raise(error: unknown): never { throw error; }
export function invalidState(_value: unknown): never { throw new Error('Concurrent modification during iteration'); }
export function indexError(_collection: unknown, index: number): never { throw new RangeError(`Invalid index: ${index}`); }
export const unwrapError = (error: unknown): unknown => error instanceof Error && error.cause ? error.cause : error;
export const errorStack = (error: unknown): string => error instanceof Error ? error.stack ?? '' : '';
export function checkRange(start: number, end: number | null, length: number): number {
  if (start < 0 || start > length || end != null && (end < start || end > length)) throw new RangeError('Invalid range');
  return end ?? length;
}
export const parseUrl = (url: string): URL => new URL(url);
export function isInstance(value: unknown, path: string): boolean {
  let constructor: unknown = globalThis;
  for (const part of path.split('.')) constructor = (constructor as Record<string, unknown>)?.[part];
  return typeof constructor === 'function' && value instanceof constructor;
}
export async function waitAll<T>(values: Iterable<PromiseLike<T> | T>): Promise<T[]> {

  let failed = false;
  let firstError: unknown;
  const results = await Promise.all(Array.from(values, value => Promise.resolve(value).catch(error => {
    if (!failed) {
      failed = true;
      firstError = error;
    }
    return undefined;
  })));
  if (failed) throw firstError;
  return results as T[];
}

export function assertPresent<T>(value: T): asserts value is NonNullable<T> {
  if (value == null) throw new TypeError('Unexpected null');
}
