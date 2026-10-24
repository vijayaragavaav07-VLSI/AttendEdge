/**
 * AttendEdge — Netlify Serverless Day Schedule Management Function
 *
 * Target: Netlify Serverless Functions (Node.js 20/22 runtime)
 * Endpoint: POST /.netlify/functions/manageDaySchedule (proxied via /api/manageDaySchedule)
 *
 * Provides cryptographically verified, faculty-only schedule override management,
 * emergency closure handling, and immutable audit history logging using the Firebase
 * Admin SDK on the Firebase Spark free plan.
 */

import admin from 'firebase-admin';
import { getAdminServices } from './recordAttendance.js';

/**
 * Core schedule override logic.
 */
export async function verifyAndSaveScheduleOverride(firestoreDb, {
  auth,
  data = {},
  now = new Date()
}) {
  // 1. Strict Authentication & Role Check
  if (!auth || !auth.uid) {
    const err = new Error('Authentication required: Only authenticated faculty can manage institutional day schedules.');
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

  // 2. Validate Date Format (YYYY-MM-DD)
  const rawDate = data.date;
  if (!rawDate || typeof rawDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(rawDate.trim())) {
    const err = new Error('Invalid date format. Expected standard ISO format YYYY-MM-DD (e.g. 2026-10-26).');
    err.code = 'invalid-argument';
    err.status = 400;
    throw err;
  }
  const cleanDate = rawDate.trim();
  const [y, m, d] = cleanDate.split('-').map(Number);
  const testDate = new Date(Date.UTC(y, m - 1, d));
  if (isNaN(testDate.getTime()) || testDate.getUTCFullYear() !== y || testDate.getUTCMonth() + 1 !== m || testDate.getUTCDate() !== d) {
    const err = new Error(`Invalid calendar date: ${cleanDate}.`);
    err.code = 'invalid-argument';
    err.status = 400;
    throw err;
  }

  // Handle Reset to Default timetable action
  if (data.action === 'resetOverride' || String(data.status).toLowerCase() === 'reset') {
    const overrideRef = firestoreDb.collection('dayScheduleOverrides').doc(cleanDate);
    const existing = await overrideRef.get();
    const prevStatus = existing.exists ? existing.data()?.status : 'Default';

    // Append to audit history
    const auditId = `audit-${cleanDate}-${Date.now()}`;
    const auditRef = firestoreDb.collection('scheduleAuditHistory').doc(auditId);
    const facultyEmail = (auth.token && auth.token.email) || null;
    const facultyUid = auth.uid;

    const auditPayload = {
      date: cleanDate,
      action: 'RESET_TO_DEFAULT',
      previousStatus: prevStatus,
      status: 'Default Timetable',
      reason: (data.reason || 'Reset to default institutional timetable').trim(),
      updatedBy: facultyEmail || facultyUid,
      updatedByEmail: facultyEmail,
      updatedByUid: facultyUid,
      timestamp: now.toISOString()
    };

    // Atomic execution for override deletion and audit history recording
    if (typeof firestoreDb.runTransaction === 'function') {
      await firestoreDb.runTransaction(async (transaction) => {
        if (typeof transaction.delete === 'function') {
          transaction.delete(overrideRef);
        } else {
          transaction.set(overrideRef, { isDeleted: true, status: 'Default' }, { merge: true });
        }
        transaction.set(auditRef, auditPayload);
      });
    } else if (typeof firestoreDb.batch === 'function') {
      const batch = firestoreDb.batch();
      if (typeof batch.delete === 'function') {
        batch.delete(overrideRef);
      } else {
        batch.set(overrideRef, { isDeleted: true, status: 'Default' }, { merge: true });
      }
      batch.set(auditRef, auditPayload);
      await batch.commit();
    } else {
      if (existing.exists) {
        if (typeof overrideRef.delete === 'function') {
          await overrideRef.delete();
        } else {
          await overrideRef.set({ isDeleted: true, status: 'Default' }, { merge: true });
        }
      }
      await auditRef.set(auditPayload);
    }

    return {
      success: true,
      message: `Schedule override for ${cleanDate} was reset to default institutional timetable.`,
      reset: true,
      date: cleanDate
    };
  }

  // 3. Validate Status
  const rawStatus = String(data.status || '').trim();
  if (!rawStatus) {
    const err = new Error('Missing schedule status. Please specify "Working Day" or "Non-working Day".');
    err.code = 'invalid-argument';
    err.status = 400;
    throw err;
  }
  const isWorking = rawStatus.toLowerCase().includes('non')
    ? false
    : (rawStatus.toLowerCase().includes('work') ? true : null);

  if (isWorking === null) {
    const err = new Error(`Invalid status "${rawStatus}". Status must be either "Working Day" or "Non-working Day".`);
    err.code = 'invalid-argument';
    err.status = 400;
    throw err;
  }
  const normalizedStatus = isWorking ? 'Working Day' : 'Non-working Day';

  // 4. Validate Required Reason
  const rawReason = String(data.reason || '').trim();
  if (!rawReason || rawReason.length < 2) {
    const err = new Error('A specific reason is required when changing the day status (e.g. "Emergency holiday", "College event", "Special working day").');
    err.code = 'invalid-argument';
    err.status = 400;
    throw err;
  }

  // 5. Persist Override to dayScheduleOverrides
  const overrideRef = firestoreDb.collection('dayScheduleOverrides').doc(cleanDate);
  const existingDoc = await overrideRef.get();
  const prevData = existingDoc.exists ? existingDoc.data() : null;

  const facultyEmail = (auth.token && auth.token.email) || null;
  const facultyUid = auth.uid;

  const overridePayload = {
    date: cleanDate,
    status: normalizedStatus,
    isWorking,
    isWorkingDay: isWorking,
    reason: rawReason,
    updatedBy: facultyUid,
    updatedByEmail: facultyEmail,
    updatedByUid: facultyUid,
    updatedAt: now.toISOString()
  };

  // 6. Record Immutable Audit History
  const auditId = `audit-${cleanDate}-${Date.now()}`;
  const auditRef = firestoreDb.collection('scheduleAuditHistory').doc(auditId);
  const auditPayload = {
    date: cleanDate,
    status: normalizedStatus,
    isWorking,
    isWorkingDay: isWorking,
    previousStatus: prevData ? prevData.status : 'Default',
    reason: rawReason,
    updatedBy: facultyEmail || facultyUid,
    updatedByEmail: facultyEmail,
    updatedByUid: facultyUid,
    timestamp: now.toISOString(),
    action: 'OVERRIDE_DAY_STATUS'
  };

  // 7. Atomic transaction / batch write for consistency
  if (typeof firestoreDb.runTransaction === 'function') {
    await firestoreDb.runTransaction(async (transaction) => {
      transaction.set(overrideRef, overridePayload);
      transaction.set(auditRef, auditPayload);
    });
  } else if (typeof firestoreDb.batch === 'function') {
    const batch = firestoreDb.batch();
    batch.set(overrideRef, overridePayload);
    batch.set(auditRef, auditPayload);
    await batch.commit();
  } else {
    await overrideRef.set(overridePayload);
    await auditRef.set(auditPayload);
  }

  return {
    success: true,
    message: `Schedule override for ${cleanDate} successfully saved as "${normalizedStatus}".`,
    override: overridePayload,
    audit: auditPayload
  };
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
        code: 'functions/internal',
        message: 'Server configuration error: Firebase Admin credentials not configured on Netlify.'
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
        code: 'functions/invalid-argument',
        message: 'Malformed request: Payload must be valid JSON.'
      })
    };
  }

  // 7. Verify & Save Schedule Override
  try {
    const result = await verifyAndSaveScheduleOverride(db, {
      auth: { uid: decodedToken.uid, token: decodedToken },
      data: payload,
      now: options.now || new Date()
    });

    return {
      statusCode: 200,
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
          code: 'functions/invalid-argument',
          message: err.message
        })
      };
    }

    console.error('[AttendEdge Netlify] Uncaught schedule management error:', err);
    return {
      statusCode: 500,
      headers: responseHeaders,
      body: JSON.stringify({
        success: false,
        code: 'functions/internal',
        message: 'Internal server error occurred while updating day schedule.'
      })
    };
  }
}
