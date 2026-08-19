import { initializeApp, type FirebaseApp } from 'firebase/app';
import { getAuth, signInAnonymously, onAuthStateChanged, type Auth } from 'firebase/auth';
import { getFirestore, type Firestore } from 'firebase/firestore';
import { firebaseConfig, isFirebaseConfigured } from './firebaseConfig';

let app: FirebaseApp | null = null;
let auth: Auth | null = null;
let db: Firestore | null = null;

if (isFirebaseConfigured) {
  app = initializeApp(firebaseConfig);
  auth = getAuth(app);
  db = getFirestore(app);
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
