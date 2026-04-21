End-to-end encrypted voice calls + chat using **AES-256-GCM** (symmetric) or **RSA-2048 + AES-GCM** (asymmetric), built with plain HTML/JS on the frontend and Node.js on the backend.

---

## Architecture

```
Browser A                Signaling Server           Browser B
   │                    (Node.js + Socket.io)           │
   │── join-room ──────────────────────────────────────>│
   │<─ peer-joined (+ public key) ──────────────────────│
   │                                                     │
   │  [Asymmetric mode only]                             │
   │── send-encrypted-key (AES key encrypted w/ RSA) ──>│
   │                                                     │
   │── WebRTC offer ─────────────────────────────────── │
   │<─ WebRTC answer ────────────────────────────────── │
   │                                                     │
   │════ DataChannel: AES-GCM encrypted audio chunks ══>│
   │<═══ AES-GCM encrypted audio chunks ════════════════│
   │                                                     │
   │── chat-message (AES-GCM encrypted text) ──────────>│
```

**The signaling server never sees audio or message content — only WebRTC handshake signals.**

---

## Encryption Modes

### 🔑 Symmetric (AES-256-GCM)
- Both peers generate the **same** AES-256 key locally
- ⚠️ In a real deployment, this key must be shared out-of-band (e.g., QR code, physical exchange)
- In this demo both users share the same key by design
- All audio chunks and chat messages are AES-GCM encrypted

### 🗝️ Asymmetric (RSA-2048 + AES-GCM)
1. Each peer generates an **RSA-2048 key pair** locally
2. Public keys are exchanged through the signaling server
3. The **caller** generates a random AES-256 session key
4. The caller **encrypts the session key with the peer's RSA public key** and sends it
5. The peer **decrypts it with their RSA private key**
6. Both now share the same AES session key — audio and chat are encrypted with it

---

## Project Structure

```
encrypted-voip/
├── backend/
│   ├── server.js          # Signaling server (Express + Socket.io)
│   └── package.json
└── frontend/
    ├── index.html         # Main UI
    ├── style.css          # Dark terminal styling
    ├── crypto-utils.js    # Web Crypto API helpers (AES + RSA)
    └── app.js             # App logic: WebRTC, encryption, signaling
```

---

## Setup & Running

### 1. Start the Backend

```bash
cd backend
npm install
npm run dev        # uses nodemon for hot reload
# or: npm start
```

Server runs at **http://localhost:3001**

### 2. Open the Frontend

Since the frontend uses plain HTML/JS, just open it in a browser.
For local development use a simple static server (needed for microphone access on some browsers):

```bash
cd frontend
npx serve .        # or: python3 -m http.server 8080
```

Then open **http://lo
calhost:8080** in **two different browser tabs or windows**.

### 3. Make a Call

1. In **Tab 1**: Choose encryption mode → click **"+ Create Room"** → copy the Room ID
2. In **Tab 2**: Choose the **same** encryption mode → paste Room ID → click **"Join →"**
3. Grant microphone access when prompted
4. Click **"My Key"**, **"Peer's Key"**, **"Session Key"** to inspect the cryptographic keys in use
5. Type in the chat box — messages are AES-GCM encrypted before being sent

---

## Technologies

| Layer | Technology |
|---|---|
| Audio capture | Web Audio API (`ScriptProcessorNode`) |
| Encryption | Web Crypto API (`AES-GCM`, `RSA-OAEP`) |
| Peer transport | WebRTC `RTCPeerConnection` + `DataChannel` |
| Signaling | Socket.io over WebSocket |
| Backend | Node.js + Express + Socket.io |
| Frontend | Plain HTML5 + CSS3 + Vanilla JS |

---

## Security Notes

- Private keys **never leave the browser** — they are not sent to the server
- The signaling server only relays WebRTC SDP/ICE and encrypted key material
- Each session uses a **fresh AES key** (asymmetric mode) or a locally-generated key (symmetric mode)
- IVs are randomly generated per-chunk (AES-GCM requirement)
- For production: add HTTPS/WSS, TURN server credentials, and proper key verification (fingerprinting)
