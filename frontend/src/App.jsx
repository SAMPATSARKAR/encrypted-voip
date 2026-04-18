import React, { useState, useEffect, useRef } from 'react';
import io from 'socket.io-client';
import Peer from 'simple-peer';
import { Phone, PhoneOff, Mic, MicOff, Lock, ShieldCheck, User, LogOut } from 'lucide-react';
import axios from 'axios';

const SERVER_URL = import.meta.env.VITE_BACKEND_URL || 'http://localhost:5050';

function App() {
  // Auth State
  const [token, setToken] = useState(localStorage.getItem('token'));
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [isRegistering, setIsRegistering] = useState(false);
  const [authError, setAuthError] = useState('');

  const [socket, setSocket] = useState(null);
  const [users, setUsers] = useState([]);
  
  // Call State
  const [stream, setStream] = useState(null);
  const [receivingCall, setReceivingCall] = useState(false);
  const [caller, setCaller] = useState('');
  const [callerSignal, setCallerSignal] = useState(null);
  const [callAccepted, setCallAccepted] = useState(false);
  const [callEnded, setCallEnded] = useState(false);
  const [isMuted, setIsMuted] = useState(false);

  // E2EE Chat State
  const [messages, setMessages] = useState([]);
  const [messageInput, setMessageInput] = useState('');
  const [cryptoState, setCryptoState] = useState('Waiting to exchange keys...');
  const [sharedKey, setSharedKey] = useState(null);
  const [keyPair, setKeyPair] = useState(null);

  const myVideo = useRef();
  const userVideo = useRef();
  const connectionRef = useRef();
  const sharedKeyRef = useRef(null);
  const ringtoneRef = useRef(null);

  // --- AUTHENTICATION ---
  
  // Check token on load
  useEffect(() => {
    if (token) {
      axios.get(`${SERVER_URL}/api/auth/me`, {
        headers: { 'x-auth-token': token }
      }).then(res => {
        setUsername(res.data.username);
      }).catch(err => {
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
      setAuthError(err.response?.data?.msg || 'Authentication failed. Is MongoDB connected?');
    }
  };

  const logout = () => {
    localStorage.removeItem('token');
    setToken(null);
    setUsername('');
    if (socket) socket.disconnect();
    window.location.reload();
  };

  const handleGoogleLogin = () => {
    alert("To enable Google OAuth, you must provide a Google Client ID in the code. For now, please use the Email & Password form above!");
  };

  // --- CRYPTOGRAPHY ---
  useEffect(() => {
    async function generateKeys() {
      const kp = await window.crypto.subtle.generateKey(
        { name: 'ECDH', namedCurve: 'P-256' },
        true,
        ['deriveKey', 'deriveBits']
      );
      setKeyPair(kp);
    }
    generateKeys();
  }, []);

  const exportPublicKey = async (key) => {
    const exported = await window.crypto.subtle.exportKey('raw', key);
    return Array.from(new Uint8Array(exported));
  };

  const importPublicKey = async (keyArray) => {
    const keyData = new Uint8Array(keyArray).buffer;
    return await window.crypto.subtle.importKey(
      'raw', keyData, { name: 'ECDH', namedCurve: 'P-256' }, true, []
    );
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
    const ciphertext = await window.crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: iv }, key, enc.encode(text)
    );
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

  // --- WEBRTC & SOCKET ---
  
  useEffect(() => {
    if (receivingCall && !callAccepted && !callEnded && ringtoneRef.current) {
      ringtoneRef.current.play().catch(e => console.log(e));
    } else if (ringtoneRef.current) {
      ringtoneRef.current.pause();
      ringtoneRef.current.currentTime = 0;
    }
  }, [receivingCall, callAccepted, callEnded]);

  useEffect(() => {
    if (token && username) {
      const newSocket = io(SERVER_URL);
      setSocket(newSocket);

      navigator.mediaDevices.getUserMedia({ video: false, audio: true }).then((currentStream) => {
        setStream(currentStream);
        if (myVideo.current) myVideo.current.srcObject = currentStream;
      });

      newSocket.emit('register', username);

      newSocket.on('users', (userList) => {
        setUsers(userList.filter(u => u !== username));
      });

      newSocket.on('callUser', (data) => {
        setReceivingCall(true);
        setCaller(data.from);
        setCallerSignal(data.signal);
      });

      newSocket.on('callEnded', leaveCall);

      return () => newSocket.close();
    }
  }, [token, username]);

  const setupPeerDataChannel = (peer) => {
    peer.on('data', async (data) => {
      const parsed = JSON.parse(data.toString());
      if (parsed.type === 'PUBLIC_KEY') {
        setCryptoState('Received peer key. Deriving AES-256...');
        try {
          const peerPubKey = await importPublicKey(parsed.key);
          const sharedSecret = await deriveSharedKey(keyPair.privateKey, peerPubKey);
          setSharedKey(sharedSecret);
          sharedKeyRef.current = sharedSecret;
          setCryptoState('E2EE Secured (AES-256 GCM)');
        } catch (e) {
          setCryptoState('Error deriving key.');
        }
      } else if (parsed.type === 'CHAT_MESSAGE') {
        if (sharedKeyRef.current) {
          const decryptedText = await decryptMessage(parsed.payload, sharedKeyRef.current);
          setMessages(prev => [...prev, { sender: 'Peer', text: decryptedText }]);
        }
      }
    });

    peer.on('connect', async () => {
      if (keyPair) {
        setCryptoState('Sending public key...');
        const pubKeyArray = await exportPublicKey(keyPair.publicKey);
        peer.send(JSON.stringify({ type: 'PUBLIC_KEY', key: pubKeyArray }));
      }
    });
  };

  const callUser = (userToCall) => {
    const peer = new Peer({
      initiator: true, trickle: false, stream: stream,
      config: { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] }
    });

    peer.on('error', err => setCryptoState('Error: ' + err.message));
    setupPeerDataChannel(peer);

    peer.on('signal', data => {
      socket.emit('callUser', { userToCall, signalData: data, from: username });
    });

    peer.on('stream', currentStream => {
      if (userVideo.current) {
        userVideo.current.srcObject = currentStream;
        userVideo.current.play().catch(e => console.log(e));
      }
    });

    socket.on('callAccepted', signal => {
      setCallAccepted(true);
      peer.signal(signal);
    });

    connectionRef.current = peer;
  };

  const answerCall = () => {
    setCallAccepted(true);
    const peer = new Peer({
      initiator: false, trickle: false, stream: stream,
      config: { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] }
    });

    peer.on('error', err => setCryptoState('Error: ' + err.message));
    setupPeerDataChannel(peer);

    peer.on('signal', data => socket.emit('answerCall', { signal: data, to: caller }));

    peer.on('stream', currentStream => {
      if (userVideo.current) {
        userVideo.current.srcObject = currentStream;
        userVideo.current.play().catch(e => console.log(e));
      }
    });

    peer.signal(callerSignal);
    connectionRef.current = peer;
  };

  const leaveCall = () => {
    setCallEnded(true);
    if (connectionRef.current) connectionRef.current.destroy();
    window.location.reload();
  };

  const sendChatMessage = async (e) => {
    e.preventDefault();
    if (messageInput.trim() && sharedKey && connectionRef.current) {
      const encryptedPayload = await encryptMessage(messageInput, sharedKey);
      connectionRef.current.send(JSON.stringify({ type: 'CHAT_MESSAGE', payload: encryptedPayload }));
      setMessages(prev => [...prev, { sender: 'You', text: messageInput }]);
      setMessageInput('');
    }
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
      <div className="auth-container">
        <div className="glass-panel auth-box">
          <ShieldCheck size={56} color="#3b82f6" style={{ margin: '0 auto 16px' }} />
          <h2>Welcome Back</h2>
          <p>Sign in to the secure VoIP network</p>
          
          {authError && <div style={{ color: '#ef4444', marginBottom: '16px', fontSize: '0.9rem' }}>{authError}</div>}
          
          <form className="auth-form" onSubmit={handleAuth}>
            {isRegistering && (
              <input 
                type="text" 
                placeholder="Choose a Username" 
                className="input-field" 
                value={username} 
                onChange={e => setUsername(e.target.value)} 
                required 
              />
            )}
            <input 
              type="email" 
              placeholder="Email Address" 
              className="input-field" 
              value={email} 
              onChange={e => setEmail(e.target.value)} 
              required 
            />
            <input 
              type="password" 
              placeholder="Password" 
              className="input-field" 
              value={password} 
              onChange={e => setPassword(e.target.value)} 
              required 
            />
            <button type="submit" className="btn btn-primary" style={{ width: '100%', marginTop: '8px' }}>
              {isRegistering ? 'Create Account' : 'Sign In'}
            </button>
          </form>

          <button className="btn btn-ghost" style={{ width: '100%', fontSize: '0.85rem' }} onClick={() => setIsRegistering(!isRegistering)}>
            {isRegistering ? 'Already have an account? Sign in' : 'Need an account? Register'}
          </button>

          <div className="auth-divider">OR</div>

          <button className="btn google-btn" onClick={handleGoogleLogin}>
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
    <div className="app-container glass-panel">
      <div className="header">
        <h1>Encrypted VoIP</h1>
        <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <div className="status-indicator pulse-animation"></div>
            <strong>{username}</strong>
          </div>
          <button className="btn btn-ghost" style={{ padding: '8px 12px' }} onClick={logout} title="Logout">
            <LogOut size={16} />
          </button>
        </div>
      </div>

      <div className="main-content">
        <div className="sidebar">
          <h3>Online Contacts</h3>
          <ul className="user-list">
            {users.length === 0 ? (
              <li style={{ color: 'var(--text-muted)', fontSize: '0.9rem', textAlign: 'center', marginTop: '20px' }}>No contacts online</li>
            ) : (
              users.map(u => (
                <li key={u} className="user-item">
                  <span className="user-name">
                    <div style={{width: 32, height: 32, borderRadius: '50%', background: 'linear-gradient(135deg, #3b82f6, #a78bfa)', display: 'flex', alignItems: 'center', justifyContent: 'center'}}>
                      <User size={16} color="white"/>
                    </div>
                    {u}
                  </span>
                  <button className="btn btn-primary" style={{ padding: '8px' }} onClick={() => callUser(u)}>
                    <Phone size={16} />
                  </button>
                </li>
              ))
            )}
          </ul>
        </div>

        <div className="call-area">
          <audio playsInline muted ref={myVideo} autoPlay style={{ display: 'none' }} />
          <audio playsInline ref={userVideo} autoPlay style={{ display: 'none' }} />
          <audio ref={ringtoneRef} src="/ringtone.wav" loop style={{ display: 'none' }} />

          {!callAccepted && receivingCall ? (
            <div style={{ textAlign: 'center' }}>
              <div className="pulse-animation" style={{ width: 80, height: 80, borderRadius: '50%', background: 'rgba(16, 185, 129, 0.2)', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 24px' }}>
                <Phone size={40} color="#10b981" />
              </div>
              <h2 style={{ color: '#10b981', marginBottom: '8px' }}>Incoming Call</h2>
              <p style={{ color: '#e2e8f0', marginBottom: '32px' }}><strong>{caller}</strong> is requesting a secure connection.</p>
              <div className="controls" style={{ justifyContent: 'center' }}>
                <button className="btn btn-success" onClick={answerCall}>
                  <Phone size={20} /> Answer
                </button>
                <button className="btn btn-danger" onClick={() => window.location.reload()}>
                  <PhoneOff size={20} /> Reject
                </button>
              </div>
            </div>
          ) : callAccepted && !callEnded ? (
            <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column' }}>
              <div style={{ textAlign: 'center', marginBottom: '16px' }}>
                <ShieldCheck size={48} color="#10b981" />
                <h2 style={{ marginTop: '16px' }}>Secure Call Active</h2>
                <div className="encryption-info">
                  <Lock size={16} color="#10b981" /> {cryptoState}
                </div>
              </div>

              {sharedKey && (
                <div className="chat-container">
                  <div className="messages">
                    {messages.map((m, i) => (
                      <div key={i} className="message">
                        <span className="sender" style={{ color: m.sender === 'You' ? '#a78bfa' : '#60a5fa' }}>{m.sender}: </span>
                        <span className="text">{m.text}</span>
                      </div>
                    ))}
                  </div>
                  <form onSubmit={sendChatMessage} style={{ display: 'flex', gap: '8px' }}>
                    <input type="text" className="input-field" placeholder="Type E2EE message..." value={messageInput} onChange={e => setMessageInput(e.target.value)} />
                    <button type="submit" className="btn btn-primary">Send</button>
                  </form>
                </div>
              )}

              <div className="controls" style={{ justifyContent: 'center', marginTop: 'auto', paddingTop: '24px' }}>
                <button className="btn" style={{ backgroundColor: isMuted ? '#ef4444' : 'rgba(255,255,255,0.1)' }} onClick={toggleMute}>
                  {isMuted ? <MicOff size={20} /> : <Mic size={20} />}
                </button>
                <button className="btn btn-danger" onClick={leaveCall}>
                  <PhoneOff size={20} /> End Call
                </button>
              </div>
            </div>
          ) : (
            <div style={{ textAlign: 'center', color: 'var(--text-muted)' }}>
              <ShieldCheck size={80} style={{ opacity: 0.1, marginBottom: '24px' }} />
              <h2 style={{ color: '#e2e8f0', marginBottom: '8px' }}>Ready to Connect</h2>
              <p style={{ maxWidth: '300px', margin: '0 auto', lineHeight: '1.5' }}>
                Select a contact from the sidebar to establish a military-grade encrypted VoIP connection.
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default App;
