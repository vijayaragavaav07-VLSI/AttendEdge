/**
 * AttendEdge — Verilog FSM Software Simulation
 *
 * Direct reproduction of the 9-state attendance controller implemented in:
 * vivado/digital attendence system using flipflops and FSM.srcs/sources_1/new/Attendence_Controller.v
 *
 * Source of truth:
 * - Module: attendance_controller
 * - Clock-driven FSM with states 1..9
 * - Status codes 0..4
 * - 64-bit flip-flop attendance register (bits 0..62 for student IDs, 63 for invalid/unregistered)
 * - Window comparator: (hour == 8) && (minute <= 35) -> 08:00 - 08:35
 */

// FSM State Constants (exact match with Verilog localparam 1..9)
export const FSM_STATES = {
  IDLE: 1,
  RECEIVE: 2,
  CHECK_TIME: 3,
  VERIFY: 4,
  CHECK_DUP: 5,
  RECORD: 6,
  INVALID: 7,
  ALREADY_PRESENT: 8,
  REPORT: 9
};

export const FSM_STATE_NAMES = {
  1: 'IDLE',
  2: 'RECEIVE',
  3: 'CHECK_TIME',
  4: 'VERIFY',
  5: 'CHECK_DUP',
  6: 'RECORD',
  7: 'INVALID',
  8: 'ALREADY_PRESENT',
  9: 'REPORT'
};

// Status Code Constants (exact match with Verilog localparam S_NONE..S_RECORDED)
export const STATUS_CODES = {
  S_NONE: 0,
  S_ALREADY: 1,
  S_BAD_ID: 2,
  S_OUT_WINDOW: 3,
  S_RECORDED: 4
};

export const STATUS_MESSAGES = {
  0: 'No status / Idle',
  1: 'Already Present: Student was previously recorded today.',
  2: 'Invalid Student ID: Index exceeds valid roster range (0..62).',
  3: 'Outside Attendance Window: Attendance only accepted 08:00 - 08:35.',
  4: 'Attendance Recorded: Register flip-flop updated 0 -> 1.'
};

export class AttendanceFSM {
  constructor() {
    this.reset();
  }

  /**
   * Synchronous reset matching Verilog `if (reset)` block.
   */
  reset() {
    this.state = FSM_STATES.IDLE;
    this.id_r = 0;
    this.h_r = 0;
    this.m_r = 0;
    this.result = STATUS_CODES.S_NONE;
    this.statusCode = STATUS_CODES.S_NONE;
    this.statusValid = false;
    // 64-bit attendance register using BigInt
    this.attendanceBits = 0n;
    this.cycleCount = 0;
    this.traceLog = [];
  }

  /**
   * Helper: check if a specific student index (0..62) is marked present
   */
  isStudentPresent(index) {
    if (index < 0 || index >= 64) return false;
    const mask = 1n << BigInt(index);
    return (this.attendanceBits & mask) !== 0n;
  }

  /**
   * Set attendance bits directly (e.g. restoring state or daily batch)
   */
  setAttendanceBits(bits) {
    this.attendanceBits = typeof bits === 'bigint' ? bits : BigInt(bits);
  }

  /**
   * Clears daily attendance bits back to 0 (daily reset)
   */
  clearAttendanceBits() {
    this.attendanceBits = 0n;
  }

  /**
   * Step the FSM by one clock cycle given input wires:
   * @param {Object} inputs
   * @param {boolean} inputs.reset
   * @param {boolean} inputs.scanValid
   * @param {number} inputs.captureId (0..63)
   * @param {number} inputs.hour (0..23)
   * @param {number} inputs.minute (0..59)
   * @param {number} inputs.second (0..59)
   */
  clockStep({ reset = false, scanValid = false, captureId = 0, hour = 8, minute = 0, second = 0 }) {
    this.cycleCount++;

    if (reset) {
      this.state = FSM_STATES.IDLE;
      this.id_r = 0;
      this.h_r = 0;
      this.m_r = 0;
      this.result = STATUS_CODES.S_NONE;
      this.statusCode = STATUS_CODES.S_NONE;
      this.statusValid = false;
      this.attendanceBits = 0n;
      return this.getStateSnapshot();
    }

    // Default: statusValid is a 1-cycle pulse
    this.statusValid = false;

    // Combinational checks based on registered values:
    const in_window = (this.h_r === 8) && (this.m_r <= 35);
    const id_ok = (this.id_r < 63);

    switch (this.state) {
      case FSM_STATES.IDLE:
        if (scanValid) {
          // Latch inputs into registers
          this.id_r = captureId & 0x3F; // 6 bits
          this.h_r = hour & 0x1F;       // 5 bits
          this.m_r = minute & 0x3F;     // 6 bits
          this.state = FSM_STATES.RECEIVE;
        }
        break;

      case FSM_STATES.RECEIVE:
        this.state = FSM_STATES.CHECK_TIME;
        break;

      case FSM_STATES.CHECK_TIME:
        if (in_window) {
          this.state = FSM_STATES.VERIFY;
        } else {
          this.result = STATUS_CODES.S_OUT_WINDOW;
          this.state = FSM_STATES.INVALID;
        }
        break;

      case FSM_STATES.VERIFY:
        if (id_ok) {
          this.state = FSM_STATES.CHECK_DUP;
        } else {
          this.result = STATUS_CODES.S_BAD_ID;
          this.state = FSM_STATES.INVALID;
        }
        break;

      case FSM_STATES.CHECK_DUP: {
        const isAlready = this.isStudentPresent(this.id_r);
        this.state = isAlready ? FSM_STATES.ALREADY_PRESENT : FSM_STATES.RECORD;
        break;
      }

      case FSM_STATES.RECORD:
        this.attendanceBits |= (1n << BigInt(this.id_r));
        this.result = STATUS_CODES.S_RECORDED;
        this.state = FSM_STATES.REPORT;
        break;

      case FSM_STATES.INVALID:
        this.state = FSM_STATES.REPORT;
        break;

      case FSM_STATES.ALREADY_PRESENT:
        this.result = STATUS_CODES.S_ALREADY;
        this.state = FSM_STATES.REPORT;
        break;

      case FSM_STATES.REPORT:
        this.statusCode = this.result;
        this.statusValid = true;
        this.state = FSM_STATES.IDLE;
        break;

      default:
        this.state = FSM_STATES.IDLE;
        break;
    }

    return this.getStateSnapshot();
  }

  /**
   * Helper that simulates the exact testbench `scan` task from `tb_attendance_controller.v`:
   * Pulses scanValid for 1 cycle, then clocks until statusValid is asserted, matching cycle counts.
   *
   * @param {number} captureId - student index (0..62 valid, 63 invalid)
   * @param {number} hour - hour value (e.g. 8)
   * @param {number} minute - minute value (e.g. 30)
   * @param {number} second - second value (e.g. 0)
   * @returns {{ statusCode: number, statusMessage: string, attendanceBits: bigint, cycles: number, stateHistory: Array<{state: number, name: string}> }}
   */
  scan(captureId, hour = 8, minute = 0, second = 0) {
    const stateHistory = [];
    let cycles = 0;

    // Cycle 1: Assert scanValid with inputs
    this.clockStep({
      reset: false,
      scanValid: true,
      captureId,
      hour,
      minute,
      second
    });
    cycles++;
    stateHistory.push({ cycle: cycles, state: this.state, name: FSM_STATE_NAMES[this.state] });

    // Subsequent cycles: Deassert scanValid and step until REPORT state produces statusValid
    const maxCycles = 20; // safety ceiling
    while (!this.statusValid && cycles < maxCycles) {
      this.clockStep({
        reset: false,
        scanValid: false,
        captureId,
        hour,
        minute,
        second
      });
      cycles++;
      stateHistory.push({ cycle: cycles, state: this.state, name: FSM_STATE_NAMES[this.state] });
    }

    return {
      statusCode: this.statusCode,
      statusMessage: STATUS_MESSAGES[this.statusCode],
      attendanceBits: this.attendanceBits,
      cycles,
      stateHistory
    };
  }

  /**
   * Get an immutable snapshot of all FSM registers and wires.
   */
  getStateSnapshot() {
    return {
      state: this.state,
      stateName: FSM_STATE_NAMES[this.state],
      id_r: this.id_r,
      h_r: this.h_r,
      m_r: this.m_r,
      result: this.result,
      statusCode: this.statusCode,
      statusValid: this.statusValid,
      attendanceBits: this.attendanceBits,
      attendanceHex: '0x' + this.attendanceBits.toString(16).padStart(16, '0')
    };
  }
}
