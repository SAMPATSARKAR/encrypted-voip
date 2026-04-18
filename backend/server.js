require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const mongoose = require('mongoose');

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*", // Allow all origins for dev
    methods: ["GET", "POST"]
  }
});

// Connect to MongoDB
const MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/voip';
mongoose.connect(MONGO_URI)
  .then(() => console.log('MongoDB Connected'))
  .catch(err => console.error('MongoDB connection error:', err));

// Define Routes
app.use('/api/auth', require('./routes/auth'));

const PORT = process.env.PORT || 5050;

// State to track users and rooms for Full Mesh Conference
const users = {}; // Maps socket.id -> { roomID, username }

io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  socket.on('join room', (data) => {
    const { roomID, username } = data;
    users[socket.id] = { roomID, username };
    socket.join(roomID);

    // Get all other users in this specific room
    const usersInThisRoom = Object.entries(users)
      .filter(([id, u]) => u.roomID === roomID && id !== socket.id)
      .map(([id, u]) => ({ socketID: id, username: u.username }));

    // Send the list of existing users to the person who just joined
    socket.emit('all users', usersInThisRoom);
    console.log(`${username} joined room ${roomID}`);
  });

  // When a new user joins, they send an offer signal to each existing user
  socket.on('sending signal', payload => {
    // payload: { userToSignal, callerID, signal, username }
    io.to(payload.userToSignal).emit('user joined', { 
      signal: payload.signal, 
      callerID: payload.callerID, 
      username: payload.username 
    });
  });

  // The existing user receives the offer, and sends an answer signal back
  socket.on('returning signal', payload => {
    // payload: { signal, callerID }
    io.to(payload.callerID).emit('receiving returned signal', { 
      signal: payload.signal, 
      id: socket.id 
    });
  });

  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);
    const user = users[socket.id];
    if (user) {
      // Notify others in the room that this user left
      socket.to(user.roomID).emit('user left', socket.id);
      delete users[socket.id];
    }
  });
});

app.get('/', (req, res) => {
  res.send('Conference Server is running');
});

server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
