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
  return new Promise((resolve, reject) => {
    const unsubscribe = onAuthStateChanged(
      authInstance,
      (user) => {
        if (user) {
          unsubscribe();
          resolve();
        }
      },
      reject,
    );
    if (!authInstance.currentUser) {
      signInAnonymously(authInstance).catch(reject);
    }
  });
}
