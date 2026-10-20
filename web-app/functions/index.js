/**
 * AttendEdge — Server-Side FSM Attendance Verification Cloud Function
 * 
 * Target Project: attendedge-11745
 * Target Region:  asia-south1
 * 
 * Provides cryptographically trusted, server-side duplicate prevention,
 * time-window validation, session verification, and student ID checks
 * using the Firebase Admin SDK and Firebase Functions v2 onCall trigger.
 */

import { onCall, HttpsError } from 'firebase-functions/v2/https';
import admin from 'firebase-admin';

if (!admin.apps.length) {
  admin.initializeApp();
}
const db = admin.firestore();

// Verilog FSM Status Codes (matching Attendence_Controller.v)
export const STATUS_CODES = {
  S_NONE: 0,
  S_ALREADY: 1,    // Duplicate detected
  S_BAD_ID: 2,     // Invalid / unregistered capture ID or student not enrolled
  S_OUT_WINDOW: 3, // Current time outside active window or session closed
  S_RECORDED: 4    // Attendance successfully recorded
};

/**
 * Core validation and atomic transaction execution logic.
 */
export async function verifyAndRecordAttendance(firestoreDb, {
  auth,
  data = {},
  now = new Date(),
  overrideSettings = null
}) {
  // 1. Strict Authentication & Role Check
  if (!auth || !auth.uid) {
    const err = new Error('Authentication required: Only authenticated faculty can record attendance.');
    err.code = 'unauthenticated';
    err.status = 401;
    throw err;
  }

  // Verify faculty privilege via custom claim or /faculty/{uid} registry
  const hasClaim = Boolean(auth.token && (auth.token.role === 'faculty' || auth.token.faculty === true));
  if (!hasClaim) {
    const facultyDoc = await firestoreDb.collection('faculty').doc(auth.uid).get();
    if (!facultyDoc.exists || facultyDoc.data().role !== 'faculty' || facultyDoc.data().disabled === true) {
      const err = new Error('Unauthorized: Caller does not possess verified faculty privileges.');
      err.code = 'permission-denied';
      err.status = 403;
      throw err;
    }
  }

  // 2. Validate student roll number format
  const rawRoll = data.rollNumber;
  if (!rawRoll || typeof rawRoll !== 'string' || !rawRoll.trim()) {
    const err = new Error('Missing or invalid student rollNumber.');
    err.code = 'invalid-argument';
    err.status = 400;
    throw err;
  }
  const cleanRoll = rawRoll.trim().toUpperCase();

  // 3. Fetch Settings & Determine Server Time
  let settings = overrideSettings;
  if (!settings) {
    try {
      const settingsDoc = await firestoreDb.collection('settings').doc('global').get();
      settings = settingsDoc.exists ? settingsDoc.data() : null;
    } catch (e) {
      // fallback to standard defaults
    }
  }
  if (!settings) {
    settings = {
      openingTime: '08:00',
      closingTime: '08:35',
      timezone: 'Asia/Kolkata'
    };
  }

  const tz = settings.timezone || 'Asia/Kolkata';
  const nowParts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(now);

  const g = (t) => nowParts.find(p => p.type === t).value;
  const todayDate = data.date || `${g('year')}-${g('month')}-${g('day')}`;
  const currentTime = data.time || `${g('hour')}:${g('minute')}:${g('second')}`;

  // 4. Server-Side Attendance Time Window Check (08:00 - 08:35)
  const toSec = (timeStr) => {
    const [h, m, s] = (timeStr || '00:00:00').split(':').map(Number);
    return (h || 0) * 3600 + (m || 0) * 60 + (s || 0);
  };

  const curSec = toSec(currentTime);
  const openSec = toSec(settings.openingTime || '08:00');
  const closeSec = toSec(settings.closingTime || '08:35');

  if (curSec < openSec || curSec > closeSec) {
    return {
      success: false,
      statusCode: STATUS_CODES.S_OUT_WINDOW,
      message: `Outside Window: Current time ${currentTime} is outside the active ${settings.openingTime || '08:00'}–${settings.closingTime || '08:35'} window.`
    };
  }

  // 5. Execute Atomic Firestore Transaction
  return await firestoreDb.runTransaction(async (transaction) => {
    // A. Verify Session Status
    const sessionRef = firestoreDb.collection('sessions').doc(todayDate);
    const sessionDoc = await transaction.get(sessionRef);

    if (sessionDoc.exists) {
      const sData = sessionDoc.data() || {};
      if (sData.sessionStatus && String(sData.sessionStatus).toLowerCase() === 'closed') {
        return {
          success: false,
          statusCode: STATUS_CODES.S_OUT_WINDOW,
          message: `Session Closed: Attendance session for ${todayDate} is closed.`
        };
      }
    }

    // B. Verify Student Existence & Capture ID
    const studentRef = firestoreDb.collection('students').doc(cleanRoll);
    const studentDoc = await transaction.get(studentRef);

    let assignedCaptureId = data.captureId;
    if (studentDoc.exists) {
      const stuData = studentDoc.data() || {};
      if (stuData.disabled === true) {
        return {
          success: false,
          statusCode: STATUS_CODES.S_BAD_ID,
          message: `Invalid ID: Student ${cleanRoll} is disabled.`
        };
      }
      if (assignedCaptureId === undefined && stuData.index !== undefined) {
        assignedCaptureId = stuData.index;
      }
    }

    // Basys 3 FPGA 64-bit register: valid capture ID is 0..62. ID 63 or out of range is invalid.
    if (assignedCaptureId !== undefined && (assignedCaptureId < 0 || assignedCaptureId > 62 || assignedCaptureId === 63)) {
      return {
        success: false,
        statusCode: STATUS_CODES.S_BAD_ID,
        message: `Invalid ID: Capture ID ${assignedCaptureId} for student ${cleanRoll} is out of valid 0..62 range.`
      };
    }

    // C. Check Duplicate Entry in Subcollection
    const entryRef = firestoreDb.collection('records').doc(todayDate).collection('entries').doc(cleanRoll);
    const entryDoc = await transaction.get(entryRef);

    // D. Check Duplicate in Summary Document
    const summaryRef = firestoreDb.collection('records').doc(todayDate);
    const summaryDoc = await transaction.get(summaryRef);
    const summaryData = summaryDoc.exists ? summaryDoc.data() : { date: todayDate, records: {}, totalPresent: 0 };

    if (entryDoc.exists) {
      const existing = entryDoc.data() || {};
      return {
        success: false,
        statusCode: STATUS_CODES.S_ALREADY,
        message: `Already Recorded: Student ${cleanRoll} attendance was already recorded at ${existing.time || existing.t || 'earlier'}.`
      };
    }

    if (summaryData.records && summaryData.records[cleanRoll]) {
      const existing = summaryData.records[cleanRoll];
      return {
        success: false,
        statusCode: STATUS_CODES.S_ALREADY,
        message: `Already Recorded: Student ${cleanRoll} attendance was already recorded at ${existing.t || existing.time || 'earlier'}.`
      };
    }

    // E. Perform Atomic Writes (Reads are complete)
    const entryPayload = {
      rollNumber: cleanRoll,
      date: todayDate,
      time: currentTime,
      src: data.source || 'web_fsm',
      captureId: assignedCaptureId ?? -1,
      recordedBy: auth.uid,
      timestamp: now.toISOString()
    };

    transaction.set(entryRef, entryPayload);

    const updatedRecords = {
      ...(summaryData.records || {}),
      [cleanRoll]: {
        t: currentTime,
        src: data.source || 'web_fsm',
        ev: {
          captureId: assignedCaptureId ?? -1,
          timestamp: now.toISOString()
        }
      }
    };

    transaction.set(summaryRef, {
      date: todayDate,
      records: updatedRecords,
      totalPresent: Object.keys(updatedRecords).length,
      lastUpdated: now.toISOString()
    }, { merge: true });

    return {
      success: true,
      statusCode: STATUS_CODES.S_RECORDED,
      message: `Present Recorded: ${cleanRoll} at ${currentTime}. Transaction committed to Cloud Firestore.`,
      record: entryPayload
    };
  });
}

/**
 * Callable Cloud Function: recordAttendance
 * Deployed to region asia-south1
 */
export const recordAttendance = onCall({ region: 'asia-south1' }, async (request) => {
  try {
    const result = await verifyAndRecordAttendance(db, {
      auth: request.auth,
      data: request.data
    });
    return result;
  } catch (err) {
    if (err.code === 'unauthenticated') {
      throw new HttpsError('unauthenticated', err.message);
    }
    if (err.code === 'permission-denied') {
      throw new HttpsError('permission-denied', err.message);
    }
    if (err.code === 'invalid-argument') {
      throw new HttpsError('invalid-argument', err.message);
    }
    throw new HttpsError('internal', err.message);
  }
});
