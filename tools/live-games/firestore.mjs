/**
 * Minimal Firestore REST v1 codec and document reader.
 *
 * The browser client receives snapshots through the Firebase SDK. Node scripts
 * cannot use that SDK without a browser, so the same documents are read through
 * the public REST API. Values are decoded into ordinary JSON (the game decoder
 * converts them to Maps afterwards), and every call is returned to the caller
 * together with request metadata so it can be logged.
 */

export function decodeFirestoreValue(value) {
  if (value === null || typeof value !== 'object') return value;
  if ('nullValue' in value) return null;
  if ('booleanValue' in value) return value.booleanValue;
  if ('integerValue' in value) return Number(value.integerValue);
  if ('doubleValue' in value) return Number(value.doubleValue);
  if ('timestampValue' in value) return value.timestampValue;
  if ('stringValue' in value) return value.stringValue;
  if ('bytesValue' in value) return value.bytesValue;
  if ('referenceValue' in value) return value.referenceValue;
  if ('geoPointValue' in value) return value.geoPointValue;
  if ('arrayValue' in value) {
    const values = value.arrayValue.values ?? [];
    return values.map(decodeFirestoreValue);
  }
  if ('mapValue' in value) {
    const output = {};
    for (const [key, field] of Object.entries(value.mapValue.fields ?? {})) {
      output[key] = decodeFirestoreValue(field);
    }
    return output;
  }
  return value;
}

export function decodeFirestoreDocument(document) {
  const output = {};
  for (const [key, field] of Object.entries(document.fields ?? {})) {
    output[key] = decodeFirestoreValue(field);
  }
  return output;
}

export function encodeFirestoreValue(value) {
  if (value === null || value === undefined) return {nullValue: null};
  if (typeof value === 'boolean') return {booleanValue: value};
  if (typeof value === 'number') {
    return Number.isInteger(value) ? {integerValue: String(value)} : {doubleValue: value};
  }
  if (typeof value === 'string') return {stringValue: value};
  if (value instanceof Date) return {timestampValue: value.toISOString()};
  if (Array.isArray(value)) return {arrayValue: {values: value.map(encodeFirestoreValue)}};
  if (value instanceof Set) return {arrayValue: {values: [...value].map(encodeFirestoreValue)}};
  if (value instanceof Map) {
    const fields = {};
    for (const [key, item] of value) fields[key] = encodeFirestoreValue(item);
    return {mapValue: {fields}};
  }
  if (typeof value === 'object') {
    const fields = {};
    for (const [key, item] of Object.entries(value)) fields[key] = encodeFirestoreValue(item);
    return {mapValue: {fields}};
  }
  throw new TypeError(`Cannot encode Firestore value: ${typeof value}`);
}

export function documentUrl(projectId, path) {
  const database = '(default)';
  return `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(projectId)}` +
    `/databases/${encodeURIComponent(database)}/documents/${path.split('/').map(encodeURIComponent).join('/')}`;
}
