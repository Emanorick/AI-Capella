import { initializeApp, type FirebaseApp } from 'firebase/app';
import { connectAuthEmulator, getAuth, signInAnonymously, onAuthStateChanged, type Auth } from 'firebase/auth';
import { connectFirestoreEmulator, initializeFirestore, memoryLocalCache, persistentLocalCache, persistentMultipleTabManager, type Firestore } from 'firebase/firestore';
import { firebaseConfig, isFirebaseConfigured } from './firebaseConfig';

let app: FirebaseApp | null = null;
let auth: Auth | null = null;
let db: Firestore | null = null;

if (isFirebaseConfigured) {
  app = initializeApp(firebaseConfig);
  auth = getAuth(app);
  // Firestore's default streaming (WebChannel) transport can stall indefinitely behind some
  // proxies, VPNs, and restrictive school/office networks -- auto-detect and fall back to plain
  // long-polling in those cases, per Firebase's own documented workaround for this exact symptom.
  // A persistent (IndexedDB) copy of everything read, so the song library -- including every
  // song's score -- keeps working without a connection (rehearsal rooms without Wi-Fi); changes
  // made offline are sent once the connection is back. Shared between open tabs.
  // Development only (?emulator=1): the local Firebase emulators instead of the choir's database,
  // for trying out the security rules and everything that writes.
  const emulated = import.meta.env.DEV && new URLSearchParams(location.search).has('emulator');
  db = initializeFirestore(app, {
    experimentalAutoDetectLongPolling: true,
    localCache: emulated ? memoryLocalCache() : persistentLocalCache({ tabManager: persistentMultipleTabManager(), cacheSizeBytes: 200 * 1024 * 1024 }),
  });
  if (emulated) {
    connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
    connectFirestoreEmulator(db, '127.0.0.1', 8085);
  }
}

export { db, isFirebaseConfigured };

/** Resolves once anonymously signed in. Firestore rules gate on request.auth != null. */
export function ensureSignedIn(): Promise<void> {
  if (!auth) return Promise.reject(new Error('Firebase is not configured'));
  const authInstance = auth;
  if (authInstance.currentUser) return Promise.resolve();
  return new Promise((resolve, reject) => {
    // Wait for the FIRST auth state callback before deciding whether to sign in: Auth's session
    // restore from persisted storage is asynchronous, so authInstance.currentUser reads null for
    // a moment even when a previously-signed-in anonymous user is about to be restored. Calling
    // signInAnonymously() before that restore lands (as this used to do, by checking currentUser
    // synchronously) creates a brand-new anonymous account on every single page load instead of
    // reusing the persisted one.
    const unsubscribe = onAuthStateChanged(
      authInstance,
      (user) => {
        unsubscribe();
        if (user) {
          resolve();
        } else {
          signInAnonymously(authInstance).then(() => resolve()).catch(reject);
        }
      },
      reject,
    );
  });
}

/** The signed-in (anonymous) user's id; only after ensureSignedIn(). */
export function currentUid(): string {
  const uid = auth?.currentUser?.uid;
  if (!uid) throw new Error('Not signed in');
  return uid;
}

/** The signed-in device's Firebase ID token, for the scan service to check who's asking. */
export async function getIdToken(): Promise<string> {
  await ensureSignedIn();
  const user = auth?.currentUser;
  if (!user) throw new Error('Not signed in');
  return user.getIdToken();
}
