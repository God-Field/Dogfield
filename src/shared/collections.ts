
export function first<T>(items: readonly T[]): T {
  if (items.length === 0) throw new Error('No element');
  return items[0];
}
export function last<T>(items: readonly T[]): T {
  if (items.length === 0) throw new Error('No element');
  return items[items.length - 1];
}
export function removeAt<T>(items: T[], index: number): T {
  if (!Number.isInteger(index) || index < 0 || index >= items.length) throw new RangeError(`Invalid index: ${index}`);
  return items.splice(index, 1)[0];
}
export function removeValue<T>(items: T[], item: T): boolean {
  const index = items.indexOf(item);
  if (index < 0) return false;
  items.splice(index, 1);
  return true;
}
export function findRequired<T>(items: readonly T[], predicate: (item: T) => boolean): T {
  const index = items.findIndex(predicate);
  if (index < 0) throw new Error('No element');
  return items[index];
}
export function findLastRequired<T>(items: readonly T[], predicate: (item: T) => boolean): T {
  for (let index = items.length - 1; index >= 0; index--) {
    if (predicate(items[index])) {
      return items[index];
    }
  }
  throw new Error('No element');
}
export function appendAll<T>(target: T[] | Set<T>, values: Iterable<T>): void {
  if (target === values) throw new Error('Concurrent modification during iteration');
  for (const value of values) {
    if (Array.isArray(target)) target.push(value);
    else target.add(value);
  }
}
export function mapFromPairs<K, V>(pairs: readonly (K | V)[]): Map<K, V> {
  if (pairs.length % 2) {
    throw new RangeError('Expected alternating keys and values');
  }
  const result = new Map<K, V>();
  for (let index = 0; index < pairs.length; index += 2) {
    result.set(pairs[index] as K, pairs[index + 1] as V);
  }
  return result;
}
export function isMap(value: unknown): value is Map<unknown, unknown> {
  return value instanceof Map;
}
export function asMap(value: unknown): Map<string, unknown> {
  return value instanceof Map ? new Map(value) : new Map();
}

export function decodeJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(decodeJson);
  if (value !== null && typeof value === 'object') return new Map(Object.entries(value).map(([key, item]) => [key, decodeJson(item)]));
  return value;
}
export function encodeJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => item instanceof Map ? Object.fromEntries(item) : item instanceof Set ? [...item] : item);
}
export function getValue<K,V>(collection: ReadonlyMap<K,V>, key: K): V | null;
export function getValue<T>(collection: readonly T[], key: number): T;
export function getValue(collection: string, key: number): string;
export function getValue(collection: ReadonlyMap<unknown,unknown> | readonly unknown[] | string, key: unknown): unknown {
  if (collection instanceof Map) return collection.get(key) ?? null;
  const indexed = collection as readonly unknown[] | string;
  if (typeof key !== 'number' || !Number.isInteger(key) || key < 0 || key >= indexed.length) throw new RangeError(`Invalid index: ${String(key)}`);
  return indexed[key];
}
export function setValue<K, V>(collection: Map<K, V> | V[], key: K, value: V): void {
  if (collection instanceof Map) collection.set(key, value);
  else {
    if (typeof key !== 'number' || !Number.isInteger(key) || key < 0 || key >= collection.length) throw new RangeError(`Invalid index: ${key}`);
    collection[key] = value;
  }
}
export function contains<T>(collection: Map<T, unknown> | Set<T> | readonly T[] | string, value: T): boolean {
  if (typeof collection === 'string') return collection.includes(String(value));
  if (Array.isArray(collection)) return collection.includes(value);
  return (collection as Map<T, unknown> | Set<T>).has(value);
}
export function forEachEntry<K, V>(collection: Map<K, V>, callback: (key: K, value: V) => void): void {
  collection.forEach((value, key) => callback(key, value));
}
export function sizeOf(value: {length: number} | {size: number} | Iterable<unknown>): number {
  if ('length' in value) return value.length;
  if ('size' in value) return value.size;
  let count = 0;
  for (const _item of value) count++;
  return count;
}
export function* mapValues<T, U>(values: Iterable<T>, callback: (value: T) => U): IterableIterator<U> {
  for (const value of values) yield callback(value);
}
export function* filterValues<T>(values: Iterable<T>, callback: (value: T) => boolean): IterableIterator<T> {
  for (const value of values) if (callback(value)) yield value;
}
export function* nonNullValues<T>(values: Iterable<T | null | undefined>): IterableIterator<T> {
  for (const value of values) if (value != null) yield value;
}
export const toArray = <T>(values: Iterable<T>): T[] => Array.from(values);

export function toInteropObject(value: unknown): unknown {
  if (value instanceof Map) return Object.fromEntries([...value].map(([key, item]) => [key, toInteropObject(item)]));
  if (Array.isArray(value)) return value.map(toInteropObject);
  return value;
}

export function removeEntry<K,V>(collection: Map<K,V>, key: K): V | null;
export function removeEntry<T>(collection: Set<T>, value: T): boolean;
export function removeEntry<K,V>(collection: Map<K,V> | Set<K>, key: K): V | null | boolean {
  if (collection instanceof Set) return collection.delete(key);
  const previous = collection.get(key) ?? null;
  collection.delete(key);
  return previous;
}
