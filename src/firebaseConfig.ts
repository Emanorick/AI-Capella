// Firebase web app config -- these values are NOT secret (Firebase's own docs say so
// explicitly: https://firebase.google.com/docs/projects/api-keys). Access control comes from
// Firestore Security Rules, not from hiding this file, so it's fine to commit as-is.
//
// Fill these in from: Firebase Console -> Project settings -> General -> "Your apps" -> Web app.
export const firebaseConfig = {
  apiKey: 'AIzaSyBYyWMKrQvYllFSdA09gq5LQ3cmgLDPVtI',
  authDomain: 'ai-capella.firebaseapp.com',
  projectId: 'ai-capella',
  storageBucket: 'ai-capella.firebasestorage.app',
  messagingSenderId: '267121953500',
  appId: '1:267121953500:web:7e8878617e49b35cee8219',
};

export const isFirebaseConfigured = firebaseConfig.apiKey !== 'REPLACE_ME';
