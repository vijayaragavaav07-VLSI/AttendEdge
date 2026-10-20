/**
 * AttendEdge — Administrator Script: Assign Faculty Role
 * 
 * Run this script using Node.js with your Firebase Service Account key
 * to grant trusted faculty privileges to a faculty user account.
 * 
 * Usage:
 *   node assignFacultyClaim.js <faculty-uid-or-email>
 * 
 * SECURITY: Never bundle or deploy this file with frontend client code.
 */

import admin from 'firebase-admin';

// Ensure GOOGLE_APPLICATION_CREDENTIALS environment variable points to your serviceAccountKey.json
if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
  console.error('ERROR: GOOGLE_APPLICATION_CREDENTIALS environment variable is not set.');
  console.error('Please export GOOGLE_APPLICATION_CREDENTIALS="/path/to/serviceAccountKey.json" before running.');
  process.exit(1);
}

if (!admin.apps.length) {
  admin.initializeApp();
}

async function assignFaculty(identifier) {
  try {
    let userRecord;
    if (identifier.includes('@')) {
      userRecord = await admin.auth().getUserByEmail(identifier);
    } else {
      userRecord = await admin.auth().getUser(identifier);
    }

    const uid = userRecord.uid;
    console.log(`Found user: ${userRecord.email} (UID: ${uid})`);

    // 1. Assign Custom User Claim: { role: 'faculty', faculty: true }
    await admin.auth().setCustomUserClaims(uid, {
      role: 'faculty',
      faculty: true
    });
    console.log(`✓ Custom claim { role: 'faculty' } assigned to UID: ${uid}`);

    // 2. Also create/update document in /faculty/{uid} registry for Firestore security rules
    await admin.firestore().collection('faculty').doc(uid).set({
      uid,
      email: userRecord.email,
      displayName: userRecord.displayName || userRecord.email.split('@')[0],
      role: 'faculty',
      grantedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
    console.log(`✓ Document /faculty/${uid} registered in Cloud Firestore.`);

    console.log('\nSuccess! The user now possesses verified faculty authorization.');
    console.log('Note: If the user is currently logged into the web app, they must log out and sign back in for the new token to take effect.');
  } catch (err) {
    console.error('Error assigning faculty role:', err);
    process.exit(1);
  }
}

const target = process.argv[2];
if (!target) {
  console.log('Usage: node assignFacultyClaim.js <user-email-or-uid>');
  process.exit(1);
}

assignFaculty(target);
