# Encrypted VoIP Communication System (E-VoIP Mesh)

A full-stack, secure Voice over IP (VoIP) application that enables end-to-end encrypted voice calling and text chat in a multi-peer mesh network.

## 🚀 Features

- **Secure Authentication:**
  - Email and password registration/login with bcrypt password hashing.
  - Social Login via Google Identity Services.
  - JWT-based authentication for secure session management.
- **Full Mesh WebRTC Conferencing:**
  - Connect multiple participants in a single room seamlessly.
  - Real-time voice communication using SimplePeer.
- **End-to-End Encryption (E2EE):**
  - **Key Exchange:** ECDH (Elliptic Curve Diffie-Hellman) using the P-256 curve.
  - **Message Encryption:** AES-GCM (256-bit) encryption for pairwise secure communication.
  - Ensures group chat messages are fully encrypted before leaving the browser.
- **Real-Time Signaling:** Robust room and connection management using Socket.IO.
- **Modern UI/UX:** Responsive, dark-themed interface built with vanilla HTML/CSS and Lucide icons.

## 🛠️ Tech Stack

**Frontend:**
- HTML5, CSS3, JavaScript (Vanilla)
- [SimplePeer](https://github.com/feross/simple-peer) (WebRTC)
- [Socket.IO Client](https://socket.io/)
- [Axios](https://axios-http.com/)
- Google Identity Services (GSI)

**Backend:**
- [Node.js](https://nodejs.org/) & [Express.js](https://expressjs.com/)
- [Socket.IO](https://socket.io/) (Signaling Server)
- [MongoDB](https://www.mongodb.com/) & [Mongoose](https://mongoosejs.com/)
- [JSON Web Tokens (JWT)](https://jwt.io/) & [bcryptjs](https://www.npmjs.com/package/bcryptjs)

## 📂 Project Structure

```text
encrypted-voip-main/
├── backend/            # Node.js/Express server
│   ├── models/         # Mongoose schemas (e.g., User)
│   ├── routes/         # Express API routes (e.g., auth)
│   ├── server.js       # Main entry point & Socket.IO signaling logic
│   └── package.json    # Backend dependencies
└── frontend/           # Vanilla JS client application
    ├── index.html      # Main application UI
    ├── style.css       # Styling and themes
    ├── script.js       # Core logic (WebRTC, Encryption, Socket, UI)
    └── package.json    # Frontend scripts (http-server)
```

## ⚙️ Setup and Installation

### Prerequisites
- [Node.js](https://nodejs.org/) (v16+ recommended)
- [MongoDB](https://www.mongodb.com/) (Local instance or MongoDB Atlas)

### 1. Clone the repository
```bash
git clone <repository-url>
cd encrypted-voip-main
```

### 2. Backend Setup
```bash
cd backend
npm install
```

Create a `.env` file in the `backend` directory and add the following variables (adjust as necessary):
```env
PORT=5050
MONGO_URI=mongodb://127.0.0.1:27017/voip
JWT_SECRET=your_super_secret_jwt_key
```

Start the backend server:
```bash
npm run dev
# Server runs on http://localhost:5050
```

### 3. Frontend Setup
Open a new terminal window/tab:
```bash
cd frontend
npm install
```

Start the frontend server:
```bash
npm run dev
# App runs on http://localhost:3000
```

## 🔒 Security Notes
- **HTTPS Required for WebRTC:** Accessing the microphone and establishing WebRTC connections requires a secure context. When running locally, `http://localhost` or `http://127.0.0.1` works. For production, the frontend **must** be served over HTTPS.
- **E2EE Details:** The encryption keys are generated client-side via Web Crypto API and are never sent to the signaling server. The signaling server only facilitates the exchange of public keys and encrypted payloads.

## 🤝 Contributing
Contributions are welcome!
