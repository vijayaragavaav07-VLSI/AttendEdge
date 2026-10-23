import { initializeApp, getApps, getApp } from 'firebase/app';
import { getAuth } from 'firebase/auth';
import { getFirestore } from 'firebase/firestore';
import { getFunctions } from 'firebase/functions';

const env = import.meta.env;

const firebaseConfig = {
  apiKey: env?.VITE_FIREBASE_API_KEY || "AIzaSyCBW34_fmgH68MYvGP9sTaNVi8-zkR9cPY",
  authDomain: env?.VITE_FIREBASE_AUTH_DOMAIN || "attendedge-11745.firebaseapp.com",
  projectId: env?.VITE_FIREBASE_PROJECT_ID || "attendedge-11745",
  storageBucket: env?.VITE_FIREBASE_STORAGE_BUCKET || "attendedge-11745.firebasestorage.app",
  messagingSenderId: env?.VITE_FIREBASE_MESSAGING_SENDER_ID || "625261477373",
  appId: env?.VITE_FIREBASE_APP_ID || "1:625261477373:web:224185f98f3d28076e2d94",
  measurementId: env?.VITE_FIREBASE_MEASUREMENT_ID || "G-4B5P89CE27"
};

/**
 * Checks whether valid Firebase credentials have been provided in .env
 */
export function isFirebaseConfigured() {
  return Boolean(
    firebaseConfig.apiKey &&
    firebaseConfig.projectId &&
    !firebaseConfig.apiKey.includes('YourApiKeyHere') &&
    !firebaseConfig.projectId.includes('your-project')
  );
}

let app = null;
let auth = null;
let db = null;
let functions = null;

if (isFirebaseConfigured()) {
  try {
    app = getApps().length ? getApp() : initializeApp(firebaseConfig);
    auth = getAuth(app);
    db = getFirestore(app);
    functions = getFunctions(app, 'asia-south1');
    console.info('[AttendEdge] Firebase initialized successfully with project:', firebaseConfig.projectId);
  } catch (err) {
    console.warn('[AttendEdge] Firebase initialization error. Falling back to local offline mode.', err);
  }
} else {
  console.info('[AttendEdge] Firebase credentials not configured. Operating in Offline / Local Demo Mode.');
}

export { app, auth, db, functions, firebaseConfig };

