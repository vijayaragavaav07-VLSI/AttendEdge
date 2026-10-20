import { describe, it, expect, beforeEach } from 'vitest';

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
import { STATUS_CODES } from '../src/logic/attendanceFSM.js';
import { D, pctText, toSec } from '../src/reports/reportGenerator.js';

describe('Stage 2: Comprehensive Workflow, Session & Report Validation', () => {
  beforeEach(() => {
    localStorage.clear();
    attendanceService.init();
  });

  describe('1. Student Management & Editing', () => {
    it('successfully edits an existing student profile', async () => {
      const roll = attendanceService.state.students[0].rollNumber;
      const updated = await attendanceService.updateStudent(roll, {
        name: 'Jane Doe Updated',
        residence: 'Hosteller',
        department: 'Information Science'
      });

      expect(updated.name).toBe('Jane Doe Updated');
      expect(updated.residence).toBe('Hosteller');
      expect(updated.department).toBe('Information Science');

      const fetched = attendanceService.getStudent(roll);
      expect(fetched.name).toBe('Jane Doe Updated');
      expect(fetched.residence).toBe('Hosteller');
    });

    it('rejects editing a non-existent student', async () => {
      await expect(attendanceService.updateStudent('INVALID_ROLL_999', { name: 'Nobody' }))
        .rejects.toThrow('not found');
    });

    it('rejects adding duplicate student with existing roll number', async () => {
      const existingRoll = attendanceService.state.students[5].rollNumber;
      await expect(attendanceService.addStudent({
        rollNumber: existingRoll,
        name: 'Imposter Student'
      })).rejects.toThrow('already exists in roster');
    });
  });

  describe('2. Attendance Workflows & Closed Session Protection', () => {
    it('accepts scan within permitted 08:00-08:35 window', async () => {
      const today = attendanceService.getTodayString();
      attendanceService.state.ui.clock.time = '08:20:00';
      const student = attendanceService.state.students[2];

      const res = await attendanceService.scanBarcode(student.rollNumber);
      expect(res.state).toBe('present');
      expect(res.statusCode).toBe(STATUS_CODES.S_RECORDED);

      const records = attendanceService.getRecordsOn(today);
      expect(records[student.rollNumber]).toBeDefined();
    });

    it('rejects scan when session is explicitly closed by faculty', async () => {
      const today = attendanceService.getTodayString();
      attendanceService.state.ui.clock.time = '08:20:00';
      const student = attendanceService.state.students[3];

      await attendanceService.closeSession(today);
      expect(attendanceService.state.sessions[today].sessionStatus).toBe('Closed');

      const res = await attendanceService.scanBarcode(student.rollNumber);
      expect(res.state).toBe('closed');
      expect(res.error).toBe('SESSION_CLOSED');
      expect(res.message).toContain('Session Closed');

      const records = attendanceService.getRecordsOn(today);
      expect(records[student.rollNumber]).toBeUndefined();
    });

    it('re-enables scanning when session is re-opened by faculty', async () => {
      const today = attendanceService.getTodayString();
      attendanceService.state.ui.clock.time = '08:25:00';
      const student = attendanceService.state.students[4];

      await attendanceService.closeSession(today);
      await attendanceService.openSession(today);
      expect(attendanceService.state.sessions[today].sessionStatus).toBe('Open');

      const res = await attendanceService.scanBarcode(student.rollNumber);
      expect(res.state).toBe('present');
      expect(res.statusCode).toBe(STATUS_CODES.S_RECORDED);
    });

    it('rejects unregistered student index (>= 63) with exact S_BAD_ID status', async () => {
      attendanceService.state.ui.clock.time = '08:10:00';
      const res = await attendanceService.scanBarcode('25EV099');
      expect(res.state).toBe('invalid');
      expect(res.statusCode).toBe(STATUS_CODES.S_BAD_ID);
    });

    it('rejects duplicate scan of same student with exact S_ALREADY status', async () => {
      attendanceService.state.ui.clock.time = '08:10:00';
      const student = attendanceService.state.students[10];

      const first = await attendanceService.scanBarcode(student.rollNumber);
      expect(first.state).toBe('present');

      const second = await attendanceService.scanBarcode(student.rollNumber);
      expect(second.state).toBe('duplicate');
      expect(second.statusCode).toBe(STATUS_CODES.S_ALREADY);
    });
  });

  describe('3. Report Calculation & Percentage Verifications', () => {
    it('correctly calculates percentage with known present/working days', () => {
      expect(pctText(100)).toBe('100.0%');
      expect(pctText(75.5)).toBe('75.5%');
      expect(pctText(null)).toBe('Not Available');
    });

    it('accurately summarizes stats across all students', () => {
      const testMap = {
        '25EV001': { working: 10, present: 9, absent: 1, pct: 90.0 },
        '25EV002': { working: 10, present: 8, absent: 2, pct: 80.0 },
        '25EV003': { working: 10, present: 6, absent: 4, pct: 60.0 }
      };

      const summary = attendanceService.summarizeStats(testMap);
      expect(summary.avg).toBeCloseTo(76.666, 1);
      expect(summary.above).toBe(2);
      expect(summary.below).toBe(1);
    });

    it('correctly parses and ranges date strings', () => {
      const range = D.range('2026-10-01', '2026-10-05');
      expect(range).toEqual([
        '2026-10-01',
        '2026-10-02',
        '2026-10-03',
        '2026-10-04',
        '2026-10-05'
      ]);
      expect(toSec('08:35:00')).toBe(8 * 3600 + 35 * 60);
    });
  });
});
