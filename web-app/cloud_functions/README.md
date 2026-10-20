# AttendEdge — Cloud Functions & Administrator Architecture

This directory contains the trusted backend services and security controls for the AttendEdge Smart Attendance Management System.

---

## Architecture Overview

```
[ ESP32-CAM / FPGA UART / Web Scanner ]
                 │
                 ▼
  HTTPS Callable Cloud Function: recordAttendance()
  ├── 1. Verifies Faculty Caller Authentication & Role (custom claim or /faculty/{uid})
  ├── 2. Validates Server-Side Clock (08:00 - 08:35 Asia/Kolkata window)
  ├── 3. Validates Student Roster & FPGA Capture ID (0..62 range check)
  ├── 4. Validates Session Status (/sessions/{date} must not be Closed)
  └── 5. Executes Atomic Firestore Transaction (db.runTransaction)
         ├── Prevents duplicate scans at /records/{date}/entries/{rollNumber}
         ├── Updates summary register at /records/{date}
         └── Returns verified status code to client
                 │
                 ▼
    Cloud Firestore Database (Security Rules: allow write: if false)
    ├── /faculty/{uid}                     (Managed strictly via Admin SDK)
    ├── /records/{date}                    (Client writes denied; Cloud Function only)
    ├── /records/{date}/entries/{roll}     (Client writes denied; Cloud Function only)
    ├── /sessions/{date}                   (Status: Open / Closed)
    └── /students/{rollNumber}             (Authorized Faculty management)
```

---

## 1. Security Rules Integration

To prevent clients from bypassing time windows, session status, or duplicate protection:
- `firestore.rules` enforces `allow write: if false;` on `/records/{recordId}` and `/records/{recordId}/entries/{rollNumber}`.
- All attendance records are created exclusively through the trusted `recordAttendance` Cloud Function running with the **Firebase Admin SDK**.
- Direct client attempts to write or tamper with attendance records are blocked by Firestore Security Rules.

---

## 2. Deployment Prerequisites & Setup

1. **System Requirements**:
   - Node.js 18, 20, or 22
   - Firebase CLI (`npm install -g firebase-tools`)

2. **Firebase Project Initialization**:
   ```bash
   firebase login
   firebase init functions
   # Select JavaScript / TypeScript and default options
   ```

3. **Install Dependencies in `functions/` Directory**:
   ```bash
   cd functions
   npm install firebase-admin firebase-functions
   ```

4. **Deploying the Cloud Function**:
   - Copy `recordAttendance.js` into your project's `functions/index.js` (or import it).
   - Deploy the function to the `asia-south1` region:
     ```bash
     firebase deploy --only functions:recordAttendance
     ```

5. **Deploying Security Rules**:
   ```bash
   firebase deploy --only firestore:rules
   ```

---

## 3. Assigning Faculty Privileges (Admin SDK)

Faculty authorization is enforced using **Firebase Custom User Claims** and the `/faculty/{uid}` Firestore collection. Ordinary authenticated users cannot grant themselves faculty privileges because `firestore.rules` blocks client writes to `/faculty/{facultyId}` (`allow write: if false;`).

To grant faculty privileges to a registered faculty email:

1. Download your Firebase Service Account JSON key from **Firebase Console** &rarr; **Project Settings** &rarr; **Service accounts**.
2. Set the environment variable:
   ```powershell
   # Windows PowerShell:
   $env:GOOGLE_APPLICATION_CREDENTIALS="C:\path\to\serviceAccountKey.json"

   # Linux / macOS:
   export GOOGLE_APPLICATION_CREDENTIALS="/path/to/serviceAccountKey.json"
   ```
3. Run the administrator script:
   ```bash
   node assignFacultyClaim.js faculty@university.edu
   ```
4. The user's account now possesses `{ role: 'faculty', faculty: true }` and an authorized profile in `/faculty/{uid}`.
