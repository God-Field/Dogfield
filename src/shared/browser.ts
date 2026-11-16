export function listen<T extends Event>(element: EventTarget, type: string, callback: (event: T) => void): {cancel(): Promise<void>} {
  const handler: EventListener = event => callback(event as T);
  element.addEventListener(type, handler, false);
  return {cancel: async () => element.removeEventListener(type, handler, false)};
}
export const getGlobal = (): typeof globalThis => globalThis;
export const getProperty = (object: Record<string, unknown>, key: string): unknown => object[key];
export function invokeMethod(object: Record<string, unknown>, name: string, argument: unknown): unknown {
  const method = object[name];
  if (typeof method !== 'function') throw new TypeError(`Missing method: ${name}`);
  return Reflect.apply(method, object, [argument]);
}
export const createDiv = (): HTMLDivElement => document.createElement('div');
export const createMap = <K, V>(): Map<K, V> => new Map();
export const createSet = <T>(): Set<T> => new Set();
