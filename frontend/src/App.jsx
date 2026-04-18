import React, { useState, useEffect, useRef } from 'react';
import io from 'socket.io-client';
import Peer from 'simple-peer';
import { Phone, PhoneOff, Mic, MicOff, Lock, ShieldCheck, LogOut, Users, MessageSquare } from 'lucide-react';
import axios from 'axios';
import { useGoogleLogin } from '@react-oauth/google';

const SERVER_URL = import.meta.env.VITE_BACKEND_URL || 'http://localhost:5050';

// Separate Component for Remote Audio to properly attach streams
const AudioElement = ({ peer }) => {
  const ref = useRef();
  useEffect(() => {
    peer.on("stream", stream => {
      if (ref.current) {
        ref.current.srcObject = stream;
        ref.current.play().catch(e => console.log('Audio play error:', e));
      }
    });
  }, [peer]);
  return <audio playsInline autoPlay ref={ref} style={{ display: 'none' }} />;
};

function App() {
  // Auth State
  const [token, setToken] = useState(localStorage.getItem('token'));
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [isRegistering, setIsRegistering] = useState(false);
  const [authError, setAuthError] = useState('');

  // Socket & Conference State
  const [socket, setSocket] = useState(null);
  const [inRoom, setInRoom] = useState(false);
  const [roomID, setRoomID] = useState('');
  const [peers, setPeers] = useState([]); // [{ peerID, username, peer }]
  const [stream, setStream] = useState(null);
  const [isMuted, setIsMuted] = useState(false);
  
  // E2EE Chat State
  const [messages, setMessages] = useState([]);
  const [messageInput, setMessageInput] = useState('');

  const peersRef = useRef([]); // mutable ref to track active peers
  const keyPairRef = useRef(null);
  const sharedKeysRef = useRef({}); // { peerID: AES-GCM shared key }
  const myVideo = useRef();

  // --- AUTHENTICATION ---
  useEffect(() => {
    if (token) {
      axios.get(`${SERVER_URL}/api/auth/me`, { headers: { 'x-auth-token': token } })
        .then(res => setUsername(res.data.username))
        .catch(err => {
          console.error(err);
          logout();
        });
    }
  }, [token]);

  const handleAuth = async (e) => {
    e.preventDefault();
    setAuthError('');
    try {
      let res;
      if (isRegistering) {
        res = await axios.post(`${SERVER_URL}/api/auth/register`, { username, email, password });
      } else {
        res = await axios.post(`${SERVER_URL}/api/auth/login`, { email, password });
      }
      localStorage.setItem('token', res.data.token);
      setToken(res.data.token);
      setUsername(res.data.username);
    } catch (err) {
      setAuthError(err.response?.data?.msg || 'Authentication failed.');
    }
  };

  const logout = () => {
    localStorage.removeItem('token');
    setToken(null);
    setUsername('');
    if (socket) socket.disconnect();
    window.location.reload();
  };

  const handleGoogleLogin = useGoogleLogin({
    onSuccess: async (tokenResponse) => {
      try {
        const res = await axios.post(`${SERVER_URL}/api/auth/google`, { credential: tokenResponse.access_token });
        localStorage.setItem('token', res.data.token);
        setToken(res.data.token);
        setUsername(res.data.username);
      } catch (err) {
        setAuthError(err.response?.data?.msg || 'Google Authentication failed.');
      }
    },
    onError: () => setAuthError('Google Login popup was closed or failed.')
  });

  // --- CRYPTOGRAPHY ---
  useEffect(() => {
    async function generateKeys() {
      const kp = await window.crypto.subtle.generateKey(
        { name: 'ECDH', namedCurve: 'P-256' },
        true,
        ['deriveKey', 'deriveBits']
      );
      keyPairRef.current = kp;
    }
    generateKeys();
  }, []);

  const exportPublicKey = async (key) => {
    const exported = await window.crypto.subtle.exportKey('raw', key);
    return Array.from(new Uint8Array(exported));
  };

  const importPublicKey = async (keyArray) => {
    const keyData = new Uint8Array(keyArray).buffer;
    return await window.crypto.subtle.importKey('raw', keyData, { name: 'ECDH', namedCurve: 'P-256' }, true, []);
  };

  const deriveSharedKey = async (privateKey, publicKey) => {
    return await window.crypto.subtle.deriveKey(
      { name: 'ECDH', public: publicKey },
      privateKey,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
  };

  const encryptMessage = async (text, key) => {
    const enc = new TextEncoder();
    const iv = window.crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await window.crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv }, key, enc.encode(text));
    return { iv: Array.from(iv), ciphertext: Array.from(new Uint8Array(ciphertext)) };
  };

  const decryptMessage = async (encryptedData, key) => {
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
  };

  // --- SOCKET INIT ---
  useEffect(() => {
    if (token && username) {
      const newSocket = io(SERVER_URL);
      setSocket(newSocket);
      return () => newSocket.disconnect();
    }
  }, [token, username]);

  // --- MESH WEBRTC LOGIC ---
  useEffect(() => {
    if (!socket || !stream) return;

    socket.on("all users", usersInRoom => {
      const newPeers = [];
      usersInRoom.forEach(user => {
        const peer = createPeer(user.socketID, socket.id, stream, user.username);
        const peerObj = { peerID: user.socketID, peer, username: user.username };
        peersRef.current.push(peerObj);
        newPeers.push(peerObj);
      });
      setPeers(newPeers);
    });

    socket.on("user joined", payload => {
      const peer = addPeer(payload.signal, payload.callerID, stream, payload.username);
      const peerObj = { peerID: payload.callerID, peer, username: payload.username };
      peersRef.current.push(peerObj);
      setPeers(prev => [...prev, peerObj]);
    });

    socket.on("receiving returned signal", payload => {
      const item = peersRef.current.find(p => p.peerID === payload.id);
      if (item) {
        item.peer.signal(payload.signal);
      }
    });

    socket.on("user left", id => {
      const peerObj = peersRef.current.find(p => p.peerID === id);
      if (peerObj) peerObj.peer.destroy();
      const newPeers = peersRef.current.filter(p => p.peerID !== id);
      peersRef.current = newPeers;
      setPeers(newPeers);
      
      // Cleanup shared key
      const keys = { ...sharedKeysRef.current };
      delete keys[id];
      sharedKeysRef.current = keys;
    });

    return () => {
      socket.off("all users");
      socket.off("user joined");
      socket.off("receiving returned signal");
      socket.off("user left");
    };
  }, [socket, stream]);

  // Pairwise Data Channel Setup for E2EE Chat
  const setupPeerDataChannel = (peer, peerID, remoteUsername) => {
    peer.on('data', async (data) => {
      const parsed = JSON.parse(data.toString());
      if (parsed.type === 'PUBLIC_KEY') {
        try {
          const peerPubKey = await importPublicKey(parsed.key);
          const sharedSecret = await deriveSharedKey(keyPairRef.current.privateKey, peerPubKey);
          sharedKeysRef.current[peerID] = sharedSecret;
          console.log(`Pairwise AES-256 Key Established with ${remoteUsername}`);
        } catch (e) {
          console.error('Error deriving key with peer.', e);
        }
      } else if (parsed.type === 'CHAT_MESSAGE') {
        const sharedSecret = sharedKeysRef.current[peerID];
        if (sharedSecret) {
          const decryptedText = await decryptMessage(parsed.payload, sharedSecret);
          setMessages(prev => [...prev, { sender: remoteUsername, text: decryptedText }]);
        }
      }
    });

    peer.on('connect', async () => {
      if (keyPairRef.current) {
        const pubKeyArray = await exportPublicKey(keyPairRef.current.publicKey);
        peer.send(JSON.stringify({ type: 'PUBLIC_KEY', key: pubKeyArray }));
      }
    });
  };

  const createPeer = (userToSignal, callerID, stream, remoteUsername) => {
    const peer = new Peer({
      initiator: true,
      trickle: false,
      stream,
      config: { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] }
    });

    peer.on("signal", signal => {
      socket.emit("sending signal", { userToSignal, callerID, signal, username });
    });

    setupPeerDataChannel(peer, userToSignal, remoteUsername);
    return peer;
  };

  const addPeer = (incomingSignal, callerID, stream, remoteUsername) => {
    const peer = new Peer({
      initiator: false,
      trickle: false,
      stream,
      config: { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] }
    });

    peer.on("signal", signal => {
      socket.emit("returning signal", { signal, callerID });
    });

    peer.signal(incomingSignal);
    setupPeerDataChannel(peer, callerID, remoteUsername);
    return peer;
  };

  const handleJoinRoom = (e) => {
    e.preventDefault();
    if (!roomID.trim()) return;

    if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
      navigator.mediaDevices.getUserMedia({ video: false, audio: true })
        .then((currentStream) => {
          setStream(currentStream);
          if (myVideo.current) myVideo.current.srcObject = currentStream;
          socket.emit("join room", { roomID, username });
          setInRoom(true);
        })
        .catch((err) => {
          console.error("Microphone Error:", err);
          alert("Could not access microphone. Please ensure permissions are granted.");
        });
    } else {
      alert("Microphone access is blocked. This usually happens if you are not using HTTPS or localhost.");
    }
  };

  const leaveRoom = () => {
    peersRef.current.forEach(p => p.peer.destroy());
    peersRef.current = [];
    setPeers([]);
    sharedKeysRef.current = {};
    if (stream) stream.getTracks().forEach(t => t.stop());
    setStream(null);
    setInRoom(false);
    setRoomID('');
    setMessages([]);
    socket.emit("disconnect"); // Trigger user left immediately
    window.location.reload();
  };

  const sendGroupMessage = async (e) => {
    e.preventDefault();
    if (!messageInput.trim()) return;

    // Encrypt and send individually to each peer using pairwise keys
    for (const p of peersRef.current) {
      const sharedSecret = sharedKeysRef.current[p.peerID];
      if (sharedSecret) {
        const encryptedPayload = await encryptMessage(messageInput, sharedSecret);
        p.peer.send(JSON.stringify({ type: 'CHAT_MESSAGE', payload: encryptedPayload }));
      }
    }
    
    setMessages(prev => [...prev, { sender: 'You', text: messageInput }]);
    setMessageInput('');
  };

  const toggleMute = () => {
    if (stream) {
      const track = stream.getAudioTracks()[0];
      track.enabled = !track.enabled;
      setIsMuted(!track.enabled);
    }
  };

  // --- RENDER ---
  if (!token || !username) {
    return (
      <div className="auth-wrapper">
        <div className="auth-card">
          <ShieldCheck size={64} color="var(--accent-cyan)" style={{ margin: '0 auto 16px', filter: 'drop-shadow(0 0 10px rgba(0, 242, 254, 0.5))' }} />
          <h2>Welcome Back</h2>
          <p>Sign in to the secure VoIP network</p>
          {authError && <div style={{ color: 'var(--danger)', marginBottom: '16px', fontSize: '0.9rem', fontWeight: 500 }}>{authError}</div>}
          <form className="auth-form" onSubmit={handleAuth}>
            {isRegistering && (
              <div className="input-group">
                <input type="text" placeholder="Choose a Username" className="input-field" value={username} onChange={e => setUsername(e.target.value)} required />
              </div>
            )}
            <div className="input-group">
              <input type="email" placeholder="Email Address" className="input-field" value={email} onChange={e => setEmail(e.target.value)} required />
            </div>
            <div className="input-group">
              <input type="password" placeholder="Password" className="input-field" value={password} onChange={e => setPassword(e.target.value)} required />
            </div>
            <button type="submit" className="btn btn-primary" style={{ width: '100%', marginTop: '8px' }}>
              {isRegistering ? 'Create Account' : 'Sign In'}
            </button>
          </form>
          <button className="btn btn-ghost" style={{ width: '100%', fontSize: '0.85rem', marginTop: '16px' }} onClick={() => setIsRegistering(!isRegistering)}>
            {isRegistering ? 'Already have an account? Sign in' : 'Need an account? Register'}
          </button>
          <div className="auth-divider">OR</div>
          <button type="button" className="btn google-btn" onClick={() => handleGoogleLogin()}>
            <svg viewBox="0 0 24 24" width="20" height="20" style={{ marginRight: '8px' }}>
              <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
              <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
              <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/>
              <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
            </svg>
            Continue with Google
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="app-container">
      <div className="sidebar" style={{ width: '300px' }}>
        <div className="sidebar-header">
          <h1>E-VoIP Mesh</h1>
          <button className="btn btn-ghost" style={{ padding: '8px 12px' }} onClick={logout} title="Logout">
            <LogOut size={18} />
          </button>
        </div>
        <div className="user-profile">
          <div className="user-status-dot"></div>
          <div>
            <strong>{username}</strong>
            <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>Network Active</div>
          </div>
        </div>
        
        {inRoom && (
          <div className="contacts-section">
            <h3><Users size={16} style={{ display: 'inline', marginRight: '6px' }}/> Room: {roomID}</h3>
            <ul className="user-list">
              <li className="user-item" style={{ background: 'rgba(255,255,255,0.05)' }}>
                <span className="user-name"><strong>You</strong></span>
              </li>
              {peers.map((peer, index) => (
                <li key={index} className="user-item">
                  <span className="user-name">{peer.username}</span>
                  <ShieldCheck size={16} color="var(--success)" title="Pairwise E2EE Secured" />
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      <div className="call-area">
        <div className="call-overlay"></div>
        <audio playsInline muted ref={myVideo} autoPlay style={{ display: 'none' }} />
        
        {/* Render incoming streams from all peers */}
        {peers.map((peer) => (
          <AudioElement key={peer.peerID} peer={peer.peer} />
        ))}

        <div className="call-content" style={{ width: '100%', maxWidth: '800px' }}>
          {!inRoom ? (
            <div className="room-join-card" style={{ textAlign: 'center', background: 'var(--bg-panel)', padding: '40px', borderRadius: '24px', backdropFilter: 'var(--glass-blur)', border: '1px solid var(--border-light)' }}>
              <ShieldCheck size={80} color="var(--accent-cyan)" style={{ marginBottom: '20px', filter: 'drop-shadow(0 0 15px rgba(0,242,254,0.4))' }} />
              <h2 style={{ fontSize: '2.5rem', marginBottom: '10px' }}>Join a Conference</h2>
              <p style={{ color: 'var(--text-muted)', marginBottom: '30px' }}>Enter a room code to establish an encrypted mesh network with your team.</p>
              
              <form onSubmit={handleJoinRoom} style={{ display: 'flex', flexDirection: 'column', gap: '16px', maxWidth: '400px', margin: '0 auto' }}>
                <input 
                  type="text" 
                  className="input-field" 
                  placeholder="e.g. 'AlphaSquad' or 'Meeting123'" 
                  value={roomID} 
                  onChange={e => setRoomID(e.target.value)} 
                  required 
                />
                <button type="submit" className="btn btn-primary" style={{ padding: '16px', fontSize: '1.1rem' }}>
                  <Users size={20} style={{ marginRight: '8px' }} /> Enter Room
                </button>
              </form>
            </div>
          ) : (
            <div style={{ width: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
              <div className="radar-container" style={{ marginBottom: '20px' }}>
                <div className="radar-ring"></div>
                <div className="radar-ring"></div>
                <div className="radar-ring"></div>
                <div className="caller-avatar">
                  <Users size={48} color="white" />
                </div>
              </div>
              
              <h2 style={{ fontSize: '2.2rem', fontWeight: 700 }}>Mesh Network Established</h2>
              <div className="encryption-badge" style={{ marginBottom: '30px' }}>
                <Lock size={16} /> AES-256 Pairwise Multi-Encryption Active
              </div>

              <div className="chat-container" style={{ width: '100%', maxWidth: '600px', height: '300px', marginBottom: '30px' }}>
                <div className="messages">
                  {messages.length === 0 && <div style={{ color: 'var(--text-muted)', textAlign: 'center', marginTop: '20px' }}>End-to-End Encrypted Group Chat</div>}
                  {messages.map((m, i) => (
                    <div key={i} className={`message ${m.sender === 'You' ? 'you' : 'peer'}`}>
                      <div style={{ fontSize: '0.8rem', opacity: 0.7, marginBottom: '4px' }}>{m.sender}</div>
                      <div>{m.text}</div>
                    </div>
                  ))}
                </div>
                <form onSubmit={sendGroupMessage} style={{ display: 'flex', gap: '12px' }}>
                  <input type="text" className="input-field" placeholder="Send encrypted message to room..." value={messageInput} onChange={e => setMessageInput(e.target.value)} />
                  <button type="submit" className="btn btn-primary" style={{ padding: '0 24px' }}>
                    <MessageSquare size={20} />
                  </button>
                </form>
              </div>

              <div className="controls-bar">
                <button className="btn" style={{ backgroundColor: isMuted ? 'var(--danger)' : 'rgba(255,255,255,0.1)' }} onClick={toggleMute}>
                  {isMuted ? <MicOff size={24} /> : <Mic size={24} />}
                </button>
                <button className="btn btn-danger" onClick={leaveRoom}>
                  <PhoneOff size={24} /> Leave
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default App;
