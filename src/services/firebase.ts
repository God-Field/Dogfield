import {createLocalBridge} from './local';
import {state} from '../app/state';
import {asMap, decodeJson, encodeJson} from '../shared/collections';

export interface FirebaseUser {
  uid: string;
  getIdToken(): Promise<string>;
}
export interface FirebaseAuth {
  currentUser: FirebaseUser | null;
  authStateReady(): Promise<void>;
}
export interface DocumentSnapshot { data(): unknown; }
export interface FirebaseBridge {
  initializeApp(options: {apiKey: string; authDomain: string; databaseURL: string; projectId: string}): unknown;
  getAuth(app: unknown): FirebaseAuth;
  getFirestore(app: unknown): unknown;
  signInAnonymously(auth: FirebaseAuth): Promise<unknown>;
  deleteUser(user: FirebaseUser): Promise<void>;
  doc(database: unknown, path: string): unknown;
  getDoc(reference: unknown): Promise<DocumentSnapshot>;
  onSnapshot(reference: unknown, callback: (snapshot: DocumentSnapshot) => void): () => void;
}
declare global {
  interface Window { firebase: FirebaseBridge; }
  var dartMainRunner: undefined | ((main: (args?: string[]) => void, args: string[]) => void);
}
export class CloudFunctionError extends Error {
  constructor(public readonly status: number | null = null, message?: string) {
    super(message ?? (status === null ? 'Cloud function request failed' : `Cloud function request failed with status ${status}`));
  }
}
const activeRequests = new Set<AbortController>();
function isAbortError(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'name' in error
    && (error as {name?: unknown}).name === 'AbortError';
}
export function closeNetworkRequests(): void {
  for (const controller of activeRequests) controller.abort();
  activeRequests.clear();
}
export async function initializeFirebase(): Promise<void> {
  if (window.godfieldLocalServer) window.firebase = createLocalBridge();
  const firebase = window.firebase;
  const app = firebase.initializeApp({
    apiKey: 'AIzaSyCBvMvZkHymK04BfEaERtbmELhyL8-mtAg',
    authDomain: 'godfield.firebaseapp.com',
    databaseURL: 'https://godfield.firebaseio.com',
    projectId: 'godfield'
  });
  state.auth = firebase.getAuth(app);
  state.database = firebase.getFirestore(app);
  await state.auth.authStateReady();
}
export async function signInAnonymously(): Promise<void> { await window.firebase.signInAnonymously(state.auth); }
export async function deleteFirebaseUser(): Promise<void> {
  const user = state.auth.currentUser;
  if (user) await window.firebase.deleteUser(user);
}
export function getFirebaseUserId(): string | null { return state.auth.currentUser?.uid ?? null; }
export async function getFirebaseIdToken(): Promise<string | null> { return await state.auth.currentUser?.getIdToken() ?? null; }
export async function loadFirestoreDocument(path: string): Promise<Map<string, unknown>> {
  const snapshot = await window.firebase.getDoc(window.firebase.doc(state.database, path));
  return asMap(decodeJson(snapshot.data()));
}
export function subscribeToFirestoreDocument(path: string, onData: (value: Map<string, unknown>) => void): () => void {
  return window.firebase.onSnapshot(window.firebase.doc(state.database, path), snapshot => onData(asMap(decodeJson(snapshot.data()))));
}
export async function callCloudFunction(action: string, payload: unknown): Promise<Map<string, unknown>> {
  const controller = new AbortController();
  activeRequests.add(controller);
  try {
    const token = await getFirebaseIdToken();
    const response = await fetch(`${window.godfieldLocalServer ? "/api/functions" : "https://asia-northeast1-godfield.cloudfunctions.net"}/${action}`, {
      method: 'POST',
      headers: {Authorization: `Bearer ${token}`, 'Content-Type': 'application/json'},
      body: encodeJson(payload),
      credentials: 'same-origin',
      redirect: 'follow',
      signal: controller.signal
    });
    if (response.status !== 200) throw new CloudFunctionError(response.status);
    // The original HTTP client defaults JSON without a charset to UTF-8 and
    // other content types without a charset to ISO-8859-1.
    const contentType = response.headers.get('content-type') ?? '';
    const charset = /charset\s*=\s*["']?([^\s;"']+)/i.exec(contentType)?.[1];
    const encoding = charset ?? (contentType.split(';')[0].trim().toLowerCase() === 'application/json' ? 'utf-8' : 'iso-8859-1');
    const bytes = await response.arrayBuffer();
    const text = new TextDecoder(encoding).decode(bytes);
    return text.length ? asMap(decodeJson(JSON.parse(text))) : new Map();
  } catch (error) {
    if (isAbortError(error)) throw new CloudFunctionError(null, 'Request aborted');
    throw error;
  } finally {
    activeRequests.delete(controller);
  }
}
