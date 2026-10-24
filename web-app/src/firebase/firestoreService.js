import {
  collection,
  doc,
  getDocs,
  getDoc,
  setDoc,
  updateDoc,
  deleteDoc,
  query,
  where,
  orderBy,
  limit,
  runTransaction
} from 'firebase/firestore';
import { httpsCallable } from 'firebase/functions';
import { db, auth, functions, isFirebaseConfigured } from './config.js';

export const CONNECTION_STATES = {
  LOCAL_DEMO: 'LOCAL_DEMO',
  FIREBASE_AUTH_REQUIRED: 'FIREBASE_AUTH_REQUIRED',
  FIREBASE_CONNECTED: 'FIREBASE_CONNECTED',
  FIREBASE_ERROR: 'FIREBASE_ERROR'
};

let lastConnectionError = null;

export function setConnectionError(err) {
  lastConnectionError = {
    message: err.message || String(err),
    code: err.code || 'unknown',
    timestamp: Date.now()
  };
}

export function clearConnectionError() {
  lastConnectionError = null;
}

export function getConnectionState() {
  if (!isFirebaseConfigured()) {
    return {
      state: CONNECTION_STATES.LOCAL_DEMO,
      label: 'Local Demo Mode',
      details: 'Firebase credentials are not configured in .env. Running in offline sandbox.'
    };
  }

  if (!auth || !auth.currentUser) {
    return {
      state: CONNECTION_STATES.FIREBASE_AUTH_REQUIRED,
      label: 'Firebase Auth Required',
      details: 'Firebase project configured. Please sign in with registered faculty credentials.'
    };
  }

  if (lastConnectionError) {
    return {
      state: CONNECTION_STATES.FIREBASE_ERROR,
      label: 'Firebase Error',
      details: `Database connection error: ${lastConnectionError.message} (${lastConnectionError.code})`,
      error: lastConnectionError
    };
  }

  return {
    state: CONNECTION_STATES.FIREBASE_CONNECTED,
    label: 'Firebase Connected',
    details: `Connected to Cloud Firestore as ${auth.currentUser.email}.`,
    userEmail: auth.currentUser.email,
    uid: auth.currentUser.uid
  };
}

export function isCloudSyncReady() {
  return Boolean(
    isFirebaseConfigured() &&
    db !== null &&
    auth !== null &&
    auth.currentUser !== null
  );
}

/**
 * Maps raw or opaque Firebase Functions errors into specific, safe diagnostic messages
 * and captures real error codes (e.g. functions/internal, functions/not-found, functions/unauthenticated).
 */
export function mapFunctionsError(err) {
  if (!err) {
    return {
      code: 'functions/unknown',
      message: 'Unknown error occurred while contacting Cloud Function.'
    };
  }

  const rawCode = err.code || err.statusCode || 'unknown';
  const cleanCode = String(rawCode).replace(/^functions\//, '');
  const rawMsg = err.message || '';

  // If the error already contains a specific domain message (e.g. from validation or custom rejection)
  // preserve it instead of replacing it with a generic fallback
  const isGenericMessage = !rawMsg || rawMsg === 'internal' || rawMsg === 'INTERNAL' || rawMsg === cleanCode;

  switch (cleanCode) {
    case 'internal':
      return {
        code: 'functions/internal',
        message: isGenericMessage
          ? 'Cloud Function "recordAttendance" is not reachable or not deployed in region asia-south1 for project attendedge-11745.'
          : rawMsg
      };
    case 'not-found':
      return {
        code: 'functions/not-found',
        message: isGenericMessage
          ? 'Cloud Function "recordAttendance" was not found in project attendedge-11745 (region: asia-south1). Deployment required.'
          : rawMsg
      };
    case 'unauthenticated':
      return {
        code: 'functions/unauthenticated',
        message: isGenericMessage
          ? 'Authentication required: Caller must be signed in with valid faculty credentials.'
          : rawMsg
      };
    case 'permission-denied':
      return {
        code: 'functions/permission-denied',
        message: isGenericMessage
          ? 'Faculty authorization required: Caller lacks verified faculty role in /faculty registry or custom claims.'
          : rawMsg
      };
    case 'unavailable':
      return {
        code: 'functions/unavailable',
        message: isGenericMessage
          ? 'Firebase Cloud Functions service is currently unavailable. Please verify network connectivity.'
          : rawMsg
      };
    case 'deadline-exceeded':
      return {
        code: 'functions/deadline-exceeded',
        message: isGenericMessage
          ? 'Cloud Function request timed out. Please try scanning again.'
          : rawMsg
      };
    case 'invalid-argument':
      return {
        code: 'functions/invalid-argument',
        message: isGenericMessage
          ? 'Invalid request: Student roll number or scan parameters are invalid.'
          : rawMsg
      };
    default:
      return {
        code: String(rawCode).startsWith('functions/') ? rawCode : (rawCode !== 'unknown' ? `functions/${rawCode}` : 'functions/unknown'),
        message: isGenericMessage ? `Cloud Function rejected request (${rawCode}).` : rawMsg
      };
  }
}

export const FirestoreService = {
  getSyncStatus() {
    return getConnectionState();
  },

  /**
   * Verified Faculty Authorization Check:
   * 1. Checks custom claims (role == 'faculty' or faculty == true)
   * 2. If claims not yet propagated, checks /faculty/{uid} registry document in Firestore
   */
  async verifyFacultyAuthorization(user) {
    if (!user || !user.uid) {
      return { authorized: false, reason: 'No user provided' };
    }

    try {
      if (typeof user.getIdTokenResult === 'function') {
        const idTokenResult = await user.getIdTokenResult();
        if (idTokenResult.claims.role === 'faculty' || idTokenResult.claims.faculty === true) {
          return { authorized: true, role: 'faculty', source: 'custom_claim' };
        }
      }

      if (db) {
        const facultyRef = doc(db, 'faculty', user.uid);
        const facultySnap = await getDoc(facultyRef);
        if (facultySnap.exists()) {
          const data = facultySnap.data();
          if (data.role === 'faculty' || data.disabled !== true) {
            return { authorized: true, role: 'faculty', source: 'firestore_registry', profile: data };
          }
        }
      }

      return {
        authorized: false,
        reason: 'User authenticated in Firebase, but not granted faculty privileges in custom claims or /faculty registry.'
      };
    } catch (err) {
      setConnectionError(err);
      return { authorized: false, reason: err.message };
    }
  },

  /**
   * Students Roster Management
   */
  async getStudents() {
    if (!isCloudSyncReady()) return null;
    try {
      const snap = await getDocs(collection(db, 'students'));
      clearConnectionError();
      if (!snap.empty) {
        return snap.docs.map(d => ({
          ...d.data(),
          id: d.id,
          rollNumber: d.data().rollNumber || d.id
        }));
      }
      return [];
    } catch (err) {
      setConnectionError(err);
      console.error('[AttendEdge] getStudents error:', err);
      throw new Error(`Failed to load students from Firestore: ${err.message} (${err.code || 'unknown'})`);
    }
  },

  async addStudent(student) {
    if (!isCloudSyncReady()) {
      throw new Error('Cannot add student: Firebase is not authenticated.');
    }
    const cleanRoll = String(student.rollNumber || '').trim().toUpperCase();
    if (!cleanRoll) throw new Error('Student roll number is required.');

    try {
      const ref = doc(db, 'students', cleanRoll);
      const existing = await getDoc(ref);
      if (existing.exists()) {
        throw new Error(`Student with roll number ${cleanRoll} already exists.`);
      }

      const payload = {
        ...student,
        rollNumber: cleanRoll,
        updatedAt: new Date().toISOString()
      };
      await setDoc(ref, payload);
      clearConnectionError();
      return { success: true, student: payload };
    } catch (err) {
      setConnectionError(err);
      console.error('[AttendEdge] addStudent error:', err);
      throw err;
    }
  },

  async updateStudent(rollNumber, patch, existingStudent = null) {
    if (!isCloudSyncReady()) {
      throw new Error('Cannot update student: Firebase is not authenticated.');
    }
    const cleanRoll = String(rollNumber || '').trim().toUpperCase();
    if (!cleanRoll) throw new Error('Student roll number is required.');

    try {
      // 1. Primary path: /students/{cleanRoll}
      let targetRef = doc(db, 'students', cleanRoll);
      let snap = await getDoc(targetRef);

      // 2. Check alternate document ID if existingStudent.id is different from roll number
      if (!snap.exists() && existingStudent?.id && existingStudent.id !== cleanRoll) {
        const altRef = doc(db, 'students', String(existingStudent.id));
        const altSnap = await getDoc(altRef);
        if (altSnap.exists()) {
          targetRef = altRef;
          snap = altSnap;
        }
      }

      // 3. Check by querying rollNumber attribute
      if (!snap.exists()) {
        const q = query(collection(db, 'students'), where('rollNumber', '==', cleanRoll), limit(1));
        const qSnap = await getDocs(q);
        if (!qSnap.empty) {
          targetRef = qSnap.docs[0].ref;
          snap = qSnap.docs[0];
        }
      }

      // 4. If document exists in Firestore, use updateDoc to modify only updated fields
      if (snap.exists()) {
        const updatePayload = {
          ...patch,
          updatedAt: new Date().toISOString()
        };
        // Preserve fixed roll number
        delete updatePayload.rollNumber;

        await updateDoc(targetRef, updatePayload);
        clearConnectionError();
        return { success: true, created: false };
      }

      // 5. If document is genuinely missing from Firestore, initialize it safely from existing roster profile
      if (existingStudent) {
        console.info(`[AttendEdge] Initializing missing Firestore profile for roster student ${cleanRoll} in /students/${cleanRoll}`);
        const fullPayload = {
          ...existingStudent,
          ...patch,
          rollNumber: cleanRoll,
          placeholder: false,
          createdAt: existingStudent.createdAt || new Date().toISOString(),
          updatedAt: new Date().toISOString()
        };
        // Remove undefined values to prevent Firestore errors
        Object.keys(fullPayload).forEach(k => {
          if (fullPayload[k] === undefined) delete fullPayload[k];
        });

        const newDocRef = doc(db, 'students', cleanRoll);
        await setDoc(newDocRef, fullPayload);
        clearConnectionError();
        return { success: true, created: true };
      }

      throw new Error(`Student ${cleanRoll} not found in Firestore or roster.`);
    } catch (err) {
      setConnectionError(err);
      console.error('[AttendEdge] updateStudent error:', err);
      throw err;
    }
  },

  async removeStudent(rollNumber) {
    if (!isCloudSyncReady()) {
      throw new Error('Cannot delete student: Firebase is not authenticated.');
    }
    const cleanRoll = String(rollNumber || '').trim().toUpperCase();
    try {
      const ref = doc(db, 'students', cleanRoll);
      await deleteDoc(ref);
      clearConnectionError();
      return { success: true };
    } catch (err) {
      setConnectionError(err);
      console.error('[AttendEdge] removeStudent error:', err);
      throw err;
    }
  },

  async saveStudentsBatch(students) {
    if (!isCloudSyncReady()) {
      throw new Error('Cannot save students batch: Firebase is not authenticated.');
    }
    try {
      for (const s of students) {
        const cleanRoll = String(s.rollNumber || '').trim().toUpperCase();
        if (cleanRoll) {
          const ref = doc(db, 'students', cleanRoll);
          await setDoc(ref, { ...s, rollNumber: cleanRoll }, { merge: true });
        }
      }
      clearConnectionError();
      return true;
    } catch (err) {
      setConnectionError(err);
      console.error('[AttendEdge] saveStudentsBatch error:', err);
      throw err;
    }
  },

  /**
   * Daily Attendance Sessions Management
   */
  async getSession(date) {
    if (!isCloudSyncReady()) return null;
    try {
      const ref = doc(db, 'sessions', date);
      const snap = await getDoc(ref);
      clearConnectionError();
      if (snap.exists()) return snap.data();
      return null;
    } catch (err) {
      setConnectionError(err);
      console.error('[AttendEdge] getSession error:', err);
      throw err;
    }
  },

  async openSession(date, sessionMeta) {
    if (!isCloudSyncReady()) {
      throw new Error('Cannot open session: Firebase is not authenticated.');
    }
    try {
      const ref = doc(db, 'sessions', date);
      const payload = {
        id: 'ses-' + date,
        date,
        sessionStatus: 'Open',
        openedAt: new Date().toISOString(),
        ...sessionMeta
      };
      await setDoc(ref, payload, { merge: true });
      clearConnectionError();
      return payload;
    } catch (err) {
      setConnectionError(err);
      console.error('[AttendEdge] openSession error:', err);
      throw err;
    }
  },

  async closeSession(date) {
    if (!isCloudSyncReady()) {
      throw new Error('Cannot close session: Firebase is not authenticated.');
    }
    try {
      const ref = doc(db, 'sessions', date);
      await setDoc(ref, {
        sessionStatus: 'Closed',
        closedAt: new Date().toISOString()
      }, { merge: true });
      clearConnectionError();
      return true;
    } catch (err) {
      setConnectionError(err);
      console.error('[AttendEdge] closeSession error:', err);
      throw err;
    }
  },

  async saveSession(date, sessionData) {
    if (!isCloudSyncReady()) return false;
    try {
      const ref = doc(db, 'sessions', date);
      await setDoc(ref, sessionData, { merge: true });
      clearConnectionError();
      return true;
    } catch (err) {
      setConnectionError(err);
      console.error('[AttendEdge] saveSession error:', err);
      throw err;
    }
  },

  async getSessionsRange(startDate, endDate) {
    if (!isCloudSyncReady()) return [];
    try {
      const q = query(
        collection(db, 'sessions'),
        where('date', '>=', startDate),
        where('date', '<=', endDate)
      );
      const snap = await getDocs(q);
      clearConnectionError();
      return snap.docs.map(d => d.data());
    } catch (err) {
      setConnectionError(err);
      console.error('[AttendEdge] getSessionsRange error:', err);
      throw err;
    }
  },

  /**
   * Attendance Records with Atomic Duplicate Prevention
   */
  async getRecordsForDate(date) {
    if (!isCloudSyncReady()) return null;
    try {
      // 1. Try reading entries subcollection
      const entriesRef = collection(db, 'records', date, 'entries');
      const snap = await getDocs(entriesRef);
      clearConnectionError();

      if (!snap.empty) {
        const records = {};
        snap.forEach(d => {
          const data = d.data();
          records[d.id] = {
            t: data.time || data.t,
            src: data.src,
            ev: {
              captureId: data.captureId,
              fsmCycles: data.fsmCycles,
              timestamp: data.timestamp
            }
          };
        });
        return records;
      }

      // 2. Fall back to parent document records map
      const parentRef = doc(db, 'records', date);
      const parentSnap = await getDoc(parentRef);
      if (parentSnap.exists()) {
        return parentSnap.data().records || {};
      }

      return {};
    } catch (err) {
      setConnectionError(err);
      console.error('[AttendEdge] getRecordsForDate error:', err);
      throw err;
    }
  },

  /**
   * Secure Attendance Recording via Trusted Cloud Function:
   * Invokes the server-side recordAttendance Cloud Function which enforces:
   * 1. Verified faculty authorization (custom claims / registry)
   * 2. Server-side time window validation (08:00 - 08:35 Asia/Kolkata)
   * 3. Session status validation (must not be Closed)
   * 4. Student roster & capture ID range check (0..62)
   * 5. Atomic transaction duplicate check
   */

  /**
   * Cloud Function Verification:
   * Invokes the server-side recordAttendance Cloud Function which enforces:
   * 1. Verified faculty authorization (custom claims / registry)
   * 2. Server-side time window validation (08:00 - 08:35 Asia/Kolkata)
   * 3. Session status validation (must not be Closed)
   * 4. Student roster & capture ID range check (0..62)
   * 5. Atomic transaction duplicate check
   */
  async recordAttendanceCloud(payload) {
    if (!isCloudSyncReady()) {
      const err = new Error('Cannot save attendance record: Firebase is not authenticated.');
      err.code = 'unauthenticated';
      throw err;
    }

    try {
      const currentUser = auth?.currentUser;
      if (!currentUser) {
        const err = new Error('Cannot save attendance record: User session expired or not authenticated.');
        err.code = 'unauthenticated';
        throw err;
      }

      const idToken = await currentUser.getIdToken();
      const endpoint = (typeof import.meta !== 'undefined' && import.meta.env?.VITE_ATTENDANCE_API_URL) || '/api/recordAttendance';

      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${idToken}`
        },
        body: JSON.stringify(payload)
      });

      let data = null;
      try {
        data = await response.json();
      } catch (jsonErr) {
        // Non-JSON response
      }

      if (!response.ok || !data || data.success !== true) {
        const errorMsg = (data && data.message) || `Attendance rejected by server (${response.status}: ${response.statusText}).`;
        const err = new Error(errorMsg);
        err.statusCode = data ? data.statusCode : 0;
        err.code = (data && data.code) || (response.status === 401 ? 'functions/unauthenticated' : response.status === 403 ? 'functions/permission-denied' : response.status === 404 ? 'functions/not-found' : 'functions/internal');
        throw err;
      }

      clearConnectionError();
      return data;
    } catch (err) {
      const mapped = mapFunctionsError(err);
      const enrichedErr = new Error(mapped.message);
      enrichedErr.code = mapped.code;
      enrichedErr.rawCode = err.code || 'unknown';
      enrichedErr.statusCode = err.statusCode || 0;
      enrichedErr.details = err.details;
      enrichedErr.originalError = err;

      setConnectionError(enrichedErr);
      console.error('[AttendEdge] recordAttendanceCloud error:', enrichedErr);
      throw enrichedErr;
    }
  },

  /**
   * Atomic Attendance Write:
   * Delegates directly to recordAttendanceCloud to guarantee server-side validation
   * and adhere to Firestore Security Rules (which forbid direct client writes).
   */
  async saveRecordAtomic(date, rollNumber, recordEntry) {
    const cleanDate = String(date).trim();
    const cleanRoll = String(rollNumber).trim().toUpperCase();

    return this.recordAttendanceCloud({
      date: cleanDate,
      rollNumber: cleanRoll,
      captureId: recordEntry.ev?.captureId ?? -1,
      source: recordEntry.src || 'web_fsm',
      time: recordEntry.t || recordEntry.time
    });
  },

  async saveRecord(date, rollNumber, recordEntry) {
    if (!isCloudSyncReady()) return false;
    try {
      const res = await this.saveRecordAtomic(date, rollNumber, recordEntry);
      return Boolean(res && res.success);
    } catch (err) {
      return false;
    }
  },

  async getRecordsForRange(startDate, endDate) {
    if (!isCloudSyncReady()) return {};
    try {
      const q = query(
        collection(db, 'records'),
        where('date', '>=', startDate),
        where('date', '<=', endDate)
      );
      const snap = await getDocs(q);
      clearConnectionError();
      const result = {};
      snap.forEach(d => {
        result[d.id] = d.data().records || {};
      });
      return result;
    } catch (err) {
      setConnectionError(err);
      console.error('[AttendEdge] getRecordsForRange error:', err);
      throw err;
    }
  },

  /**
   * Global Settings
   */
  async getSettings() {
    if (!isCloudSyncReady()) return null;
    try {
      const ref = doc(db, 'settings', 'global');
      const snap = await getDoc(ref);
      clearConnectionError();
      if (snap.exists()) return snap.data();
      return null;
    } catch (err) {
      setConnectionError(err);
      console.error('[AttendEdge] getSettings error:', err);
      throw err;
    }
  },

  async saveSettings(settings) {
    if (!isCloudSyncReady()) {
      throw new Error('Cannot save settings: Firebase is not authenticated.');
    }
    try {
      const ref = doc(db, 'settings', 'global');
      await setDoc(ref, {
        ...settings,
        updatedAt: new Date().toISOString(),
        updatedBy: auth.currentUser ? auth.currentUser.uid : 'faculty'
      }, { merge: true });
      clearConnectionError();
      return true;
    } catch (err) {
      setConnectionError(err);
      console.error('[AttendEdge] saveSettings error:', err);
      throw err;
    }
  },

  /**
   * Device Status (Hardware FPGA UART / ESP32-CAM)
   */
  async getDeviceStatus() {
    if (!isCloudSyncReady()) return null;
    try {
      const ref = doc(db, 'device_status', 'latest');
      const snap = await getDoc(ref);
      clearConnectionError();
      if (snap.exists()) return snap.data();
      return null;
    } catch (err) {
      setConnectionError(err);
      console.error('[AttendEdge] getDeviceStatus error:', err);
      throw err;
    }
  },

  async saveDeviceStatus(statusData) {
    if (!isCloudSyncReady()) return false;
    try {
      const ref = doc(db, 'device_status', 'latest');
      await setDoc(ref, {
        ...statusData,
        lastHeartbeat: new Date().toISOString()
      }, { merge: true });
      clearConnectionError();
      return true;
    } catch (err) {
      setConnectionError(err);
      console.error('[AttendEdge] saveDeviceStatus error:', err);
      throw err;
    }
  },

  /**
   * Append-Only Audit & Scan Events Log
   */
  async logEvent(event) {
    if (!isCloudSyncReady()) return false;
    try {
      const ref = doc(collection(db, 'events'));
      await setDoc(ref, {
        ...event,
        createdAt: new Date().toISOString(),
        recordedBy: auth.currentUser ? auth.currentUser.uid : 'faculty'
      });
      clearConnectionError();
      return true;
    } catch (err) {
      setConnectionError(err);
      console.error('[AttendEdge] logEvent error:', err);
      return false;
    }
  },

  async getEvents(limitCount = 50) {
    if (!isCloudSyncReady()) return [];
    try {
      const q = query(collection(db, 'events'), orderBy('createdAt', 'desc'), limit(limitCount));
      const snap = await getDocs(q);
      clearConnectionError();
      return snap.docs.map(d => ({ id: d.id, ...d.data() }));
    } catch (err) {
      setConnectionError(err);
      console.error('[AttendEdge] getEvents error:', err);
      return [];
    }
  },

  /**
   * Day Schedule Overrides Management (Faculty Privileges)
   */
  async getDayScheduleOverrides() {
    if (!isCloudSyncReady()) return {};
    try {
      const snap = await getDocs(collection(db, 'dayScheduleOverrides'));
      const overrides = {};
      snap.forEach(d => {
        overrides[d.id] = { id: d.id, ...d.data() };
      });
      clearConnectionError();
      return overrides;
    } catch (err) {
      console.warn('[AttendEdge] getDayScheduleOverrides error:', err);
      return {};
    }
  },

  async saveDayScheduleOverride({ date, status, reason }) {
    if (!isCloudSyncReady()) {
      const err = new Error('Cannot save schedule override: Firebase is not authenticated.');
      err.code = 'unauthenticated';
      throw err;
    }

    try {
      const currentUser = auth?.currentUser;
      if (!currentUser) {
        const err = new Error('Cannot save schedule override: User session expired or not authenticated.');
        err.code = 'unauthenticated';
        throw err;
      }

      const idToken = await currentUser.getIdToken();
      const endpoint = (typeof import.meta !== 'undefined' && import.meta.env?.VITE_SCHEDULE_API_URL) || '/api/manageDaySchedule';

      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${idToken}`
        },
        body: JSON.stringify({ date, status, reason })
      });

      let data = null;
      try {
        data = await response.json();
      } catch (jsonErr) {}

      if (!response.ok || !data || data.success !== true) {
        const errorMsg = (data && data.message) || `Schedule update rejected by server (${response.status}: ${response.statusText}).`;
        const err = new Error(errorMsg);
        err.code = (data && data.code) || 'functions/internal';
        throw err;
      }

      clearConnectionError();
      return data;
    } catch (err) {
      const message = err.message === 'Failed to fetch'
        ? 'Network error: Unable to contact server to save schedule override. Please check your internet connection.'
        : err.message || 'Error occurred while saving schedule override.';
      const enrichedErr = new Error(message);
      enrichedErr.code = err.code || 'functions/internal';
      console.error('[AttendEdge] saveDayScheduleOverride error:', enrichedErr);
      throw enrichedErr;
    }
  },

  async resetDayScheduleOverride(date, reason = 'Reset to default timetable') {
    if (!isCloudSyncReady()) {
      const err = new Error('Cannot reset schedule override: Firebase is not authenticated.');
      err.code = 'unauthenticated';
      throw err;
    }

    try {
      const currentUser = auth?.currentUser;
      if (!currentUser) {
        const err = new Error('Cannot reset schedule override: User session expired.');
        err.code = 'unauthenticated';
        throw err;
      }

      const idToken = await currentUser.getIdToken();
      const endpoint = (typeof import.meta !== 'undefined' && import.meta.env?.VITE_SCHEDULE_API_URL) || '/api/manageDaySchedule';

      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${idToken}`
        },
        body: JSON.stringify({ date, action: 'resetOverride', reason })
      });

      let data = null;
      try {
        data = await response.json();
      } catch (jsonErr) {}

      if (!response.ok || !data || data.success !== true) {
        const errorMsg = (data && data.message) || `Reset rejected by server (${response.status}: ${response.statusText}).`;
        const err = new Error(errorMsg);
        err.code = (data && data.code) || 'functions/internal';
        throw err;
      }

      clearConnectionError();
      return data;
    } catch (err) {
      const message = err.message === 'Failed to fetch'
        ? 'Network error: Unable to contact server to reset schedule override. Please check your internet connection.'
        : err.message || 'Error occurred while resetting schedule override.';
      const enrichedErr = new Error(message);
      enrichedErr.code = err.code || 'functions/internal';
      console.error('[AttendEdge] resetDayScheduleOverride error:', enrichedErr);
      throw enrichedErr;
    }
  },

  async getScheduleAuditHistory(limitCount = 30) {
    if (!isCloudSyncReady()) return [];
    try {
      const q = query(
        collection(db, 'scheduleAuditHistory'),
        orderBy('timestamp', 'desc'),
        limit(limitCount)
      );
      const snap = await getDocs(q);
      clearConnectionError();
      return snap.docs.map(d => ({ id: d.id, ...d.data() }));
    } catch (err) {
      console.warn('[AttendEdge] getScheduleAuditHistory error:', err);
      return [];
    }
  }
};
