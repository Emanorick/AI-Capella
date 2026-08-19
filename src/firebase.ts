import { initializeApp, type FirebaseApp } from 'firebase/app';
import { getAuth, signInAnonymously, onAuthStateChanged, type Auth } from 'firebase/auth';
import { initializeFirestore, type Firestore } from 'firebase/firestore';
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
  db = initializeFirestore(app, { experimentalAutoDetectLongPolling: true });
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
