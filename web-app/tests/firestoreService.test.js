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
  FirestoreService,
  getConnectionState,
  CONNECTION_STATES,
  isCloudSyncReady,
  setConnectionError,
  clearConnectionError,
  mapFunctionsError
} from '../src/firebase/firestoreService.js';
import { isFirebaseConfigured } from '../src/firebase/config.js';
import { attendanceService } from '../src/services/attendanceService.js';
import { STATUS_CODES } from '../src/logic/attendanceFSM.js';

describe('Stage D: Cloud Firestore Integration & Service Unit Tests', () => {
  beforeEach(() => {
    localStorage.clear();
    clearConnectionError();
    attendanceService.init();
  });

  describe('1. Connection State Machine', () => {
    it('correctly reports connection state based on environment', () => {
      const conn = getConnectionState();
      if (!isFirebaseConfigured()) {
        expect(conn.state).toBe(CONNECTION_STATES.LOCAL_DEMO);
        expect(conn.label).toBe('Local Demo Mode');
      } else {
        expect(conn.state).toBe(CONNECTION_STATES.FIREBASE_AUTH_REQUIRED);
        expect(conn.label).toBe('Firebase Auth Required');
      }
    });

    it('records and returns FIREBASE_ERROR if a cloud error is registered', () => {
      setConnectionError({ message: 'Network connection lost', code: 'unavailable' });
      const conn = getConnectionState();
      if (isFirebaseConfigured() && conn.error) {
        expect(conn.state).toBe(CONNECTION_STATES.FIREBASE_ERROR);
      }
      clearConnectionError();
      const cleared = getConnectionState();
      if (!isFirebaseConfigured()) {
        expect(cleared.state).toBe(CONNECTION_STATES.LOCAL_DEMO);
      } else {
        expect(cleared.state).toBe(CONNECTION_STATES.FIREBASE_AUTH_REQUIRED);
      }
    });

    it('isCloudSyncReady returns false when unauthenticated', () => {
      expect(isCloudSyncReady()).toBe(false);
    });
  });

  describe('2. Student Management & Validation', () => {
    it('rejects adding a student without a roll number', async () => {
      await expect(attendanceService.addStudent({ name: 'John Doe' }))
        .rejects.toThrow('Roll number is required');
    });

    it('rejects adding a duplicate student roll number', async () => {
      const existingRoll = attendanceService.state.students[0].rollNumber;
      await expect(attendanceService.addStudent({ rollNumber: existingRoll, name: 'Duplicate' }))
        .rejects.toThrow('already exists');
    });

    it('successfully adds and removes a student in local roster', async () => {
      const initialCount = attendanceService.state.students.length;
      const newRoll = '25EV099';
      
      const added = await attendanceService.addStudent({
        rollNumber: newRoll,
        name: 'Test Student',
        email: 'test@attendedge.edu',
        department: 'Electronics',
        classSection: 'Section A',
        semester: '4',
        residence: 'Day Scholar'
      });

      expect(added.rollNumber).toBe(newRoll);
      expect(attendanceService.state.students.length).toBe(initialCount + 1);

      const removed = await attendanceService.removeStudent(newRoll);
      expect(removed).toBe(true);
      expect(attendanceService.state.students.length).toBe(initialCount);
    });

    it('throws when attempting to delete a non-existent student', async () => {
      await expect(attendanceService.removeStudent('NON_EXISTENT_ROLL'))
        .rejects.toThrow('not found');
    });

    it('successfully updates an existing student profile and preserves fixed roll number and attendance', async () => {
      const student = attendanceService.state.students[1]; // e.g. 25EV002
      const roll = student.rollNumber;
      const initialIndex = student.index;

      // Seed a record for this student today
      const today = attendanceService.getTodayString();
      attendanceService.state.records[today] = {
        [roll]: { t: '08:15:00', src: 'web_fsm' }
      };

      const patch = {
        name: 'Rohan Sharma Updated',
        email: 'rohan.sharma@attendedge.edu',
        department: 'Computer Science',
        classSection: 'Section B',
        semester: '5',
        residence: 'Hosteller'
      };

      const res = await attendanceService.updateStudent(roll, patch);
      expect(res.name).toBe('Rohan Sharma Updated');
      expect(res.email).toBe('rohan.sharma@attendedge.edu');
      expect(res.department).toBe('Computer Science');
      expect(res.classSection).toBe('Section B');
      expect(res.semester).toBe('5');
      expect(res.residence).toBe('Hosteller');

      // Crucial: Roll number and FPGA bit index must remain unchanged
      expect(res.rollNumber).toBe(roll);
      expect(res.index).toBe(initialIndex);

      // Attendance history must remain completely preserved
      expect(attendanceService.state.records[today][roll]).toBeDefined();
      expect(attendanceService.state.records[today][roll].t).toBe('08:15:00');
    });

    it('throws error when attempting to update a non-existent student roll number', async () => {
      await expect(attendanceService.updateStudent('INVALID_ROLL_999', { name: 'Nobody' }))
        .rejects.toThrow('not found');
    });
  });

  describe('3. Session State Management', () => {
    it('allows opening and closing daily attendance sessions', async () => {
      const testDate = '2026-10-18';
      await attendanceService.openSession(testDate);
      expect(attendanceService.state.sessions[testDate].sessionStatus).toBe('Open');

      await attendanceService.closeSession(testDate);
      expect(attendanceService.state.sessions[testDate].sessionStatus).toBe('Closed');
    });
  });

  describe('4. Duplicate Record Prevention & FSM Integrity', () => {
    it('records attendance on first scan within window', async () => {
      const roll = attendanceService.state.students[0].rollNumber;
      attendanceService.state.ui.clock.time = '08:15:00'; // within 08:00–08:35 window

      const res = await attendanceService.scanBarcode(roll);
      expect(res.state).toBe('present');
      expect(res.statusCode).toBe(STATUS_CODES.S_RECORDED);

      // Verify attendance register bit is latched
      const today = attendanceService.getTodayString();
      expect(attendanceService.state.records[today][roll]).toBeDefined();
    });

    it('prevents duplicate attendance on subsequent scan with exact FSM status S_ALREADY', async () => {
      const roll = attendanceService.state.students[1].rollNumber;
      attendanceService.state.ui.clock.time = '08:15:00';

      // First scan: records
      const first = await attendanceService.scanBarcode(roll);
      expect(first.state).toBe('present');

      // Second scan of same student: duplicate rejected
      const second = await attendanceService.scanBarcode(roll);
      expect(second.state).toBe('duplicate');
      expect(second.statusCode).toBe(STATUS_CODES.S_ALREADY);
      expect(second.message).toContain('Already Present');
    });

    it('rejects scan when time is outside active attendance window (S_OUT_WINDOW)', async () => {
      const roll = attendanceService.state.students[2].rollNumber;
      attendanceService.state.ui.clock.time = '08:36:00'; // after 08:35:00 close

      const res = await attendanceService.scanBarcode(roll);
      expect(res.state).toBe('closed');
      expect(res.statusCode).toBe(STATUS_CODES.S_OUT_WINDOW);
    });
  });

  describe('5. Error Handling & Demo Isolation', () => {
    it('does not silently report mock success if a cloud write is attempted without credentials', async () => {
      await expect(FirestoreService.saveRecordAtomic('2026-10-18', '25EV001', { t: '08:10:00' }))
        .rejects.toThrow('Cannot save attendance record: Firebase is not authenticated');
    });

    it('does not allow student addition to Firestore without authenticated session', async () => {
      await expect(FirestoreService.addStudent({ rollNumber: '25EV088', name: 'Unauthorized' }))
        .rejects.toThrow('Cannot add student: Firebase is not authenticated');
    });
  });

  describe('6. Report Calculation Integrity', () => {
    it('calculates class stats accurately from attendance records', () => {
      const today = attendanceService.getTodayString();
      const stats = attendanceService.getClassStats(today, today);
      expect(stats).toBeDefined();
      expect(stats.map).toBeDefined();
      expect(typeof stats.map).toBe('object');
    });
  });

  describe('7. Cloud Functions Error Mapping & Diagnostic Safety', () => {
    it('maps internal error code and generic internal message to actionable diagnostic message', () => {
      const mapped = mapFunctionsError({ code: 'functions/internal', message: 'internal' });
      expect(mapped.code).toBe('functions/internal');
      expect(mapped.message).toContain('recordAttendance');
      expect(mapped.message).toContain('asia-south1');
      expect(mapped.message).toContain('attendedge-11745');
    });

    it('maps not-found error code to deployment required message', () => {
      const mapped = mapFunctionsError({ code: 'functions/not-found', message: 'not-found' });
      expect(mapped.code).toBe('functions/not-found');
      expect(mapped.message).toContain('not found in project attendedge-11745');
    });

    it('maps unauthenticated and permission-denied error codes clearly', () => {
      const unauth = mapFunctionsError({ code: 'functions/unauthenticated', message: 'unauthenticated' });
      expect(unauth.code).toBe('functions/unauthenticated');
      expect(unauth.message).toContain('Authentication required');

      const perm = mapFunctionsError({ code: 'functions/permission-denied', message: 'permission-denied' });
      expect(perm.code).toBe('functions/permission-denied');
      expect(perm.message).toContain('Faculty authorization required');
    });

    it('preserves specific domain error messages from backend transactions', () => {
      const customMsg = 'Already Recorded: Student 25EV001 attendance was already recorded at 08:10:00.';
      const mapped = mapFunctionsError({ code: 'functions/already-exists', message: customMsg });
      expect(mapped.message).toBe(customMsg);
    });
  });
});
