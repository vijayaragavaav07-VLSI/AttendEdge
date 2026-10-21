import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  verifyAndRecordAttendance,
  STATUS_CODES
} from '../functions/index.js';
import { FirestoreService, isCloudSyncReady } from '../src/firebase/firestoreService.js';
import * as firestoreModule from '../src/firebase/firestoreService.js';
import { attendanceService } from '../src/services/attendanceService.js';

/**
 * In-memory Mock Firestore Database for Cloud Functions Unit Testing
 */
class MockFirestore {
  constructor() {
    this.store = new Map();
  }

  _getKey(collectionPath, docId) {
    return `${collectionPath}/${docId}`;
  }

  set(collectionPath, docId, data, options = {}) {
    const key = this._getKey(collectionPath, docId);
    if (options.merge && this.store.has(key)) {
      this.store.set(key, { ...this.store.get(key), ...data });
    } else {
      this.store.set(key, { ...data });
    }
  }

  get(collectionPath, docId) {
    const key = this._getKey(collectionPath, docId);
    const data = this.store.get(key);
    return {
      exists: Boolean(data),
      id: docId,
      data: () => (data ? { ...data } : undefined)
    };
  }

  collection(collectionPath) {
    const self = this;
    return {
      doc(docId) {
        return {
          id: docId,
          path: self._getKey(collectionPath, docId),
          async get() {
            return self.get(collectionPath, docId);
          },
          async set(data, options) {
            self.set(collectionPath, docId, data, options);
          },
          collection(subPath) {
            const nestedPath = `${collectionPath}/${docId}/${subPath}`;
            return self.collection(nestedPath);
          }
        };
      }
    };
  }

  async runTransaction(updateFunction) {
    const writes = [];
    const transaction = {
      get: async (docRef) => {
        const parts = docRef.path.split('/');
        const docId = parts.pop();
        const colPath = parts.join('/');
        return this.get(colPath, docId);
      },
      set: (docRef, data, options) => {
        writes.push({ docRef, data, options });
      }
    };

    const result = await updateFunction(transaction);

    // Commit writes if transaction did not throw or return failure
    for (const w of writes) {
      const parts = w.docRef.path.split('/');
      const docId = parts.pop();
      const colPath = parts.join('/');
      this.set(colPath, docId, w.data, w.options);
    }

    return result;
  }
}

describe('Stage 4: Cloud Functions Attendance Security & Verification Tests', () => {
  let mockDb;
  const facultyAuth = {
    uid: 'fac-001',
    token: { role: 'faculty', faculty: true }
  };

  const defaultSettings = {
    openingTime: '08:00',
    closingTime: '08:35',
    timezone: 'Asia/Kolkata'
  };

  // Canonical server time within the active 08:00–08:35 Asia/Kolkata window (08:15:00 IST)
  const validServerNow = new Date('2026-10-20T08:15:00+05:30');

  beforeEach(() => {
    mockDb = new MockFirestore();
    // Pre-populate settings
    mockDb.set('settings', 'global', defaultSettings);
    // Pre-populate student
    mockDb.set('students', '25EV001', {
      rollNumber: '25EV001',
      name: 'Anika Verma',
      index: 0,
      disabled: false
    });
    // Pre-populate faculty in registry
    mockDb.set('faculty', 'fac-001', {
      role: 'faculty',
      email: 'faculty@attendedge.edu',
      disabled: false
    });
  });

  describe('1. Unauthorized Writes & Caller Authentication', () => {
    it('rejects unauthenticated attendance writes with unauthenticated error', async () => {
      await expect(
        verifyAndRecordAttendance(mockDb, {
          auth: null,
          data: { rollNumber: '25EV001' },
          now: validServerNow,
          overrideSettings: defaultSettings
        })
      ).rejects.toThrow('Authentication required');
    });

    it('rejects authenticated users who do not possess faculty claims or registry entry', async () => {
      const studentAuth = {
        uid: 'student-999',
        token: { role: 'student' }
      };

      await expect(
        verifyAndRecordAttendance(mockDb, {
          auth: studentAuth,
          data: { rollNumber: '25EV001' },
          now: validServerNow,
          overrideSettings: defaultSettings
        })
      ).rejects.toThrow('Unauthorized: Caller does not possess verified faculty privileges');
    });

    it('rejects faculty whose registry record is marked disabled: true', async () => {
      const disabledFacultyAuth = {
        uid: 'fac-disabled',
        token: {} // No custom claim, relies on registry check
      };
      mockDb.set('faculty', 'fac-disabled', {
        role: 'faculty',
        disabled: true
      });

      await expect(
        verifyAndRecordAttendance(mockDb, {
          auth: disabledFacultyAuth,
          data: { rollNumber: '25EV001' },
          now: validServerNow,
          overrideSettings: defaultSettings
        })
      ).rejects.toThrow('Unauthorized');
    });
  });

  describe('2. Closed Attendance Sessions', () => {
    it('rejects attendance recording when session is closed', async () => {
      const date = '2026-10-20';
      mockDb.set('sessions', date, {
        id: `ses-${date}`,
        date,
        sessionStatus: 'Closed'
      });

      const res = await verifyAndRecordAttendance(mockDb, {
        auth: facultyAuth,
        data: { rollNumber: '25EV001', captureId: 0 },
        now: validServerNow,
        overrideSettings: defaultSettings
      });

      expect(res.success).toBe(false);
      expect(res.statusCode).toBe(STATUS_CODES.S_OUT_WINDOW);
      expect(res.message).toContain('Session Closed');
    });
  });

  describe('3. Attendance Time Window Validation & Client Tampering Prevention', () => {
    it('rejects scan before opening time (e.g. 07:55:00 before 08:00)', async () => {
      const earlyNow = new Date('2026-10-20T07:55:00+05:30');
      const res = await verifyAndRecordAttendance(mockDb, {
        auth: facultyAuth,
        data: { rollNumber: '25EV001', captureId: 0 },
        now: earlyNow,
        overrideSettings: defaultSettings
      });

      expect(res.success).toBe(false);
      expect(res.statusCode).toBe(STATUS_CODES.S_OUT_WINDOW);
      expect(res.message).toContain('Outside Window');
      expect(res.message).toContain('07:55:00');
    });

    it('rejects scan after closing time (e.g. 08:36:00 after 08:35)', async () => {
      const lateNow = new Date('2026-10-20T08:36:00+05:30');
      const res = await verifyAndRecordAttendance(mockDb, {
        auth: facultyAuth,
        data: { rollNumber: '25EV001', captureId: 0 },
        now: lateNow,
        overrideSettings: defaultSettings
      });

      expect(res.success).toBe(false);
      expect(res.statusCode).toBe(STATUS_CODES.S_OUT_WINDOW);
      expect(res.message).toContain('Outside Window');
      expect(res.message).toContain('08:36:00');
    });

    it('prevents client-supplied time from bypassing early window (spoofed 08:15:00 during server 07:55:00)', async () => {
      const earlyNow = new Date('2026-10-20T07:55:00+05:30');
      // Browser client attempts to fake an in-window time 08:15:00
      const res = await verifyAndRecordAttendance(mockDb, {
        auth: facultyAuth,
        data: { rollNumber: '25EV001', time: '08:15:00', date: '2026-10-20', captureId: 0 },
        now: earlyNow,
        overrideSettings: defaultSettings
      });

      expect(res.success).toBe(false);
      expect(res.statusCode).toBe(STATUS_CODES.S_OUT_WINDOW);
      expect(res.message).toContain('Outside Window');
      expect(res.message).toContain('07:55:00');
      expect(res.message).not.toContain('08:15:00');
    });

    it('prevents client-supplied time from bypassing closed window (spoofed 08:15:00 during server 08:45:00)', async () => {
      const lateNow = new Date('2026-10-20T08:45:00+05:30');
      // Browser client attempts to fake an in-window time 08:15:00
      const res = await verifyAndRecordAttendance(mockDb, {
        auth: facultyAuth,
        data: { rollNumber: '25EV001', time: '08:15:00', date: '2026-10-20', captureId: 0 },
        now: lateNow,
        overrideSettings: defaultSettings
      });

      expect(res.success).toBe(false);
      expect(res.statusCode).toBe(STATUS_CODES.S_OUT_WINDOW);
      expect(res.message).toContain('Outside Window');
      expect(res.message).toContain('08:45:00');
      expect(res.message).not.toContain('08:15:00');
    });

    it('ignores client-supplied date/time and strictly binds record to server now', async () => {
      // Browser supplies spoofed date (2020-01-01) and out-of-bounds time (23:59:59)
      const res = await verifyAndRecordAttendance(mockDb, {
        auth: facultyAuth,
        data: { rollNumber: '25EV001', time: '23:59:59', date: '2020-01-01', captureId: 0 },
        now: validServerNow,
        overrideSettings: defaultSettings
      });

      expect(res.success).toBe(true);
      expect(res.statusCode).toBe(STATUS_CODES.S_RECORDED);
      expect(res.record.date).toBe('2026-10-20');
      expect(res.record.time).toBe('08:15:00');

      // Stored under server date, not client date
      const serverEntry = mockDb.get('records/2026-10-20/entries', '25EV001');
      expect(serverEntry.exists).toBe(true);
      expect(serverEntry.data().date).toBe('2026-10-20');
      expect(serverEntry.data().time).toBe('08:15:00');

      const clientEntry = mockDb.get('records/2020-01-01/entries', '25EV001');
      expect(clientEntry.exists).toBe(false);
    });
  });

  describe('4. Student ID & Capture ID Validation', () => {
    it('rejects missing or empty roll number with invalid-argument error', async () => {
      await expect(
        verifyAndRecordAttendance(mockDb, {
          auth: facultyAuth,
          data: { rollNumber: '' },
          now: validServerNow,
          overrideSettings: defaultSettings
        })
      ).rejects.toThrow('Missing or invalid student rollNumber');
    });

    it('rejects student with disabled status in roster', async () => {
      mockDb.set('students', '25EV002', {
        rollNumber: '25EV002',
        name: 'Disabled Student',
        index: 1,
        disabled: true
      });

      const res = await verifyAndRecordAttendance(mockDb, {
        auth: facultyAuth,
        data: { rollNumber: '25EV002', captureId: 1 },
        now: validServerNow,
        overrideSettings: defaultSettings
      });

      expect(res.success).toBe(false);
      expect(res.statusCode).toBe(STATUS_CODES.S_BAD_ID);
      expect(res.message).toContain('disabled');
    });

    it('rejects capture ID 63 (unregistered / invalid in Verilog FSM)', async () => {
      const res = await verifyAndRecordAttendance(mockDb, {
        auth: facultyAuth,
        data: { rollNumber: '25EV001', captureId: 63 },
        now: validServerNow,
        overrideSettings: defaultSettings
      });

      expect(res.success).toBe(false);
      expect(res.statusCode).toBe(STATUS_CODES.S_BAD_ID);
      expect(res.message).toContain('Invalid ID');
    });

    it('rejects capture ID out of 0..62 range (e.g. -1 or 99)', async () => {
      const res = await verifyAndRecordAttendance(mockDb, {
        auth: facultyAuth,
        data: { rollNumber: '25EV001', captureId: 99 },
        now: validServerNow,
        overrideSettings: defaultSettings
      });

      expect(res.success).toBe(false);
      expect(res.statusCode).toBe(STATUS_CODES.S_BAD_ID);
    });
  });

  describe('5. Duplicate Attendance Prevention', () => {
    it('rejects duplicate attendance when subcollection entry already exists', async () => {
      const date = '2026-10-20';
      const roll = '25EV001';

      // Record first attendance
      mockDb.set(`records/${date}/entries`, roll, {
        rollNumber: roll,
        date,
        time: '08:05:00'
      });

      const res = await verifyAndRecordAttendance(mockDb, {
        auth: facultyAuth,
        data: { rollNumber: roll, captureId: 0 },
        now: validServerNow,
        overrideSettings: defaultSettings
      });

      expect(res.success).toBe(false);
      expect(res.statusCode).toBe(STATUS_CODES.S_ALREADY);
      expect(res.message).toContain('Already Recorded');
    });

    it('rejects duplicate attendance when roll exists in summary map', async () => {
      const date = '2026-10-20';
      const roll = '25EV001';

      mockDb.set('records', date, {
        date,
        records: {
          [roll]: { t: '08:05:00', src: 'cloud_function' }
        },
        totalPresent: 1
      });

      const res = await verifyAndRecordAttendance(mockDb, {
        auth: facultyAuth,
        data: { rollNumber: roll, captureId: 0 },
        now: validServerNow,
        overrideSettings: defaultSettings
      });

      expect(res.success).toBe(false);
      expect(res.statusCode).toBe(STATUS_CODES.S_ALREADY);
      expect(res.message).toContain('Already Recorded');
    });
  });

  describe('6. Successful Attendance Recording', () => {
    it('successfully records attendance within active window and commits atomically', async () => {
      const date = '2026-10-20';
      const roll = '25EV001';

      const res = await verifyAndRecordAttendance(mockDb, {
        auth: facultyAuth,
        data: { rollNumber: roll, captureId: 0 },
        now: validServerNow,
        overrideSettings: defaultSettings
      });

      expect(res.success).toBe(true);
      expect(res.statusCode).toBe(STATUS_CODES.S_RECORDED);
      expect(res.message).toContain('Present Recorded');
      expect(res.record.rollNumber).toBe(roll);
      expect(res.record.recordedBy).toBe(facultyAuth.uid);
      expect(res.record.date).toBe(date);
      expect(res.record.time).toBe('08:15:00');

      // Verify subcollection entry document was written
      const entry = mockDb.get(`records/${date}/entries`, roll);
      expect(entry.exists).toBe(true);
      expect(entry.data().rollNumber).toBe(roll);
      expect(entry.data().date).toBe(date);
      expect(entry.data().time).toBe('08:15:00');

      // Verify summary document was written
      const summary = mockDb.get('records', date);
      expect(summary.exists).toBe(true);
      expect(summary.data().totalPresent).toBe(1);
      expect(summary.data().records[roll]).toBeDefined();
      expect(summary.data().records[roll].t).toBe('08:15:00');
    });
  });

  describe('7. Frontend Client Cloud Rejection Handling', () => {
    it('does not register attendance locally when Cloud Function rejects the write with internal error', async () => {
      attendanceService.init();
      attendanceService.state.ui.clock.time = '08:15:00';
      const testRoll = '25EV005';
      const today = attendanceService.getTodayString();

      const cloudSyncSpy = vi.spyOn(firestoreModule, 'isCloudSyncReady').mockReturnValue(true);
      const spy = vi.spyOn(FirestoreService, 'recordAttendanceCloud').mockImplementation(async () => {
        const err = new Error('Cloud Function "recordAttendance" is not reachable or not deployed in region asia-south1 for project attendedge-11745.');
        err.code = 'functions/internal';
        throw err;
      });

      const res = await attendanceService.scanBarcode(testRoll);

      expect(res.state).toBe('error');
      expect(res.errorCode).toBe('functions/internal');
      expect(res.message).toContain('Cloud Rejection (functions/internal)');
      expect(res.message).toContain('Record was NOT saved');

      // Crucial: local record must NOT be committed
      expect(attendanceService.state.records[today]?.[testRoll]).toBeUndefined();

      // Check event log
      const latestEvt = attendanceService.state.events[0];
      expect(latestEvt.state).toBe('error');
      expect(latestEvt.errorCode).toBe('functions/internal');
      expect(latestEvt.message).toContain('Record was NOT saved');

      spy.mockRestore();
      cloudSyncSpy.mockRestore();
    });

    it('does not register attendance locally when Cloud Function detects duplicate', async () => {
      attendanceService.init();
      attendanceService.state.ui.clock.time = '08:15:00';
      const testRoll = '25EV006';
      const today = attendanceService.getTodayString();

      const cloudSyncSpy = vi.spyOn(firestoreModule, 'isCloudSyncReady').mockReturnValue(true);
      const spy = vi.spyOn(FirestoreService, 'recordAttendanceCloud').mockImplementation(async () => {
        const err = new Error('Already Recorded: Student 25EV006 was recorded earlier.');
        err.statusCode = STATUS_CODES.S_ALREADY;
        err.code = 'functions/already-exists';
        throw err;
      });

      const res = await attendanceService.scanBarcode(testRoll);

      expect(res.state).toBe('duplicate');
      expect(res.statusCode).toBe(STATUS_CODES.S_ALREADY);
      expect(res.message).toContain('Cloud Rejection');
      expect(res.message).toContain('Record was NOT saved');
      expect(attendanceService.state.records[today]?.[testRoll]).toBeUndefined();

      spy.mockRestore();
      cloudSyncSpy.mockRestore();
    });
  });
});
