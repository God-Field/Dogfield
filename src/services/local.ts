import type {
  FirebaseBridge,
  FirebaseAuth,
  FirebaseUser,
  DocumentSnapshot,
} from './firebase';
declare global {
  interface Window {
    godfieldLocalServer?: boolean;
  }
}
interface Identity {
  uid: string;
  token: string;
}
/** Adapts the existing Firebase surface to the local server's HTTP/SSE API. */
export function createLocalBridge(): FirebaseBridge {
  let identity: Identity | null = null;
  try {
    identity = JSON.parse(
      localStorage.getItem('godfield.local.identity') ?? 'null',
    );
  } catch {
    /* First sign-in replaces invalid saved data. */
  }

  const getCurrentUser = (): FirebaseUser | null =>
    identity
      ? {
          uid: identity.uid,
          getIdToken: async () => identity!.token,
        }
      : null;
  const authentication: FirebaseAuth = {
    get currentUser() {
      return getCurrentUser();
    },
    authStateReady: async () => {
      if (!identity) {
        return;
      }
      const response = await fetch('/api/doc?path=status/user_count', {
        headers: {
          Authorization: `Bearer ${identity.token}`,
        },
      });
      if (response.status === 403) {
        identity = null;
        localStorage.removeItem('godfield.local.identity');
      } else if (!response.ok) {
        throw new Error('Local session validation failed');
      }
    },
  };
  const createDocumentSnapshot = (value: unknown): DocumentSnapshot => ({
    data: () => value ?? {},
  });
  return {
    initializeApp: () => ({}),
    getAuth: () => authentication,
    getFirestore: () => ({}),
    signInAnonymously: async () => {
      if (!identity) {
        const response = await fetch('/api/auth', {
          method: 'POST',
        });
        if (!response.ok) {
          throw new Error('Local sign-in failed');
        }
        identity = (await response.json()) as Identity;
        localStorage.setItem(
          'godfield.local.identity',
          JSON.stringify(identity),
        );
      }
      return getCurrentUser();
    },
    deleteUser: async () => {
      const response = await fetch('/api/auth', {
        method: 'DELETE',
        headers: {
          Authorization: `Bearer ${identity?.token}`,
        },
      });
      if (!response.ok) {
        throw new Error('Local account deletion failed');
      }
      identity = null;
      localStorage.removeItem('godfield.local.identity');
    },
    doc: (_database, path) => path,
    getDoc: async (reference) => {
      const response = await fetch(
        `/api/doc?path=${encodeURIComponent(String(reference))}`,
        {
          headers: {
            Authorization: `Bearer ${identity?.token}`,
          },
        },
      );
      if (!response.ok) {
        throw new Error('Local document read failed');
      }
      return createDocumentSnapshot(await response.json());
    },
    onSnapshot: (reference, callback) => {
      const eventSource = new EventSource(
        `/api/watch?path=${encodeURIComponent(String(reference))}&token=${encodeURIComponent(identity?.token ?? '')}`,
      );
      eventSource.onmessage = (event) =>
        callback(createDocumentSnapshot(JSON.parse(event.data)));
      return () => {
        eventSource.close();
      };
    },
  };
}
