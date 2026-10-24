import {
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged,
  sendPasswordResetEmail,
  setPersistence,
  browserLocalPersistence,
  EmailAuthProvider,
  reauthenticateWithCredential
} from 'firebase/auth';
import { auth, isFirebaseConfigured } from './config.js';

const LOCAL_AUTH_KEY = 'attendedge.auth.v1';

export const DEMO_USER = {
  uid: 'faculty-demo-001',
  email: 'faculty.demo@attendedge.local',
  displayName: 'Faculty Instructor (Demo)',
  role: 'faculty',
  isDemo: true,
  provider: 'local_demo'
};

// Formats Firebase error codes into clear, user-friendly security notifications
function mapAuthError(err) {
  const code = err.code || '';
  switch (code) {
    case 'auth/invalid-credential':
    case 'auth/wrong-password':
      return 'Invalid email or password. Please verify your faculty credentials.';
    case 'auth/user-not-found':
      return 'No faculty account found with this email. Contact your system administrator.';
    case 'auth/invalid-email':
      return 'Please enter a valid academic/institutional email address.';
    case 'auth/user-disabled':
      return 'This faculty account has been disabled. Contact security administration.';
    case 'auth/too-many-requests':
      return 'Access temporarily restricted due to repeated failed login attempts. Please wait or reset password.';
    case 'auth/network-request-failed':
      return 'Network connection error: Unable to contact Firebase Authentication servers.';
    default:
      return err.message || 'Authentication failed. Please verify credentials.';
  }
}

/**
 * Sign in faculty member
 */
export async function signInFaculty(identity, password) {
  const cleanId = String(identity || '').trim();
  const cleanPass = String(password || '');

  if (!cleanId || !cleanPass) {
    return { success: false, error: 'Please enter both faculty email/username and password.' };
  }

  // 1. Production Mode: Firebase Authentication is active
  if (isFirebaseConfigured()) {
    if (!auth) {
      return { success: false, error: 'Firebase Auth instance is not initialized.' };
    }

    // Explicitly reject using demo credentials in production login field
    if (cleanId === 'faculty' && cleanPass === 'demo123') {
      return {
        success: false,
        error: 'Firebase Authentication is active on this system. Demo credentials are not valid for production access. Please sign in with your registered faculty email, or use the Sandbox Demo option.'
      };
    }

    if (!cleanId.includes('@')) {
      return {
        success: false,
        error: 'Please enter your registered institutional email address (e.g. instructor@university.edu).'
      };
    }

    try {
      if (typeof setPersistence === 'function') {
        await setPersistence(auth, browserLocalPersistence).catch(() => {});
      }
      const userCredential = await signInWithEmailAndPassword(auth, cleanId, cleanPass);
      const fbUser = userCredential.user;

      // Ensure local demo key is cleared so production state is unpolluted
      try { localStorage.removeItem(LOCAL_AUTH_KEY); } catch (e) {}

      return {
        success: true,
        user: {
          uid: fbUser.uid,
          email: fbUser.email,
          displayName: fbUser.displayName || fbUser.email.split('@')[0],
          role: 'faculty',
          isDemo: false,
          provider: 'firebase'
        }
      };
    } catch (err) {
      return { success: false, error: mapAuthError(err) };
    }
  }

  // 2. Offline / Local Demo Mode: Firebase credentials are NOT configured
  if (cleanId === 'faculty' && cleanPass === 'demo123') {
    return startDemoSession();
  }

  return {
    success: false,
    error: 'Invalid credentials. Firebase is not configured; use demo username "faculty" and password "demo123".'
  };
}

/**
 * Starts an isolated offline demo session.
 * Clearly marked with isDemo: true so that cloud sync and Firebase privileges are never assumed.
 */
export function startDemoSession() {
  const user = {
    ...DEMO_USER,
    loggedInAt: Date.now()
  };
  try {
    localStorage.setItem(LOCAL_AUTH_KEY, JSON.stringify(user));
  } catch (e) {
    window.__attendedgeAuth = user;
  }
  return { success: true, user };
}

/**
 * Re-authenticates the current faculty member before executing sensitive actions (e.g. Schedule Overrides).
 * Enforces Firebase Authentication's reauthenticateWithCredential using the current user's email and password.
 * In demo mode, verifies against the active demo credentials.
 * NEVER stores, caches, or logs the entered password.
 */
export async function reauthenticateFaculty(password) {
  const cleanPass = String(password || '');
  if (!cleanPass) {
    return { success: false, error: 'Password is required to confirm schedule changes.' };
  }

  // 1. Production Mode: Firebase Auth is active
  if (isFirebaseConfigured() && auth && auth.currentUser) {
    const user = auth.currentUser;
    if (!user.email) {
      return { success: false, error: 'Current user has no associated institutional email address.' };
    }
    try {
      const credential = EmailAuthProvider.credential(user.email, cleanPass);
      await reauthenticateWithCredential(user, credential);
      return { success: true };
    } catch (err) {
      console.warn('[AttendEdge Auth] Re-authentication failed:', err.code);
      return {
        success: false,
        error: err.code === 'auth/wrong-password' || err.code === 'auth/invalid-credential'
          ? 'Incorrect faculty password. Schedule modification cancelled.'
          : err.code === 'auth/too-many-requests'
          ? 'Too many failed verification attempts. Please wait before retrying.'
          : mapAuthError(err)
      };
    }
  }

  // 2. Offline / Local Demo Mode
  const cur = getCurrentUser();
  if (cur && cur.isDemo) {
    if (cleanPass === 'demo123') {
      return { success: true };
    }
    return {
      success: false,
      error: 'Incorrect demo password. (Use "demo123" to authorize changes in demo sandbox).'
    };
  }

  return {
    success: false,
    error: 'No active authenticated faculty session found.'
  };
}

/**
 * Send password reset email via Firebase Auth
 */
export async function sendFacultyPasswordReset(email) {
  if (!isFirebaseConfigured() || !auth) {
    return {
      success: false,
      error: 'Password reset requires an active Firebase configuration. In demo mode, use password "demo123".'
    };
  }
  const cleanEmail = String(email || '').trim();
  if (!cleanEmail || !cleanEmail.includes('@')) {
    return { success: false, error: 'Please enter a valid email address to receive reset instructions.' };
  }
  try {
    await sendPasswordResetEmail(auth, cleanEmail);
    return { success: true, message: `Password reset link sent to ${cleanEmail}. Check your inbox.` };
  } catch (err) {
    return { success: false, error: mapAuthError(err) };
  }
}

/**
 * Sign out faculty member
 */
export async function signOutFaculty() {
  if (isFirebaseConfigured() && auth && auth.currentUser) {
    try {
      await signOut(auth);
    } catch (e) {
      console.warn('Firebase signout error:', e);
    }
  }
  try {
    localStorage.removeItem(LOCAL_AUTH_KEY);
  } catch (e) {
    delete window.__attendedgeAuth;
  }
  return true;
}

/**
 * Get currently authenticated faculty profile.
 * Prevents client-side privilege escalation:
 * When Firebase is configured, only a valid Firebase currentUser or explicit isDemo session is returned.
 */
export function getCurrentUser() {
  if (isFirebaseConfigured() && auth && auth.currentUser) {
    return {
      uid: auth.currentUser.uid,
      email: auth.currentUser.email,
      displayName: auth.currentUser.displayName || auth.currentUser.email.split('@')[0],
      role: 'faculty',
      isDemo: false,
      provider: 'firebase'
    };
  }

  // If Firebase is configured but user is not signed in via Firebase,
  // check if an explicit offline sandbox session was launched.
  try {
    const raw = localStorage.getItem(LOCAL_AUTH_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      // Ensure that a user-modified localStorage entry cannot spoof isDemo: false
      if (parsed && parsed.isDemo === true) {
        return {
          ...parsed,
          isDemo: true,
          provider: 'local_demo'
        };
      }
    }
  } catch (e) {
    if (typeof window !== 'undefined' && window.__attendedgeAuth && window.__attendedgeAuth.isDemo === true) {
      return window.__attendedgeAuth;
    }
  }

  // If Firebase is NOT configured and no session is found, return null
  return null;
}

/**
 * Subscribe to auth state updates
 */
export function subscribeAuth(callback) {
  if (isFirebaseConfigured() && auth) {
    return onAuthStateChanged(auth, user => {
      if (user) {
        callback({
          uid: user.uid,
          email: user.email,
          displayName: user.displayName || user.email.split('@')[0],
          role: 'faculty',
          isDemo: false,
          provider: 'firebase'
        });
      } else {
        // Fall back only to explicit sandbox demo session if active, otherwise null
        const current = getCurrentUser();
        callback(current && current.isDemo ? current : null);
      }
    });
  } else {
    // Offline / Local Demo mode
    callback(getCurrentUser());
    return () => {};
  }
}
