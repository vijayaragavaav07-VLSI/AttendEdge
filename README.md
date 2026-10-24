# AttendEdge — Hardware-Based Smart Attendance Management System

**AttendEdge** is an end-to-end hardware-validated Smart Attendance Management platform. The system integrates physical student identity card scanning on an **ESP32-CAM**, cycle-accurate hardware validation on a **Xilinx Basys 3 Artix-7 FPGA (9-State FSM Controller)**, secure serverless cloud ingestion via **Netlify Functions & Firebase Cloud Firestore**, and a high-performance **Vite Web Dashboard**.

---

## 1. System Architecture & Hardware Flow

```
+----------------------------------------------------------------------------------------------------+
|                                    ATTENDEDGE HARDWARE PIPELINE                                    |
+----------------------------------------------------------------------------------------------------+
|                                                                                                    |
|   +--------------------+       1 Byte Index (0..62)       +------------------------------------+   |
|   |     ESP32-CAM      | -------------------------------> |         Basys 3 Artix-7 FPGA       |   |
|   |  (Optical Scanner) |                                  |  - 9-State Verilog FSM Controller  |   |
|   |  - Student QR code | <------------------------------- |  - Time Window Comparator (08-0835)|   |
|   |  - Barcode capture |    1 Byte Result (Status 1..4)   |  - 64-Bit Flip-Flop Register Bus   |   |
|   +--------------------+                                  +------------------------------------+   |
|             |                                                                                      |
|             | HTTPS POST (Payload + Device Auth)                                                   |
|             v                                                                                      |
|   +------------------------------------+                                                           |
|   |     Netlify Serverless Backend     |                                                           |
|   |     `recordAttendance` Function    |                                                           |
|   |  - Faculty / Device Auth Token     |                                                           |
|   |  - Server-Side Window Validation   |                                                           |
|   |  - Atomic Duplicate Prevention     |                                                           |
|   +------------------------------------+                                                           |
|             |                                                                                      |
|             | Atomic Firestore Transaction                                                         |
|             v                                                                                      |
|   +------------------------------------+                                                           |
|   |       Google Cloud Firestore       |                                                           |
|   |  - Collections: /records, /faculty |                                                           |
|   |  - Spark Free Plan (No Cloud Func) |                                                           |
|   +------------------------------------+                                                           |
|             |                                                                                      |
|             | Real-Time Subscription & Live Refresh                                                |
|             v                                                                                      |
|   +------------------------------------+                                                           |
|   |     AttendEdge Web Application     |                                                           |
|   |  - Live Hardware Attendance Feed   |                                                           |
|   |  - 63 Flip-Flop Register Inspector |                                                           |
|   |  - Daily / Weekly / Monthly Reports|                                                           |
|   |  - PDF / CSV Export Engine         |                                                           |
|   +------------------------------------+                                                           |
|                                                                                                    |
+----------------------------------------------------------------------------------------------------+
```

---

## 2. FPGA Verilog FSM Specification (`vivado/`)

The core hardware validation is implemented in synthesizable Verilog (`attendedge_Top.v` and `Attendence_Controller.v`):

### 9 FSM States (`localparam 1..9`)
1. **`IDLE (1)`**: Waits for incoming UART scan pulse. Latches student index `capture_id`, `hour`, and `minute`.
2. **`RECEIVE (2)`**: Latches inputs and evaluates clock registers.
3. **`CHECK_TIME (3)`**: Hardware comparator evaluates `in_window = (hour == 8) && (minute <= 35)`. If in window, transitions to `VERIFY`; otherwise outputs `S_OUT_WINDOW (3)` and jumps to `INVALID`.
4. **`VERIFY (4)`**: Validates student index `id_ok = (id_r < 63)` for the 63-student class. If valid, transitions to `CHECK_DUP`; otherwise outputs `S_BAD_ID (2)`.
5. **`CHECK_DUP (5)`**: Reads the 64-bit flip-flop register bit `attendance_bits[id_r]`. If already `1`, branches to `ALREADY_PRESENT`; otherwise branches to `RECORD`.
6. **`RECORD (6)`**: Sets the hardware flip-flop (`attendance_bits[id_r] <= 1'b1`), sets result `S_RECORDED (4)`, transitions to `REPORT`.
7. **`INVALID (7)`**: Rejection state for invalid window or out-of-range student index.
8. **`ALREADY_PRESENT (8)`**: Duplicate protection state (`status_code = S_ALREADY`).
9. **`REPORT (9)`**: Asserts `status_valid <= 1'b1` for 1 clock cycle with `status_code <= result`, returns to `IDLE`.

### FPGA UART Status Codes
- **`1 (S_ALREADY)`**: Already Present (Duplicate scan rejected).
- **`2 (S_BAD_ID)`**: Invalid Student ID (Index $\ge 63$).
- **`3 (S_OUT_WINDOW)`**: Outside Attendance Window (Not within 08:00–08:35).
- **`4 (S_RECORDED)`**: Attendance Successfully Recorded (Flip-Flop set from `0` to `1`).

---

## 3. Repository Directory Structure

```
c:/attadence/
├── .gitignore               # Root git ignore (protects secrets, builds, logs)
├── netlify.toml             # Root Netlify CI/CD build & redirects configuration
├── README.md                # Repository overview & setup guide
├── netlify/
│   └── functions/
│       ├── manageDaySchedule.js # Serverless day schedule override & audit history
│       └── recordAttendance.js  # Serverless function bridge
├── esp_cam/                 # ESP32-CAM firmware workspace
├── vivado/                  # STRICTLY READ-ONLY Vivado hardware project
│   └── digital attendence system using flipflops and FSM/
├── web/                     # Original design prototype reference
└── web-app/                 # Complete modern Vite web application
    ├── netlify.toml         # Base Netlify build configuration
    ├── firestore.rules      # Cloud Firestore production security rules
    ├── package.json         # Dependencies & scripts
    ├── vite.config.js       # Vite bundler configuration
    ├── index.html           # SPA entrypoint
    ├── .env.example         # Example client environment variables
    ├── netlify/
    │   └── functions/
    │       ├── manageDaySchedule.js # Atomic day schedule override management
    │       └── recordAttendance.js  # Atomic Firestore serverless verification
    ├── src/
    │   ├── logic/           # Attendance FSM definition, status codes & statistics engine
    │   ├── firebase/        # Authentication, Firestore CRUD & configuration
    │   ├── services/        # Attendance controller & Web Serial API service
    │   ├── reports/         # PDF and CSV report export engine
    │   ├── components/      # UI icons & logo components
    │   ├── styles/          # AttendEdge responsive CSS design system
    │   └── main.js          # Main UI routing, dashboard & Working Day Management
    └── tests/               # 111 Vitest unit, security, workflow, statistics & schedule management tests
```

---

## 4. How to Deploy on Netlify

### Option A: Automatic Git Deployment (Recommended)
1. Push this repository to GitHub:
   ```bash
   git add .
   git commit -m "Configure AttendEdge for Netlify deployment"
   git push origin main
   ```
2. Log in to [Netlify](https://app.netlify.com/).
3. Click **"Add new site" > "Import an existing project"** and select your GitHub repository.
4. Netlify will automatically detect `netlify.toml`:
   - **Base directory**: `web-app`
   - **Build command**: `npm install && npm run build`
   - **Publish directory**: `dist`
   - **Functions directory**: `netlify/functions`
5. Under **Site configuration > Environment variables**, add your Firebase keys (optional, default demo keys are already provided in `.env.example`):
   ```
   VITE_FIREBASE_API_KEY=AIzaSy...
   VITE_FIREBASE_AUTH_DOMAIN=attendedge-11745.firebaseapp.com
   VITE_FIREBASE_PROJECT_ID=attendedge-11745
   VITE_FIREBASE_STORAGE_BUCKET=attendedge-11745.firebasestorage.app
   VITE_FIREBASE_MESSAGING_SENDER_ID=625261477373
   VITE_FIREBASE_APP_ID=1:625261477373:web:224185f98f3d28076e2d94
   ```
6. Click **Deploy Site**. Netlify will build the frontend and deploy the serverless verification endpoint at `/.netlify/functions/recordAttendance`.

---

## 5. Local Development & Testing

### Install Dependencies
```bash
cd web-app
npm install
```

### Start Local Development Server
```bash
npm run dev
```
Open **`http://localhost:5173`** in your browser.

### Run Automated Test Suite
```bash
npm test
```
Executes all 111 unit, security, schedule override, and transaction verification tests via Vitest.

### Build Production Bundle
```bash
npm run build
```
Generates production assets in `web-app/dist/`.

---

## 6. Firebase Spark Plan Setup

AttendEdge is designed to run 100% on the **Firebase Spark (Free) plan** without requiring paid Google Cloud Functions:

1. Create a Firebase project at [Firebase Console](https://console.firebase.google.com/).
2. Enable **Authentication** (Email/Password).
3. Enable **Cloud Firestore** and publish the security rules in `web-app/firestore.rules`.
4. Deploy the serverless function to Netlify (which acts as the trusted backend for atomic transactions).
5. For offline evaluation, AttendEdge includes a fully isolated **Offline Demo Mode** with demo faculty credentials (`faculty` / `demo123`).
