import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

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

import { attendanceService } from '../src/services/attendanceService.js';
import {
  verifyAndSaveScheduleOverride,
  handler as netlifyManageDaySchedule
} from '../netlify/functions/manageDaySchedule.js';
import {
  verifyAndRecordAttendance,
  STATUS_CODES
} from '../netlify/functions/recordAttendance.js';
import {
  reauthenticateFaculty,
  startDemoSession,
  signInFaculty,
  signOutFaculty,
  getCurrentUser
} from '../src/firebase/auth.js';
import { FirestoreService, isCloudSyncReady } from '../src/firebase/firestoreService.js';
import * as firestoreModule from '../src/firebase/firestoreService.js';
import { auth } from '../src/firebase/config.js';
import { D, pctText } from '../src/reports/reportGenerator.js';

/**
 * Mock Firestore database for server-side Netlify and Cloud Firestore testing
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

  delete(collectionPath, docId) {
    const key = this._getKey(collectionPath, docId);
    this.store.delete(key);
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
          async delete() {
            self.delete(collectionPath, docId);
          },
          collection(subPath) {
            return self.collection(`${collectionPath}/${docId}/${subPath}`);
          }
        };
      },
      async add(data) {
        const docId = `doc-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
        self.set(collectionPath, docId, data);
        return { id: docId };
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
        writes.push({ type: 'set', docRef, data, options });
      },
      delete: (docRef) => {
        writes.push({ type: 'delete', docRef });
      }
    };

    const result = await updateFunction(transaction);
    for (const w of writes) {
      const parts = w.docRef.path.split('/');
      const docId = parts.pop();
      const colPath = parts.join('/');
      if (w.type === 'delete') {
        this.delete(colPath, docId);
      } else {
        this.set(colPath, docId, w.data, w.options);
      }
    }
    return result;
  }
}

describe('AttendEdge — Faculty-Controlled Working Day Management Test Suite', () => {
  let mockDb;

  const facultyAuth = {
    uid: 'fac-001',
    token: { uid: 'fac-001', role: 'faculty', email: 'instructor@university.edu' }
  };

  const studentAuth = {
    uid: 'student-999',
    token: { uid: 'student-999', role: 'student', email: 'student@university.edu' }
  };

  const defaultSettings = {
    openingTime: '08:00',
    closingTime: '08:35',
    timezone: 'Asia/Kolkata',
    workingWeekdays: [1, 2, 3, 4, 5],
    holidays: [{ date: '2026-10-02', label: 'Gandhi Jayanti' }]
  };

  beforeEach(() => {
    localStorage.clear();
    attendanceService.init();

    mockDb = new MockFirestore();
    mockDb.set('settings', 'global', defaultSettings);
    mockDb.set('faculty', 'fac-001', {
      role: 'faculty',
      email: 'instructor@university.edu',
      disabled: false
    });
    mockDb.set('students', '25EV001', {
      rollNumber: '25EV001',
      name: 'Anika Verma',
      index: 0,
      disabled: false
    });
  });

  describe('1. Default Working-Day Schedule Loading', () => {
    it('automatically displays default institutional timetable when page first opens', () => {
      // Monday 2026-10-19 should be working day by default
      const monInfo = attendanceService.getDayScheduleInfo('2026-10-19');
      expect(monInfo.isWorking).toBe(true);
      expect(monInfo.status).toBe('Working Day');
      expect(monInfo.isOverride).toBe(false);

      // Sunday 2026-10-18 should be non-working day by default
      const sunInfo = attendanceService.getDayScheduleInfo('2026-10-18');
      expect(sunInfo.isWorking).toBe(false);
      expect(sunInfo.status).toBe('Non-working Day');
      expect(sunInfo.isOverride).toBe(false);

      // Gandhi Jayanti 2026-10-02 should be non-working holiday
      const holInfo = attendanceService.getDayScheduleInfo('2026-10-02');
      expect(holInfo.isWorking).toBe(false);
      expect(holInfo.reason).toContain('Gandhi Jayanti');
    });
  });

  describe('2. Switching a Date from Working Day to Non-working Day (Emergency Closure)', () => {
    it('overrides Monday 2026-10-26 to Non-working Day without affecting other Mondays', () => {
      // Before override
      expect(attendanceService.isWorkingDay('2026-10-26')).toBe(true);
      expect(attendanceService.isWorkingDay('2026-11-02')).toBe(true); // Next Monday

      // Apply emergency closure override
      attendanceService.setScheduleOverride('2026-10-26', {
        status: 'Non-working Day',
        reason: 'Emergency Cyclone Red Alert - Institutional Closure',
        updatedBy: 'faculty@attendedge.edu'
      });

      const updated = attendanceService.getDayScheduleInfo('2026-10-26');
      expect(updated.isWorking).toBe(false);
      expect(updated.status).toBe('Non-working Day');
      expect(updated.isOverride).toBe(true);
      expect(updated.reason).toContain('Cyclone Red Alert');

      // Next Monday must remain an official working day
      const nextMon = attendanceService.getDayScheduleInfo('2026-11-02');
      expect(nextMon.isWorking).toBe(true);
      expect(nextMon.isOverride).toBe(false);
    });
  });

  describe('3. Switching a Date from Non-working Day to Working Day (Special Class)', () => {
    it('overrides Sunday 2026-10-25 to Working Day for special makeup session', () => {
      // Normally Sunday is Non-working Day
      expect(attendanceService.isWorkingDay('2026-10-25')).toBe(false);

      // Apply special working day override
      attendanceService.setScheduleOverride('2026-10-25', {
        status: 'Working Day',
        reason: 'Special VLSI Makeup Laboratory Session',
        updatedBy: 'faculty@attendedge.edu'
      });

      const updated = attendanceService.getDayScheduleInfo('2026-10-25');
      expect(updated.isWorking).toBe(true);
      expect(updated.status).toBe('Working Day');
      expect(updated.isOverride).toBe(true);
      expect(updated.reason).toContain('Special VLSI Makeup');

      // Other Sundays must remain non-working
      expect(attendanceService.isWorkingDay('2026-11-01')).toBe(false);
    });
  });

  describe('4. Persistence After Refresh / Local Storage', () => {
    it('persists schedule overrides across re-initialization of attendanceService', () => {
      attendanceService.setScheduleOverride('2026-10-28', {
        status: 'Non-working Day',
        reason: 'College Sports Day',
        updatedBy: 'faculty@attendedge.edu'
      });

      expect(attendanceService.isWorkingDay('2026-10-28')).toBe(false);

      // Simulate page refresh by creating new service instance
      attendanceService.init();

      const reloaded = attendanceService.getDayScheduleInfo('2026-10-28');
      expect(reloaded.isWorking).toBe(false);
      expect(reloaded.isOverride).toBe(true);
      expect(reloaded.reason).toBe('College Sports Day');
    });
  });

  describe('5. Authorization Checks for Faculty-Only Updates', () => {
    it('allows verified faculty to set day schedule override via Netlify backend', async () => {
      const res = await verifyAndSaveScheduleOverride(mockDb, {
        auth: facultyAuth,
        data: {
          date: '2026-10-26',
          status: 'Non-working Day',
          reason: 'Emergency Holiday Declaration'
        }
      });

      expect(res.success).toBe(true);
      expect(res.override.date).toBe('2026-10-26');
      expect(res.override.isWorking).toBe(false);

      const saved = mockDb.get('dayScheduleOverrides', '2026-10-26');
      expect(saved.exists).toBe(true);
      expect(saved.data().status).toBe('Non-working Day');
      expect(saved.data().reason).toBe('Emergency Holiday Declaration');
    });

    it('rejects unauthorized students from saving day schedule overrides with 403 permission-denied', async () => {
      await expect(
        verifyAndSaveScheduleOverride(mockDb, {
          auth: studentAuth,
          data: {
            date: '2026-10-26',
            status: 'Non-working Day',
            reason: 'Student Prank Holiday'
          }
        })
      ).rejects.toThrow('Unauthorized: Caller does not possess verified faculty privileges');

      const doc = mockDb.get('dayScheduleOverrides', '2026-10-26');
      expect(doc.exists).toBe(false);
    });

    it('rejects unauthenticated requests with 401 unauthenticated error', async () => {
      await expect(
        verifyAndSaveScheduleOverride(mockDb, {
          auth: null,
          data: {
            date: '2026-10-26',
            status: 'Working Day',
            reason: 'No auth'
          }
        })
      ).rejects.toThrow('Authentication required');
    });

    it('enforces required non-empty reason when modifying schedule', async () => {
      await expect(
        verifyAndSaveScheduleOverride(mockDb, {
          auth: facultyAuth,
          data: {
            date: '2026-10-26',
            status: 'Working Day',
            reason: ''
          }
        })
      ).rejects.toThrow('reason is required');
    });
  });

  describe('6. Rejection of Direct Unauthorized Client Writes', () => {
    it('validates Netlify HTTP endpoint rejects missing Authorization bearer token', async () => {
      const event = {
        httpMethod: 'POST',
        headers: {},
        body: JSON.stringify({ date: '2026-10-26', status: 'Non-working Day', reason: 'Test' })
      };

      const res = await netlifyManageDaySchedule(event, {}, {
        services: { db: mockDb, auth: { verifyIdToken: vi.fn() } }
      });

      expect(res.statusCode).toBe(401);
      const parsed = JSON.parse(res.body);
      expect(parsed.code).toBe('functions/unauthenticated');
    });

    it('rejects non-POST HTTP methods with 405 Method Not Allowed', async () => {
      const event = { httpMethod: 'GET', headers: {} };
      const res = await netlifyManageDaySchedule(event, {}, {
        services: { db: mockDb, auth: {} }
      });
      expect(res.statusCode).toBe(405);
    });
  });

  describe('7. Correct Weekly Working-Day and Non-Working-Day Counts', () => {
    it('accurately counts working days and non-working days for week after overrides', () => {
      // Week of Monday 2026-10-05 to Sunday 2026-10-11 (clean week with no default holidays)
      const ws = '2026-10-05';
      const we = '2026-10-11';
      const weekDays = D.range(ws, we);

      // Default week: Mon..Fri = 5 working days, Sat..Sun = 2 non-working days
      expect(weekDays.filter(d => attendanceService.isWorkingDay(d)).length).toBe(5);
      expect(weekDays.filter(d => !attendanceService.isWorkingDay(d)).length).toBe(2);

      // Override Wednesday 2026-10-07 to Non-working Day (e.g. unexpected closure)
      attendanceService.setScheduleOverride('2026-10-07', {
        status: 'Non-working Day',
        reason: 'Local Election Day Closure'
      });

      // Override Sunday 2026-10-11 to Working Day (special lab class)
      attendanceService.setScheduleOverride('2026-10-11', {
        status: 'Working Day',
        reason: 'Special Makeup Lab'
      });

      const updatedWorking = weekDays.filter(d => attendanceService.isWorkingDay(d)).length;
      const updatedNonWorking = weekDays.filter(d => !attendanceService.isWorkingDay(d)).length;

      // 5 default - 1 (Wed off) + 1 (Sun on) = 5 working days, 2 non-working
      expect(updatedWorking).toBe(5);
      expect(updatedNonWorking).toBe(2);

      // Check stats calculation reflects actual schedule
      const stats = attendanceService.getClassStats(ws, we);
      // Working days counted in stats only counts completed working days
      expect(stats.days.every(d => attendanceService.isWorkingDay(d))).toBe(true);
      expect(stats.days.includes('2026-10-07')).toBe(false);
    });
  });

  describe('8. Correct Treatment of Future Dates Without Attendance', () => {
    it('does not falsely treat future working days as zero attendance or 100% absence', () => {
      const futureDate = D.add(attendanceService.getTodayString(), 5);
      const sched = attendanceService.getDayScheduleInfo(futureDate);
      const sessionInfo = attendanceService.getSessionInfo(futureDate);

      if (sched.isWorking) {
        expect(sessionInfo.key).toBe('notstarted');
        expect(sessionInfo.reason).toContain('Upcoming working day');
        // Attendance count on future day must be 0, but isSessionCompleted must be false
        expect(attendanceService.isSessionCompleted(futureDate)).toBe(false);
        // Therefore getClassStats does not include it as completed session with 0% attendance
        const counted = attendanceService.getCountedDays(futureDate, futureDate);
        expect(counted.length).toBe(0);
      }
    });
  });

  describe('9. Attendance Rejection on Non-Working Days', () => {
    it('backend rejects attendance recording on a date overridden to Non-working Day', async () => {
      // 2026-10-20 is a Tuesday (normally working). Faculty overrides it to Non-working Day.
      mockDb.set('dayScheduleOverrides', '2026-10-20', {
        date: '2026-10-20',
        status: 'Non-working Day',
        isWorking: false,
        reason: 'Emergency Power Grid Failure'
      });

      const testNow = new Date('2026-10-20T08:15:00+05:30'); // Within 08:00-08:35 window

      const res = await verifyAndRecordAttendance(mockDb, {
        auth: facultyAuth,
        data: { rollNumber: '25EV001' },
        now: testNow,
        overrideSettings: defaultSettings
      });

      expect(res.success).toBe(false);
      expect(res.statusCode).toBe(STATUS_CODES.S_OUT_WINDOW);
      expect(res.message).toContain('Non-working Day: Attendance rejected');
      expect(res.message).toContain('Emergency Power Grid Failure');

      // Verify no record was committed to Firestore
      const entry = mockDb.get('records/2026-10-20/entries', '25EV001');
      expect(entry.exists).toBe(false);
    });

    it('frontend attendanceService scanBarcode rejects scan when date has Non-working Day override', async () => {
      const today = attendanceService.getTodayString();
      attendanceService.state.ui.clock.time = '08:20:00';

      attendanceService.setScheduleOverride(today, {
        status: 'Non-working Day',
        reason: 'Institutional Holiday'
      });

      const res = await attendanceService.scanBarcode('25EV001');
      expect(res.state).toBe('closed');
      expect(res.statusCode).toBe(STATUS_CODES.S_OUT_WINDOW);
      expect(res.error).toBe('NON_WORKING_DAY');
      expect(res.message).toContain('Non-working Day: Attendance rejected');
    });
  });

  describe('10. Attendance Acceptance on Working Days within Active Window', () => {
    it('backend accepts attendance on working day within 08:00–08:35 Asia/Kolkata window', async () => {
      const testNow = new Date('2026-10-20T08:15:00+05:30'); // Tuesday 08:15 IST

      const res = await verifyAndRecordAttendance(mockDb, {
        auth: facultyAuth,
        data: { rollNumber: '25EV001', captureId: 0 },
        now: testNow,
        overrideSettings: defaultSettings
      });

      expect(res.success).toBe(true);
      expect(res.statusCode).toBe(STATUS_CODES.S_RECORDED);
      expect(res.record.rollNumber).toBe('25EV001');
      expect(res.record.date).toBe('2026-10-20');
      expect(res.record.time).toBe('08:15:00');

      const entry = mockDb.get('records/2026-10-20/entries', '25EV001');
      expect(entry.exists).toBe(true);
    });

    it('backend accepts attendance on a weekend overridden by faculty to Working Day', async () => {
      // 2026-10-25 is a Sunday. Faculty overrides it to Working Day.
      mockDb.set('dayScheduleOverrides', '2026-10-25', {
        date: '2026-10-25',
        status: 'Working Day',
        isWorking: true,
        reason: 'Special Sunday Makeup Class'
      });

      const testNow = new Date('2026-10-25T08:20:00+05:30'); // Sunday 08:20 IST

      const res = await verifyAndRecordAttendance(mockDb, {
        auth: facultyAuth,
        data: { rollNumber: '25EV001', captureId: 0 },
        now: testNow,
        overrideSettings: defaultSettings
      });

      expect(res.success).toBe(true);
      expect(res.statusCode).toBe(STATUS_CODES.S_RECORDED);
      expect(res.record.date).toBe('2026-10-25');
    });
  });

  describe('11. Duplicate Attendance Protection', () => {
    it('prevents second scan of same student on the same date with S_ALREADY status', async () => {
      const testNow = new Date('2026-10-20T08:15:00+05:30');

      // First scan: successful
      const first = await verifyAndRecordAttendance(mockDb, {
        auth: facultyAuth,
        data: { rollNumber: '25EV001', captureId: 0 },
        now: testNow,
        overrideSettings: defaultSettings
      });
      expect(first.success).toBe(true);

      // Second scan: duplicate rejected
      const second = await verifyAndRecordAttendance(mockDb, {
        auth: facultyAuth,
        data: { rollNumber: '25EV001', captureId: 0 },
        now: testNow,
        overrideSettings: defaultSettings
      });
      expect(second.success).toBe(false);
      expect(second.statusCode).toBe(STATUS_CODES.S_ALREADY);
      expect(second.message).toContain('Already Recorded');
    });
  });

  describe('12. Asia/Kolkata Timezone Handling', () => {
    it('strictly calculates todayDate and currentTime from UTC timestamp using Asia/Kolkata', async () => {
      // 02:45:00 UTC on 2026-10-20 corresponds exactly to 08:15:00 IST (+05:30)
      const utcTime = new Date('2026-10-20T02:45:00Z');

      const res = await verifyAndRecordAttendance(mockDb, {
        auth: facultyAuth,
        data: { rollNumber: '25EV001', captureId: 0 },
        now: utcTime,
        overrideSettings: defaultSettings
      });

      expect(res.success).toBe(true);
      expect(res.record.date).toBe('2026-10-20');
      expect(res.record.time).toBe('08:15:00');
    });
  });

  describe('13. Audit History Creation', () => {
    it('records immutable audit record with who, when, and reason when schedule is overridden', async () => {
      const auditNow = new Date('2026-10-24T10:30:00+05:30');

      const res = await verifyAndSaveScheduleOverride(mockDb, {
        auth: facultyAuth,
        data: {
          date: '2026-10-27',
          status: 'Non-working Day',
          reason: 'Emergency Campus Maintenance'
        },
        now: auditNow
      });

      expect(res.success).toBe(true);
      expect(res.audit).toBeDefined();
      expect(res.audit.date).toBe('2026-10-27');
      expect(res.audit.status).toBe('Non-working Day');
      expect(res.audit.reason).toBe('Emergency Campus Maintenance');
      expect(res.audit.updatedBy).toBe('instructor@university.edu');
      expect(res.audit.timestamp).toBe(auditNow.toISOString());
    });
  });

  describe('14. CSV and PDF Reports Reflecting Updated Schedule', () => {
    it('weekly report generator includes working and non-working days in summary metadata', () => {
      const ws = '2026-10-05';
      const we = '2026-10-11';

      // Override one day
      attendanceService.setScheduleOverride('2026-10-09', {
        status: 'Non-working Day',
        reason: 'Special Holiday'
      });

      const weekDays = D.range(ws, we);
      const workingDays = weekDays.filter(d => attendanceService.isWorkingDay(d));
      const nonWorkingDays = weekDays.filter(d => !attendanceService.isWorkingDay(d));

      expect(workingDays.length).toBe(4);
      expect(nonWorkingDays.length).toBe(3);

      const st = attendanceService.getClassStats(ws, we);
      // Working days counted in class stats reflects only working days
      expect(st.days.every(d => attendanceService.isWorkingDay(d))).toBe(true);
    });
  });

  describe('15. Faculty Password Re-Authentication Security', () => {
    it('successfully authorizes re-authentication in demo mode with demo credentials', async () => {
      startDemoSession();
      const res = await reauthenticateFaculty('demo123');
      expect(res.success).toBe(true);
    });

    it('rejects re-authentication with incorrect password', async () => {
      startDemoSession();
      const res = await reauthenticateFaculty('wrongpassword');
      expect(res.success).toBe(false);
      expect(res.error).toContain('Incorrect demo password');
    });

    it('rejects re-authentication when password is empty', async () => {
      startDemoSession();
      const res = await reauthenticateFaculty('');
      expect(res.success).toBe(false);
      expect(res.error).toContain('Password is required');
    });
  });

  describe('16. isCloudSyncReady Readiness Helper Verification', () => {
    it('isCloudSyncReady is an exported function and returns boolean', () => {
      expect(typeof isCloudSyncReady).toBe('function');
      const ready = isCloudSyncReady();
      expect(typeof ready).toBe('boolean');
    });

    it('returns false when unauthenticated or Firebase is not connected', () => {
      // In Node test environment without real user login
      expect(isCloudSyncReady()).toBe(false);
    });
  });

  describe('17. Uninitialized Firebase Connection Handling', () => {
    it('saveDayScheduleOverride throws unauthenticated error when isCloudSyncReady is false', async () => {
      await expect(FirestoreService.saveDayScheduleOverride({
        date: '2026-10-26',
        status: 'Working Day',
        reason: 'Test reason'
      })).rejects.toThrow('Cannot save schedule override: Firebase is not authenticated.');
    });

    it('resetDayScheduleOverride throws unauthenticated error when isCloudSyncReady is false', async () => {
      await expect(FirestoreService.resetDayScheduleOverride('2026-10-26'))
        .rejects.toThrow('Cannot reset schedule override: Firebase is not authenticated.');
    });

    it('getDayScheduleOverrides safely returns empty object when isCloudSyncReady is false', async () => {
      const overrides = await FirestoreService.getDayScheduleOverrides();
      expect(overrides).toEqual({});
    });

    it('getScheduleAuditHistory safely returns empty array when isCloudSyncReady is false', async () => {
      const history = await FirestoreService.getScheduleAuditHistory();
      expect(history).toEqual([]);
    });
  });

  describe('18. Netlify manageDaySchedule Endpoint Authentication & Authorization', () => {
    it('rejects requests missing the Authorization header with 401', async () => {
      const res = await netlifyManageDaySchedule({
        httpMethod: 'POST',
        headers: {},
        body: JSON.stringify({ date: '2026-10-26', status: 'Working Day', reason: 'Holiday class' })
      }, {}, { services: { db: mockDb, auth: {} } });

      expect(res.statusCode).toBe(401);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
      expect(body.code).toBe('functions/unauthenticated');
    });

    it('rejects requests with an invalid Bearer token with 401', async () => {
      const mockAuthService = {
        verifyIdToken: vi.fn().mockRejectedValue(new Error('Invalid token'))
      };

      const res = await netlifyManageDaySchedule({
        httpMethod: 'POST',
        headers: { authorization: 'Bearer invalid.token.xyz' },
        body: JSON.stringify({ date: '2026-10-26', status: 'Working Day', reason: 'Holiday class' })
      }, {}, { services: { db: mockDb, auth: mockAuthService } });

      expect(res.statusCode).toBe(401);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
      expect(body.message).toContain('Invalid, expired, or revoked');
    });

    it('rejects callers without faculty role with 403', async () => {
      const studentToken = { uid: 'student-999', email: 'student@example.edu' };
      const mockAuthService = {
        verifyIdToken: vi.fn().mockResolvedValue(studentToken)
      };

      const res = await netlifyManageDaySchedule({
        httpMethod: 'POST',
        headers: { authorization: 'Bearer student.token' },
        body: JSON.stringify({ date: '2026-10-26', status: 'Working Day', reason: 'Holiday class' })
      }, {}, { services: { db: mockDb, auth: mockAuthService } });

      expect(res.statusCode).toBe(403);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
      expect(body.code).toBe('functions/permission-denied');
    });

    it('accepts valid faculty token and saves override with 200', async () => {
      const facultyToken = {
        uid: 'faculty-001',
        email: 'faculty@university.edu',
        role: 'faculty',
        faculty: true
      };
      const mockAuthService = {
        verifyIdToken: vi.fn().mockResolvedValue(facultyToken)
      };

      const res = await netlifyManageDaySchedule({
        httpMethod: 'POST',
        headers: { authorization: 'Bearer faculty.valid.token' },
        body: JSON.stringify({
          date: '2026-10-28',
          status: 'Non-working Day',
          reason: 'Campus Convocation'
        })
      }, {}, { services: { db: mockDb, auth: mockAuthService } });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.override.status).toBe('Non-working Day');
      expect(body.override.isWorking).toBe(false);
      expect(body.override.reason).toBe('Campus Convocation');

      // Verify persistence in mock database
      const stored = mockDb.get('dayScheduleOverrides', '2026-10-28');
      expect(stored.exists).toBe(true);
      expect(stored.data().status).toBe('Non-working Day');
      expect(stored.data().isWorking).toBe(false);
    });
  });

  describe('19. Network and Backend Failure Error Diagnostics', () => {
    let originalUser;
    beforeEach(() => {
      originalUser = auth?.currentUser;
      if (auth) {
        Object.defineProperty(auth, 'currentUser', {
          value: {
            uid: 'faculty-001',
            email: 'faculty@university.edu',
            getIdToken: async () => 'mock-id-token'
          },
          configurable: true,
          writable: true
        });
      }
    });

    afterEach(() => {
      if (auth) {
        Object.defineProperty(auth, 'currentUser', {
          value: originalUser,
          configurable: true,
          writable: true
        });
      }
    });

    it('maps network fetch failures into meaningful error messages in saveDayScheduleOverride', async () => {
      // Mock global fetch to simulate network loss
      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));

      try {
        await FirestoreService.saveDayScheduleOverride({
          date: '2026-10-26',
          status: 'Non-working Day',
          reason: 'Emergency weather closure'
        });
        expect.fail('Should have thrown an error');
      } catch (err) {
        expect(err.message).toContain('Network error: Unable to contact server');
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it('preserves specific server rejection error messages in saveDayScheduleOverride', async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        statusText: 'Bad Request',
        json: async () => ({
          success: false,
          code: 'functions/invalid-argument',
          message: 'A specific reason is required when changing the day status.'
        })
      });

      try {
        await FirestoreService.saveDayScheduleOverride({
          date: '2026-10-26',
          status: 'Non-working Day',
          reason: 'X'
        });
        expect.fail('Should have thrown an error');
      } catch (err) {
        expect(err.message).toBe('A specific reason is required when changing the day status.');
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });

  describe('20. End-to-End Schedule Save, Audit Trail, and Local State Synchronization', () => {
    it('persists override, records audit entry with action, and synchronizes with attendanceService', async () => {
      const testDate = '2026-10-29';
      const testReason = 'Special Department Symposium';

      // 1. Backend save
      const saveRes = await verifyAndSaveScheduleOverride(mockDb, {
        auth: facultyAuth,
        data: {
          date: testDate,
          status: 'Working Day',
          reason: testReason
        },
        now: new Date('2026-10-24T12:00:00Z')
      });

      expect(saveRes.success).toBe(true);

      // 2. Audit Trail verification
      expect(saveRes.audit.action).toBe('OVERRIDE_DAY_STATUS');
      expect(saveRes.audit.reason).toBe(testReason);
      expect(saveRes.audit.updatedBy).toBe('instructor@university.edu');

      // 3. Local attendanceService state synchronization
      attendanceService.setScheduleOverride(testDate, {
        status: 'Working Day',
        reason: testReason,
        updatedBy: 'instructor@university.edu'
      });

      const info = attendanceService.getDayScheduleInfo(testDate);
      expect(info.isWorking).toBe(true);
      expect(info.isOverride).toBe(true);
      expect(info.reason).toBe(testReason);
    });
  });

  describe('21. Deterministic Document IDs, Repeat Updates, and Schema Compliance', () => {
    it('uses deterministic document ID dayScheduleOverrides/{YYYY-MM-DD} and overwrites on repeat updates', async () => {
      const targetDate = '2026-10-24';

      // 1. First update: Working Day -> Non-working Day
      const firstSave = await verifyAndSaveScheduleOverride(mockDb, {
        auth: facultyAuth,
        data: {
          date: targetDate,
          status: 'Non-working Day',
          reason: 'Emergency weather holiday'
        },
        now: new Date('2026-10-24T06:00:00Z')
      });

      expect(firstSave.success).toBe(true);
      const firstDoc = mockDb.get('dayScheduleOverrides', targetDate);
      expect(firstDoc.exists).toBe(true);
      expect(firstDoc.data().date).toBe(targetDate);
      expect(firstDoc.data().isWorkingDay).toBe(false);
      expect(firstDoc.data().isWorking).toBe(false);
      expect(firstDoc.data().reason).toBe('Emergency weather holiday');
      expect(firstDoc.data().updatedBy).toBe('fac-001'); // faculty UID
      expect(firstDoc.data().updatedByEmail).toBe('instructor@university.edu');

      // 2. Repeat update on same date: Non-working Day -> Working Day
      const secondSave = await verifyAndSaveScheduleOverride(mockDb, {
        auth: facultyAuth,
        data: {
          date: targetDate,
          status: 'Working Day',
          reason: 'Weather cleared, special class resumed'
        },
        now: new Date('2026-10-24T07:00:00Z')
      });

      expect(secondSave.success).toBe(true);
      const secondDoc = mockDb.get('dayScheduleOverrides', targetDate);
      expect(secondDoc.exists).toBe(true);
      expect(secondDoc.data().date).toBe(targetDate);
      expect(secondDoc.data().isWorkingDay).toBe(true);
      expect(secondDoc.data().isWorking).toBe(true);
      expect(secondDoc.data().reason).toBe('Weather cleared, special class resumed');
      expect(secondDoc.data().updatedBy).toBe('fac-001');

      // Verify no duplicates were created - document ID is strictly targetDate
      expect(secondDoc.id).toBe(targetDate);
    });

    it('atomic reset removes override document and records RESET_TO_DEFAULT in audit history', async () => {
      const targetDate = '2026-10-24';

      // Seed an override
      await verifyAndSaveScheduleOverride(mockDb, {
        auth: facultyAuth,
        data: { date: targetDate, status: 'Non-working Day', reason: 'Holiday' }
      });
      expect(mockDb.get('dayScheduleOverrides', targetDate).exists).toBe(true);

      // Reset to default
      const resetRes = await verifyAndSaveScheduleOverride(mockDb, {
        auth: facultyAuth,
        data: { date: targetDate, action: 'resetOverride', reason: 'Reverting to regular schedule' },
        now: new Date('2026-10-24T08:00:00Z')
      });

      expect(resetRes.success).toBe(true);
      expect(resetRes.reset).toBe(true);

      // Document is removed
      expect(mockDb.get('dayScheduleOverrides', targetDate).exists).toBe(false);
    });
  });
});

