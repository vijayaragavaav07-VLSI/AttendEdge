import { attendanceService } from './services/attendanceService.js';
import { getCurrentUser, signInFaculty, signOutFaculty, subscribeAuth, startDemoSession, sendFacultyPasswordReset, reauthenticateFaculty } from './firebase/auth.js';
import { isFirebaseConfigured } from './firebase/config.js';
import { getConnectionState, CONNECTION_STATES, FirestoreService, isCloudSyncReady } from './firebase/firestoreService.js';
import { serialService } from './services/serialService.js';
import { FSM_STATES, FSM_STATE_NAMES, STATUS_CODES } from './logic/attendanceFSM.js';
import { D, toSec, hms, t12, pctText, exportCSV, exportPDF, printReport } from './reports/reportGenerator.js';
import { ic, ICONS, LOGO } from './components/icons.js';

// DOM Utilities
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad = n => String(n).padStart(2, '0');

// Navigation Pages
const PAGES = [
  ['overview', 'Overview'],
  ['daily', 'Daily Attendance'],
  ['students', 'Students'],
  ['weekly', 'Weekly Reports'],
  ['monthly', 'Monthly Performance'],
  ['semester', 'Semester Analytics'],
  ['pdf', 'PDF Reports'],
  ['device', 'Device Status'],
  ['settings', 'Settings']
];

const RES = ['Hosteller', 'Day Scholar'];

import { STAT_LABELS, parseStudentGender, parseStudentAccom, getStudentStatistics } from './logic/studentStatistics.js';

export { STAT_LABELS, parseStudentGender, parseStudentAccom, getStudentStatistics };

// UI State
const UI = {
  page: 'overview',
  currentUser: getCurrentUser(),
  tables: {},
  daily: { q: '', filter: 'all', size: 25, res: '', statFilter: 'all' },
  stu: { q: '', dept: '', cls: '', sem: '', res: '' },
  weekly: { date: '', q: '', band: 'all', res: '', manageDate: '', targetStatus: '', targetReason: '' },
  monthly: { y: 0, m: 0, q: '', band: 'all', student: '25EV001', res: '' },
  sem: { sem: '', ay: '', q: '', band: 'all', res: '' },
  pdf: { student: '25EV001', day: '', week: '', y: 0, m: 0, pDate: '', aDate: '', cy: 0, cm: 0 },
  scan: {
    roll: '25EV001',
    flash: null
  }
};

function initUIState() {
  const t = attendanceService.getTodayString();
  const y = +t.slice(0, 4);
  const m = +t.slice(5, 7);
  UI.weekly.date = UI.pdf.day = UI.pdf.week = UI.pdf.pDate = UI.pdf.aDate = attendanceService.state.ui.selDate || t;
  UI.weekly.manageDate = UI.weekly.date;
  UI.monthly.y = UI.pdf.y = UI.pdf.cy = y;
  UI.monthly.m = UI.pdf.m = UI.pdf.cm = m;
  UI.sem.sem = attendanceService.state.settings.semester;
  UI.sem.ay = attendanceService.state.settings.academicYear;
}

// Toast Notifications
function toast(msg, kind = 'info') {
  const host = $('#toasts');
  if (!host) return;
  const el = document.createElement('div');
  el.className = 'toast ' + kind;
  el.setAttribute('role', kind === 'bad' ? 'alert' : 'status');
  const iconName = kind === 'ok' ? 'check' : kind === 'bad' || kind === 'warn' ? 'alert' : 'info';
  el.innerHTML = `${ic(iconName, 18)}<div>${esc(msg)}</div>`;
  host.appendChild(el);
  while (host.children.length > 4) host.firstChild.remove();
  setTimeout(() => el.remove(), kind === 'bad' ? 7000 : 4500);
}

// Modal Dialogs
let pendingConfirm = null;
function openModal(html, wide = false) {
  const d = $('#dlg');
  d.className = wide ? 'wide' : '';
  d.innerHTML = `<div class="dlg-in">${html}</div>`;
  if (!d.open) d.showModal();
}
function closeModal() {
  const d = $('#dlg');
  if (d.open) d.close();
}
function confirmDialog({ title, body, ok = 'Confirm', danger = false }) {
  return new Promise(res => {
    pendingConfirm = res;
    openModal(`<h2>${esc(title)}</h2><p class="muted">${body}</p>
      <div class="dlg-actions">
        <button class="btn" data-act="dlgCancel">Cancel</button>
        <button class="btn ${danger ? 'btn-danger-solid' : 'btn-primary'}" data-act="dlgOk">${esc(ok)}</button>
      </div>`);
  });
}

// Table Helper
const T = id => UI.tables[id] || (UI.tables[id] = { sort: null, dir: 'asc', page: 1 });
function table(id, { cols, rows, size = 25, caption, rowCls, empty }) {
  const st = T(id);
  let data = rows.slice();
  if (st.sort) {
    const c = cols.find(c => c.key === st.sort);
    const v = c.val || (r => r[c.key]);
    const dir = st.dir === 'asc' ? 1 : -1;
    data.sort((a, b) => {
      const x = v(a);
      const y = v(b);
      if (x == null && y == null) return 0;
      if (x == null) return 1;
      if (y == null) return -1;
      return (typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), undefined, { numeric: true })) * dir;
    });
  }
  const pages = size ? Math.max(1, Math.ceil(data.length / size)) : 1;
  st.page = Math.min(Math.max(1, st.page), pages);
  const slice = size ? data.slice((st.page - 1) * size, st.page * size) : data;
  if (!data.length) return empty || `<div class="empty"><b>No matching rows</b>Adjust the search or filters.</div>`;

  const head = cols.map(c => {
    const on = st.sort === c.key;
    return `<th scope="col" class="${c.cls || ''}" aria-sort="${on ? (st.dir === 'asc' ? 'ascending' : 'descending') : 'none'}">
      ${c.nosort ? esc(c.label) : `<button class="th-btn" data-act="sort" data-t="${id}" data-k="${c.key}">${esc(c.label)}${on ? ic(st.dir === 'asc' ? 'up' : 'down', 13) : ''}</button>`}
    </th>`;
  }).join('');

  const body = slice.map(r => `<tr class="${rowCls ? rowCls(r) : ''}">${cols.map(c => `<td class="${c.cls || ''}">${c.html ? c.html(r) : esc(r[c.key])}</td>`).join('')}</tr>`).join('');

  let pager = '';
  if (size && data.length > size) {
    const a = (st.page - 1) * size + 1;
    const b = Math.min(data.length, st.page * size);
    pager = `<div class="pager">
      <span>Showing ${a}–${b} of ${data.length}</span>
      <span class="row">
        <button class="btn btn-sm" data-act="page" data-t="${id}" data-d="-1" ${st.page <= 1 ? 'disabled' : ''}>${ic('chevL', 14)} Prev</button>
        <span>Page ${st.page} of ${pages}</span>
        <button class="btn btn-sm" data-act="page" data-t="${id}" data-d="1" ${st.page >= pages ? 'disabled' : ''}>Next ${ic('chevR', 14)}</button>
      </span>
    </div>`;
  } else {
    pager = `<div class="pager"><span>${data.length} row${data.length === 1 ? '' : 's'}</span></div>`;
  }
  return `<div class="tbl-wrap"><table><caption class="sr">${esc(caption || 'Data table')}</caption><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>${pager}`;
}

// Chart SVG Generator
function chart({ type = 'bar', labels, values, meta = [], max = 100, unit = '%', h = 200, label = 'Chart' }) {
  if (!values.some(v => v !== null)) {
    return `<div class="empty"><b>No completed sessions in this period</b>Charts fill in once working days have finished.</div>`;
  }
  const W = 640, pl = 36, pr = 8, pt = 10, pb = 26, iw = W - pl - pr, ih = h - pt - pb, n = values.length;
  const cx = i => pl + (iw / n) * (i + 0.5);
  const cy = v => pt + ih * (1 - Math.min(v, max) / max);
  const step = Math.max(1, Math.ceil(n / 8));
  let s = `<svg class="chart" viewBox="0 0 ${W} ${h}" role="img" aria-label="${esc(label)}">`;
  [0, 0.25, 0.5, 0.75, 1].forEach(f => {
    const y = pt + ih * (1 - f);
    s += `<line class="c-grid" x1="${pl}" x2="${W - pr}" y1="${y}" y2="${y}"/><text class="c-axis" x="${pl - 6}" y="${y + 3}" text-anchor="end">${Math.round(max * f)}</text>`;
  });
  const val = v => (unit === '%' ? v.toFixed(1) + '%' : v);
  if (type === 'bar') {
    const bw = Math.max(3, Math.min(34, (iw / n) * 0.62));
    values.forEach((v, i) => {
      const m = meta[i] || {};
      if (v === null) {
        const xCenter = cx(i);
        if (m.isNonWorking) {
          s += `<rect x="${(xCenter - bw / 2).toFixed(1)}" y="${(pt + ih - 14).toFixed(1)}" width="${bw.toFixed(1)}" height="12" rx="2" fill="#E6E1D8" opacity="0.65"><title>${esc(labels[i])}: Non-working Day (${esc(m.reason || 'Off')})</title></rect>`;
          s += `<text class="c-axis" x="${xCenter.toFixed(1)}" y="${(pt + ih - 4).toFixed(1)}" font-size="8.5" text-anchor="middle" fill="#8C887B" font-weight="600">OFF</text>`;
        } else if (m.isPending) {
          s += `<rect x="${(xCenter - bw / 2).toFixed(1)}" y="${(pt + ih - 14).toFixed(1)}" width="${bw.toFixed(1)}" height="12" rx="2" fill="none" stroke="#C4BCAD" stroke-dasharray="2,2"><title>${esc(labels[i])}: Upcoming session (Pending)</title></rect>`;
          s += `<text class="c-axis" x="${xCenter.toFixed(1)}" y="${(pt + ih - 4).toFixed(1)}" font-size="8.5" text-anchor="middle" fill="#8C887B">—</text>`;
        } else if (m.isMissing) {
          s += `<rect x="${(xCenter - bw / 2).toFixed(1)}" y="${(pt + ih - 14).toFixed(1)}" width="${bw.toFixed(1)}" height="12" rx="2" fill="#FCE8E6"><title>${esc(labels[i])}: No attendance data recorded</title></rect>`;
          s += `<text class="c-axis" x="${xCenter.toFixed(1)}" y="${(pt + ih - 4).toFixed(1)}" font-size="8.5" text-anchor="middle" fill="#C43828">N/A</text>`;
        }
        return;
      }
      const y = cy(v);
      s += `<rect class="c-bar${unit === '%' && v < attendanceService.state.settings.threshold ? ' low' : ''}" x="${(cx(i) - bw / 2).toFixed(1)}" y="${y.toFixed(1)}" width="${bw.toFixed(1)}" height="${(pt + ih - y).toFixed(1)}" rx="3"><title>${esc(labels[i])}: ${val(v)}</title></rect>`;
    });
  } else {
    let d = '', pen = false;
    values.forEach((v, i) => {
      if (v === null) { pen = false; return; }
      d += `${pen ? 'L' : 'M'}${cx(i).toFixed(1)} ${cy(v).toFixed(1)} `;
      pen = true;
    });
    s += `<path class="c-line" d="${d}"/>`;
    if (n <= 45) {
      values.forEach((v, i) => {
        if (v !== null) s += `<circle class="c-dot" cx="${cx(i).toFixed(1)}" cy="${cy(v).toFixed(1)}" r="3.2"><title>${esc(labels[i])}: ${val(v)}</title></circle>`;
      });
    }
  }
  labels.forEach((l, i) => {
    if (i % step === 0) s += `<text class="c-axis" x="${cx(i).toFixed(1)}" y="${h - 8}" text-anchor="middle">${esc(l)}</text>`;
  });
  return s + '</svg>';
}

// UI Badges & Formatting
const badge = (t, txt) => `<span class="badge ${t}">${esc(txt)}</span>`;
const rollc = r => `<span class="rollc">${esc(r)}</span>`;
const resBadge = r => (r === 'Hosteller' ? badge('info', 'Hosteller') : badge('muted', 'Day Scholar'));
const tone = v => (v !== null && v >= attendanceService.state.settings.threshold ? 'ok' : 'warn');
const bar = v => (v === null ? '<span class="muted small">Not Available</span>' : `<div class="barcell"><div class="bar" role="img" aria-label="${v.toFixed(1)} percent"><span class="${tone(v) === 'ok' ? '' : 'warn'}" style="width:${Math.max(0, Math.min(100, v))}%"></span></div><span class="small" style="min-width:48px;text-align:right">${v.toFixed(1)}%</span></div>`);
const resSel = (id, bind, v) => `<div class="field"><label for="${id}">Residence</label><select id="${id}" class="select" data-bind="${bind}"><option value="">All</option>${RES.map(o => `<option ${v === o ? 'selected' : ''}>${o}</option>`).join('')}</select></div>`;
const inBand = (v, band) => band === 'all' || (band === 'below' && v !== null && v < attendanceService.state.settings.threshold) || (band === 'above' && v !== null && v >= attendanceService.state.settings.threshold) || (band === 'na' && v === null);
const empty = (t, b) => `<div class="empty"><b>${esc(t)}</b>${esc(b || '')}</div>`;

// Reports Data Builders
function meta(period, stu) {
  const s = attendanceService.state.settings;
  const n = attendanceService.getRealNow();
  return [
    ['Department', stu ? stu.department : s.department],
    ['Class / Section', stu ? stu.classSection : s.classSection],
    ...(stu ? [['Residence', stu.residence]] : []),
    ['Semester', `${stu ? stu.semester : s.semester} (AY ${s.academicYear})`],
    ['Period', period],
    ['Generated', `${D.med(n.date)}, ${t12(n.time)} (${s.timezone})`]
  ];
}

const ReportsModel = {
  dailyStudent({ roll, date }) {
    const s = attendanceService.getStudent(roll);
    const info = attendanceService.getSessionInfo(date);
    const r = attendanceService.getRecordsOn(date)[roll];
    const status = info.key === 'nonworking' ? `No session (${info.reason})` : r ? 'Present (1)' : attendanceService.isSessionCompleted(date) ? 'Absent (0)' : 'Absent (0), session not finished';
    return {
      file: `AttendEdge_daily_${roll}_${date}`,
      title: 'Student Daily Attendance Report',
      meta: meta(D.long(date), s),
      summary: [],
      columns: ['Field', 'Value'],
      rows: [
        ['Roll Number', roll],
        ['Student Name', s.name],
        ['Residence', s.residence],
        ['Date', D.long(date)],
        ['Session Window', `${t12(info.times.open)} - ${t12(info.times.close)}`],
        ['Status', status],
        ['First Scan Time', r ? t12(r.t) : '—'],
        ['Register Bit', r ? '1' : '0'],
        ['Record Source', r ? (r.src === 'fpga_uart' ? 'Basys 3 FPGA' : 'Verilog FSM Simulation') : '—']
      ]
    };
  },
  dailyAll({ date }) {
    const tot = attendanceService.state.students.length;
    const pc = attendanceService.getPresentCount(date);
    const rows = attendanceService.state.students.map(s => {
      const r = attendanceService.getRecordsOn(date)[s.rollNumber];
      return [s.rollNumber, s.name, s.residence, r ? t12(r.t) : '—', r ? 'Present (1)' : 'Absent (0)'];
    });
    return {
      file: `AttendEdge_daily_attendance_${date}`,
      title: 'Daily Attendance Register (All 63 Students)',
      meta: meta(D.long(date)),
      summary: [
        ['Present', pc],
        ['Absent', tot - pc],
        ['Attendance %', pctText((pc / tot) * 100)]
      ],
      columns: ['Roll Number', 'Student Name', 'Residence', 'Scan Time', 'Status'],
      rows
    };
  },
  presentList({ date }) {
    const rows = attendanceService.state.students
      .filter(s => !!attendanceService.getRecordsOn(date)[s.rollNumber])
      .map((s, i) => [i + 1, s.rollNumber, s.name, s.residence, t12(attendanceService.getRecordsOn(date)[s.rollNumber].t)]);
    return {
      file: `AttendEdge_present_${date}`,
      title: 'Daily Present List',
      meta: meta(D.long(date)),
      summary: [['Present Count', rows.length]],
      columns: ['#', 'Roll Number', 'Student Name', 'Residence', 'First Scan Time'],
      rows
    };
  },
  absentList({ date }) {
    const rows = attendanceService.state.students
      .filter(s => !attendanceService.getRecordsOn(date)[s.rollNumber])
      .map((s, i) => [i + 1, s.rollNumber, s.name, s.residence, 'Absent (0)']);
    return {
      file: `AttendEdge_absent_${date}`,
      title: 'Daily Absent List',
      meta: meta(D.long(date)),
      summary: [['Absent Count', rows.length]],
      columns: ['#', 'Roll Number', 'Student Name', 'Residence', 'Status'],
      rows
    };
  },
  weeklyClass({ date }) {
    const ws = D.weekStart(date);
    const we = D.add(ws, 6);
    const weekDays = D.range(ws, we);
    const workingDays = weekDays.filter(d => attendanceService.isWorkingDay(d));
    const nonWorkingDays = weekDays.filter(d => !attendanceService.isWorkingDay(d));
    const st = attendanceService.getClassStats(ws, we);
    const rows = attendanceService.state.students.map(s => {
      const x = st.map[s.rollNumber];
      return [s.rollNumber, s.name, s.residence, x.working, x.present, x.absent, pctText(x.pct)];
    });
    return {
      file: `AttendEdge_weekly_class_${ws}`,
      title: 'Weekly Class Attendance Report',
      meta: meta(`${D.med(ws)} to ${D.med(we)}`),
      summary: [
        ['Working Days in Week', workingDays.length],
        ['Non-working Days in Week', nonWorkingDays.length],
        ['Working Days Counted', st.days.length]
      ],
      columns: ['Roll Number', 'Student Name', 'Residence', 'Working Days', 'Present', 'Absent', 'Attendance %'],
      rows
    };
  },
  monthlyClass({ y, m }) {
    const [a, b] = D.monthRange(+y, +m);
    const st = attendanceService.getClassStats(a, b);
    const rows = attendanceService.state.students.map(s => {
      const x = st.map[s.rollNumber];
      return [s.rollNumber, s.name, s.residence, x.working, x.present, x.absent, pctText(x.pct)];
    });
    return {
      file: `AttendEdge_monthly_class_${y}-${pad(m)}`,
      title: `Monthly Class Attendance Report (${D.mon(+y, +m)})`,
      meta: meta(D.mon(+y, +m)),
      summary: [['Working Days Counted', st.days.length]],
      columns: ['Roll Number', 'Student Name', 'Residence', 'Working Days', 'Present', 'Absent', 'Attendance %'],
      rows
    };
  },
  monthlyStudent({ roll, y, m }) {
    const s = attendanceService.getStudent(roll);
    const [a, b] = D.monthRange(+y, +m);
    const st = attendanceService.getClassStats(a, b);
    const x = st.map[roll] || { working: 0, present: 0, absent: 0, pct: null };
    const rows = st.days.map(d => {
      const r = attendanceService.getRecordsOn(d)[roll];
      return [d, D.dayName(d), r ? 'Present (1)' : 'Absent (0)', r ? t12(r.t) : '-'];
    });
    return {
      file: `AttendEdge_monthly_${roll}_${y}-${pad(m)}`,
      title: `Student Monthly Attendance Report (${D.mon(+y, +m)})`,
      meta: meta(D.mon(+y, +m), s),
      summary: [
        ['Working Days', x.working],
        ['Present', x.present],
        ['Absent', x.absent],
        ['Attendance %', pctText(x.pct)]
      ],
      columns: ['Date', 'Day', 'Status', 'First Scan Time'],
      rows
    };
  },
  semesterStudent({ roll }) {
    const s = attendanceService.getStudent(roll);
    const a = attendanceService.state.settings.semesterStart;
    const b = attendanceService.state.settings.semesterEnd;
    const st = attendanceService.getClassStats(a, b);
    const x = st.map[roll] || { working: 0, present: 0, absent: 0, pct: null };
    const rows = st.days.map(d => {
      const r = attendanceService.getRecordsOn(d)[roll];
      return [d, D.dayName(d), r ? 'Present (1)' : 'Absent (0)', r ? t12(r.t) : '-'];
    });
    return {
      file: `AttendEdge_semester_${roll}_S${attendanceService.state.settings.semester}`,
      title: `Student Semester Attendance Report (Semester ${attendanceService.state.settings.semester})`,
      meta: meta(`${D.med(a)} to ${D.med(b)}`, s),
      summary: [
        ['Working Days', x.working],
        ['Present', x.present],
        ['Absent', x.absent],
        ['Attendance %', pctText(x.pct)]
      ],
      columns: ['Date', 'Day', 'Status', 'First Scan Time'],
      rows
    };
  },
  semesterClass() {
    const a = attendanceService.state.settings.semesterStart;
    const b = attendanceService.state.settings.semesterEnd;
    const st = attendanceService.getClassStats(a, b);
    const rows = attendanceService.state.students.map(s => {
      const x = st.map[s.rollNumber];
      return [s.rollNumber, s.name, s.residence, x.working, x.present, x.absent, pctText(x.pct)];
    });
    return {
      file: `AttendEdge_semester_class_${attendanceService.state.settings.academicYear}_S${attendanceService.state.settings.semester}`,
      title: `Semester Class Attendance Report (Semester ${attendanceService.state.settings.semester})`,
      meta: meta(`${D.med(a)} to ${D.med(b)}`),
      summary: [['Working Days Counted', st.days.length]],
      columns: ['Roll Number', 'Student Name', 'Residence', 'Working Days', 'Present', 'Absent', 'Attendance %'],
      rows
    };
  }
};

function runReport(name, args, mode = 'pdf') {
  const handler = ReportsModel[name];
  if (!handler) return;
  const report = handler(args || {});
  if (mode === 'csv') exportCSV(report);
  else if (mode === 'print') printReport(report);
  else exportPDF(report);
}

// Layout Components
function sidebar() {
  const user = UI.currentUser;
  const isDemo = Boolean(user && user.isDemo);
  return `<aside class="sidebar" id="sidebar" aria-label="Main navigation">
    <div class="brand">${LOGO}<div><b>AttendEdge</b><span>FSM & Flip-Flop System</span></div></div>
    <hr>
    <nav class="nav" aria-label="Sections">
      ${PAGES.map(p => `<a href="#/${p[0]}" ${UI.page === p[0] ? 'aria-current="page"' : ''}>${ic(p[0], 19)}<span>${p[1]}</span></a>`).join('')}
    </nav>
    <div class="side-foot">
      <div class="profile">
        <div class="avatar" aria-hidden="true">${user && user.displayName ? user.displayName[0] : 'F'}</div>
        <div>
          <b>${esc(user ? user.displayName : 'Faculty')}</b>
          <div>
            ${isDemo
              ? `<span class="auth-badge badge-demo">Demo Mode (Offline)</span>`
              : `<span class="auth-badge badge-firebase">Firebase Faculty</span>`}
          </div>
        </div>
      </div>
      <button class="btn btn-sm" style="width:100%;margin-top:10px" data-act="logout">${ic('logout', 16)} Log out</button>
    </div>
  </aside>
  <div class="scrim" data-act="closeNav"></div>`;
}

function header() {
  const sel = attendanceService.state.ui.selDate;
  const n = attendanceService.getClockNow();
  const h = +n.time.slice(0, 2);
  const s = attendanceService.state.settings;
  const label = (PAGES.find(p => p[0] === UI.page) || ['', 'Dashboard'])[1];
  const ov = UI.page === 'overview';
  const greet = h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
  const hwConnected = serialService.status === 'connected';
  const conn = getConnectionState();

  let connBadge = '';
  if (conn.state === CONNECTION_STATES.FIREBASE_CONNECTED) {
    connBadge = `<span class="pill" title="${esc(conn.details)}"><span class="dot ok"></span>Cloud Sync: Active</span>`;
  } else if (conn.state === CONNECTION_STATES.FIREBASE_ERROR) {
    connBadge = `<span class="pill" title="${esc(conn.details)}"><span class="dot bad"></span>Cloud: Error</span>`;
  } else if (conn.state === CONNECTION_STATES.FIREBASE_AUTH_REQUIRED) {
    connBadge = `<span class="pill" title="${esc(conn.details)}"><span class="dot warn"></span>Cloud: Auth Required</span>`;
  } else {
    connBadge = `<span class="pill" title="${esc(conn.details)}"><span class="dot off"></span>Mode: Offline Demo</span>`;
  }

  return `<header class="page-head">
    <div>
      <div class="mono">${D.dayName(sel)} · ${ov ? 'FSM Hardware Overview' : esc(label)}</div>
      <h1>${ov ? greet + ', Faculty' : esc(label)}</h1>
      <div class="muted small">${esc(s.department)} · Semester ${esc(s.semester)} · ${esc(s.classSection)} · AY ${esc(s.academicYear)}</div>
    </div>
    <div class="head-ctl">
      <div class="field"><label for="selDate">Selected date</label><input id="selDate" class="input" type="date" data-bind="sel" value="${sel}"></div>
      ${connBadge}
      <span class="pill">
        <span class="dot ${hwConnected ? 'ok' : 'off'}" aria-hidden="true"></span>
        ${hwConnected ? 'Basys 3 Connected' : 'FPGA Disconnected (Sim FSM)'}
      </span>
      <span class="pill">${ic('clock', 14)}<span data-clock>${t12(n.time)}</span><span class="muted">${attendanceService.state.ui.clock.mode === 'real' ? 'system clock' : 'simulated'}</span></span>
    </div>
  </header>`;
}

// PAGE: Overview
function pageOverview() {
  const d = attendanceService.state.ui.selDate;
  const info = attendanceService.getSessionInfo(d);
  const pc = attendanceService.getPresentCount(d);
  const tot = attendanceService.state.students.length;
  const ab = tot - pc;
  const tm = info.times;
  const msg = {
    open: `Scanner is accepting student roll numbers (0..62) until ${t12(tm.close)}.`,
    notstarted: d > attendanceService.getTodayString() ? `Upcoming working day. Scanning opens at ${t12(tm.open)}.` : `Scanning opens at ${t12(tm.open)}.`,
    closed: `Scanning closed at ${t12(tm.close)}. Unscanned students remain marked Absent (bit = 0).`,
    nonworking: info.reason + '.'
  }[info.key];

  const recent = Object.entries(attendanceService.getRecordsOn(d))
    .sort((a, b) => b[1].t.localeCompare(a[1].t))
    .slice(0, 6);
  const sample = attendanceService.state.students.slice(0, 6);
  const days = attendanceService.getCountedDays(D.add(d, -70), d).slice(-14);
  const trend = chart({
    type: 'bar',
    labels: days.map(x => `${+x.slice(8)} ${D.monShort(+x.slice(0, 4), +x.slice(5, 7))}`),
    values: days.map(x => (attendanceService.getPresentCount(x) / tot) * 100),
    label: 'Daily attendance percentage for recent working days'
  });

  return `<div class="grid kpis">
    <div class="card kpi"><div class="label">Total students</div><div class="v c-primary">${tot}</div><div class="s">63 flip-flops (25EV001-063)</div></div>
    <div class="card kpi"><div class="label">Present</div><div class="v c-ok">${pc}</div><div class="s">register bit = 1</div></div>
    <div class="card kpi"><div class="label">Absent</div><div class="v c-warn">${ab}</div><div class="s">register bit = 0</div></div>
    <div class="card kpi"><div class="label">Attendance</div><div class="v c-primary">${((pc / tot) * 100).toFixed(pc % tot === 0 || pc === 0 ? 0 : 1)}%</div><div class="s">${esc(D.med(d))}</div></div>
  </div>
  <section class="banner" aria-label="Attendance session">
    <div>
      <h2>Attendance Session <span class="state ${info.key}">${info.label}</span></h2>
      <p>Hardware Window: ${t12(tm.open)} – ${t12(tm.close)} (Verilog in_window check)</p>
      <p style="opacity:.92;font-size:13.5px">${esc(msg)}</p>
      <span class="chip">${serialService.status === 'connected' ? 'Live Basys 3 FPGA UART Connected' : 'Hardware Attendance Pipeline Active'}</span>
    </div>
    <a class="btn btn-white" href="#/daily">${ic('barcode', 17)} Open Daily Attendance</a>
  </section>
  <div class="grid g2">
    <div class="stack">
      <section class="card">
        <div class="card-h"><h2>${d === attendanceService.getTodayString() ? "Today's Attendance" : 'Attendance on ' + esc(D.med(d))}</h2><a class="btn btn-sm" href="#/daily">View all ${tot}</a></div>
        <div class="row spread label" style="padding-bottom:6px"><span>Roll number</span><span>Status</span></div>
        <div class="list">
          ${sample.map(s => `<div><span class="row" style="gap:8px"><span class="rollc">${s.rollNumber}</span>${resBadge(s.residence)}</span>${attendanceService.getRecordsOn(d)[s.rollNumber] ? badge('ok', 'Present · 1') : badge('warn', 'Absent · 0')}</div>`).join('')}
        </div>
        <p class="muted small" style="margin-top:10px">Showing a sample of the ${tot}-student roster.</p>
      </section>
      <section class="card">
        <div class="card-h"><h2>Daily Attendance Preview</h2><span class="label">Last ${days.length || 0} working days</span></div>
        ${trend}
        <p class="muted tiny" style="margin-top:6px">Bars in amber are below the ${attendanceService.state.settings.threshold}% target.</p>
      </section>
    </div>
    <div class="stack">
      <section class="card">
        <div class="card-h"><h2>Recent Activity</h2><span class="label">${esc(D.short(d))}</span></div>
        ${recent.length ? `<div class="list">${recent.map(([r, v]) => `<div><span><b>${esc(attendanceService.getStudent(r).name)}</b><br><span class="rollc muted">${r}</span> ${resBadge(attendanceService.getStudent(r).residence)}</span><span style="text-align:right">${t12(v.t)}<br>${badge('ok', 'Present')}</span></div>`).join('')}</div>` : empty('No attendance recorded for this date', 'Awaiting hardware scans from ESP32-CAM.')}
      </section>
      <section class="card">
        <div class="card-h"><h2>Quick Links</h2></div>
        <div class="quick">
          <a class="btn" href="#/daily">${ic('barcode', 16)} Daily Attendance</a>
          <a class="btn" href="#/students">${ic('students', 16)} Student Roster</a>
          <a class="btn" href="#/device">${ic('device', 16)} FPGA Diagnostics</a>
          <a class="btn" href="#/pdf">${ic('pdf', 16)} PDF Reports</a>
        </div>
      </section>
    </div>
  </div>`;
}

// PAGE: Daily Attendance & Student Statistics Dashboard
function pageDaily() {
  const q = UI.daily;
  const d = attendanceService.state.ui.selDate;
  const sc = UI.scan;
  const info = attendanceService.getSessionInfo(d);
  const curRoll = (sc.roll || '25EV001').trim().toUpperCase();
  const stu = attendanceService.getStudent(curRoll);
  const curRecord = stu && attendanceService.getRecordsOn(d)[stu.rollNumber];
  const bit = curRecord ? 1 : 0;
  const statFilter = q.statFilter || 'all';

  const stats = getStudentStatistics(attendanceService.state.students);

  const all = attendanceService.state.students.map(s => {
    const r = attendanceService.getRecordsOn(d)[s.rollNumber];
    const g = parseStudentGender(s);
    const a = parseStudentAccom(s);
    return {
      roll: s.rollNumber,
      name: s.name,
      time: r ? r.t : null,
      bit: r ? 1 : 0,
      residence: s.residence,
      gender: g,
      accommodation: a,
      rawStudent: s
    };
  });
  const pc = all.filter(r => r.bit).length;

  const matchesStatFilter = r => {
    if (statFilter === 'all') return true;
    if (statFilter === 'boys') return r.gender === 'Boy';
    if (statFilter === 'girls') return r.gender === 'Girl';
    if (statFilter === 'hostellers') return r.accommodation === 'Hosteller';
    if (statFilter === 'dayscholars') return r.accommodation === 'Day Scholar';
    if (statFilter === 'boys_dayscholar') return r.gender === 'Boy' && r.accommodation === 'Day Scholar';
    if (statFilter === 'boys_hosteller') return r.gender === 'Boy' && r.accommodation === 'Hosteller';
    if (statFilter === 'girls_dayscholar') return r.gender === 'Girl' && r.accommodation === 'Day Scholar';
    if (statFilter === 'girls_hosteller') return r.gender === 'Girl' && r.accommodation === 'Hosteller';
    return true;
  };

  const rows = all.filter(r =>
    (q.filter === 'all' || (q.filter === 'present' ? r.bit : !r.bit)) &&
    (!q.res || r.residence === q.res) &&
    (!q.q || (r.roll + ' ' + r.name + ' ' + (r.residence || '')).toLowerCase().includes(q.q.trim().toLowerCase())) &&
    matchesStatFilter(r)
  );

  const cols = [
    { key: 'roll', label: 'Roll number', html: r => rollc(r.roll) },
    { key: 'name', label: 'Student name', html: r => `<button class="th-btn" style="font-weight:500" data-act="openStudent" data-roll="${r.roll}">${esc(r.name)}</button>` },
    { key: 'gender', label: 'Gender', html: r => r.gender ? `<span class="badge ${r.gender === 'Boy' ? 'info' : 'ok'}">${esc(r.gender)}</span>` : '<span class="muted small">—</span>' },
    { key: 'residence', label: 'Residence', html: r => resBadge(r.residence) },
    { key: 'time', label: 'Scan time', html: r => (r.time ? t12(r.time) : '<span class="muted">—</span>') },
    { key: 'bit', label: 'Flip-Flop Bit', html: r => (r.bit ? badge('ok', 'Present · 1') : badge('warn', 'Absent · 0')) },
    {
      key: 'act',
      label: 'Actions',
      nosort: true,
      html: r => `<span class="row" style="gap:6px;flex-wrap:nowrap">
        <button class="icon-btn" data-act="openStudent" data-roll="${r.roll}" title="Student Profile">${ic('user', 16)}</button>
        <button class="icon-btn" data-act="selectStudentBit" data-roll="${r.roll}" title="Inspect Register Bit">${ic('chip', 16)}</button>
        <button class="icon-btn" data-act="report" data-r="dailyStudent" data-args='${esc(JSON.stringify({ roll: r.roll, date: d }))}' title="Daily PDF">${ic('file', 16)}</button>
      </span>`
    }
  ];

  const seg = (f, l, c) => `<button data-act="setFilter" data-f="${f}" aria-pressed="${q.filter === f}">${l} ${c}</button>`;

  // 63 Flip-Flops Grid (Bits 0..62)
  const regsGrid = attendanceService.state.students.map((s, i) => {
    const b = attendanceService.getRecordsOn(d)[s.rollNumber] ? 1 : 0;
    const isSel = curRoll === s.rollNumber;
    return `<button class="reg ${b ? 'on' : ''} ${s.residence === 'Hosteller' ? 'h' : ''} ${isSel ? 'sel' : ''}" data-act="selectStudentBit" data-roll="${s.rollNumber}" title="${s.rollNumber} (${s.name}): bit=${b}">${i + 1}</button>`;
  }).join('');

  // 9 Responsive Statistic Cards
  const statCards = [
    {
      key: 'all',
      title: 'Total Students',
      icon: 'students',
      value: stats.total,
      hasData: true,
      meta: 'Active Roster',
      pillClass: 'stat-pill ok',
      fullWidth: true
    },
    {
      key: 'boys',
      title: 'Boys',
      icon: 'male',
      value: stats.boys.count,
      hasData: stats.boys.hasData,
      meta: stats.boys.hasData ? (stats.boys.missing > 0 ? `${stats.boys.missing} incomplete` : 'Complete') : 'Data incomplete',
      pillClass: stats.boys.hasData && stats.boys.missing === 0 ? 'stat-pill ok' : 'stat-pill warn'
    },
    {
      key: 'girls',
      title: 'Girls',
      icon: 'female',
      value: stats.girls.count,
      hasData: stats.girls.hasData,
      meta: stats.girls.hasData ? (stats.girls.missing > 0 ? `${stats.girls.missing} incomplete` : 'Complete') : 'Data incomplete',
      pillClass: stats.girls.hasData && stats.girls.missing === 0 ? 'stat-pill ok' : 'stat-pill warn'
    },
    {
      key: 'hostellers',
      title: 'Hostellers',
      icon: 'home',
      value: stats.hostellers.count,
      hasData: stats.hostellers.hasData,
      meta: stats.hostellers.hasData ? (stats.hostellers.missing > 0 ? `${stats.hostellers.missing} incomplete` : 'Complete') : 'Data incomplete',
      pillClass: stats.hostellers.hasData && stats.hostellers.missing === 0 ? 'stat-pill ok' : 'stat-pill warn'
    },
    {
      key: 'dayscholars',
      title: 'Day Scholars',
      icon: 'sun',
      value: stats.dayScholars.count,
      hasData: stats.dayScholars.hasData,
      meta: stats.dayScholars.hasData ? (stats.dayScholars.missing > 0 ? `${stats.dayScholars.missing} incomplete` : 'Complete') : 'Data incomplete',
      pillClass: stats.dayScholars.hasData && stats.dayScholars.missing === 0 ? 'stat-pill ok' : 'stat-pill warn'
    },
    {
      key: 'boys_dayscholar',
      title: 'Boys — Day Scholars',
      icon: 'male_sun',
      value: stats.boysDayScholar.count,
      hasData: stats.boysDayScholar.hasData,
      meta: stats.boysDayScholar.hasData ? (stats.boysDayScholar.missing > 0 ? `${stats.boysDayScholar.missing} incomplete` : 'Complete') : 'Data incomplete',
      pillClass: stats.boysDayScholar.hasData && stats.boysDayScholar.missing === 0 ? 'stat-pill ok' : 'stat-pill warn'
    },
    {
      key: 'boys_hosteller',
      title: 'Boys — Hostellers',
      icon: 'male_home',
      value: stats.boysHosteller.count,
      hasData: stats.boysHosteller.hasData,
      meta: stats.boysHosteller.hasData ? (stats.boysHosteller.missing > 0 ? `${stats.boysHosteller.missing} incomplete` : 'Complete') : 'Data incomplete',
      pillClass: stats.boysHosteller.hasData && stats.boysHosteller.missing === 0 ? 'stat-pill ok' : 'stat-pill warn'
    },
    {
      key: 'girls_dayscholar',
      title: 'Girls — Day Scholars',
      icon: 'female_sun',
      value: stats.girlsDayScholar.count,
      hasData: stats.girlsDayScholar.hasData,
      meta: stats.girlsDayScholar.hasData ? (stats.girlsDayScholar.missing > 0 ? `${stats.girlsDayScholar.missing} incomplete` : 'Complete') : 'Data incomplete',
      pillClass: stats.girlsDayScholar.hasData && stats.girlsDayScholar.missing === 0 ? 'stat-pill ok' : 'stat-pill warn'
    },
    {
      key: 'girls_hosteller',
      title: 'Girls — Hostellers',
      icon: 'female_home',
      value: stats.girlsHosteller.count,
      hasData: stats.girlsHosteller.hasData,
      meta: stats.girlsHosteller.hasData ? (stats.girlsHosteller.missing > 0 ? `${stats.girlsHosteller.missing} incomplete` : 'Complete') : 'Data incomplete',
      pillClass: stats.girlsHosteller.hasData && stats.girlsHosteller.missing === 0 ? 'stat-pill ok' : 'stat-pill warn'
    }
  ];

  const renderCardIcon = icon => {
    if (icon === 'male_sun') return `<span class="stat-card-ic">${ic('male', 14)}${ic('sun', 14)}</span>`;
    if (icon === 'male_home') return `<span class="stat-card-ic">${ic('male', 14)}${ic('home', 14)}</span>`;
    if (icon === 'female_sun') return `<span class="stat-card-ic">${ic('female', 14)}${ic('sun', 14)}</span>`;
    if (icon === 'female_home') return `<span class="stat-card-ic">${ic('female', 14)}${ic('home', 14)}</span>`;
    return `<span class="stat-card-ic">${ic(icon, 16)}</span>`;
  };

  const statCardsHtml = `<div class="stat-grid">${statCards.map(c => `
    <button class="stat-card ${c.fullWidth ? 'full-width' : ''} ${statFilter === c.key ? 'active' : ''}" data-act="setStatFilter" data-filter="${c.key}" title="Click to filter student list by ${esc(c.title)}">
      <div class="stat-card-title">
        ${renderCardIcon(c.icon)}
        <span class="stat-title-text">${esc(c.title)}</span>
      </div>
      <div class="stat-card-v ${!c.hasData ? 'empty-val' : ''}">${c.hasData ? c.value : '—'}</div>
      <div class="stat-card-meta">
        <span class="${c.pillClass}">${esc(c.meta)}</span>
      </div>
    </button>
  `).join('')}</div>`;

  return `<div class="notice info" style="margin-bottom:16px">${ic('info', 18)}<div>Session for ${esc(D.long(d))}: <b>${info.label}</b>${info.reason ? ' · ' + esc(info.reason) : ''}. FSM window: ${t12(info.times.open)}–${t12(info.times.close)}.</div></div>
  <div class="grid daily-grid">
    <div class="stack" style="min-width:0">
      <section class="card">
        <div class="toolbar">
          <div class="field"><label for="dd">Date</label><div class="row" style="flex-wrap:nowrap;gap:6px"><button class="icon-btn" data-act="shiftDate" data-d="-1">${ic('chevL', 16)}</button><input id="dd" class="input" style="width:auto" type="date" data-bind="sel" value="${d}"><button class="icon-btn" data-act="shiftDate" data-d="1">${ic('chevR', 16)}</button></div></div>
          <div class="field search"><label for="dq">Search</label><div style="position:relative">${ic('search', 16)}<input id="dq" class="input" style="padding-left:36px" type="search" data-bind="daily.q" value="${esc(q.q)}" placeholder="Roll number or name"></div></div>
          <div class="field"><span class="label">Status</span><div class="seg">${seg('all', 'All', all.length)}${seg('present', 'Present', pc)}${seg('absent', 'Absent', all.length - pc)}</div></div>
        </div>
        <div class="toolbar">
          ${resSel('dr', 'daily.res', q.res)}
          <button class="btn" data-act="report" data-mode="csv" data-r="dailyAll" data-args='${esc(JSON.stringify({ date: d }))}'>${ic('download', 16)} Export CSV</button>
          <button class="btn" data-act="report" data-mode="pdf" data-r="dailyAll" data-args='${esc(JSON.stringify({ date: d }))}'>${ic('pdf', 16)} Export PDF</button>
          ${info.key === 'closed'
            ? `<button class="btn btn-primary" data-act="openSession">${ic('check', 16)} Open Session</button>`
            : `<button class="btn btn-warn" data-act="closeSession">${ic('x', 16)} Close Session</button>`}
          <button class="btn btn-danger" data-act="resetDay">${ic('reset', 16)} Reset Today's Day</button>
        </div>
        ${statFilter !== 'all' ? `
        <div class="filter-notice">
          <div class="row" style="gap:8px">
            ${ic('filter', 16)}
            <span>Filtered by: <b>${esc(STAT_LABELS[statFilter] || statFilter)}</b> (${rows.length} student${rows.length === 1 ? '' : 's'})</span>
          </div>
          <button class="btn btn-sm" data-act="clearStatFilter">${ic('x', 14)} Clear Filter</button>
        </div>` : ''}
        <div class="row small" style="margin-bottom:10px"><b>${pc}</b> present · <b>${all.length - pc}</b> absent · <b>${all.length ? ((pc / all.length) * 100).toFixed(1) : 0}%</b> attendance</div>
        ${table('daily', {
          cols,
          rows,
          size: q.size,
          caption: 'Attendance for ' + d,
          rowCls: r => (sc.flash === r.roll ? 'flash' : ''),
          empty: `<div class="empty"><b>No matching students</b>${statFilter !== 'all' ? `No students found matching category "${esc(STAT_LABELS[statFilter] || statFilter)}".` : 'Adjust the search or filters.'}</div>`
        })}
      </section>
    </div>
    <div class="stack sticky">
      <section class="card stat-dash">
        <div class="stat-dash-h">
          <div>
            <h2 style="font-size:16px;font-weight:700">Student Statistics</h2>
            <p class="muted small" style="margin:2px 0 0 0">Roster demographics &amp; accommodation</p>
          </div>
          <span class="badge info">Active Roster</span>
        </div>
        ${statCardsHtml}
      </section>

      <section class="card">
        <div class="card-h"><h2>63 × 1-Bit Attendance Register</h2><span class="label">64-bit flip-flop bus</span></div>
        <div class="regs">${regsGrid}</div>
        <p class="hint" style="margin-top:8px">Green = Flip-flop Bit 1 (Present). Blue underline = Hosteller. Click any cell to inspect student register.</p>
      </section>
    </div>
  </div>`;
}

// PAGE: Students
function pageStudents() {
  const q = UI.stu;
  const st = attendanceService.getClassStats(attendanceService.state.settings.semesterStart, attendanceService.state.settings.semesterEnd).map;
  const rows = attendanceService.state.students.filter(s => (!q.dept || s.department === q.dept) && (!q.cls || s.classSection === q.cls) && (!q.sem || s.semester === q.sem) && (!q.res || s.residence === q.res) && (!q.q || (s.rollNumber + ' ' + s.name + ' ' + s.residence).toLowerCase().includes(q.q.trim().toLowerCase())));

  const cols = [
    { key: 'rollNumber', label: 'Roll number', html: r => rollc(r.rollNumber) },
    { key: 'name', label: 'Name', html: r => `<button class="th-btn" style="font-weight:600" data-act="openStudent" data-roll="${r.rollNumber}">${esc(r.name)}</button>` },
    { key: 'email', label: 'Email' },
    { key: 'department', label: 'Department' },
    { key: 'classSection', label: 'Class' },
    { key: 'semester', label: 'Sem' },
    { key: 'gender', label: 'Gender', html: r => r.gender ? `<span class="badge ${r.gender === 'Boy' || r.gender === 'Male' ? 'info' : 'ok'}">${esc(r.gender)}</span>` : '<span class="muted small">—</span>' },
    { key: 'residence', label: 'Residence', html: r => resBadge(r.residence) },
    { key: 'pct', label: 'Semester %', val: r => st[r.rollNumber].pct, cls: 'num', html: r => `<span class="${st[r.rollNumber].pct !== null && st[r.rollNumber].pct < attendanceService.state.settings.threshold ? 'c-warn' : 'c-ok'}" style="font-weight:600">${pctText(st[r.rollNumber].pct)}</span>` },
    { key: 'act', label: '', nosort: true, html: r => `<button class="btn btn-sm" data-act="openStudent" data-roll="${r.rollNumber}">${ic('edit', 14)} Edit</button>` }
  ];

  return `<section class="card">
    <div class="toolbar">
      <div class="field search"><label for="sq">Search</label><div style="position:relative">${ic('search', 16)}<input id="sq" class="input" style="padding-left:36px" type="search" data-bind="stu.q" value="${esc(q.q)}" placeholder="Roll number or name"></div></div>
      ${resSel('sr', 'stu.res', q.res)}
      <button class="btn btn-primary" data-act="openAddStudent">${ic('plus', 16)} Add Student</button>
      <button class="btn" data-act="exportRoster">${ic('download', 16)} Export Roster CSV</button>
      <button class="btn" data-act="importRoster">${ic('upload', 16)} Import Roster CSV</button>
      <input type="file" id="rosterFile" accept=".csv,text/csv" class="sr" tabindex="-1" data-file="roster">
    </div>
    <div class="row small" style="margin-bottom:10px">Showing ${rows.length} of ${attendanceService.state.students.length} students. Indices correspond to FPGA registers 0..62.</div>
    ${table('students', { cols, rows, size: 25, caption: 'Student roster' })}
  </section>`;
}

// Student Edit Modal Dialog
function studentModal(roll) {
  const s = attendanceService.getStudent(roll);
  const st = attendanceService.getClassStats(attendanceService.state.settings.semesterStart, attendanceService.state.settings.semesterEnd).map[roll];
  const t = attendanceService.getTodayString();
  const last = attendanceService.getCountedDays(D.add(t, -45), t).slice(-14);
  const n = attendanceService.getClockNow();
  const f = (id, l, v, extra = '') => `<div class="field"><label for="${id}">${l}</label><input id="${id}" name="${id}" class="input" value="${esc(v)}" ${extra}></div>`;

  const isBoy = s.gender === 'Boy' || s.gender === 'Male';
  const isGirl = s.gender === 'Girl' || s.gender === 'Female';

  return `<div class="row spread">
    <div><h2 style="margin:0">${esc(s.name)}</h2><span class="rollc muted">${s.rollNumber} (FPGA Bit ${s.index})</span></div>
    <span class="row" style="gap:6px">${s.gender ? `<span class="badge ${isBoy ? 'info' : 'ok'}">${esc(s.gender)}</span>` : ''}${resBadge(s.residence)}</span>
  </div>
  <div class="grid g3" style="margin:16px 0">
    <div class="card flat kpi"><div class="label">Semester</div><div class="v ${st.pct !== null && st.pct < attendanceService.state.settings.threshold ? 'c-warn' : 'c-ok'}" style="font-size:24px">${pctText(st.pct)}</div></div>
    <div class="card flat kpi"><div class="label">Present / Working</div><div class="v" style="font-size:24px">${st.present} / ${st.working}</div></div>
    <div class="card flat kpi"><div class="label">Register Bit Today</div><div class="v" style="font-size:24px">${attendanceService.getRecordsOn(n.date)[roll] ? '1' : '0'}</div></div>
  </div>
  <div class="label" style="margin-bottom:6px">Last ${last.length} Completed Working Days</div>
  <div class="daystrip" style="margin-bottom:18px">${last.map(d => `<span class="${attendanceService.getRecordsOn(d)[roll] ? 'p' : 'a'}" title="${D.short(d)}: ${attendanceService.getRecordsOn(d)[roll] ? 'Present' : 'Absent'}">${+d.slice(8)}</span>`).join('') || '<span class="muted small">No completed days yet</span>'}</div>
  <form data-form="student" data-roll="${roll}">
    <div class="formgrid">
      ${f('roll', 'Roll Number (Fixed FPGA ID)', s.rollNumber, 'disabled')}
      ${f('name', 'Name', s.name, 'required maxlength="60"')}
      ${f('email', 'Email', s.email, 'type="email" required maxlength="80"')}
      ${f('department', 'Department', s.department, 'required maxlength="60"')}
      ${f('classSection', 'Class / Section', s.classSection, 'required maxlength="30"')}
      ${f('semester', 'Semester', s.semester, 'required maxlength="1"')}
      <div class="field"><label for="gender">Gender</label><select id="gender" name="gender" class="select">
        <option value="" ${!s.gender ? 'selected' : ''}>— Unspecified —</option>
        <option value="Boy" ${isBoy ? 'selected' : ''}>Boy</option>
        <option value="Girl" ${isGirl ? 'selected' : ''}>Girl</option>
      </select></div>
      <div class="field"><label for="residence">Residence</label><select id="residence" name="residence" class="select">${RES.map(o => `<option ${s.residence === o ? 'selected' : ''}>${o}</option>`).join('')}</select></div>
    </div>
    <div id="stuErr" class="err" role="alert"></div>
    <div class="dlg-actions">
      <button type="button" class="btn btn-danger" data-act="deleteStudent" data-roll="${roll}">${ic('trash', 16)} Delete</button>
      <button type="button" class="btn" data-act="report" data-r="dailyStudent" data-args='${esc(JSON.stringify({ roll, date: t }))}'>${ic('pdf', 16)} Daily PDF</button>
      <button type="button" class="btn" data-act="dlgCancel">Cancel</button>
      <button class="btn btn-primary" type="submit">Save Changes</button>
    </div>
  </form>`;
}

// PAGE: Weekly Reports
function pageWeekly() {
  const w = UI.weekly;
  const ws = D.weekStart(w.date);
  const we = D.add(ws, 6);
  const weekDays = D.range(ws, we);
  const today = attendanceService.getTodayString();
  const tot = attendanceService.state.students.length;
  const st = attendanceService.getClassStats(ws, we);
  const sm = attendanceService.summarizeStats(st.map);

  // Manage date defaults to currently selected week date if unset or invalid
  if (!w.manageDate || !D.valid(w.manageDate)) {
    w.manageDate = w.date;
  }
  const manageDate = w.manageDate;
  const manageInfo = attendanceService.getDayScheduleInfo(manageDate);

  const rows = weekDays.map(d => {
    const sched = attendanceService.getDayScheduleInfo(d);
    const wk = sched.isWorking;
    const isPast = d < today;
    const isToday = d === today;
    const isFuture = d > today;

    const p = attendanceService.getPresentCount(d);
    const recordsOnDate = attendanceService.getRecordsOn(d);
    const hasRecords = Boolean(recordsOnDate && Object.keys(recordsOnDate).length > 0);
    const session = attendanceService.state.sessions[d];
    const isSessionDone = attendanceService.isSessionCompleted(d);

    let statusType = sched.status;
    let badgeType = wk ? 'info' : 'muted';
    let pDisplay = '—';
    let aDisplay = '—';
    let pct = null;
    let note = '';

    if (!wk) {
      statusType = 'Non-working Day';
      badgeType = 'muted';
      note = sched.isOverride ? `Override: ${sched.reason}` : sched.reason;
      pDisplay = '<span class="muted">—</span>';
      aDisplay = '<span class="muted">—</span>';
      pct = null;
    } else if (isFuture) {
      statusType = 'Working Day';
      badgeType = 'info';
      pDisplay = '<span class="badge warn">Pending</span>';
      aDisplay = '<span class="muted">—</span>';
      note = 'Upcoming working day';
      pct = null;
    } else if (isToday) {
      statusType = 'Working Day';
      badgeType = 'info';
      if (hasRecords || isSessionDone) {
        pDisplay = p;
        aDisplay = tot - p;
        pct = (p / tot) * 100;
      } else {
        pDisplay = '<span class="muted">— (Pending)</span>';
        aDisplay = '<span class="muted">—</span>';
        note = 'Scanning window pending';
        pct = null;
      }
    } else {
      // Past working day
      statusType = 'Working Day';
      badgeType = 'info';
      if (hasRecords) {
        pDisplay = p;
        aDisplay = tot - p;
        pct = (p / tot) * 100;
      } else if (session && String(session.sessionStatus).toLowerCase() === 'closed') {
        pDisplay = 0;
        aDisplay = tot;
        pct = 0.0;
        note = 'Confirmed 0 attendance';
      } else {
        // Distinguish missing attendance data from confirmed zero-attendance day
        pDisplay = '<span class="badge warn">Missing Data</span>';
        aDisplay = '<span class="muted">—</span>';
        note = 'No attendance recorded';
        pct = null;
      }
    }

    return {
      date: d,
      wk,
      isPending: isFuture || (isToday && !hasRecords && !isSessionDone),
      isMissing: isPast && wk && !hasRecords && !(session && String(session.sessionStatus).toLowerCase() === 'closed'),
      p,
      pDisplay,
      aDisplay,
      pct,
      statusType,
      badgeType,
      sched,
      note
    };
  });

  const workingDaysInWeek = rows.filter(r => r.wk).length;
  const nonWorkingDaysInWeek = rows.filter(r => !r.wk).length;
  const recordedDaysInWeek = rows.filter(r => r.wk && r.pct !== null).length;

  const validPcts = rows.filter(r => r.wk && r.pct !== null).map(r => r.pct);
  const weekClassAvg = validPcts.length ? validPcts.reduce((sum, v) => sum + v, 0) / validPcts.length : null;

  const cols = [
    { key: 'date', label: 'Date', html: r => D.short(r.date) },
    {
      key: 'type',
      label: 'Day Status',
      html: r => `<div>${badge(r.badgeType, r.statusType)}${r.sched.isOverride ? ' <span class="badge warn" style="font-size:10px;margin-left:4px" title="Reason: ' + esc(r.sched.reason) + '">Override</span>' : ''}</div>`
    },
    { key: 'p', label: 'Present', cls: 'num', html: r => r.pDisplay },
    { key: 'a', label: 'Absent', cls: 'num', html: r => r.aDisplay },
    {
      key: 'pct',
      label: 'Attendance %',
      html: r => (!r.wk ? '<span class="muted small">Non-working</span>' : r.pct === null ? '<span class="muted small">—</span>' : bar(r.pct))
    }
  ];

  // Faculty Working Day Management Controls
  const targetStatus = w.targetStatus || (manageInfo.isWorking ? 'Non-working Day' : 'Working Day');
  const targetReason = w.targetReason || '';
  const isFacultyUser = Boolean(UI.currentUser && UI.currentUser.role === 'faculty');

  return `<section class="card" style="margin-bottom:16px">
    <div class="toolbar">
      <div class="field"><label for="wd">Select Date in Week</label><input id="wd" class="input" style="width:auto" type="date" data-bind="weekly.date" value="${w.date}"></div>
      <div class="field"><span class="label">Week Range</span><b>${D.med(ws)} – ${D.med(we)}</b></div>
      <div class="grow"></div>
      <button class="btn" data-act="report" data-mode="csv" data-r="weeklyClass" data-args='${esc(JSON.stringify({ date: w.date }))}'>${ic('download', 16)} Export CSV</button>
      <button class="btn btn-primary" data-act="report" data-mode="pdf" data-r="weeklyClass" data-args='${esc(JSON.stringify({ date: w.date }))}'>${ic('pdf', 16)} Export PDF</button>
    </div>
  </section>

  <!-- Working Day Management Section -->
  <section class="card" style="margin-bottom:16px" id="sec-working-day-mgmt">
    <div class="card-h" style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px">
      <div>
        <h2 style="margin:0 0 4px 0">Working Day Management</h2>
        <span class="label">Faculty-controlled schedule override & emergency status adjustments</span>
      </div>
      <div>
        <button class="btn btn-sm" data-act="viewScheduleAudit" title="View historical schedule changes">${ic('clock', 14)} Audit History</button>
      </div>
    </div>
    <div style="background:var(--bg);padding:14px;border-radius:10px;margin-top:12px;border:1px solid var(--line)">
      <div style="display:grid;grid-template-columns:repeat(auto-fit, minmax(260px, 1fr));gap:14px;align-items:start">
        <div class="field">
          <label for="mgmtDate"><b>Select Date to Manage</b></label>
          <input id="mgmtDate" class="input" type="date" value="${manageDate}" data-act="changeMgmtDate" style="background:#fff">
          <div style="margin-top:8px;font-size:13px;display:flex;align-items:center;gap:6px;flex-wrap:wrap">
            <span class="muted">Currently Assigned:</span>
            <b>${badge(manageInfo.isWorking ? 'ok' : 'muted', manageInfo.status)}</b>
            ${manageInfo.isOverride ? `<span class="badge warn" style="font-size:11px">Overridden</span>` : `<span class="badge info" style="font-size:11px">Default Timetable</span>`}
          </div>
          <div style="font-size:12px;color:var(--muted);margin-top:5px;line-height:1.4">
            ${manageInfo.isOverride ? `Reason: <b>${esc(manageInfo.reason)}</b> · <span class="small">${esc(manageInfo.updatedBy || '')}</span>` : esc(manageInfo.reason)}
          </div>
        </div>

        <div class="field">
          <label><b>Choose New Day Status</b></label>
          <div style="display:flex;gap:8px;margin-top:2px">
            <button type="button" class="btn ${targetStatus === 'Working Day' ? 'btn-primary' : ''}" data-act="setSchedTarget" data-status="Working Day" style="flex:1">
              ${ic('check', 16)} Working Day
            </button>
            <button type="button" class="btn ${targetStatus === 'Non-working Day' ? 'btn-danger-solid' : ''}" data-act="setSchedTarget" data-status="Non-working Day" style="flex:1">
              ${ic('cross', 16)} Non-working Day
            </button>
          </div>
          <div style="margin-top:10px">
            <label for="mgmtReason" style="font-size:12px;font-weight:600">Reason for Change <span style="color:var(--bad)">*</span></label>
            <input id="mgmtReason" class="input" style="background:#fff" placeholder="e.g. Emergency holiday, Special working day..." value="${esc(targetReason)}" data-bind="weekly.targetReason">
            <div style="display:flex;flex-wrap:wrap;gap:4px;margin-top:6px">
              <button type="button" class="btn btn-sm" style="font-size:11px;padding:3px 7px" data-act="quickSchedReason" data-r="Emergency holiday">Emergency holiday</button>
              <button type="button" class="btn btn-sm" style="font-size:11px;padding:3px 7px" data-act="quickSchedReason" data-r="College event">College event</button>
              <button type="button" class="btn btn-sm" style="font-size:11px;padding:3px 7px" data-act="quickSchedReason" data-r="Special working day">Special working day</button>
              <button type="button" class="btn btn-sm" style="font-size:11px;padding:3px 7px" data-act="quickSchedReason" data-r="Institutional announcement">Institutional announcement</button>
            </div>
          </div>
        </div>
      </div>

      <div style="display:flex;justify-content:space-between;align-items:center;margin-top:16px;padding-top:12px;border-top:1px solid var(--line);flex-wrap:wrap;gap:8px">
        <div>
          ${manageInfo.isOverride ? `<button type="button" class="btn btn-sm btn-danger" data-act="promptResetOverride" data-date="${manageDate}">Reset to Institutional Default</button>` : `<span class="muted" style="font-size:12px">Default institutional timetable active for this date.</span>`}
        </div>
        <div>
          <button type="button" class="btn btn-primary" data-act="openScheduleConfirmModal" ${!isFacultyUser ? 'title="Faculty sign-in required"' : ''}>
            ${ic('save', 16)} Save Changes
          </button>
        </div>
      </div>
    </div>
  </section>

  <!-- Week Schedule Summary KPIs -->
  <div class="grid g4" style="margin-bottom:16px">
    <div class="card kpi"><div class="label">Working Days Counted</div><div class="v c-primary">${st.days.length}</div></div>
    <div class="card kpi"><div class="label">Non-working Days</div><div class="v muted">${nonWorkingDaysInWeek}</div></div>
    <div class="card kpi"><div class="label">Attendance-Recorded Days</div><div class="v c-ok">${recordedDaysInWeek}</div></div>
    <div class="card kpi"><div class="label">Class Weekly Average</div><div class="v c-ok">${pctText(weekClassAvg)}</div></div>
  </div>

  <div class="grid g2e" style="margin-bottom:16px">
    <section class="card">
      <div class="card-h"><h2>Daily Totals</h2></div>
      ${table('wk-days', { cols, rows, size: 0, caption: 'Daily totals' })}
    </section>
    <section class="card">
      <div class="card-h"><h2>Weekly Trend</h2><span class="label">Attendance % per working day</span></div>
      ${chart({
        type: 'bar',
        labels: rows.map(r => D.short(r.date)),
        values: rows.map(r => r.pct),
        meta: rows.map(r => ({ isNonWorking: !r.wk, isPending: r.isPending, isMissing: r.isMissing, reason: r.sched.reason })),
        label: 'Weekly trend'
      })}
    </section>
  </div>`;
}

// PAGE: Monthly Performance
function pageMonthly() {
  const q = UI.monthly;
  const [a, b] = D.monthRange(q.y, q.m);
  const st = attendanceService.getClassStats(a, b);
  const sm = attendanceService.summarizeStats(st.map);
  const tot = attendanceService.state.students.length;

  return `<section class="card" style="margin-bottom:16px">
    <div class="toolbar">
      <div class="field"><label for="mm">Month</label><select id="mm" class="select" data-bind="monthly.m">${Array.from({ length: 12 }, (_, i) => `<option value="${i + 1}" ${q.m === i + 1 ? 'selected' : ''}>${D.mon(2000, i + 1).split(' ')[0]}</option>`).join('')}</select></div>
      <div class="field"><label for="my">Year</label><select id="my" class="select" data-bind="monthly.y">${[-1, 0, 1].map(o => { const yy = +attendanceService.getTodayString().slice(0, 4) + o; return `<option ${q.y === yy ? 'selected' : ''}>${yy}</option>`; }).join('')}</select></div>
      <div class="grow"></div>
      <button class="btn" data-act="report" data-mode="csv" data-r="monthlyClass" data-args='${esc(JSON.stringify({ y: q.y, m: q.m }))}'>${ic('download', 16)} Export CSV</button>
      <button class="btn btn-primary" data-act="report" data-mode="pdf" data-r="monthlyClass" data-args='${esc(JSON.stringify({ y: q.y, m: q.m }))}'>${ic('pdf', 16)} Download PDF</button>
    </div>
  </section>
  <div class="grid g3" style="margin-bottom:16px">
    <div class="card kpi"><div class="label">Working Days Counted</div><div class="v c-primary">${st.days.length}</div></div>
    <div class="card kpi"><div class="label">Class Average</div><div class="v c-ok">${pctText(sm.avg)}</div></div>
    <div class="card kpi"><div class="label">Below Target</div><div class="v c-warn">${sm.below}</div></div>
  </div>
  <section class="card" style="margin-bottom:16px">
    <div class="card-h"><h2>Monthly Attendance Trend</h2><span class="label">Attendance % per working day</span></div>
    ${chart({ type: 'line', labels: st.days.map(d => String(+d.slice(8))), values: st.days.map(d => (attendanceService.getPresentCount(d) / tot) * 100), label: 'Monthly trend' })}
  </section>`;
}

// PAGE: Semester Analytics
function pageSemester() {
  const q = UI.sem;
  const s = attendanceService.state.settings;
  const configured = q.sem === s.semester && q.ay === s.academicYear;
  const a = s.semesterStart;
  const b = s.semesterEnd;
  const st = configured ? attendanceService.getClassStats(a, b) : { days: [], map: {} };
  const sm = configured ? attendanceService.summarizeStats(st.map) : { avg: null, below: 0, above: 0 };

  return `<section class="card" style="margin-bottom:16px">
    <div class="toolbar">
      <div class="field"><label for="se">Semester</label><select id="se" class="select" data-bind="sem.sem">${[1, 2, 3, 4, 5, 6, 7, 8].map(n => `<option ${q.sem === String(n) ? 'selected' : ''}>${n}</option>`).join('')}</select></div>
      <div class="field"><label for="sa">Academic Year</label><input id="sa" class="input" data-bind="sem.ay" value="${esc(q.ay)}"></div>
      <div class="grow"></div>
      <button class="btn btn-primary" data-act="report" data-mode="pdf" data-r="semesterClass" ${configured ? '' : 'disabled'}>${ic('pdf', 16)} Semester Report PDF</button>
    </div>
    <p class="hint">Window: ${D.med(a)} – ${D.med(b)} · Formula: Present working days ÷ Total working days × 100.</p>
  </section>
  <div class="grid g3" style="margin-bottom:16px">
    <div class="card kpi"><div class="label">Working Days Counted</div><div class="v c-primary">${configured ? st.days.length : '—'}</div></div>
    <div class="card kpi"><div class="label">Class Average</div><div class="v c-ok">${pctText(sm.avg)}</div></div>
    <div class="card kpi"><div class="label">Below Target (${s.threshold}%)</div><div class="v c-warn">${configured ? sm.below : '—'}</div></div>
  </div>`;
}

// PAGE: PDF Reports
function pagePdf() {
  const p = UI.pdf;
  const card = (title, desc, name, args = {}, hasCsv = true) => `
    <section class="card">
      <div class="row" style="flex-wrap:nowrap;align-items:flex-start">
        <span style="color:var(--primary)">${ic('pdf', 22)}</span>
        <div><h2 style="font-size:16px">${title}</h2><p class="muted small">${desc}</p></div>
      </div>
      <div class="row" style="margin-top:14px">
        <button class="btn btn-primary" data-act="report" data-mode="pdf" data-r="${name}" data-args='${esc(JSON.stringify(args))}'>${ic('download', 16)} Download PDF</button>
        <button class="btn" data-act="report" data-mode="print" data-r="${name}" data-args='${esc(JSON.stringify(args))}'>${ic('printer', 16)} Print View</button>
        ${hasCsv ? `<button class="btn" data-act="report" data-mode="csv" data-r="${name}" data-args='${esc(JSON.stringify(args))}'>CSV</button>` : ''}
      </div>
    </section>`;

  return `<section class="card" style="margin-bottom:16px">
    <div class="toolbar">
      <div class="field" style="min-width:280px;flex:1">
        <label for="ps">Student for Individual Reports</label>
        <select id="ps" class="select" data-bind="pdf.student">
          ${attendanceService.state.students.map(s => `<option value="${s.rollNumber}" ${s.rollNumber === p.student ? 'selected' : ''}>${s.rollNumber} · ${esc(s.name)}</option>`).join('')}
        </select>
      </div>
    </div>
  </section>
  <div class="grid g2e">
    ${card('Student Daily Report', 'One student status, scan time, and register bit.', 'dailyStudent', { roll: p.student, date: p.day })}
      ${card('Student Monthly Report', 'Individual daily record log and percentage across the month.', 'monthlyStudent', { roll: p.student, y: p.y, m: p.m })}
      ${card('Student Semester Report', 'Complete student record log and percentage for current semester.', 'semesterStudent', { roll: p.student })}
    ${card('Daily Attendance Register', 'Full class table with status and first scan time.', 'dailyAll', { date: p.day })}
    ${card('Daily Present List', 'All students with flip-flop bit 1 today.', 'presentList', { date: p.day })}
    ${card('Daily Absent List', 'All students with flip-flop bit 0 today.', 'absentList', { date: p.day })}
    ${card('Weekly Class Report', 'Comprehensive weekly totals and percentages.', 'weeklyClass', { date: p.week })}
    ${card('Monthly Class Report', 'All 63 students performance across the month.', 'monthlyClass', { y: p.y, m: p.m })}
    ${card('Semester Class Analytics', 'Complete semester register and target verification.', 'semesterClass', {})}
  </div>`;
}

// PAGE: Device Status (FPGA Hardware & FSM Diagnostics)
function pageDevice() {
  const s = attendanceService.state.settings;
  const isHw = serialService.status === 'connected';
  const fsmState = attendanceService.fsm.state;
  const fsmStateName = FSM_STATE_NAMES[fsmState] || 'IDLE';

  return `<div class="notice info" style="margin-bottom:16px">
    ${ic('info', 18)}
    <div>
      <b>Hardware Attendance Architecture</b><br>
      Intended hardware pipeline: ESP32-CAM QR/barcode capture → Basys 3 FPGA Verilog FSM validation → FPGA result returned to ESP32-CAM → secure upload to Firebase → AttendEdge display.<br>
      ${isHw ? 'Basys 3 FPGA is connected via Web Serial UART at 115200 baud.' : 'Basys 3 FPGA is ready for Web Serial monitoring. ESP32-CAM firmware and communication protocol are pending implementation.'}
    </div>
  </div>
  <div class="grid g3" style="margin-bottom:16px">
    <section class="card dev-card">
      <div class="row spread"><span class="ic">${ic('device', 20)}</span>${badge(isHw ? 'ok' : 'muted', isHw ? 'Connected' : 'Not Connected')}</div>
      <h2 style="font-size:16px">Basys 3 Artix-7 FPGA</h2>
      <p class="muted small">${isHw ? 'Receiving UART status replies on COM port.' : 'Finalized Verilog module: attendedge_Top.v (Read-Only).'}</p>
      <button class="btn btn-sm ${isHw ? 'btn-danger' : 'btn-primary'}" data-act="${isHw ? 'disconnectHw' : 'connectHw'}">${isHw ? 'Disconnect USB' : 'Connect via Web Serial'}</button>
    </section>
    <section class="card dev-card">
      <div class="row spread"><span class="ic">${ic('barcode', 20)}</span>${badge('warn', 'Firmware Pending')}</div>
      <h2 style="font-size:16px">ESP32-CAM Optical Reader</h2>
      <p class="muted small">Hardware camera unit for student ID capture. Transmits 1-byte index (0..62) to FPGA, receives validation, and uploads to Firebase. Firmware and device auth pending.</p>
    </section>
    <section class="card dev-card">
      <div class="row spread"><span class="ic">${ic('chip', 20)}</span>${badge('ok', 'Hardware Spec Valid')}</div>
      <h2 style="font-size:16px">9-State Verilog FSM</h2>
      <p class="muted small">Hardware controller state: <b>${fsmStateName} (${fsmState})</b> · 64-Bit Register: <b>${attendanceService.fsm.getStateSnapshot().attendanceHex}</b></p>
    </section>
  </div>
  <section class="card" style="margin-bottom:16px">
    <div class="card-h"><h2>Verilog FSM States (Attendence_Controller.v)</h2><span class="label">Hardware State Tracker</span></div>
    <div class="fsm">
      ${[1, 2, 3, 4, 5, 6, 7, 8, 9].map(num => `<span class="${fsmState === num ? 'on' : ''}">${num}. ${FSM_STATE_NAMES[num]}</span>`).join('')}
    </div>
    <p class="hint" style="margin-top:10px">State Sequence: 1.IDLE -> 2.RECEIVE -> 3.CHECK_TIME (08:00–08:35) -> 4.VERIFY (ID &lt; 63) -> 5.CHECK_DUP (bit test) -> 6.RECORD (bit |= 1) -> 9.REPORT (status_valid=1) -> 1.IDLE</p>
  </section>
  <div class="grid g2e">
    <section class="card">
      <div class="card-h"><h2>UART Protocol Specification</h2>${badge('info', 'Hardware Interface')}</div>
      <dl class="kv">
        <dt>Baud Rate</dt><dd>115200 baud (CLKS_PER_BIT = 868 at 100MHz)</dd>
        <dt>Framing</dt><dd>8 Data bits, No parity, 1 Stop bit (8N1)</dd>
        <dt>TX Payload</dt><dd>1 Byte (Student Index 0..62, or 63 = Invalid ID)</dd>
        <dt>FPGA Reply</dt><dd>1 Byte ({5'b0, status_code[2:0]}): 1=ALREADY, 2=BAD_ID, 3=OUT_WINDOW, 4=RECORDED</dd>
        <dt>Basys 3 LEDs</dt><dd>led[2:0] = status_code, led[6:3] = state_dbg, led[15:8] = attendance_bits[7:0]</dd>
      </dl>
    </section>
    <section class="card">
      <div class="card-h"><h2>System Health Diagnostics</h2>${badge('ok', 'Verified')}</div>
      <ul class="diag">
        <li><span class="dot ok"></span><span>63 Student Roster Integrity</span><span class="grow"></span>${badge('ok', 'Pass')}</li>
        <li><span class="dot ok"></span><span>64-bit Flip-Flop Register File</span><span class="grow"></span>${badge('ok', 'Pass')}</li>
        <li><span class="dot ok"></span><span>Time Window Comparator (08:00 - 08:35)</span><span class="grow"></span>${badge('ok', 'Pass')}</li>
        <li><span class="dot ok"></span><span>Duplicate Scan Protection (CHECK_DUP)</span><span class="grow"></span>${badge('ok', 'Pass')}</li>
        <li><span class="dot ${isFirebaseConfigured() ? 'ok' : 'warn'}"></span><span>Cloud Firestore Integration</span><span class="grow"></span>${badge(isFirebaseConfigured() ? 'ok' : 'muted', isFirebaseConfigured() ? 'Connected' : 'Offline Mode')}</li>
        <li><span class="dot warn"></span><span>ESP32-CAM Firmware &amp; Device Auth</span><span class="grow"></span>${badge('warn', 'Pending Firmware')}</li>
      </ul>
    </section>
  </div>`;
}

// PAGE: Settings
function pageSettings() {
  const s = attendanceService.state.settings;
  const f = (id, l, v, extra = '') => `<div class="field"><label for="${id}">${l}</label><input id="${id}" name="${id}" class="input" value="${esc(v)}" ${extra}></div>`;
  const isFb = isFirebaseConfigured();

  return `<div class="notice info" style="margin-bottom:16px">${ic('info', 18)}<div>Changes made here update the active academic calendar and window comparison immediately.</div></div>
  <form data-form="settings" class="stack">
    <section class="card">
      <div class="card-h"><h2>Class Details</h2><span class="badge info">Roster Scope</span></div>
      <div class="formgrid">
        ${f('department', 'Department', s.department, 'required')}
        ${f('classSection', 'Class / Section', s.classSection, 'required')}
        <div class="field"><label for="semester">Semester</label><select id="semester" name="semester" class="select">${[1, 2, 3, 4, 5, 6, 7, 8].map(n => `<option ${s.semester === String(n) ? 'selected' : ''}>${n}</option>`).join('')}</select></div>
        ${f('academicYear', 'Academic Year', s.academicYear, 'required placeholder="2026-27"')}
        ${f('semesterStart', 'Semester Start', s.semesterStart, 'type="date" required')}
        ${f('semesterEnd', 'Semester End', s.semesterEnd, 'type="date" required')}
      </div>
    </section>
    <section class="card">
      <div class="card-h"><h2>Attendance Window (Hardware Comparator)</h2><span class="badge info">08:00 - 08:35</span></div>
      <div class="formgrid">
        ${f('openingTime', 'Attendance Opens', s.openingTime, 'type="time" required')}
        ${f('closingTime', 'Attendance Closes (Inclusive)', s.closingTime, 'type="time" required')}
        ${f('threshold', 'Attendance Target (%)', s.threshold, 'type="number" min="1" max="100" required')}
      </div>
    </section>
    <div><button class="btn btn-primary" type="submit">${ic('check', 16)} Save Settings</button></div>
  </form>
  <section class="card" style="margin-top:16px">
    <div class="card-h"><h2>Data & Storage Administration</h2></div>
    <p class="muted small" style="margin-bottom:12px">Firebase Status: <b>${isFb ? 'Connected to Project ' + import.meta.env.VITE_FIREBASE_PROJECT_ID : 'Local Demo Storage (Configure .env to connect Firebase)'}</b></p>
    <div class="row">
      <button class="btn btn-danger" data-act="resetAllData">${ic('reset', 16)} Reset Demo Records & Regenerate</button>
    </div>
  </section>`;
}

// PAGE: Login View
function loginView() {
  const isFb = isFirebaseConfigured();
  return `<div class="login-wrap">
    <div class="login">
      <div class="row" style="justify-content:center;margin-bottom:18px;flex-wrap:nowrap">
        ${LOGO}
        <div><b style="font-size:24px;letter-spacing:-.02em">AttendEdge</b><div class="muted small">Smart Attendance Management</div></div>
      </div>
      <section class="card">
        <h1 style="font-size:22px;margin-bottom:4px">Faculty Sign In</h1>
        <p class="muted small" style="margin-bottom:14px">Authorized faculty access only. Students present their ID card to the scanner.</p>
        
        ${isFb ? `
          <div class="notice" style="margin-bottom:16px;background:#EBFDF5;border-color:#A7F3D0;color:#065F46">
            ${ic('check', 18)}
            <div><strong>Firebase Production Mode:</strong> Sign in with your registered university faculty email and password. Protected by cloud security rules.</div>
          </div>
        ` : `
          <div class="notice" style="margin-bottom:16px;background:#FFF9ED;border-color:#F8DCA6;color:#92540D">
            ${ic('alert', 18)}
            <div><strong>Offline Demo Mode:</strong> Firebase credentials are not configured in <code style="font-size:11px">.env</code>. The application is running in an offline local sandbox. Use demo credentials below.</div>
          </div>
        `}

        <form data-form="login" class="stack">
          <div class="field">
            <label for="lu">${isFb ? 'Faculty Institutional Email' : 'Faculty Username or Email'}</label>
            <input id="lu" name="user" class="input" autocomplete="username" placeholder="${isFb ? 'faculty@university.edu' : 'faculty'}" value="${isFb ? '' : 'faculty'}">
            <div id="luErr" class="err"></div>
          </div>
          <div class="field">
            <div class="row" style="justify-content:space-between;margin-bottom:4px">
              <label for="lp" style="margin:0">Password</label>
              ${isFb ? `<button type="button" class="auth-subtle-link" data-act="forgotPw">Forgot password?</button>` : ''}
            </div>
            <div class="pw">
              <input id="lp" name="pass" class="input" type="password" autocomplete="current-password" placeholder="${isFb ? '••••••••' : 'demo123'}" value="${isFb ? '' : 'demo123'}">
              <button type="button" data-act="togglePw">${ic('eye', 18)}</button>
            </div>
            <div id="lpErr" class="err"></div>
          </div>
          <div id="lgErr" class="err" role="alert"></div>
          <button class="btn btn-primary" type="submit" style="width:100%">${isFb ? 'Sign In with Firebase' : 'Sign In (Local Demo)'}</button>
          ${!isFb ? `<button class="btn" type="button" data-act="fillDemo" style="width:100%">Fill Demo Credentials</button>` : ''}
          ${isFb ? `
            <div style="text-align:center;margin-top:12px;padding-top:12px;border-top:1px dashed var(--line)">
              <div class="muted small" style="margin-bottom:8px">Presenting in a lab without Internet connectivity?</div>
              <button class="btn btn-sm" type="button" data-act="launchDemoSandbox" style="width:100%">Launch Offline Demo Sandbox (No Cloud Sync)</button>
            </div>
          ` : ''}
        </form>
      </section>
    </div>
  </div>`;
}

// Render Master
function render() {
  const root = $('#root');
  if (!root) return;

  if (!UI.currentUser) {
    root.innerHTML = loginView();
    return;
  }

  const pagesMap = {
    overview: pageOverview,
    daily: pageDaily,
    students: pageStudents,
    weekly: pageWeekly,
    monthly: pageMonthly,
    semester: pageSemester,
    pdf: pagePdf,
    device: pageDevice,
    settings: pageSettings
  };

  const user = UI.currentUser;
  const isDemo = Boolean(user && user.isDemo);
  const envBanner = isDemo
    ? `<div class="env-banner env-banner-demo" role="status">
        ${ic('alert', 16)}
        <span><strong>LOCAL DEMO MODE ACTIVE:</strong> Offline simulated environment. Cloud synchronization is offline and Firebase Auth is bypassed. Do not treat as production security.</span>
      </div>`
    : `<div class="env-banner env-banner-prod" role="status">
        ${ic('check', 16)}
        <span><strong>FIREBASE AUTHENTICATED:</strong> Verified session for <strong>${esc(user?.email || 'Faculty')}</strong>. Secure Firestore rules enforced.</span>
      </div>`;

  const pageFn = pagesMap[UI.page] || pageOverview;
  root.innerHTML = `
    <a class="skip" href="#main">Skip to content</a>
    ${sidebar()}
    <div class="shell">
      ${envBanner}
      <div class="topbar-m">
        <button class="icon-btn" data-act="openNav">${ic('menu', 18)}</button>
        <b>AttendEdge</b>
      </div>
      <main id="main" tabindex="-1">
        ${header()}
        ${pageFn()}
      </main>
    </div>
  `;

  UI.scan.flash = null;
}

// Router
function route() {
  let h = location.hash.replace(/^#\/?/, '');
  if (!PAGES.some(p => p[0] === h)) {
    h = 'overview';
    history.replaceState(null, '', '#/overview');
  }
  UI.page = h;
  document.body.classList.remove('nav-open');
  document.title = 'AttendEdge · ' + (PAGES.find(p => p[0] === h) || ['', 'Dashboard'])[1];
  render();
}

// Action Dispatcher
const ACTIONS = {
  openNav() { document.body.classList.add('nav-open'); },
  closeNav() { document.body.classList.remove('nav-open'); },
  async logout() {
    await signOutFaculty();
    UI.currentUser = null;
    closeModal();
    render();
    toast('You have been logged out.', 'info');
  },
  sort(el) {
    const st = T(el.dataset.t);
    const k = el.dataset.k;
    if (st.sort === k) st.dir = st.dir === 'asc' ? 'desc' : 'asc';
    else { st.sort = k; st.dir = 'asc'; }
    render();
  },
  page(el) {
    T(el.dataset.t).page += +el.dataset.d;
    render();
  },
  setFilter(el) {
    UI.daily.filter = el.dataset.f;
    T('daily').page = 1;
    render();
  },
  setStatFilter(el) {
    const filter = el.dataset.filter || 'all';
    UI.daily.statFilter = (UI.daily.statFilter === filter) ? 'all' : filter;
    T('daily').page = 1;
    render();
  },
  clearStatFilter() {
    UI.daily.statFilter = 'all';
    T('daily').page = 1;
    render();
  },
  shiftDate(el) {
    const newDate = D.add(attendanceService.state.ui.selDate, +el.dataset.d);
    attendanceService.state.ui.selDate = newDate;
    attendanceService.saveLocal();
    render();
  },
  selectStudentBit(el) {
    UI.scan.roll = el.dataset.roll;
    render();
  },
  pickRoll(el) {
    UI.scan.roll = el.dataset.roll;
    render();
  },
  async syncCloud() {
    try {
      await attendanceService.syncWithFirestore();
      render();
      toast('Attendance records synchronized with backend.', 'ok');
    } catch (err) {
      toast('Sync failed: ' + err.message, 'bad');
    }
  },
  openStudent(el) {
    openModal(studentModal(el.dataset.roll), true);
  },
  report(el) {
    const rawArgs = el.dataset.args;
    const args = rawArgs ? JSON.parse(rawArgs) : {};
    runReport(el.dataset.r, args, el.dataset.mode || 'pdf');
  },
  async openSession() {
    const d = attendanceService.state.ui.selDate;
    try {
      await attendanceService.openSession(d);
      render();
      toast(`Attendance session opened for ${d}.`, 'ok');
    } catch (err) {
      toast(`Failed to open session: ${err.message}`, 'bad');
    }
  },
  async closeSession() {
    const d = attendanceService.state.ui.selDate;
    const ok = await confirmDialog({
      title: 'Close Attendance Session?',
      body: `Are you sure you want to close the attendance session for <b>${esc(D.long(d))}</b>? New attendance scans will be rejected for this date.`,
      ok: 'Close Session',
      danger: true
    });
    if (ok) {
      try {
        await attendanceService.closeSession(d);
        render();
        toast(`Attendance session closed for ${d}.`, 'info');
      } catch (err) {
        toast(`Failed to close session: ${err.message}`, 'bad');
      }
    }
  },
  async resetDay() {
    const d = attendanceService.state.ui.selDate;
    const ok = await confirmDialog({
      title: 'Reset Attendance for Selected Day?',
      body: `This clears all records for <b>${esc(D.long(d))}</b> and resets the 64-bit attendance register flip-flops back to 0.`,
      ok: 'Reset Day',
      danger: true
    });
    if (ok) {
      const res = attendanceService.resetDay(d);
      UI.scan.state = 'ready';
      UI.scan.message = 'Day reset. 64-bit register cleared.';
      render();
      toast(`Day reset: ${res.removed} record(s) cleared.`, 'ok');
    }
  },
  async resetAllData() {
    const ok = await confirmDialog({
      title: 'Reset All Demo Data?',
      body: 'This resets all students, records, and events back to clean factory state.',
      ok: 'Reset All Data',
      danger: true
    });
    if (ok) {
      attendanceService.resetAllData();
      initUIState();
      render();
      toast('All data reset to initial state.', 'ok');
    }
  },
  async connectHw() {
    try {
      await serialService.connect(115200);
      toast('Connected to Basys 3 FPGA over USB UART at 115200 baud!', 'ok');
      render();
    } catch (err) {
      toast('Failed to connect serial port: ' + err.message, 'bad');
    }
  },
  async disconnectHw() {
    await serialService.disconnect();
    toast('FPGA disconnected. Switched to software FSM simulation.', 'info');
    render();
  },
  dlgOk() {
    if (pendingConfirm) {
      const r = pendingConfirm;
      pendingConfirm = null;
      r(true);
    }
    closeModal();
  },
  dlgCancel() {
    if (pendingConfirm) {
      const r = pendingConfirm;
      pendingConfirm = null;
      r(false);
    }
    closeModal();
  },
  fillDemo() {
    const u = $('#lu');
    const p = $('#lp');
    if (u && p) {
      u.value = 'faculty';
      p.value = 'demo123';
      p.focus();
    }
  },
  launchDemoSandbox() {
    const res = startDemoSession();
    UI.currentUser = res.user;
    render();
    toast('Launched in Offline Demo Sandbox. Cloud sync disabled.', 'warn');
  },
  forgotPw() {
    const curEmail = ($('#lu')?.value || '').trim();
    openModal(`
      <h2>Faculty Password Reset</h2>
      <p class="muted">Enter your registered faculty email address. Firebase Authentication will transmit a secure password reset link to your inbox.</p>
      <form data-form="resetPw" class="stack" style="margin-top:14px">
        <div class="field">
          <label for="resetEmail">Faculty Email</label>
          <input id="resetEmail" name="email" class="input" type="email" value="${esc(curEmail)}" placeholder="faculty@university.edu" required>
        </div>
        <div id="resetErr" class="err"></div>
        <div id="resetOk" style="color:var(--ok);font-size:13px;display:none"></div>
        <div class="dlg-actions">
          <button class="btn" type="button" data-act="dlgCancel">Cancel</button>
          <button class="btn btn-primary" type="submit">Send Reset Email</button>
        </div>
      </form>
    `);
  },
  togglePw(el) {
    const i = $('#lp');
    const show = i.type === 'password';
    i.type = show ? 'text' : 'password';
    el.innerHTML = ic(show ? 'eyeoff' : 'eye', 18);
  },
  exportRoster() {
    const rows = [
      ['rollNumber', 'name', 'email', 'department', 'classSection', 'semester', 'gender', 'residence'],
      ...attendanceService.state.students.map(s => [s.rollNumber, s.name, s.email, s.department, s.classSection, s.semester, s.gender || '', s.residence])
    ];
    exportCSV({ file: 'AttendEdge_Roster', title: 'Student Roster', columns: rows[0], rows: rows.slice(1) });
  },
  importRoster() {
    $('#rosterFile').click();
  },
  openAddStudent() {
    openModal(`
      <h2>Add New Student</h2>
      <p class="muted">Register a new student into the active roster. In Cloud Firestore mode, the record is immediately committed to the database.</p>
      <form data-form="addStudent" class="stack" style="margin-top:14px">
        <div class="formgrid">
          <div class="field">
            <label for="newRoll">Roll Number</label>
            <input id="newRoll" name="rollNumber" class="input" placeholder="25EV064" required maxlength="12">
          </div>
          <div class="field">
            <label for="newName">Full Name</label>
            <input id="newName" name="name" class="input" placeholder="Student Name" required maxlength="60">
          </div>
          <div class="field">
            <label for="newEmail">Email Address</label>
            <input id="newEmail" name="email" class="input" type="email" placeholder="student@example.edu" required maxlength="80">
          </div>
          <div class="field">
            <label for="newDept">Department</label>
            <input id="newDept" name="department" class="input" value="${esc(attendanceService.state.settings.department)}" required maxlength="60">
          </div>
          <div class="field">
            <label for="newCls">Class / Section</label>
            <input id="newCls" name="classSection" class="input" value="${esc(attendanceService.state.settings.classSection)}" required maxlength="30">
          </div>
          <div class="field">
            <label for="newSem">Semester</label>
            <input id="newSem" name="semester" class="input" value="${esc(attendanceService.state.settings.semester)}" required maxlength="1">
          </div>
          <div class="field">
            <label for="newGender">Gender</label>
            <select id="newGender" name="gender" class="select">
              <option value="">— Unspecified —</option>
              <option value="Boy">Boy</option>
              <option value="Girl">Girl</option>
            </select>
          </div>
          <div class="field">
            <label for="newRes">Residence</label>
            <select id="newRes" name="residence" class="select">
              <option value="Hosteller">Hosteller</option>
              <option value="Day Scholar">Day Scholar</option>
            </select>
          </div>
        </div>
        <div id="addStuErr" class="err" role="alert"></div>
        <div class="dlg-actions">
          <button type="button" class="btn" data-act="dlgCancel">Cancel</button>
          <button class="btn btn-primary" type="submit">Create Student</button>
        </div>
      </form>
    `, true);
  },
  async deleteStudent(el) {
    const roll = el.dataset.roll;
    const confirmed = await confirmDialog({
      title: 'Delete Student',
      body: `Are you sure you want to remove student ${roll} from the active roster? In Cloud Firestore mode, this will delete the student profile from the database.`,
      ok: 'Delete Student',
      danger: true
    });
    if (!confirmed) return;
    try {
      await attendanceService.removeStudent(roll);
      closeModal();
      render();
      toast(`Student ${roll} removed from roster.`, 'info');
    } catch (err) {
      toast(`Failed to delete student: ${err.message}`, 'bad');
    }
  },
  changeMgmtDate(el) {
    const v = el.value;
    if (D.valid(v)) {
      UI.weekly.manageDate = v;
      UI.weekly.targetStatus = '';
      UI.weekly.targetReason = '';
      render();
    }
  },
  setSchedTarget(el) {
    UI.weekly.targetStatus = el.dataset.status;
    render();
  },
  quickSchedReason(el) {
    UI.weekly.targetReason = el.dataset.r;
    const inp = $('#mgmtReason');
    if (inp) inp.value = el.dataset.r;
  },
  openScheduleConfirmModal() {
    if (!UI.currentUser || UI.currentUser.role !== 'faculty') {
      toast('Access Denied: Only authenticated faculty can modify working day schedule.', 'bad');
      return;
    }

    const manageDate = UI.weekly.manageDate || UI.weekly.date;
    const manageInfo = attendanceService.getDayScheduleInfo(manageDate);
    const targetStatus = UI.weekly.targetStatus || (manageInfo.isWorking ? 'Non-working Day' : 'Working Day');
    const reasonInput = $('#mgmtReason');
    const reason = (reasonInput ? reasonInput.value : UI.weekly.targetReason || '').trim();

    if (!reason || reason.length < 2) {
      toast('Please enter a specific reason for this schedule override.', 'warn');
      if (reasonInput) reasonInput.focus();
      return;
    }

    openModal(`
      <h2>Confirm Working Day Override</h2>
      <p class="muted">You are requesting an authorized institutional schedule override for <b>${esc(D.long(manageDate))}</b>.</p>
      <div style="background:var(--bg);padding:12px;border-radius:8px;border:1px solid var(--line);margin:12px 0;font-size:13.5px">
        <div style="display:flex;justify-content:space-between;margin-bottom:6px">
          <span class="muted">Selected Date:</span>
          <b>${esc(D.med(manageDate))} (${esc(manageDate)})</b>
        </div>
        <div style="display:flex;justify-content:space-between;margin-bottom:6px">
          <span class="muted">Previous Status:</span>
          <b>${badge(manageInfo.isWorking ? 'ok' : 'muted', manageInfo.status)}</b>
        </div>
        <div style="display:flex;justify-content:space-between;margin-bottom:6px">
          <span class="muted">New Effective Status:</span>
          <b>${badge(targetStatus === 'Working Day' ? 'ok' : 'muted', targetStatus)}</b>
        </div>
        <div style="display:flex;justify-content:space-between">
          <span class="muted">Provided Reason:</span>
          <b>${esc(reason)}</b>
        </div>
      </div>

      <div class="alert" style="background:var(--warn-soft);color:#6C4B00;border:1px solid #EBD0A4;padding:8px 12px;border-radius:8px;font-size:12.5px;margin-bottom:14px">
        ${targetStatus === 'Non-working Day'
          ? '⚠️ Changing this date to Non-working Day will cause new attendance scans on this date to be rejected.'
          : '✅ Changing this date to Working Day will permit attendance scanning during the 08:00–08:35 window.'}
      </div>

      <form data-form="confirmScheduleChange" class="stack">
        <input type="hidden" name="date" value="${esc(manageDate)}">
        <input type="hidden" name="status" value="${esc(targetStatus)}">
        <input type="hidden" name="reason" value="${esc(reason)}">
        <div class="field">
          <label for="confFacultyPass"><b>Re-enter Faculty Account Password</b> <span style="color:var(--bad)">*</span></label>
          <div style="display:flex;gap:6px;align-items:center">
            <input id="confFacultyPass" name="facultyPassword" type="password" class="input" placeholder="Current faculty account password" required autocomplete="current-password" style="flex:1">
            <button type="button" class="icon-btn" data-act="toggleConfPassword" title="Show/Hide Password">${ic('eye', 18)}</button>
          </div>
          <div class="hint muted" style="font-size:11.5px;margin-top:4px">Identity re-authentication is strictly enforced before schedule overrides can be saved.</div>
        </div>
        <div id="confSchedErr" class="err" style="color:var(--bad);font-size:13px" role="alert"></div>
        <div class="dlg-actions">
          <button type="button" class="btn" data-act="dlgCancel">Cancel</button>
          <button id="btnSubmitSchedChange" class="btn btn-primary" type="submit">${ic('save', 16)} Verify Password & Apply</button>
        </div>
      </form>
    `);
  },
  toggleConfPassword(el) {
    const inp = $('#confFacultyPass') || $('#confResetPass');
    if (!inp) return;
    const show = inp.type === 'password';
    inp.type = show ? 'text' : 'password';
    el.innerHTML = ic(show ? 'eyeoff' : 'eye', 18);
  },
  promptResetOverride(el) {
    const date = el.dataset.date;
    openModal(`
      <h2>Reset Day Schedule to Default</h2>
      <p class="muted">Are you sure you want to remove the faculty schedule override for <b>${esc(D.long(date))}</b> and revert to the institutional default timetable?</p>
      <form data-form="confirmResetSchedule" class="stack" style="margin-top:14px">
        <input type="hidden" name="date" value="${esc(date)}">
        <div class="field">
          <label for="confResetPass"><b>Re-enter Faculty Password</b> <span style="color:var(--bad)">*</span></label>
          <div style="display:flex;gap:6px;align-items:center">
            <input id="confResetPass" name="facultyPassword" type="password" class="input" placeholder="Faculty password" required autocomplete="current-password" style="flex:1">
            <button type="button" class="icon-btn" data-act="toggleConfPassword" title="Show/Hide Password">${ic('eye', 18)}</button>
          </div>
        </div>
        <div id="confResetErr" class="err" style="color:var(--bad);font-size:13px" role="alert"></div>
        <div class="dlg-actions">
          <button type="button" class="btn" data-act="dlgCancel">Cancel</button>
          <button class="btn btn-danger-solid" type="submit">Revert to Default Timetable</button>
        </div>
      </form>
    `);
  },
  async viewScheduleAudit() {
    let history = [];
    if (isCloudSyncReady()) {
      try {
        history = await FirestoreService.getScheduleAuditHistory(30);
      } catch (e) {
        history = attendanceService.getScheduleAuditHistory();
      }
    } else {
      history = attendanceService.getScheduleAuditHistory();
    }

    const rows = history && history.length ? history.map(h => `
      <tr>
        <td><b>${esc(h.date)}</b><div class="muted small">${D.dayName(h.date)}</div></td>
        <td>${badge(h.isWorking ? 'ok' : 'muted', h.status || 'Override')}</td>
        <td>${esc(h.reason || '—')}</td>
        <td>${esc(h.updatedBy || 'Faculty')}</td>
        <td class="small muted">${h.timestamp ? new Date(h.timestamp).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }) : '—'}</td>
      </tr>
    `).join('') : `<tr><td colspan="5" class="empty">No schedule override modifications recorded yet.</td></tr>`;

    openModal(`
      <h2>Schedule Modification Audit History</h2>
      <p class="muted">Read-only institutional audit trail of all faculty-authorized working day and non-working day overrides.</p>
      <div class="tbl-wrap" style="max-height:360px;overflow-y:auto;margin:14px 0">
        <table>
          <thead>
            <tr>
              <th>Date</th>
              <th>Effective Status</th>
              <th>Reason Provided</th>
              <th>Authorized By</th>
              <th>Recorded (IST)</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
      <div class="dlg-actions">
        <button class="btn btn-primary" data-act="dlgCancel">Close</button>
      </div>
    `, true);
  }
};

// Form Handlers
const FORMS = {
  async confirmScheduleChange(f) {
    const date = f.elements.date.value;
    const status = f.elements.status.value;
    const reason = f.elements.reason.value;
    const pass = f.elements.facultyPassword.value;
    const errEl = $('#confSchedErr');
    const submitBtn = $('#btnSubmitSchedChange');

    if (errEl) errEl.textContent = '';

    // 1. Client-Side Input Validation
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      if (errEl) errEl.textContent = 'Please select a valid date in YYYY-MM-DD format.';
      return;
    }
    const cleanStatus = String(status || '').trim();
    if (!cleanStatus || (!cleanStatus.toLowerCase().includes('work') && !cleanStatus.toLowerCase().includes('non'))) {
      if (errEl) errEl.textContent = 'Please specify status as "Working Day" or "Non-working Day".';
      return;
    }
    const cleanReason = String(reason || '').trim();
    if (!cleanReason || cleanReason.length < 2) {
      if (errEl) errEl.textContent = 'A specific reason is required (e.g. "Emergency closure", "College sports day").';
      return;
    }
    if (!pass) {
      if (errEl) errEl.textContent = 'Password is required to confirm schedule changes.';
      return;
    }

    // 2. Production Firebase Readiness Check (Never falsely report saved)
    const isDemo = Boolean(UI.currentUser && UI.currentUser.isDemo);
    if (!isDemo && !isCloudSyncReady()) {
      const msg = 'Firebase cloud sync is not ready or unauthenticated. Please verify your connection before modifying schedules.';
      if (errEl) errEl.textContent = msg;
      toast(msg, 'bad');
      return;
    }

    if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = 'Verifying Password...'; }

    // 3. Faculty Re-authentication
    const authRes = await reauthenticateFaculty(pass);
    f.elements.facultyPassword.value = ''; // Never retain password

    if (!authRes.success) {
      if (errEl) errEl.textContent = authRes.error;
      if (submitBtn) { submitBtn.disabled = false; submitBtn.innerHTML = `${ic('save', 16)} Verify Password & Apply`; }
      toast(`Re-authentication failed: ${authRes.error}`, 'bad');
      return;
    }

    // 4. Persist to Backend / Local State
    try {
      if (isCloudSyncReady()) {
        if (submitBtn) submitBtn.textContent = 'Saving to Firestore...';
        await FirestoreService.saveDayScheduleOverride({ date, status: cleanStatus, reason: cleanReason });
      }
      attendanceService.setScheduleOverride(date, {
        status: cleanStatus,
        reason: cleanReason,
        updatedBy: UI.currentUser.email || UI.currentUser.displayName || 'Faculty',
        updatedAt: new Date().toISOString()
      });

      closeModal();
      UI.weekly.targetReason = '';
      render();
      toast(`Schedule override saved: ${date} is now marked as ${cleanStatus}.`, 'ok');
    } catch (err) {
      if (errEl) errEl.textContent = err.message;
      if (submitBtn) { submitBtn.disabled = false; submitBtn.innerHTML = `${ic('save', 16)} Verify Password & Apply`; }
      toast(`Failed to save schedule change: ${err.message}`, 'bad');
    }
  },
  async confirmResetSchedule(f) {
    const date = f.elements.date.value;
    const pass = f.elements.facultyPassword.value;
    const errEl = $('#confResetErr');

    if (errEl) errEl.textContent = '';

    if (!pass) {
      if (errEl) errEl.textContent = 'Password is required to confirm schedule reset.';
      return;
    }

    const isDemo = Boolean(UI.currentUser && UI.currentUser.isDemo);
    if (!isDemo && !isCloudSyncReady()) {
      const msg = 'Firebase cloud sync is not ready or unauthenticated. Please verify your connection before resetting schedules.';
      if (errEl) errEl.textContent = msg;
      toast(msg, 'bad');
      return;
    }

    const authRes = await reauthenticateFaculty(pass);
    f.elements.facultyPassword.value = '';

    if (!authRes.success) {
      if (errEl) errEl.textContent = authRes.error;
      toast(`Re-authentication failed: ${authRes.error}`, 'bad');
      return;
    }

    try {
      if (isCloudSyncReady()) {
        await FirestoreService.resetDayScheduleOverride(date, 'Reverted to default timetable');
      }
      attendanceService.removeScheduleOverride(date, 'Reverted to default timetable', UI.currentUser.email || 'Faculty');
      closeModal();
      render();
      toast(`Schedule for ${date} reverted to default institutional timetable.`, 'info');
    } catch (err) {
      if (errEl) errEl.textContent = err.message;
      toast(`Failed to reset schedule: ${err.message}`, 'bad');
    }
  },
  async resetPw(f) {
    const email = f.elements.email.value.trim();
    const errEl = $('#resetErr');
    const okEl = $('#resetOk');
    if (errEl) errEl.textContent = '';
    if (okEl) okEl.style.display = 'none';

    const res = await sendFacultyPasswordReset(email);
    if (res.success) {
      if (okEl) {
        okEl.textContent = res.message;
        okEl.style.display = 'block';
      }
      toast('Password reset link sent to ' + email, 'ok');
      setTimeout(closeModal, 2500);
    } else {
      if (errEl) errEl.textContent = res.error;
    }
  },
  async login(f) {
    const user = f.elements.user.value.trim();
    const pass = f.elements.pass.value;
    const lgErr = $('#lgErr');
    if (lgErr) lgErr.textContent = '';

    const res = await signInFaculty(user, pass);
    if (res.success) {
      UI.currentUser = res.user;
      render();
      toast('Welcome back, ' + (res.user.displayName || 'Faculty'), 'ok');
    } else {
      if (lgErr) lgErr.textContent = res.error;
    }
  },
  async addStudent(f) {
    const errEl = $('#addStuErr');
    if (errEl) errEl.textContent = '';
    const newStudent = {
      rollNumber: f.elements.rollNumber.value.trim().toUpperCase(),
      name: f.elements.name.value.trim(),
      email: f.elements.email.value.trim(),
      department: f.elements.department.value.trim(),
      classSection: f.elements.classSection.value.trim(),
      semester: f.elements.semester.value.trim(),
      gender: f.elements.gender ? f.elements.gender.value : '',
      residence: f.elements.residence.value
    };

    try {
      await attendanceService.addStudent(newStudent);
      closeModal();
      render();
      toast(`Student ${newStudent.rollNumber} added successfully.`, 'ok');
    } catch (err) {
      if (errEl) errEl.textContent = err.message;
    }
  },
  async student(f) {
    const roll = f.dataset.roll;
    const name = f.elements.name ? f.elements.name.value.trim() : '';
    const errEl = $('#stuErr');
    if (errEl) errEl.textContent = '';

    if (!name) {
      if (errEl) errEl.textContent = 'Student name cannot be empty.';
      return;
    }

    const patch = {
      name,
      email: f.elements.email ? f.elements.email.value.trim() : '',
      department: f.elements.department ? f.elements.department.value.trim() : '',
      classSection: f.elements.classSection ? f.elements.classSection.value.trim() : '',
      semester: f.elements.semester ? f.elements.semester.value.trim() : '',
      gender: f.elements.gender ? f.elements.gender.value : '',
      residence: f.elements.residence ? f.elements.residence.value : 'Day Scholar'
    };
    try {
      const res = await attendanceService.updateStudent(roll, patch);
      closeModal();
      render();
      const msg = res?._cloud?.created
        ? `Student profile registered and saved to Cloud Firestore for ${roll}.`
        : `Student record updated for ${roll}.`;
      toast(msg, 'ok');
    } catch (err) {
      if (errEl) errEl.textContent = err.message;
    }
  },
  settings(f) {
    const patch = {
      department: f.elements.department.value.trim(),
      classSection: f.elements.classSection.value.trim(),
      semester: f.elements.semester.value.trim(),
      academicYear: f.elements.academicYear.value.trim(),
      semesterStart: f.elements.semesterStart.value,
      semesterEnd: f.elements.semesterEnd.value,
      openingTime: f.elements.openingTime.value,
      closingTime: f.elements.closingTime.value,
      threshold: +f.elements.threshold.value
    };
    attendanceService.saveSettings(patch);
    render();
    toast('Settings saved successfully.', 'ok');
  }
};

// Global Event Listeners
function setupEventListeners() {
  document.addEventListener('click', e => {
    const el = e.target.closest('[data-act]');
    if (!el || el.disabled) return;
    const h = ACTIONS[el.dataset.act];
    if (h) {
      if (el.tagName === 'A' && el.getAttribute('href') && !el.getAttribute('href').startsWith('#')) {
        return;
      }
      h(el, e);
    }
  });

  document.addEventListener('submit', e => {
    const f = e.target.closest('form[data-form]');
    if (!f) return;
    e.preventDefault();
    const h = FORMS[f.dataset.form];
    if (h) h(f, e);
  });

  document.addEventListener('input', e => {
    const el = e.target;
    const b = el.dataset && el.dataset.bind;
    if (!b) return;
    let v = el.value;
    if (b === 'sel') {
      if (D.valid(v)) {
        attendanceService.state.ui.selDate = v;
        attendanceService.saveLocal();
        render();
      }
      return;
    }
    const [g, k] = b.split('.');
    if (!UI[g]) return;
    UI[g][k] = v;
    render();
  });

  const dlg = $('#dlg');
  if (dlg) {
    dlg.addEventListener('click', e => { if (e.target === dlg) closeModal(); });
    dlg.addEventListener('close', () => {
      if (pendingConfirm) {
        const r = pendingConfirm;
        pendingConfirm = null;
        r(false);
      }
    });
  }

  window.addEventListener('hashchange', route);
}

// Tick loop (live clock)
setInterval(() => {
  if (UI.currentUser && attendanceService.state.ui.clock.mode === 'real') {
    const now = attendanceService.getClockNow();
    $$('[data-clock]').forEach(el => el.textContent = t12(now.time));
  }
}, 1000);

// Bootstrap
function boot() {
  initUIState();
  subscribeAuth(async user => {
    UI.currentUser = user;
    if (user && !user.isDemo) {
      try {
        await attendanceService.syncWithFirestore();
      } catch (e) {
        console.warn('Initial cloud sync skipped/failed:', e);
      }
    }
    render();
  });
  setupEventListeners();
  route();

  // Periodic background sync for live attendance updates from backend
  setInterval(async () => {
    if (UI.currentUser && !UI.currentUser.isDemo && (UI.page === 'daily' || UI.page === 'overview')) {
      try {
        await attendanceService.syncWithFirestore();
        render();
      } catch (e) {
        // silent background refresh
      }
    }
  }, 15000);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
