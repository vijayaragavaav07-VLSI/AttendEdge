import { initializeApp, getApps, getApp } from 'firebase/app';
import { getAuth } from 'firebase/auth';
import { getFirestore } from 'firebase/firestore';
import { getFunctions } from 'firebase/functions';

const env = import.meta.env;

const firebaseConfig = {
  apiKey: "AIzaSyCBW34_fmgH68MYvGP9sTaNVi8-zkR9cPY",
  authDomain: "attendedge-11745.firebaseapp.com",
  projectId: "attendedge-11745",
  storageBucket: "attendedge-11745.firebasestorage.app",
  messagingSenderId: "625261477373",
  appId: "1:625261477373:web:224185f98f3d28076e2d94",
  measurementId: "G-4B5P89CE27"
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

