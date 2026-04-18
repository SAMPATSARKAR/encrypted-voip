import React, { useState, useEffect, useRef } from 'react';
import io from 'socket.io-client';
import Peer from 'simple-peer';
import { Phone, PhoneOff, Mic, MicOff, Lock, ShieldCheck, User } from 'lucide-react';

const SERVER_URL = import.meta.env.VITE_BACKEND_URL || 'http://localhost:5050';

function App() {
  const [username, setUsername] = useState('');
  const [isLoggedIn, setIsLoggedIn] = useState(false);
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

  // 1. Initialize Web Crypto API Keys for Asymmetric Exchange
  useEffect(() => {
    async function generateKeys() {
      // Generate ECDH key pair for key exchange
      const kp = await window.crypto.subtle.generateKey(
        { name: 'ECDH', namedCurve: 'P-256' },
        true,
        ['deriveKey', 'deriveBits']
      );
      setKeyPair(kp);
      console.log('Asymmetric ECDH Key Pair Generated');
    }
    generateKeys();
  }, []);

  // Ringtone Effect
  useEffect(() => {
    if (receivingCall && !callAccepted && !callEnded && ringtoneRef.current) {
      ringtoneRef.current.play().catch(e => console.log('Autoplay prevented ringtone:', e));
    } else if (ringtoneRef.current) {
      ringtoneRef.current.pause();
      ringtoneRef.current.currentTime = 0;
    }
  }, [receivingCall, callAccepted, callEnded]);

  // 2. Setup Socket Connection
  useEffect(() => {
    if (isLoggedIn) {
      const newSocket = io(SERVER_URL);
      setSocket(newSocket);

      navigator.mediaDevices.getUserMedia({ video: false, audio: true }).then((currentStream) => {
        setStream(currentStream);
        if (myVideo.current) {
          myVideo.current.srcObject = currentStream;
        }
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

      newSocket.on('callEnded', () => {
        leaveCall();
      });

      return () => newSocket.close();
    }
  }, [isLoggedIn, username]);

  const handleLogin = (e) => {
    e.preventDefault();
    if (username.trim()) setIsLoggedIn(true);
  };

  const toggleMute = () => {
    if (stream) {
      const audioTrack = stream.getAudioTracks()[0];
      audioTrack.enabled = !audioTrack.enabled;
      setIsMuted(!audioTrack.enabled);
    }
  };

  // --- CRYPTOGRAPHY FUNCTIONS ---

  // Export public key to send to peer
  const exportPublicKey = async (key) => {
    const exported = await window.crypto.subtle.exportKey('raw', key);
    return Array.from(new Uint8Array(exported)); // Convert to array to send via JSON/DataChannel
  };

  // Import peer's public key
  const importPublicKey = async (keyArray) => {
    const keyData = new Uint8Array(keyArray).buffer;
    return await window.crypto.subtle.importKey(
      'raw',
      keyData,
      { name: 'ECDH', namedCurve: 'P-256' },
      true,
      []
    );
  };

  // Derive Symmetric AES-GCM Key using our private and their public
  const deriveSharedKey = async (privateKey, publicKey) => {
    return await window.crypto.subtle.deriveKey(
      { name: 'ECDH', public: publicKey },
      privateKey,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
  };

  // Encrypt Message (Symmetric)
  const encryptMessage = async (text, key) => {
    const enc = new TextEncoder();
    const iv = window.crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await window.crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: iv },
      key,
      enc.encode(text)
    );
    return {
      iv: Array.from(iv),
      ciphertext: Array.from(new Uint8Array(ciphertext))
    };
  };

  // Decrypt Message (Symmetric)
  const decryptMessage = async (encryptedData, key) => {
    const dec = new TextDecoder();
    try {
      const decrypted = await window.crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: new Uint8Array(encryptedData.iv) },
        key,
        new Uint8Array(encryptedData.ciphertext)
      );
      return dec.decode(decrypted);
    } catch (e) {
      console.error("Decryption failed", e);
      return "[Decryption Failed]";
    }
  };

  // --- WEBRTC FUNCTIONS ---

  const setupPeerDataChannel = (peer) => {
    peer.on('data', async (data) => {
      const parsed = JSON.parse(data.toString());
      
      if (parsed.type === 'PUBLIC_KEY') {
        setCryptoState('Received peer public key. Deriving shared secret...');
        try {
          const peerPubKey = await importPublicKey(parsed.key);
          const sharedSecret = await deriveSharedKey(keyPair.privateKey, peerPubKey);
          setSharedKey(sharedSecret);
          sharedKeyRef.current = sharedSecret;
          setCryptoState('Symmetric AES-256 Key derived and ready!');
        } catch (e) {
          console.error("Key derivation failed", e);
          setCryptoState('Error deriving key.');
        }
      } else if (parsed.type === 'CHAT_MESSAGE') {
        if (sharedKeyRef.current) {
          const decryptedText = await decryptMessage(parsed.payload, sharedKeyRef.current);
          setMessages(prev => [...prev, { sender: 'Peer', text: decryptedText }]);
        } else {
          setMessages(prev => [...prev, { sender: 'System', text: 'Received encrypted message but no shared key exists.' }]);
        }
      }
    });

    peer.on('connect', async () => {
      // Data channel is open, send our public key for Asymmetric exchange
      if (keyPair) {
        setCryptoState('Sending public key to peer...');
        const pubKeyArray = await exportPublicKey(keyPair.publicKey);
        peer.send(JSON.stringify({ type: 'PUBLIC_KEY', key: pubKeyArray }));
      }
    });
  };

  const callUser = (userToCall) => {
    const peer = new Peer({
      initiator: true,
      trickle: false,
      stream: stream,
      config: {
        iceServers: [
          { urls: 'stun:stun.l.google.com:19302' },
          { urls: 'stun:global.stun.twilio.com:3478' }
        ]
      }
    });

    peer.on('error', (err) => {
      console.error('Peer error:', err);
      setCryptoState('Connection Error: ' + err.message);
    });

    setupPeerDataChannel(peer);

    peer.on('signal', (data) => {
      socket.emit('callUser', {
        userToCall: userToCall,
        signalData: data,
        from: username,
      });
    });

    peer.on('stream', (currentStream) => {
      if (userVideo.current) {
        userVideo.current.srcObject = currentStream;
      }
    });

    socket.on('callAccepted', (signal) => {
      setCallAccepted(true);
      peer.signal(signal);
    });

    connectionRef.current = peer;
  };

  const answerCall = () => {
    setCallAccepted(true);
    const peer = new Peer({
      initiator: false,
      trickle: false,
      stream: stream,
      config: {
        iceServers: [
          { urls: 'stun:stun.l.google.com:19302' },
          { urls: 'stun:global.stun.twilio.com:3478' }
        ]
      }
    });

    peer.on('error', (err) => {
      console.error('Peer error:', err);
      setCryptoState('Connection Error: ' + err.message);
    });

    setupPeerDataChannel(peer);

    peer.on('signal', (data) => {
      socket.emit('answerCall', { signal: data, to: caller });
    });

    peer.on('stream', (currentStream) => {
      if (userVideo.current) {
        userVideo.current.srcObject = currentStream;
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
      connectionRef.current.send(JSON.stringify({
        type: 'CHAT_MESSAGE',
        payload: encryptedPayload
      }));
      setMessages(prev => [...prev, { sender: 'You', text: messageInput }]);
      setMessageInput('');
    }
  };

  if (!isLoggedIn) {
    return (
      <div className="login-container">
        <div className="login-box">
          <ShieldCheck size={48} color="#3b82f6" style={{ margin: '0 auto 16px' }} />
          <h2>Encrypted VoIP Portal</h2>
          <p style={{ color: 'var(--text-muted)', marginBottom: '24px' }}>
            Voice and Data secured with WebRTC (DTLS-SRTP) and AES-256 E2EE.
          </p>
          <form onSubmit={handleLogin} style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
            <input
              type="text"
              placeholder="Enter your username"
              className="input-field"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              required
            />
            <button type="submit" className="btn btn-primary" style={{ justifyContent: 'center' }}>
              Connect securely
            </button>
          </form>
        </div>
      </div>
    );
  }

  return (
    <div className="app-container">
      <div className="header">
        <h1>Secure VoIP Client</h1>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', color: 'var(--success-color)' }}>
          <div className="status-indicator"></div>
          Logged in as <strong>{username}</strong>
        </div>
      </div>

      <div className="main-content">
        <div className="sidebar">
          <h3>Online Contacts</h3>
          <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>Select a user to initiate an encrypted call.</p>
          <ul className="user-list">
            {users.length === 0 ? (
              <li className="user-item" style={{ justifyContent: 'center', color: 'var(--text-muted)' }}>No one is online</li>
            ) : (
              users.map(u => (
                <li key={u} className="user-item">
                  <span className="user-name"><User size={16} style={{display:'inline', marginRight:'8px', verticalAlign:'text-bottom'}}/>{u}</span>
                  <button className="btn btn-primary" style={{ padding: '6px 12px' }} onClick={() => callUser(u)}>
                    <Phone size={16} />
                  </button>
                </li>
              ))
            )}
          </ul>
        </div>

        <div className="call-area">
          {/* Audio Elements */}
          <audio playsInline muted ref={myVideo} autoPlay style={{ display: 'none' }} />
          <audio playsInline ref={userVideo} autoPlay style={{ display: 'none' }} />
          <audio ref={ringtoneRef} src="/ringtone.wav" loop style={{ display: 'none' }} />

          {!callAccepted && receivingCall ? (
            <div style={{ textAlign: 'center' }}>
              <h2 className="pulse-animation" style={{ color: 'var(--success-color)', marginBottom: '16px' }}>
                Incoming Secure Call
              </h2>
              <p><strong>{caller}</strong> is requesting an encrypted connection.</p>
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
            <div style={{ width: '100%' }}>
              <div style={{ textAlign: 'center', marginBottom: '24px' }}>
                <ShieldCheck size={48} color="#10b981" />
                <h2 style={{ marginTop: '16px' }}>Secure Connection Active</h2>
                <p style={{ color: 'var(--text-muted)' }}>Connected with peer</p>
              </div>
              
              <div className="encryption-info">
                <strong><Lock size={14} style={{display:'inline', marginRight:'4px'}}/> E2EE Status:</strong> {cryptoState}
              </div>

              {sharedKey && (
                <div className="chat-container">
                  <div className="messages">
                    {messages.map((m, i) => (
                      <div key={i} className="message">
                        <span className="sender">{m.sender}: </span>
                        <span className="text">{m.text}</span>
                      </div>
                    ))}
                  </div>
                  <form onSubmit={sendChatMessage} style={{ display: 'flex', gap: '8px' }}>
                    <input 
                      type="text" 
                      className="input-field" 
                      placeholder="Type E2EE message..." 
                      value={messageInput}
                      onChange={e => setMessageInput(e.target.value)}
                    />
                    <button type="submit" className="btn btn-primary">Send</button>
                  </form>
                </div>
              )}

              <div className="controls" style={{ justifyContent: 'center' }}>
                <button className="btn" style={{ backgroundColor: '#334155', color: 'white' }} onClick={toggleMute}>
                  {isMuted ? <MicOff size={20} /> : <Mic size={20} />}
                </button>
                <button className="btn btn-danger" onClick={leaveCall}>
                  <PhoneOff size={20} /> End Call
                </button>
              </div>
            </div>
          ) : (
            <div style={{ textAlign: 'center', color: 'var(--text-muted)' }}>
              <ShieldCheck size={64} style={{ opacity: 0.2, marginBottom: '16px' }} />
              <h2>Ready to Connect</h2>
              <p>Audio is secured by DTLS-SRTP.<br/>Data channel uses custom AES-256 GCM.</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default App;
