import { AttendanceFSM, FSM_STATES, STATUS_CODES, STATUS_MESSAGES } from '../logic/attendanceFSM.js';
import { FirestoreService, isCloudSyncReady } from '../firebase/firestoreService.js';
import { isFirebaseConfigured } from '../firebase/config.js';
import { serialService } from './serialService.js';
import { D, toSec, hms, t12, pctText } from '../reports/reportGenerator.js';

const STORAGE_KEY = 'attendedge.app.v1';

const FIRST_NAMES = ['Anika', 'Rohan', 'Meera', 'Kabir', 'Isha', 'Dev', 'Tara', 'Neel', 'Zoya'];
const LAST_NAMES = ['Verma', 'Nair', 'Iyer', 'Menon', 'Kulkarni', 'Bose', 'Rao'];

function hash32(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function rnd(seed) {
  let t = (seed + 0x6D2B79F5) >>> 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

export class AttendanceService {
  constructor() {
    this.fsm = new AttendanceFSM();
    this.state = null;
    this.listeners = new Set();
    this.init();
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  notify() {
    this.listeners.forEach(fn => fn(this.state));
  }

  getTodayString() {
    const tz = (this.state && this.state.settings && this.state.settings.timezone) || 'Asia/Kolkata';
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).formatToParts(new Date());
    const g = t => parts.find(p => p.type === t).value;
    return `${g('year')}-${g('month')}-${g('day')}`;
  }

  getRealNow() {
    const tz = (this.state && this.state.settings && this.state.settings.timezone) || 'Asia/Kolkata';
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23'
    }).formatToParts(new Date());
    const g = t => parts.find(p => p.type === t).value;
    const h = g('hour') === '24' ? '00' : g('hour');
    return {
      date: `${g('year')}-${g('month')}-${g('day')}`,
      time: `${h}:${g('minute')}:${g('second')}`
    };
  }

  getClockNow() {
    const r = this.getRealNow();
    if (!this.state || !this.state.ui || this.state.ui.clock.mode === 'real') {
      return r;
    }
    return { date: r.date, time: this.state.ui.clock.time };
  }

  createDefaultSettings() {
    const today = this.getTodayString();
    const y = +today.slice(0, 4);
    const m = +today.slice(5, 7);
    const isSecondHalf = m >= 7;
    const start = D.firstMonday(isSecondHalf ? `${y}-08-01` : `${y}-01-01`);

    return {
      department: 'Electronics Engineering',
      classSection: 'Section A',
      semester: isSecondHalf ? '3' : '4',
      academicYear: isSecondHalf ? `${y}-${String((y + 1) % 100).padStart(2, '0')}` : `${y - 1}-${String(y % 100).padStart(2, '0')}`,
      timezone: 'Asia/Kolkata',
      workingWeekdays: [1, 2, 3, 4, 5],
      holidays: isSecondHalf
        ? [
            { date: `${y}-08-26`, label: 'Sample holiday' },
            { date: `${y}-10-02`, label: 'Gandhi Jayanti' },
            { date: `${y}-10-20`, label: 'Sample holiday' }
          ]
        : [{ date: `${y}-03-04`, label: 'Sample holiday' }],
      // Matches the hardware FSM window: 08:00 - 08:35
      openingTime: '08:00',
      closingTime: '08:35',
      threshold: 75,
      retentionYears: 2,
      semesterStart: start,
      semesterEnd: D.add(start, 125)
    };
  }

  generateStudents(settings) {
    const students = [];
    // Exactly 63 students corresponding to 0..62 index in FPGA controller
    for (let i = 1; i <= 63; i++) {
      const idx = i - 1;
      const fn = FIRST_NAMES[(i - 1) % 9];
      const ln = LAST_NAMES[(i - 1) % 7];
      const rollNumber = `25EV${String(i).padStart(3, '0')}`;
      const residence = rnd(hash32('res' + rollNumber)) < 0.4 ? 'Hosteller' : 'Day Scholar';

      students.push({
        id: `stu-${String(i).padStart(2, '0')}`,
        index: idx, // 0..62
        rollNumber,
        name: `${fn} ${ln}`,
        email: `${fn}.${ln}.${String(i).padStart(2, '0')}@example.edu`.toLowerCase(),
        department: settings.department,
        classSection: settings.classSection,
        semester: settings.semester,
        residence,
        placeholder: true
      });
    }
    return students;
  }

  init() {
    let saved = null;
    try {
      if (typeof localStorage !== 'undefined' && typeof localStorage.getItem === 'function') {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw) saved = JSON.parse(raw);
      }
    } catch (e) {
      console.warn('Storage read error:', e);
    }

    if (saved && saved.version === 2 && Array.isArray(saved.students) && saved.students.length > 0) {
      this.state = saved;
    } else {
      const settings = this.createDefaultSettings();
      const students = this.generateStudents(settings);
      this.state = {
        version: 2,
        settings,
        students,
        sessions: {},
        records: {},
        events: [],
        ui: {
          selDate: this.getTodayString(),
          clock: { mode: 'sim', time: '08:10:00' }
        }
      };
      this.seedPastHistory();
      this.saveLocal();
    }

    // Sync FSM attendance register for today's records
    this.syncFsmWithRecords(this.state.ui.selDate);

    // Try background sync with Firestore if configured
    this.syncWithFirestore();
  }

  saveLocal() {
    try {
      if (typeof localStorage !== 'undefined' && typeof localStorage.setItem === 'function') {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(this.state));
      }
    } catch (e) {
      console.warn('LocalStorage save error:', e);
    }
    this.notify();
  }

  async syncWithFirestore() {
    if (!isCloudSyncReady()) return;
    try {
      const remoteSettings = await FirestoreService.getSettings();
      if (remoteSettings) {
        Object.assign(this.state.settings, remoteSettings);
      }

      const remoteStudents = await FirestoreService.getStudents();
      if (Array.isArray(remoteStudents) && remoteStudents.length > 0) {
        const studentMap = new Map(this.state.students.map(st => [st.rollNumber, st]));
        for (const rs of remoteStudents) {
          const cleanRoll = String(rs.rollNumber || rs.id || '').trim().toUpperCase();
          if (cleanRoll) {
            const existing = studentMap.get(cleanRoll);
            if (existing) {
              studentMap.set(cleanRoll, { ...existing, ...rs, rollNumber: cleanRoll, placeholder: false });
            } else {
              studentMap.set(cleanRoll, { ...rs, rollNumber: cleanRoll, placeholder: false });
            }
          }
        }
        this.state.students = Array.from(studentMap.values());
      }

      const today = this.getTodayString();
      const remoteRecords = await FirestoreService.getRecordsForDate(today);
      if (remoteRecords) {
        this.state.records[today] = remoteRecords;
        this.syncFsmWithRecords(today);
      }

      this.saveLocal();
    } catch (e) {
      console.warn('[AttendEdge] Firestore initial sync skipped/failed:', e.message);
    }
  }

  syncFsmWithRecords(date) {
    this.fsm.clearAttendanceBits();
    const dayRecords = this.state.records[date] || {};
    let bits = 0n;
    this.state.students.forEach(s => {
      if (dayRecords[s.rollNumber]) {
        bits |= (1n << BigInt(s.index));
      }
    });
    this.fsm.setAttendanceBits(bits);
  }

  seedPastHistory() {
    const today = this.getTodayString();
    const yesterday = D.add(today, -1);
    const end = yesterday < this.state.settings.semesterEnd ? yesterday : this.state.settings.semesterEnd;
    const days = D.range(this.state.settings.semesterStart, end);

    days.forEach(d => {
      if (this.isWorkingDay(d) && !this.state.sessions[d]) {
        const open = toSec(this.state.settings.openingTime);
        const close = toSec(this.state.settings.closingTime);
        const rec = {};

        this.state.students.forEach(s => {
          const prob = 0.64 + 0.35 * Math.sqrt(rnd(hash32('base' + s.rollNumber)));
          if (rnd(hash32(s.rollNumber + d + 'p')) < prob) {
            const r = rnd(hash32(s.rollNumber + d + 't'));
            rec[s.rollNumber] = {
              t: hms(open + 5 + Math.floor(Math.pow(r, 1.5) * Math.max(10, close - open - 40))),
              src: 'seed'
            };
          }
        });

        this.state.records[d] = rec;
        this.state.sessions[d] = {
          id: 'ses-' + d,
          date: d,
          openingTime: this.state.settings.openingTime,
          closingTime: this.state.settings.closingTime,
          sessionStatus: 'Closed'
        };
      }
    });
  }

  isWorkingDay(date) {
    const dow = D.dow(date);
    const isHoliday = this.state.settings.holidays.some(h => h.date === date);
    return this.state.settings.workingWeekdays.includes(dow) && !isHoliday;
  }

  getSessionInfo(date) {
    const now = this.getClockNow();
    const times = {
      open: this.state.settings.openingTime,
      close: this.state.settings.closingTime
    };

    if (this.state.sessions && this.state.sessions[date] && this.state.sessions[date].sessionStatus) {
      const status = String(this.state.sessions[date].sessionStatus).toLowerCase();
      if (status === 'closed') {
        return { key: 'closed', label: 'Closed', reason: 'Session closed by faculty', times };
      }
      if (status === 'open' && date === now.date) {
        return { key: 'open', label: 'Open', reason: 'Session active', times };
      }
    }

    if (!this.isWorkingDay(date)) {
      const holiday = this.state.settings.holidays.find(h => h.date === date);
      return {
        key: 'nonworking',
        label: 'No session',
        reason: holiday ? `${holiday.label} (holiday)` : `${D.dayName(date)} is not an official working day`,
        times
      };
    }

    if (date < now.date) {
      return { key: 'closed', label: 'Closed', reason: 'Session finished', times };
    }
    if (date > now.date) {
      return { key: 'notstarted', label: 'Not Started', reason: 'Upcoming working day', times };
    }

    // Today's window evaluation (open <= time <= close)
    const curSec = toSec(now.time);
    const openSec = toSec(times.open);
    const closeSec = toSec(times.close);

    if (curSec < openSec) {
      return { key: 'notstarted', label: 'Not Started', reason: `Scanning opens at ${t12(times.open)}`, times };
    }
    if (curSec <= closeSec) {
      return { key: 'open', label: 'Open', reason: `Accepting attendance until ${t12(times.close)}`, times };
    }
    return { key: 'closed', label: 'Closed', reason: `Scanning ended at ${t12(times.close)}`, times };
  }

  isSessionCompleted(date) {
    const now = this.getClockNow();
    if (date < now.date) return true;
    if (date > now.date) return false;
    return this.getSessionInfo(date).key === 'closed';
  }

  /**
   * Scan barcode / roll number using actual FSM logic
   * Persists atomically to Firestore when connected, or local memory when in Demo Mode.
   */
  async scanBarcode(rawInput) {
    const raw = String(rawInput || '').trim().toUpperCase();
    const clock = this.getClockNow();
    const [h, m, s] = clock.time.split(':').map(Number);
    const stu = this.state.students.find(st => st.rollNumber === raw);

    // Check if session for date is closed
    const sessionInfo = this.getSessionInfo(clock.date);
    const sessionDoc = this.state.sessions && this.state.sessions[clock.date];
    const isManuallyClosed = sessionDoc && sessionDoc.sessionStatus && String(sessionDoc.sessionStatus).toLowerCase() === 'closed';

    if (isManuallyClosed || sessionInfo.key === 'closed') {
      const reason = isManuallyClosed ? 'Session closed by faculty' : (sessionInfo.reason || 'Session closed');
      const msg = `Session Closed: Attendance session for ${clock.date} is closed (${reason}). New scans cannot be recorded.`;
      const event = {
        id: 'evt-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
        date: clock.date,
        time: clock.time,
        roll: raw || '-',
        state: 'closed',
        statusCode: STATUS_CODES.S_OUT_WINDOW,
        message: msg,
        isHardware: serialService.status === 'connected'
      };
      this.state.events.unshift(event);
      if (this.state.events.length > 100) this.state.events.pop();
      this.saveLocal();
      return {
        roll: raw,
        student: stu,
        state: 'closed',
        statusCode: STATUS_CODES.S_OUT_WINDOW,
        message: msg,
        error: 'SESSION_CLOSED'
      };
    }

    // Convert student to 6-bit FPGA capture_id (0..62, or 63 for invalid/unregistered)
    const captureId = stu ? stu.index : 63;

    // Run the actual 9-state Verilog FSM reproduction!
    // Sync current attendance register into FSM first
    this.syncFsmWithRecords(clock.date);
    const fsmResult = this.fsm.scan(captureId, h, m, s);

    let stateKey = 'ready';
    let message = fsmResult.statusMessage;

    if (fsmResult.statusCode === STATUS_CODES.S_RECORDED) {
      stateKey = 'present';
      const recordEntry = {
        t: clock.time,
        src: serialService.status === 'connected' ? 'fpga_uart' : 'sim_fsm',
        ev: {
          captureId,
          fsmCycles: fsmResult.cycles,
          statusCode: fsmResult.statusCode,
          timestamp: new Date().toISOString()
        }
      };

      // 1. Production Mode: Persist via Trusted Cloud Function
      if (isCloudSyncReady()) {
        try {
          const cloudRes = await FirestoreService.recordAttendanceCloud({
            rollNumber: raw,
            captureId,
            source: serialService.status === 'connected' ? 'fpga_uart' : 'web_fsm',
            date: clock.date,
            time: clock.time
          });

          if (!cloudRes || !cloudRes.success) {
            throw new Error((cloudRes && cloudRes.message) || 'Attendance rejected by Cloud Function.');
          }

          // Update local state only after successful cloud confirmation
          this.state.records[clock.date] = this.state.records[clock.date] || {};
          this.state.records[clock.date][raw] = recordEntry;

          this.state.sessions[clock.date] = this.state.sessions[clock.date] || {
            id: 'ses-' + clock.date,
            date: clock.date,
            openingTime: this.state.settings.openingTime,
            closingTime: this.state.settings.closingTime,
            sessionStatus: 'Open'
          };
          await FirestoreService.saveSession(clock.date, this.state.sessions[clock.date]);

          this.syncFsmWithRecords(clock.date);
          message = `Present Recorded: ${stu.name} (${raw}, ${stu.residence}) at ${t12(clock.time)}. Verified by trusted Cloud Function.`;
        } catch (cloudErr) {
          console.error('[AttendEdge] Cloud recordAttendance error:', cloudErr);
          // Rollback and DO NOT silently claim success
          this.syncFsmWithRecords(clock.date);

          let stateKey = 'error';
          if (cloudErr.statusCode === STATUS_CODES.S_ALREADY || cloudErr.message?.includes('Already')) {
            stateKey = 'duplicate';
          } else if (cloudErr.statusCode === STATUS_CODES.S_OUT_WINDOW || cloudErr.message?.includes('Window') || cloudErr.message?.includes('Closed')) {
            stateKey = 'closed';
          } else if (cloudErr.statusCode === STATUS_CODES.S_BAD_ID || cloudErr.message?.includes('Invalid ID')) {
            stateKey = 'invalid';
          }

          const errorCode = cloudErr.code || cloudErr.rawCode || 'functions/unknown';
          const rawMsg = cloudErr.message || 'Internal Cloud Rejection';
          const safeMessage = rawMsg.endsWith('.') ? rawMsg : `${rawMsg}.`;
          const failureMsg = `Cloud Rejection (${errorCode}): ${safeMessage} Record was NOT saved.`;
          const failEvent = {
            id: 'evt-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
            date: clock.date,
            time: clock.time,
            roll: raw || '—',
            state: stateKey,
            statusCode: cloudErr.statusCode || STATUS_CODES.S_NONE,
            errorCode,
            message: failureMsg,
            isHardware: serialService.status === 'connected'
          };
          this.state.events.unshift(failEvent);
          if (this.state.events.length > 100) this.state.events.pop();
          this.saveLocal();

          return {
            roll: raw,
            student: stu,
            state: stateKey,
            statusCode: cloudErr.statusCode || STATUS_CODES.S_NONE,
            errorCode,
            message: failureMsg,
            error: failureMsg,
            fsmResult
          };
        }
      } else {
        // 2. Local Demo Mode
        this.state.records[clock.date] = this.state.records[clock.date] || {};
        this.state.records[clock.date][raw] = recordEntry;

        this.state.sessions[clock.date] = this.state.sessions[clock.date] || {
          id: 'ses-' + clock.date,
          date: clock.date,
          openingTime: this.state.settings.openingTime,
          closingTime: this.state.settings.closingTime,
          sessionStatus: 'Open'
        };

        this.syncFsmWithRecords(clock.date);
        message = `Present Recorded (Demo): ${stu.name} (${raw}, ${stu.residence}) at ${t12(clock.time)}. Flip-flop bit ${captureId} -> 1.`;
      }
    } else if (fsmResult.statusCode === STATUS_CODES.S_ALREADY) {
      stateKey = 'duplicate';
      message = `Already Present: ${stu ? stu.name : raw} (${raw}) was recorded earlier. Duplicate scan rejected by FSM state CHECK_DUP.`;
    } else if (fsmResult.statusCode === STATUS_CODES.S_BAD_ID) {
      stateKey = 'invalid';
      message = `Invalid ID: ${raw || '(empty)'} is not in the valid 63-student FPGA register range (0..62).`;
    } else if (fsmResult.statusCode === STATUS_CODES.S_OUT_WINDOW) {
      stateKey = 'closed';
      message = `Outside Window: Current time ${t12(clock.time)} is outside the active 08:00–08:35 window.`;
    }

    const event = {
      id: 'evt-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
      date: clock.date,
      time: clock.time,
      roll: raw || '—',
      state: stateKey,
      statusCode: fsmResult.statusCode,
      message,
      isHardware: serialService.status === 'connected'
    };

    this.state.events.unshift(event);
    if (this.state.events.length > 100) this.state.events.pop();

    if (isCloudSyncReady()) {
      FirestoreService.logEvent(event).catch(() => {});
    }
    this.saveLocal();

    return {
      roll: raw,
      student: stu,
      state: stateKey,
      statusCode: fsmResult.statusCode,
      message,
      fsmResult
    };
  }

  async addStudent(student) {
    const cleanRoll = String(student.rollNumber || '').trim().toUpperCase();
    if (!cleanRoll) throw new Error('Roll number is required.');
    if (this.state.students.some(s => s.rollNumber === cleanRoll)) {
      throw new Error(`Student ${cleanRoll} already exists in roster.`);
    }

    const nextIndex = student.index ?? this.state.students.length;
    const newStudent = {
      ...student,
      rollNumber: cleanRoll,
      index: nextIndex,
      placeholder: false
    };

    if (isCloudSyncReady()) {
      await FirestoreService.addStudent(newStudent);
    }

    this.state.students.push(newStudent);
    this.saveLocal();
    return newStudent;
  }

  async updateStudent(rollNumber, patch) {
    const cleanRoll = String(rollNumber || '').trim().toUpperCase();
    const s = this.getStudent(cleanRoll);
    if (!s) throw new Error(`Student ${cleanRoll} not found.`);

    let cloudRes = null;
    if (isCloudSyncReady()) {
      cloudRes = await FirestoreService.updateStudent(cleanRoll, patch, s);
    }

    Object.assign(s, patch, { placeholder: false });
    if (cloudRes) s._cloud = cloudRes;
    this.saveLocal();
    return s;
  }

  async removeStudent(rollNumber) {
    const cleanRoll = String(rollNumber || '').trim().toUpperCase();
    const idx = this.state.students.findIndex(s => s.rollNumber === cleanRoll);
    if (idx === -1) throw new Error(`Student ${cleanRoll} not found.`);

    if (isCloudSyncReady()) {
      await FirestoreService.removeStudent(cleanRoll);
    }

    this.state.students.splice(idx, 1);
    this.saveLocal();
    return true;
  }

  async openSession(date) {
    const meta = {
      openingTime: this.state.settings.openingTime,
      closingTime: this.state.settings.closingTime
    };
    if (isCloudSyncReady()) {
      await FirestoreService.openSession(date, meta);
    }
    this.state.sessions[date] = {
      id: 'ses-' + date,
      date,
      sessionStatus: 'Open',
      ...meta
    };
    this.saveLocal();
  }

  async closeSession(date) {
    if (isCloudSyncReady()) {
      await FirestoreService.closeSession(date);
    }
    if (this.state.sessions[date]) {
      this.state.sessions[date].sessionStatus = 'Closed';
    } else {
      this.state.sessions[date] = {
        id: 'ses-' + date,
        date,
        sessionStatus: 'Closed',
        openingTime: this.state.settings.openingTime,
        closingTime: this.state.settings.closingTime
      };
    }
    this.saveLocal();
    this.notify();
  }

  resetDay(date) {
    const today = this.getTodayString();
    if (date < today) {
      return { ok: false, reason: 'Historical records are protected and cannot be reset.' };
    }
    const day = this.state.records[date] || {};
    const count = Object.keys(day).length;
    delete this.state.records[date];
    this.syncFsmWithRecords(date);

    this.state.events.unshift({
      id: 'evt-' + Date.now().toString(36),
      date,
      time: this.getClockNow().time,
      roll: '—',
      state: 'reset',
      message: `Day ${date} reset: ${count} attendance record(s) cleared. 64-bit register reset to 0.`
    });

    this.saveLocal();
    return { ok: true, removed: count };
  }

  resetAllData() {
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch (e) {}
    this.init();
    this.notify();
  }

  getStudent(rollNumber) {
    return this.state.students.find(s => s.rollNumber === rollNumber);
  }

  async saveSettings(patch) {
    Object.assign(this.state.settings, patch);
    this.seedPastHistory();
    this.saveLocal();
    if (isCloudSyncReady()) {
      await FirestoreService.saveSettings(this.state.settings);
    }
  }

  getRecordsOn(date) {
    return this.state.records[date] || {};
  }

  getPresentCount(date) {
    return Object.keys(this.getRecordsOn(date)).length;
  }

  /**
   * Analytics and Calculation
   */
  getCountedDays(start, end) {
    return D.range(start, end).filter(d => this.isWorkingDay(d) && this.isSessionCompleted(d));
  }

  getScheduledDays(start, end) {
    return D.range(start, end).filter(d => this.isWorkingDay(d));
  }

  getClassStats(start, end) {
    const days = this.getCountedDays(start, end);
    const map = {};

    this.state.students.forEach(s => {
      let p = 0;
      days.forEach(d => {
        if (this.getRecordsOn(d)[s.rollNumber]) p++;
      });
      map[s.rollNumber] = {
        working: days.length,
        present: p,
        absent: days.length - p,
        pct: days.length ? (p / days.length) * 100 : null
      };
    });

    return { days, map };
  }

  summarizeStats(map) {
    const v = Object.values(map).filter(x => x.pct !== null);
    if (!v.length) return { avg: null, below: 0, above: 0 };
    return {
      avg: v.reduce((a, x) => a + x.pct, 0) / v.length,
      below: v.filter(x => x.pct < this.state.settings.threshold).length,
      above: v.filter(x => x.pct >= this.state.settings.threshold).length
    };
  }
}

export const attendanceService = new AttendanceService();
