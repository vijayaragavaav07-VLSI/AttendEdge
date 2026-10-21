/**
 * AttendEdge — Netlify Serverless Attendance Verification Function
 *
 * Target: Netlify Serverless Functions (Node.js 20/22 runtime)
 * Endpoint: POST /.netlify/functions/recordAttendance (proxied via /api/recordAttendance)
 *
 * Provides cryptographically verified, server-side duplicate prevention,
 * time-window validation, session verification, student ID checks, and faculty
 * authentication using the Firebase Admin SDK on the Firebase Spark free plan.
 */

import admin from 'firebase-admin';

// Verilog FSM Status Codes (matching Attendence_Controller.v)
export const STATUS_CODES = {
  S_NONE: 0,
  S_ALREADY: 1,    // Duplicate detected
  S_BAD_ID: 2,     // Invalid / unregistered capture ID or student not enrolled
  S_OUT_WINDOW: 3, // Current time outside active window or session closed
  S_RECORDED: 4    // Attendance successfully recorded
};

let cachedApp = null;
let cachedDb = null;
let cachedAuth = null;

/**
 * Lazily initialize and return Firebase Admin services.
 * Supports multiple environment configuration formats:
 * - FIREBASE_SERVICE_ACCOUNT (raw JSON string or Base64-encoded JSON)
 * - Individual FIREBASE_PRIVATE_KEY, FIREBASE_CLIENT_EMAIL, FIREBASE_PROJECT_ID
 * - GOOGLE_APPLICATION_CREDENTIALS path
 */
export function getAdminServices({ overrideDb = null, overrideAuth = null } = {}) {
  if (overrideDb || overrideAuth) {
    return { db: overrideDb, auth: overrideAuth };
  }

  if (!cachedApp) {
    const saEnv = process.env.FIREBASE_SERVICE_ACCOUNT || process.env.FIREBASE_SERVICE_ACCOUNT_KEY;
    const projectId = process.env.FIREBASE_PROJECT_ID || 'attendedge-11745';
    let credential = null;

    if (saEnv) {
      try {
        const parsed = JSON.parse(saEnv);
        credential = admin.credential.cert(parsed);
      } catch (rawErr) {
        try {
          const decoded = Buffer.from(saEnv, 'base64').toString('utf8');
          const parsed = JSON.parse(decoded);
          credential = admin.credential.cert(parsed);
        } catch (b64Err) {
          console.error('[AttendEdge Netlify] Error parsing FIREBASE_SERVICE_ACCOUNT environment variable.');
        }
      }
    } else if (process.env.FIREBASE_PRIVATE_KEY && process.env.FIREBASE_CLIENT_EMAIL) {
      credential = admin.credential.cert({
        projectId,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n')
      });
    } else if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
      credential = admin.credential.applicationDefault();
    }

    if (!admin.apps.length) {
      if (credential) {
        cachedApp = admin.initializeApp({
          credential,
          projectId
        });
      } else {
        // Fallback for local emulator or test environments
        try {
          cachedApp = admin.initializeApp({ projectId });
        } catch (initErr) {
          // May be caught in test runners without default credentials
        }
      }
    } else {
      cachedApp = admin.apps[0];
    }
  }

  cachedDb = cachedDb || (cachedApp ? admin.firestore(cachedApp) : null);
  cachedAuth = cachedAuth || (cachedApp ? admin.auth(cachedApp) : null);

  return { db: cachedDb, auth: cachedAuth };
}

/**
 * Core attendance verification & atomic Firestore transaction.
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

  // 3. Fetch Settings & Determine Trusted Server Time
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
  // Browser-supplied date/time is NEVER trusted; server calculates strictly from now
  const todayDate = `${g('year')}-${g('month')}-${g('day')}`;
  const currentTime = `${g('hour')}:${g('minute')}:${g('second')}`;

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

    // E. Perform Atomic Writes
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
 * Netlify Serverless Function Handler
 */
export async function handler(event, context, options = {}) {
  const responseHeaders = {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate'
  };

  // 1. CORS Preflight
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 204,
      headers: {
        ...responseHeaders,
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        'Access-Control-Allow-Methods': 'POST, OPTIONS'
      }
    };
  }

  // 2. HTTP Method Validation
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers: responseHeaders,
      body: JSON.stringify({
        success: false,
        statusCode: 0,
        code: 'method-not-allowed',
        message: `HTTP Method ${event.httpMethod} not allowed. Please use POST.`
      })
    };
  }

  // 3. Bearer Token Extraction
  const headers = event.headers || {};
  const authHeader = headers.authorization || headers.Authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return {
      statusCode: 401,
      headers: responseHeaders,
      body: JSON.stringify({
        success: false,
        statusCode: 0,
        code: 'functions/unauthenticated',
        message: 'Authentication required: Missing or invalid Authorization Bearer header.'
      })
    };
  }

  const idToken = authHeader.substring(7).trim();
  if (!idToken) {
    return {
      statusCode: 401,
      headers: responseHeaders,
      body: JSON.stringify({
        success: false,
        statusCode: 0,
        code: 'functions/unauthenticated',
        message: 'Authentication required: Missing Firebase ID token.'
      })
    };
  }

  // 4. Resolve Firebase Admin Services
  const { db, auth: adminAuth } = options.services || getAdminServices();

  if (!db || !adminAuth) {
    return {
      statusCode: 503,
      headers: responseHeaders,
      body: JSON.stringify({
        success: false,
        statusCode: 0,
        code: 'functions/internal',
        message: 'Server configuration error: Firebase Admin credentials not configured on Netlify. Please configure FIREBASE_SERVICE_ACCOUNT in Netlify site settings.'
      })
    };
  }

  // 5. Verify Firebase ID Token
  let decodedToken;
  try {
    decodedToken = await adminAuth.verifyIdToken(idToken);
  } catch (authErr) {
    return {
      statusCode: 401,
      headers: responseHeaders,
      body: JSON.stringify({
        success: false,
        statusCode: 0,
        code: 'functions/unauthenticated',
        message: 'Authentication failed: Invalid, expired, or revoked Firebase ID token.'
      })
    };
  }

  // 6. Parse Request Payload
  let payload = {};
  try {
    const raw = typeof event.body === 'string' ? JSON.parse(event.body || '{}') : (event.body || {});
    payload = raw.data || raw;
  } catch (parseErr) {
    return {
      statusCode: 400,
      headers: responseHeaders,
      body: JSON.stringify({
        success: false,
        statusCode: 0,
        code: 'functions/invalid-argument',
        message: 'Malformed request: Payload must be valid JSON.'
      })
    };
  }

  // 7. Execute Attendance Verification & Atomic Transaction
  try {
    const result = await verifyAndRecordAttendance(db, {
      auth: { uid: decodedToken.uid, token: decodedToken },
      data: payload,
      now: options.now || new Date(),
      overrideSettings: options.overrideSettings || null
    });

    if (result.success) {
      return {
        statusCode: 200,
        headers: responseHeaders,
        body: JSON.stringify(result)
      };
    }

    let httpStatus = 400;
    if (result.statusCode === STATUS_CODES.S_ALREADY) {
      httpStatus = 409; // Conflict (Duplicate)
    } else if (result.statusCode === STATUS_CODES.S_OUT_WINDOW) {
      httpStatus = 403; // Forbidden (Window / Session closed)
    } else if (result.statusCode === STATUS_CODES.S_BAD_ID) {
      httpStatus = 400; // Bad Request (Invalid student / capture ID)
    }

    return {
      statusCode: httpStatus,
      headers: responseHeaders,
      body: JSON.stringify(result)
    };
  } catch (err) {
    if (err.code === 'unauthenticated' || err.status === 401) {
      return {
        statusCode: 401,
        headers: responseHeaders,
        body: JSON.stringify({
          success: false,
          statusCode: 0,
          code: 'functions/unauthenticated',
          message: err.message
        })
      };
    }
    if (err.code === 'permission-denied' || err.status === 403) {
      return {
        statusCode: 403,
        headers: responseHeaders,
        body: JSON.stringify({
          success: false,
          statusCode: 0,
          code: 'functions/permission-denied',
          message: err.message
        })
      };
    }
    if (err.code === 'invalid-argument' || err.status === 400) {
      return {
        statusCode: 400,
        headers: responseHeaders,
        body: JSON.stringify({
          success: false,
          statusCode: 0,
          code: 'functions/invalid-argument',
          message: err.message
        })
      };
    }

    console.error('[AttendEdge Netlify] Uncaught attendance recording error:', err);
    return {
      statusCode: 500,
      headers: responseHeaders,
      body: JSON.stringify({
        success: false,
        statusCode: 0,
        code: 'functions/internal',
        message: 'Internal server error occurred while verifying attendance.'
      })
    };
  }
}
