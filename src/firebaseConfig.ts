// Firebase web app config -- these values are NOT secret (Firebase's own docs say so
// explicitly: https://firebase.google.com/docs/projects/api-keys). Access control comes from
// Firestore Security Rules, not from hiding this file, so it's fine to commit as-is.
//
// Fill these in from: Firebase Console -> Project settings -> General -> "Your apps" -> Web app.
export const firebaseConfig = {
  apiKey: 'REPLACE_ME',
  authDomain: 'REPLACE_ME.firebaseapp.com',
  projectId: 'REPLACE_ME',
  storageBucket: 'REPLACE_ME.appspot.com',
  messagingSenderId: 'REPLACE_ME',
  appId: 'REPLACE_ME',
};

export const isFirebaseConfigured = firebaseConfig.apiKey !== 'REPLACE_ME';
