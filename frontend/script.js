// --- CONSTANTS & CONFIG ---
const SERVER_URL = 'http://localhost:5050'; // Adjust for production if needed
const ICE_SERVERS = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
    { urls: 'stun:stun3.l.google.com:19302' },
    { urls: 'stun:stun4.l.google.com:19302' },
    // For reliable laptop-to-laptop connections, add a TURN server here:
    // { urls: 'turn:your-turn-server.com', username: 'user', credential: 'password' }
];

// --- STATE MANAGEMENT ---
let state = {
    token: localStorage.getItem('token'),
    username: '',
    isRegistering: false,
    socket: null,
    inRoom: false,
    roomID: '',
    peers: [], // [{ peerID, username, peer }]
    stream: null,
    isMuted: false,
    messages: [],
    keyPair: null,
    sharedKeys: {}, // { peerID: AES-GCM shared key }
};

// --- DOM ELEMENTS ---
const elements = {
    authScreen: document.getElementById('auth-screen'),
    appScreen: document.getElementById('app-screen'),
    authForm: document.getElementById('auth-form'),
    usernameGroup: document.getElementById('username-group'),
    authTitle: document.getElementById('auth-title'),
    authSubtitle: document.getElementById('auth-subtitle'),
    authSubmit: document.getElementById('auth-submit'),
    toggleAuth: document.getElementById('toggle-auth'),
    authError: document.getElementById('auth-error'),
    displayUsername: document.getElementById('display-username'),
    logoutBtn: document.getElementById('logout-btn'),
    roomInfo: document.getElementById('room-info'),
    userList: document.getElementById('user-list'),
    joinRoomView: document.getElementById('join-room-view'),
    activeCallView: document.getElementById('active-call-view'),
    joinRoomForm: document.getElementById('join-room-form'),
    roomIDInput: document.getElementById('room-id-input'),
    chatMessages: document.getElementById('chat-messages'),
    chatForm: document.getElementById('chat-form'),
    chatInput: document.getElementById('chat-input'),
    muteBtn: document.getElementById('mute-btn'),
    leaveBtn: document.getElementById('leave-btn'),
    audioContainer: document.getElementById('audio-container'),
    myAudio: document.getElementById('my-audio'),
    participantGrid: document.getElementById('participant-grid'),
};

// --- INITIALIZATION ---
async function init() {
    console.log('App Initializing...');
    lucide.createIcons();
    
    // Check for Secure Context (WebRTC requirement)
    if (!window.isSecureContext && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') {
        showError('SECURITY ERROR: WebRTC requires a secure context (HTTPS or localhost). Please use http://localhost:3000');
    }
    
    if (state.token) {
        try {
            const res = await axios.get(`${SERVER_URL}/api/auth/me`, { headers: { 'x-auth-token': state.token } });
            state.username = res.data.username;
            showApp();
        } catch (err) {
            console.error('Auth check failed:', err);
            showAuth(); // Show login instead of reloading (prevents loops)
        }
    } else {
        showAuth();
    }

    await generateKeys();
    
    if (document.readyState === 'complete') {
        setupGoogleLogin();
    } else {
        window.addEventListener('load', setupGoogleLogin);
    }
}

function showError(msg) {
    console.error(msg);
    const errDiv = document.getElementById('auth-error');
    if (errDiv) {
        errDiv.innerText = msg;
        errDiv.style.display = 'block';
    }
    alert(msg);
}

// --- AUTHENTICATION ---
function showAuth() {
    elements.authScreen.style.display = 'flex';
    elements.appScreen.style.display = 'none';
}

function showApp() {
    elements.authScreen.style.display = 'none';
    elements.appScreen.style.display = 'flex';
    elements.displayUsername.innerText = state.username;
    initSocket();
}

elements.toggleAuth.addEventListener('click', () => {
    state.isRegistering = !state.isRegistering;
    elements.usernameGroup.style.display = state.isRegistering ? 'block' : 'none';
    elements.authTitle.innerText = state.isRegistering ? 'Create Account' : 'Welcome Back';
    elements.authSubtitle.innerText = state.isRegistering ? 'Join the secure network' : 'Sign in to the secure VoIP network';
    elements.authSubmit.innerText = state.isRegistering ? 'Register' : 'Sign In';
    elements.toggleAuth.innerText = state.isRegistering ? 'Already have an account? Sign in' : 'Need an account? Register';
});

elements.authForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = document.getElementById('email').value;
    const password = document.getElementById('password').value;
    const username = document.getElementById('username').value;
    
    elements.authError.innerText = '';
    try {
        let res;
        if (state.isRegistering) {
            res = await axios.post(`${SERVER_URL}/api/auth/register`, { username, email, password });
        } else {
            res = await axios.post(`${SERVER_URL}/api/auth/login`, { email, password });
        }
        localStorage.setItem('token', res.data.token);
        state.token = res.data.token;
        state.username = res.data.username;
        showApp();
    } catch (err) {
        elements.authError.innerText = err.response?.data?.msg || 'Authentication failed.';
    }
});

function logout() {
    localStorage.removeItem('token');
    state.token = null;
    state.username = '';
    if (state.socket) state.socket.disconnect();
    state.socket = null;
    showAuth();
}

elements.logoutBtn.addEventListener('click', logout);

function setupGoogleLogin() {
    if (typeof google === 'undefined' || !google.accounts) {
        console.warn('Google Identity Services script not loaded. Social login unavailable.');
        const btn = document.getElementById("google-login-btn");
        if (btn) btn.innerHTML = '<p style="font-size: 0.8rem; color: var(--text-muted);">Social login unavailable in this browser.</p>';
        return;
    }

    google.accounts.id.initialize({
        client_id: "309372709932-35cueldgo77ssqm2gnit2bnnr40bqeab.apps.googleusercontent.com",
        callback: handleGoogleResponse
    });
    google.accounts.id.renderButton(
        document.getElementById("google-login-btn"),
        { theme: "outline", size: "large", width: 360 }
    );
}

async function handleGoogleResponse(response) {
    try {
        const res = await axios.post(`${SERVER_URL}/api/auth/google`, { credential: response.credential });
        localStorage.setItem('token', res.data.token);
        state.token = res.data.token;
        state.username = res.data.username;
        showApp();
    } catch (err) {
        elements.authError.innerText = 'Google Authentication failed.';
    }
}

// --- CRYPTOGRAPHY ---
async function generateKeys() {
    state.keyPair = await window.crypto.subtle.generateKey(
        { name: 'ECDH', namedCurve: 'P-256' },
        true,
        ['deriveKey', 'deriveBits']
    );
}

async function exportPublicKey(key) {
    const exported = await window.crypto.subtle.exportKey('raw', key);
    return Array.from(new Uint8Array(exported));
}

async function importPublicKey(keyArray) {
    const keyData = new Uint8Array(keyArray).buffer;
    return await window.crypto.subtle.importKey('raw', keyData, { name: 'ECDH', namedCurve: 'P-256' }, true, []);
}

async function deriveSharedKey(privateKey, publicKey) {
    return await window.crypto.subtle.deriveKey(
        { name: 'ECDH', public: publicKey },
        privateKey,
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt', 'decrypt']
    );
}

async function encryptMessage(text, key) {
    const enc = new TextEncoder();
    const iv = window.crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await window.crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv }, key, enc.encode(text));
    return { iv: Array.from(iv), ciphertext: Array.from(new Uint8Array(ciphertext)) };
}

async function decryptMessage(encryptedData, key) {
    const dec = new TextDecoder();
    try {
        const decrypted = await window.crypto.subtle.decrypt(
            { name: 'AES-GCM', iv: new Uint8Array(encryptedData.iv) },
            key, new Uint8Array(encryptedData.ciphertext)
        );
        return dec.decode(decrypted);
    } catch (e) {
        return "[Decryption Failed]";
    }
}

// --- SOCKET & WEBRTC ---
function getPeerConstructor() {
    if (typeof SimplePeer !== 'undefined') return SimplePeer;
    if (typeof Peer !== 'undefined') return Peer;
    throw new Error('WebRTC Library (SimplePeer) not found. Check your internet connection or CDN links.');
}

function initSocket() {
    if (state.socket) return;
    try {
        state.socket = io(SERVER_URL);
    } catch (e) {
        showError('Failed to connect to signaling server at ' + SERVER_URL);
        return;
    }

    state.socket.on("all users", usersInRoom => {
        usersInRoom.forEach(user => {
            const peer = createPeer(user.socketID, state.socket.id, state.stream, user.username);
            const peerObj = { peerID: user.socketID, peer, username: user.username };
            state.peers.push(peerObj);
        });
        updateUserList();
    });

    state.socket.on("user joined", payload => {
        const peer = addPeer(payload.signal, payload.callerID, state.stream, payload.username);
        const peerObj = { peerID: payload.callerID, peer, username: payload.username };
        state.peers.push(peerObj);
        updateUserList();
    });

    state.socket.on("receiving returned signal", payload => {
        const item = state.peers.find(p => p.peerID === payload.id);
        if (item) {
            item.peer.signal(payload.signal);
        }
    });

    state.socket.on("user left", id => {
        const peerObj = state.peers.find(p => p.peerID === id);
        if (peerObj) peerObj.peer.destroy();
        state.peers = state.peers.filter(p => p.peerID !== id);
        delete state.sharedKeys[id];
        updateUserList();
        updateParticipantGrid();
    });
}

function createPeer(userToSignal, callerID, stream, remoteUsername) {
    const PeerClass = getPeerConstructor();
    const peer = new PeerClass({
        initiator: true,
        trickle: false,
        stream,
        config: { iceServers: ICE_SERVERS }
    });

    peer.on("signal", signal => {
        state.socket.emit("sending signal", { userToSignal, callerID, signal, username: state.username });
    });

    setupPeerEvents(peer, userToSignal, remoteUsername);
    return peer;
}

function addPeer(incomingSignal, callerID, stream, remoteUsername) {
    const PeerClass = getPeerConstructor();
    const peer = new PeerClass({
        initiator: false,
        trickle: false,
        stream,
        config: { iceServers: ICE_SERVERS }
    });

    peer.on("signal", signal => {
        state.socket.emit("returning signal", { signal, callerID });
    });

    peer.signal(incomingSignal);
    setupPeerEvents(peer, callerID, remoteUsername);
    return peer;
}

function setupPeerEvents(peer, peerID, remoteUsername) {
    peer.on('stream', stream => {
        const audio = document.createElement('audio');
        audio.id = `audio-${peerID}`;
        audio.srcObject = stream;
        audio.autoplay = true;
        audio.playsInline = true;
        elements.audioContainer.appendChild(audio);
    });

    peer.on('data', async (data) => {
        const parsed = JSON.parse(data.toString());
        if (parsed.type === 'PUBLIC_KEY') {
            const peerPubKey = await importPublicKey(parsed.key);
            const sharedSecret = await deriveSharedKey(state.keyPair.privateKey, peerPubKey);
            state.sharedKeys[peerID] = sharedSecret;
            console.log(`E2EE Established with ${remoteUsername}`);
        } else if (parsed.type === 'CHAT_MESSAGE') {
            const sharedSecret = state.sharedKeys[peerID];
            if (sharedSecret) {
                const decryptedText = await decryptMessage(parsed.payload, sharedSecret);
                addChatMessage(remoteUsername, decryptedText);
            }
        }
    });

    peer.on('connect', async () => {
        const pubKeyArray = await exportPublicKey(state.keyPair.publicKey);
        peer.send(JSON.stringify({ type: 'PUBLIC_KEY', key: pubKeyArray }));
    });

    peer.on('close', () => {
        const audio = document.getElementById(`audio-${peerID}`);
        if (audio) audio.remove();
    });
}

// --- UI UPDATES ---
function updateUserList() {
    elements.userList.innerHTML = `
        <li class="user-item" style="background: rgba(255,255,255,0.05)">
            <span class="user-name">
                <div class="mini-avatar" style="background: ${getUserColor(state.username)}">${state.username.charAt(0).toUpperCase()}</div>
                <strong>You</strong>
            </span>
        </li>
    `;
    state.peers.forEach(p => {
        const li = document.createElement('li');
        li.className = 'user-item';
        li.innerHTML = `
            <span class="user-name">
                <div class="mini-avatar" style="background: ${getUserColor(p.username)}">${p.username.charAt(0).toUpperCase()}</div>
                ${p.username}
            </span>
            <i data-lucide="shield-check" color="var(--success)" style="width: 16px; height: 16px;"></i>
        `;
        elements.userList.appendChild(li);
    });
    lucide.createIcons();
    updateParticipantGrid();
}

function updateParticipantGrid() {
    if (!elements.participantGrid) return;
    elements.participantGrid.innerHTML = '';
    
    // Add Self
    addParticipantToGrid(state.username, true);
    
    // Add Peers
    state.peers.forEach(p => {
        addParticipantToGrid(p.username, false);
    });
}

function addParticipantToGrid(name, isSelf) {
    const card = document.createElement('div');
    card.className = 'participant-card';
    card.innerHTML = `
        <div class="participant-avatar" style="border-color: ${getUserColor(name)}">
            <div class="avatar-inner" style="background: ${getUserColor(name)}">
                ${name.charAt(0).toUpperCase()}
            </div>
        </div>
        <div class="participant-name">${name}${isSelf ? ' (You)' : ''}</div>
    `;
    elements.participantGrid.appendChild(card);
}

function getUserColor(name) {
    const colors = ['#00f2fe', '#8e2de2', '#ff0844', '#f8fafc', '#10b981', '#fbbf24'];
    let hash = 0;
    for (let i = 0; i < name.length; i++) {
        hash = name.charCodeAt(i) + ((hash << 5) - hash);
    }
    return colors[Math.abs(hash) % colors.length];
}

function addChatMessage(sender, text) {
    const isYou = sender === 'You';
    const msgDiv = document.createElement('div');
    msgDiv.className = `message ${isYou ? 'you' : 'peer'}`;
    msgDiv.innerHTML = `
        <div style="font-size: 0.8rem; opacity: 0.7; margin-bottom: 4px;">${sender}</div>
        <div>${text}</div>
    `;
    elements.chatMessages.appendChild(msgDiv);
    elements.chatMessages.scrollTop = elements.chatMessages.scrollHeight;
}

// --- CALL ACTIONS ---
elements.joinRoomForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const roomID = elements.roomIDInput.value.trim();
    if (!roomID) return;

    try {
        state.stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
        elements.myAudio.srcObject = state.stream;
        state.roomID = roomID;
        state.socket.emit("join room", { roomID, username: state.username });
        
        elements.joinRoomView.style.setProperty('display', 'none', 'important');
        elements.activeCallView.style.setProperty('display', 'flex', 'important');
        elements.roomInfo.style.display = 'block';
        state.inRoom = true;
        lucide.createIcons();
    } catch (err) {
        console.error("Mic Error:", err);
        alert("Could not access microphone.");
    }
});

elements.chatForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = elements.chatInput.value.trim();
    if (!text) return;

    for (const p of state.peers) {
        const sharedSecret = state.sharedKeys[p.peerID];
        if (sharedSecret) {
            const encrypted = await encryptMessage(text, sharedSecret);
            p.peer.send(JSON.stringify({ type: 'CHAT_MESSAGE', payload: encrypted }));
        }
    }
    
    addChatMessage('You', text);
    elements.chatInput.value = '';
});

elements.muteBtn.addEventListener('click', () => {
    if (state.stream) {
        const track = state.stream.getAudioTracks()[0];
        track.enabled = !track.enabled;
        state.isMuted = !track.enabled;
        elements.muteBtn.innerHTML = state.isMuted ? '<i data-lucide="mic-off"></i>' : '<i data-lucide="mic"></i>';
        elements.muteBtn.style.backgroundColor = state.isMuted ? 'var(--danger)' : 'rgba(255,255,255,0.1)';
        lucide.createIcons();
    }
});

elements.leaveBtn.addEventListener('click', () => {
    window.location.reload();
});

init();
