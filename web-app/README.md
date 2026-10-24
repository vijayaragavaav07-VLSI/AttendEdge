# AttendEdge — Smart Attendance Management Web Application

AttendEdge is a Smart Attendance Management Web Application developed directly from the hardware specification of the Basys 3 Artix-7 FPGA 9-state FSM controller (`Attendence_Controller.v` and `attendedge_Top.v`).

---

## 1. Verilog Hardware FSM Architecture & Reproduction

The attendance workflow is driven by the exact state transition diagram from the Vivado source code:

### FSM States (`localparam 1..9`)
1. **`IDLE (1)`**: Waits for a `scan_valid` 1-cycle pulse. Latches `capture_id`, `hour`, and `minute`.
2. **`RECEIVE (2)`**: Holds latched registers, transitions to window evaluation.
3. **`CHECK_TIME (3)`**: Evaluates window comparator `in_window = (hour == 8) && (minute <= 35)`. If inside window (08:00–08:35), moves to `VERIFY`; otherwise sets status `S_OUT_WINDOW (3)` and moves to `INVALID`.
4. **`VERIFY (4)`**: Validates student index `id_ok = (id_r < 63)`. If valid (indices 0..62), moves to `CHECK_DUP`; otherwise sets status `S_BAD_ID (2)` and moves to `INVALID`.
5. **`CHECK_DUP (5)`**: Reads the 64-bit attendance register flip-flop: `attendance_bits[id_r]`. If already `1`, branches to `ALREADY_PRESENT`; otherwise branches to `RECORD`.
6. **`RECORD (6)`**: Sets the flip-flop bit (`attendance_bits[id_r] <= 1'b1`), sets result `S_RECORDED (4)`, transitions to `REPORT`.
7. **`INVALID (7)`**: Bypass state for rejected scans, transitions to `REPORT`.
8. **`ALREADY_PRESENT (8)`**: Sets result `S_ALREADY (1)`, transitions to `REPORT`.
9. **`REPORT (9)`**: Asserts `status_valid <= 1'b1` for 1 clock cycle with `status_code <= result`, returns to `IDLE`.

### Status Codes Output by FPGA (`status_code[2:0]`)
- **`0 (S_NONE)`**: No status / Idle.
- **`1 (S_ALREADY)`**: Already Present — Duplicate scan protection.
- **`2 (S_BAD_ID)`**: Invalid Student ID — Unregistered index (63 or above).
- **`3 (S_OUT_WINDOW)`**: Outside Attendance Window — Scan arrived outside 08:00–08:35.
- **`4 (S_RECORDED)`**: Attendance Successfully Recorded — Register flip-flop set from `0` to `1`.

---

## 2. Directory Structure

```
c:/attadence/
├── vivado/                  <-- STRICTLY READ-ONLY (Untouched)
│   └── digital attendence system using flipflops and FSM/
├── esp_cam/                 <-- ESP32-CAM firmware workspace
├── web/                     <-- Original prototype reference (Untouched)
└── web-app/                 <-- Complete Vite web application
    ├── src/
    │   ├── logic/
    │   │   └── attendanceFSM.js     # Cycle-accurate Verilog FSM reproduction
    │   ├── firebase/
    │   │   ├── config.js            # Environment validation & fallback
    │   │   ├── auth.js              # Faculty authentication service
    │   │   └── firestoreService.js  # Firestore collections CRUD
    │   ├── services/
    │   │   ├── attendanceService.js # High-level controller & analytics
    │   │   └── serialService.js     # Web Serial API for live FPGA UART
    │   ├── reports/
    │   │   └── reportGenerator.js   # PDF & CSV report exports
    │   ├── components/
    │   │   └── icons.js             # SVG UI icons
    │   ├── styles/
    │   │   └── main.css             # Preserved AttendEdge design system
    │   └── main.js                  # Main UI routing, dashboard & Working Day Management
    ├── netlify/
    │   └── functions/
    │       ├── manageDaySchedule.js # Serverless day schedule override & audit history
    │       └── recordAttendance.js  # Serverless attendance verification
    ├── tests/
    │   ├── fsm.test.js              # Hardware FSM test suite matching Vivado testbench
    │   ├── auth.test.js             # Authentication & role verification
    │   ├── firestoreService.test.js # Firestore CRUD operations & schedule sync
    │   ├── studentStatistics.test.js# Attendance statistics calculation
    │   ├── workflow_and_reports.test.js # End-to-end report workflow
    │   ├── cloudFunctionsSecurity.test.js # Cloud Functions security & window checks
    │   └── workingDayManagement.test.js   # Faculty working day management & overrides
    ├── index.html
    ├── vite.config.js
    ├── firestore.rules
    ├── .env.example
    ├── package.json
    └── README.md
```

---

## 3. How to Run Locally

### Start Development Server
```bash
cd c:/attadence/web-app
npm run dev
```
Open your browser to: **`http://localhost:5173`**

### Run Automated Unit & Integration Tests
```bash
npm test
```
Executes all 111 test scenarios across 7 test suites via Vitest.

### Production Build
```bash
npm run build
```

---

## 4. Hardware Architecture & Real-Time Monitoring

- **Hardware Flow (Default)**: Intended physical flow is ESP32-CAM QR/barcode capture → Basys 3 FPGA Verilog FSM validation → secure upload to Firebase → AttendEdge web application live display. Manual browser scanning and FSM event simulation are disabled.
- **Hardware Connection Mode (Web Serial)**: On the **Device Status** page, click **Connect via Web Serial** to connect a physical Basys 3 FPGA over USB UART at 115200 baud (8N1). If disconnected, the UI explicitly shows the device status and never fakes a live connection.

---

## 5. Firebase Setup Steps

1. Go to the [Firebase Console](https://console.firebase.google.com/).
2. Create a new Firebase project (e.g. `attendedge-attendance`).
3. Enable **Authentication**:
   - Go to **Build > Authentication > Sign-in method**.
   - Enable **Email/Password**.
   - Under **Users**, add your faculty credentials (e.g., `faculty@attendedge.edu`).
4. Enable **Cloud Firestore**:
   - Go to **Build > Firestore Database > Create database**.
   - Choose production mode and select your region (e.g., `asia-south1` or `us-central1`).
   - Copy the contents of `web-app/firestore.rules` into the Firestore **Rules** tab and click **Publish**.
5. Register a Web App:
   - Go to **Project Settings > General > Your apps > Add app (Web / </>)**.
   - Copy the configuration keys into `web-app/.env`:
     ```env
     VITE_FIREBASE_API_KEY=AIzaSy...
     VITE_FIREBASE_AUTH_DOMAIN=attendedge-xxxx.firebaseapp.com
     VITE_FIREBASE_PROJECT_ID=attendedge-xxxx
     VITE_FIREBASE_STORAGE_BUCKET=attendedge-xxxx.appspot.com
     VITE_FIREBASE_MESSAGING_SENDER_ID=123456789
     VITE_FIREBASE_APP_ID=1:123456789:web:abcdef
     ```
6. If credentials are not yet configured, AttendEdge automatically operates in **Local Demo Mode** using `localStorage` and demo login (`faculty` / `demo123`).
