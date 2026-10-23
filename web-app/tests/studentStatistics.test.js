import { describe, it, expect } from 'vitest';
import { parseStudentGender, parseStudentAccom, getStudentStatistics } from '../src/logic/studentStatistics.js';
import { attendanceService } from '../src/services/attendanceService.js';

describe('Student Statistics Dashboard', () => {
  describe('Demographic parsing and normalization', () => {
    it('normalizes gender correctly from valid values', () => {
      expect(parseStudentGender({ gender: 'Boy' })).toBe('Boy');
      expect(parseStudentGender({ gender: 'Male' })).toBe('Boy');
      expect(parseStudentGender({ sex: 'M' })).toBe('Boy');
      expect(parseStudentGender({ gender: 'Girl' })).toBe('Girl');
      expect(parseStudentGender({ gender: 'Female' })).toBe('Girl');
      expect(parseStudentGender({ sex: 'F' })).toBe('Girl');
    });

    it('returns null for missing, empty, or placeholder gender', () => {
      expect(parseStudentGender(null)).toBeNull();
      expect(parseStudentGender({})).toBeNull();
      expect(parseStudentGender({ gender: '' })).toBeNull();
      expect(parseStudentGender({ placeholder: true })).toBeNull();
      expect(parseStudentGender({ placeholder: true, residence: 'Hosteller' })).toBeNull();
    });

    it('normalizes accommodation correctly from valid values', () => {
      expect(parseStudentAccom({ residence: 'Hosteller' })).toBe('Hosteller');
      expect(parseStudentAccom({ accommodation: 'Hostel' })).toBe('Hosteller');
      expect(parseStudentAccom({ isHosteller: true })).toBe('Hosteller');
      expect(parseStudentAccom({ residence: 'Day Scholar' })).toBe('Day Scholar');
      expect(parseStudentAccom({ accommodation: 'dayscholar' })).toBe('Day Scholar');
      expect(parseStudentAccom({ isHosteller: false })).toBe('Day Scholar');
    });

    it('returns null for unconfirmed placeholder accommodation', () => {
      expect(parseStudentAccom(null)).toBeNull();
      expect(parseStudentAccom({})).toBeNull();
      expect(parseStudentAccom({ placeholder: true, residence: 'Hosteller' })).toBeNull();
      expect(parseStudentAccom({ placeholder: true, residence: 'Day Scholar' })).toBeNull();
      expect(parseStudentAccom({ rollNumber: '25EV001', residence: 'Hosteller' })).toBeNull();
      expect(parseStudentAccom({ rollNumber: '25EV002', residence: 'Day Scholar' })).toBeNull();
    });

    it('respects accommodation once student is confirmed or updated', () => {
      expect(parseStudentAccom({ placeholder: false, residence: 'Hosteller' })).toBe('Hosteller');
      expect(parseStudentAccom({ updatedAt: '2026-10-23T10:00:00Z', residence: 'Day Scholar' })).toBe('Day Scholar');
      expect(parseStudentAccom({ gender: 'Boy', residence: 'Hosteller' })).toBe('Hosteller');
    });
  });

  describe('Default 63 placeholder students', () => {
    it('accurately reports 63 total students with unconfirmed/incomplete demographics', () => {
      const generated = attendanceService.generateStudents(attendanceService.createDefaultSettings());
      expect(generated.length).toBe(63);

      const stats = getStudentStatistics(generated);

      // Total Students must be 63
      expect(stats.total).toBe(63);

      // All 8 demographic categories must flag hasData: false (awaiting data)
      expect(stats.boys.hasData).toBe(false);
      expect(stats.boys.count).toBe(0);
      expect(stats.boys.missing).toBe(63);

      expect(stats.girls.hasData).toBe(false);
      expect(stats.girls.count).toBe(0);
      expect(stats.girls.missing).toBe(63);

      expect(stats.hostellers.hasData).toBe(false);
      expect(stats.hostellers.count).toBe(0);
      expect(stats.hostellers.missing).toBe(63);

      expect(stats.dayScholars.hasData).toBe(false);
      expect(stats.dayScholars.count).toBe(0);
      expect(stats.dayScholars.missing).toBe(63);

      expect(stats.boysDayScholar.hasData).toBe(false);
      expect(stats.boysHosteller.hasData).toBe(false);
      expect(stats.girlsDayScholar.hasData).toBe(false);
      expect(stats.girlsHosteller.hasData).toBe(false);
    });
  });

  describe('Dynamic calculation from actual student records', () => {
    const sampleStudents = [
      { rollNumber: '25EV001', name: 'Alice', gender: 'Girl', residence: 'Hosteller' },
      { rollNumber: '25EV002', name: 'Bob', gender: 'Boy', residence: 'Hosteller' },
      { rollNumber: '25EV003', name: 'Charlie', gender: 'Boy', residence: 'Day Scholar' },
      { rollNumber: '25EV004', name: 'Diana', gender: 'Girl', residence: 'Day Scholar' },
      { rollNumber: '25EV005', name: 'Evan', gender: 'Boy', residence: 'Day Scholar' },
      { rollNumber: '25EV006', name: 'Fiona', gender: 'Girl', residence: 'Hosteller' },
      { rollNumber: '25EV007', name: 'George', gender: 'Boy', residence: 'Hosteller' },
      { rollNumber: '25EV008', name: 'Hannah', placeholder: true } // Incomplete
    ];

    it('calculates all 9 statistics dynamically and identifies missing data', () => {
      const stats = getStudentStatistics(sampleStudents);

      // 1. Total Students
      expect(stats.total).toBe(8);

      // 2. Total Boys (Bob, Charlie, Evan, George = 4)
      expect(stats.boys.hasData).toBe(true);
      expect(stats.boys.count).toBe(4);
      expect(stats.boys.missing).toBe(1);

      // 3. Total Girls (Alice, Diana, Fiona = 3)
      expect(stats.girls.hasData).toBe(true);
      expect(stats.girls.count).toBe(3);
      expect(stats.girls.missing).toBe(1);

      // 4. Total Hostellers (Alice, Bob, Fiona, George = 4)
      expect(stats.hostellers.hasData).toBe(true);
      expect(stats.hostellers.count).toBe(4);
      expect(stats.hostellers.missing).toBe(1);

      // 5. Total Day Scholars (Charlie, Diana, Evan = 3)
      expect(stats.dayScholars.hasData).toBe(true);
      expect(stats.dayScholars.count).toBe(3);
      expect(stats.dayScholars.missing).toBe(1);

      // 6. Boys who are Day Scholars (Charlie, Evan = 2)
      expect(stats.boysDayScholar.hasData).toBe(true);
      expect(stats.boysDayScholar.count).toBe(2);

      // 7. Boys who are Hostellers (Bob, George = 2)
      expect(stats.boysHosteller.hasData).toBe(true);
      expect(stats.boysHosteller.count).toBe(2);

      // 8. Girls who are Day Scholars (Diana = 1)
      expect(stats.girlsDayScholar.hasData).toBe(true);
      expect(stats.girlsDayScholar.count).toBe(1);

      // 9. Girls who are Hostellers (Alice, Fiona = 2)
      expect(stats.girlsHosteller.hasData).toBe(true);
      expect(stats.girlsHosteller.count).toBe(2);
    });

    it('sums correctly across all mutually exclusive subgroups', () => {
      const stats = getStudentStatistics(sampleStudents);
      const verifiedSubgroups =
        stats.boysDayScholar.count +
        stats.boysHosteller.count +
        stats.girlsDayScholar.count +
        stats.girlsHosteller.count;

      expect(verifiedSubgroups).toBe(7); // 7 verified students + 1 incomplete = 8 total
    });
  });
});
