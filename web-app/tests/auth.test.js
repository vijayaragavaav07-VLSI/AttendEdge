import { describe, it, expect, beforeEach, vi } from 'vitest';

// Node/Vitest localStorage & window polyfill
const store = new Map();
const mockLocalStorage = {
  getItem: (key) => (store.has(key) ? store.get(key) : null),
  setItem: (key, val) => { store.set(key, String(val)); },
  removeItem: (key) => { store.delete(key); },
  clear: () => { store.clear(); }
};

Object.defineProperty(globalThis, 'localStorage', {
  value: mockLocalStorage,
  writable: true,
  configurable: true
});
if (!globalThis.window) {
  globalThis.window = {};
}

import {
  signInFaculty,
  signOutFaculty,
  getCurrentUser,
  startDemoSession,
  DEMO_USER
} from '../src/firebase/auth.js';
import { isFirebaseConfigured } from '../src/firebase/config.js';
import { isCloudSyncReady, FirestoreService } from '../src/firebase/firestoreService.js';

describe('AttendEdge Authentication & Security Audit Test Suite', () => {
  beforeEach(() => {
    localStorage.clear();
    delete window.__attendedgeAuth;
  });

  describe('1. Local Demo Mode Isolation', () => {
    it('provides a well-defined DEMO_USER marked explicitly with isDemo: true', () => {
      expect(DEMO_USER).toBeDefined();
      expect(DEMO_USER.isDemo).toBe(true);
      expect(DEMO_USER.role).toBe('faculty');
      expect(DEMO_USER.provider).toBe('local_demo');
    });

    it('successfully signs in with demo credentials when in offline mode or sandbox', async () => {
      if (isFirebaseConfigured()) {
        // In configured mode, production login rejects demo credentials, and sandbox session is used
        const res = await signInFaculty('faculty', 'demo123');
        expect(res.success).toBe(false);
        expect(res.error).toContain('Demo credentials are not valid for production access');

        const sandbox = startDemoSession();
        expect(sandbox.success).toBe(true);
        expect(sandbox.user.isDemo).toBe(true);
      } else {
        const res = await signInFaculty('faculty', 'demo123');
        expect(res.success).toBe(true);
        expect(res.user.isDemo).toBe(true);
        expect(res.user.role).toBe('faculty');

        const current = getCurrentUser();
        expect(current).not.toBeNull();
        expect(current.isDemo).toBe(true);
      }
    });

    it('rejects invalid demo credentials with helpful security guidance', async () => {
      const res = await signInFaculty('faculty', 'wrongpassword');
      expect(res.success).toBe(false);
      expect(res.error).toBeTruthy();
    });

    it('rejects empty credentials', async () => {
      const res = await signInFaculty('', '');
      expect(res.success).toBe(false);
      expect(res.error).toContain('Please enter both');
    });
  });

  describe('2. Client-Side Privilege Escalation Prevention', () => {
    it('prevents browser-side tampering: an attacker attempting to write isDemo: false to localStorage is sanitized or ignored', () => {
      // Attacker tries to inject a forged production faculty session via localStorage
      const forgedPayload = {
        uid: 'attacker-injected-id',
        email: 'attacker@evil.com',
        displayName: 'Evil Admin',
        role: 'faculty',
        isDemo: false // Trying to spoof real production Firebase Auth
      };
      localStorage.setItem('attendedge.auth.v1', JSON.stringify(forgedPayload));

      // getCurrentUser should NOT treat this as a legitimate production Firebase session
      const current = getCurrentUser();
      if (current) {
        expect(current.isDemo).toBe(true);
        expect(current.provider).toBe('local_demo');
      } else {
        expect(current).toBeNull();
      }
    });

    it('completely purges local session keys on signOutFaculty', async () => {
      startDemoSession();
      expect(getCurrentUser()).not.toBeNull();

      await signOutFaculty();
      expect(localStorage.getItem('attendedge.auth.v1')).toBeNull();
      expect(getCurrentUser()).toBeNull();
    });
  });

  describe('3. Cloud Sync Guarding', () => {
    it('isCloudSyncReady returns false when no real Firebase user is authenticated', () => {
      // Offline/demo mode must not attempt unauthorized cloud sync
      expect(isCloudSyncReady()).toBe(false);
    });

    it('FirestoreService gracefully returns null or false and avoids network errors when cloud sync is not ready', async () => {
      const students = await FirestoreService.getStudents();
      expect(students).toBeNull();

      const session = await FirestoreService.getSession('2026-10-18');
      expect(session).toBeNull();

      const saved = await FirestoreService.saveRecord('2026-10-18', '25EV001', { t: '08:15:00' });
      expect(saved).toBe(false);
    });
  });
});
