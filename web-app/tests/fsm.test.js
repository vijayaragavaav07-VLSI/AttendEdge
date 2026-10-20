import { describe, it, expect, beforeEach } from 'vitest';
import { AttendanceFSM, FSM_STATES, STATUS_CODES } from '../src/logic/attendanceFSM.js';

describe('AttendanceFSM - Verilog Hardware Reproduction', () => {
  let fsm;

  beforeEach(() => {
    fsm = new AttendanceFSM();
  });

  it('initializes in IDLE state with all registers cleared to 0', () => {
    const s = fsm.getStateSnapshot();
    expect(s.state).toBe(FSM_STATES.IDLE);
    expect(s.attendanceBits).toBe(0n);
    expect(s.statusCode).toBe(STATUS_CODES.S_NONE);
    expect(s.statusValid).toBe(false);
  });

  describe('Verilog tb_attendance_controller.v test suite', () => {
    it('Scenario 1: scan(6\'d10, 5\'d8, 6\'d30) -> expect 4 (S_RECORDED)', () => {
      const res = fsm.scan(10, 8, 30);
      expect(res.statusCode).toBe(STATUS_CODES.S_RECORDED);
      expect(fsm.isStudentPresent(10)).toBe(true);
      // Bit 10 must be set in 64-bit attendance register
      expect((fsm.attendanceBits & (1n << 10n)) !== 0n).toBe(true);
    });

    it('Scenario 2: scan(6\'d10, 5\'d8, 6\'d31) -> expect 1 (S_ALREADY)', () => {
      // First scan: records
      fsm.scan(10, 8, 30);
      expect(fsm.isStudentPresent(10)).toBe(true);

      // Second scan of same ID: duplicate
      const res = fsm.scan(10, 8, 31);
      expect(res.statusCode).toBe(STATUS_CODES.S_ALREADY);
    });

    it('Scenario 3: scan(6\'d62, 5\'d9, 6\'d14) -> expect 3 (S_OUT_WINDOW)', () => {
      const res = fsm.scan(62, 9, 14);
      expect(res.statusCode).toBe(STATUS_CODES.S_OUT_WINDOW);
      expect(fsm.isStudentPresent(62)).toBe(false);
    });

    it('Scenario 4: scan(6\'d63, 5\'d8, 6\'d10) -> expect 2 (S_BAD_ID)', () => {
      // 63 is unregistered in the 63-student design (0..62 valid)
      const res = fsm.scan(63, 8, 10);
      expect(res.statusCode).toBe(STATUS_CODES.S_BAD_ID);
      expect(fsm.isStudentPresent(63)).toBe(false);
    });

    it('Scenario 5: scan(6\'d5, 5\'d8, 6\'d5) -> expect 4 (S_RECORDED)', () => {
      const res = fsm.scan(5, 8, 5);
      expect(res.statusCode).toBe(STATUS_CODES.S_RECORDED);
      expect(fsm.isStudentPresent(5)).toBe(true);
    });
  });

  describe('Sequential execution of entire testbench sequence', () => {
    it('executes the full tb sequence in order matching Verilog simulation output', () => {
      // Reset DUT
      fsm.reset();

      // scan(6'd10, 5'd8, 6'd30); -> expect 4 recorded
      const res1 = fsm.scan(10, 8, 30);
      expect(res1.statusCode).toBe(4);

      // scan(6'd10, 5'd8, 6'd31); -> expect 1 already present
      const res2 = fsm.scan(10, 8, 31);
      expect(res2.statusCode).toBe(1);

      // scan(6'd62, 5'd9, 6'd14); -> expect 3 outside window
      const res3 = fsm.scan(62, 9, 14);
      expect(res3.statusCode).toBe(3);

      // scan(6'd63, 5'd8, 6'd10); -> expect 2 invalid id
      const res4 = fsm.scan(63, 8, 10);
      expect(res4.statusCode).toBe(2);

      // scan(6'd5, 5'd8, 6'd5); -> expect 4 recorded
      const res5 = fsm.scan(5, 8, 5);
      expect(res5.statusCode).toBe(4);

      // Check bits: only bit 10 and bit 5 are set
      const expectedBits = (1n << 10n) | (1n << 5n);
      expect(fsm.attendanceBits).toBe(expectedBits);
    });
  });

  describe('Cycle-accurate state transition verification', () => {
    it('verifies exact cycle-by-cycle progression for a successful scan', () => {
      fsm.reset();

      // Cycle 1: scanValid pulse at IDLE
      let snap = fsm.clockStep({ scanValid: true, captureId: 7, hour: 8, minute: 15 });
      expect(snap.state).toBe(FSM_STATES.RECEIVE);
      expect(snap.id_r).toBe(7);
      expect(snap.h_r).toBe(8);
      expect(snap.m_r).toBe(15);
      expect(snap.statusValid).toBe(false);

      // Cycle 2: RECEIVE -> CHECK_TIME
      snap = fsm.clockStep({ scanValid: false });
      expect(snap.state).toBe(FSM_STATES.CHECK_TIME);
      expect(snap.statusValid).toBe(false);

      // Cycle 3: CHECK_TIME -> VERIFY (since 08:15 is in window)
      snap = fsm.clockStep({ scanValid: false });
      expect(snap.state).toBe(FSM_STATES.VERIFY);
      expect(snap.statusValid).toBe(false);

      // Cycle 4: VERIFY -> CHECK_DUP (since 7 < 63)
      snap = fsm.clockStep({ scanValid: false });
      expect(snap.state).toBe(FSM_STATES.CHECK_DUP);
      expect(snap.statusValid).toBe(false);

      // Cycle 5: CHECK_DUP -> RECORD (not present yet)
      snap = fsm.clockStep({ scanValid: false });
      expect(snap.state).toBe(FSM_STATES.RECORD);
      expect(snap.statusValid).toBe(false);

      // Cycle 6: RECORD -> REPORT (bit 7 set, result = 4)
      snap = fsm.clockStep({ scanValid: false });
      expect(snap.state).toBe(FSM_STATES.REPORT);
      expect(snap.result).toBe(STATUS_CODES.S_RECORDED);
      expect(fsm.isStudentPresent(7)).toBe(true);

      // Cycle 7: REPORT -> IDLE (statusValid asserted for 1 cycle, statusCode output)
      snap = fsm.clockStep({ scanValid: false });
      expect(snap.state).toBe(FSM_STATES.IDLE);
      expect(snap.statusValid).toBe(true);
      expect(snap.statusCode).toBe(STATUS_CODES.S_RECORDED);

      // Cycle 8: IDLE remains with statusValid falling back to false
      snap = fsm.clockStep({ scanValid: false });
      expect(snap.state).toBe(FSM_STATES.IDLE);
      expect(snap.statusValid).toBe(false);
    });

    it('verifies out of window cycle progression: CHECK_TIME -> INVALID -> REPORT', () => {
      fsm.reset();

      // Cycle 1: pulse at IDLE with hour=9
      fsm.clockStep({ scanValid: true, captureId: 1, hour: 9, minute: 0 }); // -> RECEIVE
      fsm.clockStep({ scanValid: false }); // -> CHECK_TIME
      const snap = fsm.clockStep({ scanValid: false }); // -> INVALID
      expect(snap.state).toBe(FSM_STATES.INVALID);
      expect(snap.result).toBe(STATUS_CODES.S_OUT_WINDOW);

      fsm.clockStep({ scanValid: false }); // -> REPORT
      const reportSnap = fsm.clockStep({ scanValid: false }); // -> IDLE with statusValid
      expect(reportSnap.state).toBe(FSM_STATES.IDLE);
      expect(reportSnap.statusValid).toBe(true);
      expect(reportSnap.statusCode).toBe(STATUS_CODES.S_OUT_WINDOW);
    });
  });

  describe('Window boundary conditions', () => {
    it('accepts 08:00 (minute 0) and 08:35 (minute 35) as inside window', () => {
      expect(fsm.scan(1, 8, 0).statusCode).toBe(STATUS_CODES.S_RECORDED);
      expect(fsm.scan(2, 8, 35).statusCode).toBe(STATUS_CODES.S_RECORDED);
    });

    it('rejects 07:59 and 08:36 as outside window', () => {
      expect(fsm.scan(3, 7, 59).statusCode).toBe(STATUS_CODES.S_OUT_WINDOW);
      expect(fsm.scan(4, 8, 36).statusCode).toBe(STATUS_CODES.S_OUT_WINDOW);
    });
  });
});
