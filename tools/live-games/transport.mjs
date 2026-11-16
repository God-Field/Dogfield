/**
 * Live-service transport used by the orchestration scripts.
 *
 * This is the only layer that talks to Firebase. It deliberately mirrors the
 * real client's service calls: anonymous sign-in, Firestore snapshot reads for
 * the room document, and the cloud-function room actions named in
 * src/services/protocol.ts. All requests and all Firestore messages are logged.
 */
import crypto from 'node:crypto';
import {documentUrl, decodeFirestoreDocument} from './firestore.mjs';

export function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

// Chrome's x-browser-validation is base64(SHA-1(platform API key + full UA)).
// See https://github.com/dsekz/chrome-x-browser-validation-header. The live
// token observed here did not match the published Linux key for our Chrome 153
// UA, so it is kept as the default and can be overridden with env vars when a
// new Chrome build rotates the key/UA pair.
const BROWSER_UA = process.env.GODFIELD_BROWSER_UA
  ?? 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36';
const BROWSER_KEY = process.env.GODFIELD_BROWSER_KEY
  ?? 'AIzaSyBqJZh-7pA44blAaAkH6490hUFOwX0KCYM';
const GENERATED_VALIDATION = process.env.GODFIELD_BROWSER_UA && process.env.GODFIELD_BROWSER_KEY
  ? crypto.createHash('sha1').update(BROWSER_KEY + BROWSER_UA).digest('base64')
  : 'boAeyUjOFfkgf0XnDp141HVmZkM=';

const FIREBASE_BROWSER_HEADERS = {
  accept: '*/*',
  'accept-language': 'en-US,en;q=0.9',
  'cache-control': 'no-cache',
  pragma: 'no-cache',
  origin: 'https://godfield.net',
  referer: 'https://godfield.net/',
  'user-agent': BROWSER_UA,
  'x-browser-channel': 'stable',
  'x-browser-copyright': 'Copyright 2026 Google LLC. All Rights Reserved.',
  'x-browser-validation': process.env.GODFIELD_X_BROWSER_VALIDATION ?? GENERATED_VALIDATION,
  'x-browser-year': '2026',
  'x-client-version': 'Chrome/JsCore/13.1.0/FirebaseCore-web',
  'x-firebase-client': 'eyJ2ZXJzaW9uIjoyLCJoZWFydGJlYXRzIjpbeyJhZ2VudCI6ImZpcmUtY29yZS8wLjE2LjQgZmlyZS1jb3JlLWVzbTIwMjAvMC4xNi40IGZpcmUtanMvIGZpcmUtanMtYWxsLWNkbi8xMy4xLjAgZmlyZS1hdXRoLzEuMTMuOCBmaXJlLWF1dGgtZXNtMjAyMC8xLjEzLjggZmlyZS1mc3QvNC4xOS4wIGZpcmUtZnN0LWVzbTIwMjAvNC4xOS4wIiwiZGF0ZXMiOlsiMjAyNi0xMS0wNSJdfV19',
};

export const FIREBASE = {
  apiKey: 'AIzaSyCBvMvZkHymK04BfEaERtbmELhyL8-mtAg',
  projectId: 'godfield',
  authDomain: 'godfield.firebaseapp.com',
  databaseURL: 'https://godfield.firebaseio.com',
  cloudFunctions: 'https://asia-northeast1-godfield.cloudfunctions.net',
  identityToolkit: 'https://identitytoolkit.googleapis.com/v1',
  secureToken: 'https://securetoken.googleapis.com/v1',
};

function toPlain(value) {
  if (value instanceof Map) {
    const output = {};
    for (const [key, item] of value) output[key] = toPlain(item);
    return output;
  }
  if (value instanceof Set) return [...value].map(toPlain);
  if (Array.isArray(value)) return value.map(toPlain);
  if (value !== null && typeof value === 'object') {
    const output = {};
    for (const [key, item] of Object.entries(value)) output[key] = toPlain(item);
    return output;
  }
  return value;
}

export class HttpError extends Error {
  constructor(action, status, body) {
    super(`${action} failed with HTTP ${status}${body ? `: ${body}` : ''}`);
    this.name = 'HttpError';
    this.action = action;
    this.status = status;
    this.body = body;
  }
}

export class LiveTransport {
  constructor({logger, roomMode = 'training', pollIntervalMs = 300, logPolls = 'summary', logChannelDocument = true} = {}) {
    this.logger = logger;
    this.logChannelDocument = logChannelDocument;
    this.roomMode = roomMode;
    this.pollIntervalMs = pollIntervalMs;
    this.logPolls = logPolls;
    this.idToken = null;
    this.refreshToken = null;
    this.expiresAt = 0;
    this.userId = null;
    this.requestId = 0;
    this.channelSequence = 0;
    this.lastChannelUpdate = null;
    this.stopped = false;
  }

  async signIn() {
    const url = `${FIREBASE.identityToolkit}/accounts:signUp?key=${FIREBASE.apiKey}`;
    const retryDelays = [2000, 5000, 10000, 20000];
    for (let attempt = 0; ; attempt++) {
      const started = Date.now();
      const response = await fetch(url, {
        method: 'POST',
        headers: {...FIREBASE_BROWSER_HEADERS, 'Content-Type': 'application/json'},
        body: JSON.stringify({returnSecureToken: true}),
      });
      const text = await response.text();
      let body = null;
      try {
        body = text.length ? JSON.parse(text) : null;
      } catch {
        body = text;
      }
      this.logger.record('request', {
        id: ++this.requestId,
        action: 'auth.signUp',
        method: 'POST',
        url,
        request: {returnSecureToken: true},
        status: response.status,
        ok: response.ok,
        attempt,
        durationMs: Date.now() - started,
        response: body,
      });
      if (response.ok) {
        this.applyAuth(body);
        return this.userId;
      }
      const retryable = response.status === 429
        || (response.status === 400 && /TOO_MANY_ATTEMPTS_TRY_LATER/i.test(text));
      if (!retryable || attempt >= retryDelays.length) throw new HttpError('auth.signUp', response.status, text);
      await new Promise(resolve => setTimeout(resolve, retryDelays[attempt]));
    }
  }

  applyAuth(body) {
    this.idToken = body.idToken ?? body.id_token ?? this.idToken;
    this.refreshToken = body.refreshToken ?? body.refresh_token ?? this.refreshToken;
    this.userId = body.localId ?? body.user_id ?? this.userId;
    const lifetime = Number(body.expiresIn ?? body.expires_in ?? 3600);
    this.expiresAt = Date.now() + lifetime * 1000;
  }

  async refreshAuth() {
    if (!this.refreshToken) throw new Error('No refresh token');
    const url = `${FIREBASE.secureToken}/token?key=${FIREBASE.apiKey}`;
    const started = Date.now();
    const response = await fetch(url, {
      method: 'POST',
      headers: {'Content-Type': 'application/x-www-form-urlencoded'},
      body: new URLSearchParams({grant_type: 'refresh_token', refresh_token: this.refreshToken}),
    });
    const text = await response.text();
    let body = null;
    try {
      body = text.length ? JSON.parse(text) : null;
    } catch {
      body = text;
    }
    this.logger.record('request', {
      id: ++this.requestId,
      action: 'auth.refresh',
      method: 'POST',
      url,
      request: {grant_type: 'refresh_token', refresh_token: this.refreshToken},
      status: response.status,
      ok: response.ok,
      durationMs: Date.now() - started,
      response: body,
    });
    if (!response.ok) throw new HttpError('auth.refresh', response.status, text);
    this.applyAuth(body);
  }

  async ensureToken(force = false) {
    if (!this.idToken) return this.signIn();
    if (force || Date.now() > this.expiresAt - 60000) await this.refreshAuth();
  }

  async authorizedFetch(action, url, options) {
    await this.ensureToken();
    let response = await fetch(url, options);
    if (response.status === 401) {
      await this.refreshAuth();
      response = await fetch(url, options);
    }
    return response;
  }

  async call(action, payload = new Map()) {
    const url = `${FIREBASE.cloudFunctions}/${action}`;
    const plain = toPlain(payload);
    const started = Date.now();
    const response = await this.authorizedFetch(action, url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.idToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(plain),
    });
    const text = await response.text();
    let body = null;
    try {
      body = text.length ? JSON.parse(text) : null;
    } catch {
      body = text;
    }
    this.logger.record('request', {
      id: ++this.requestId,
      action,
      method: 'POST',
      url,
      request: plain,
      status: response.status,
      ok: response.ok,
      durationMs: Date.now() - started,
      response: body,
    });
    if (!response.ok) throw new HttpError(action, response.status, text);
    return body;
  }

  async readRoom(roomId, options = {}) {
    return this.readDocument(`modes/${this.roomMode}/rooms/${roomId}`, options);
  }

  async readDocument(path, {log = true} = {}) {
    const url = documentUrl(FIREBASE.projectId, path);
    const started = Date.now();
    const response = await this.authorizedFetch('firestore.get', url, {
      method: 'GET',
      headers: {Authorization: `Bearer ${this.idToken}`},
    });
    const text = await response.text();
    let raw = null;
    let body = null;
    try {
      body = text.length ? JSON.parse(text) : null;
    } catch {
      body = text;
    }
    if (response.ok && body) {
      raw = decodeFirestoreDocument(body);
      raw.__documentUpdateTime = body.updateTime ?? null;
      raw.__createTime = body.createTime ?? null;
    }
    if (log) {
      const summary = raw === null ? null : {
        updateTime: raw.updatedAt ?? body?.updateTime ?? null,
        updateCount: raw.game?.updateCount ?? null,
        userCount: raw.userCount ?? null,
      };
      this.logger.record('request', {
        id: ++this.requestId,
        action: 'firestore.get',
        method: 'GET',
        url,
        status: response.status,
        ok: response.ok,
        durationMs: Date.now() - started,
        response: this.logPolls === 'all' ? {summary, document: raw} : summary,
        error: response.ok ? undefined : body,
      });
    }
    if (response.status === 404) return {exists: false, raw: null, status: 404};
    if (!response.ok) throw new HttpError('firestore.get', response.status, text);
    return {exists: true, raw, status: response.status};
  }

  /**
   * Polls the room document and forwards each changed snapshot. Firestore's
   * realtime Listen RPC is gRPC/HTTP2-only, so the Node scripts use the same
   * document endpoint with a short interval. A changed snapshot is the channel
   * message the browser client would have received through onSnapshot.
   */
  async listCollection(collectionPath, {log = true} = {}) {
    const url = documentUrl(FIREBASE.projectId, collectionPath);
    const started = Date.now();
    const response = await this.authorizedFetch('firestore.list', url, {
      method: 'GET',
      headers: {Authorization: `Bearer ${this.idToken}`},
    });
    const text = await response.text();
    let body = null;
    try {
      body = text.length ? JSON.parse(text) : null;
    } catch {
      body = text;
    }
    const documents = Array.isArray(body?.documents)
      ? body.documents.map(document => ({
        name: document.name?.split('/documents/')[1] ?? document.name ?? null,
        id: document.name?.split('/').pop() ?? null,
        updateTime: document.updateTime ?? null,
        createTime: document.createTime ?? null,
        document: decodeFirestoreDocument(document),
      }))
      : [];
    if (log) {
      this.logger.record('request', {
        id: ++this.requestId,
        action: 'firestore.list',
        method: 'GET',
        url,
        status: response.status,
        ok: response.ok,
        durationMs: Date.now() - started,
        response: {documentCount: documents.length, documents},
        error: response.ok ? undefined : body,
      });
    }
    if (!response.ok) throw new HttpError('firestore.list', response.status, text);
    return {documents, status: response.status};
  }

  async watchRoom(roomId, onSnapshot, {onMissing, intervalMs = this.pollIntervalMs} = {}) {
    this.stopped = false;
    let missingReported = false;
    while (!this.stopped) {
      const started = Date.now();
      const result = await this.readRoom(roomId);
      if (!result.exists) {
        if (!missingReported) {
          missingReported = true;
          onMissing?.();
        }
      } else {
        missingReported = false;
        const updateTime = result.raw.__documentUpdateTime ?? result.raw.updatedAt ?? null;
        const signature = updateTime === null ? `no-update:${Date.now()}` : updateTime;
        if (signature !== this.lastChannelUpdate) {
          this.lastChannelUpdate = signature;
          const channelSequence = ++this.channelSequence;
          const gameHash = crypto.createHash('sha256').update(stableStringify(result.raw.game ?? null)).digest('hex');
          const message = {
            sequence: channelSequence,
            updateTime,
            gameHash,
            document: result.raw,
          };
          if (this.logChannelDocument) {
            this.logger.record('channel', message);
          } else {
            const documentHash = crypto.createHash('sha256').update(stableStringify(result.raw)).digest('hex');
            this.logger.record('channelSummary', {
              sequence: channelSequence,
              updateTime,
              documentHash,
              gameHash,
              updateCount: result.raw.game?.updateCount ?? null,
              userCount: result.raw.userCount ?? null,
            });
          }
          await onSnapshot(message);
        }
      }
      const wait = Math.max(0, intervalMs - (Date.now() - started));
      if (this.stopped) break;
      await new Promise(resolve => setTimeout(resolve, wait));
    }
    return null;
  }

  stop() {
    this.stopped = true;
  }
}

export {toPlain};
