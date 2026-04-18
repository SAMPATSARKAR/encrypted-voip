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

// Simple in-memory user store for now to get things working fast.
// We can move to MongoDB later if requested.
const users = {}; 

io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  // When a user logs in / registers their username
  socket.on('register', (username) => {
    users[username] = socket.id;
    io.emit('users', Object.keys(users)); // Broadcast updated user list
    console.log(`${username} registered with ID ${socket.id}`);
  });

  // Signaling: Call a user
  socket.on('callUser', (data) => {
    const { userToCall, signalData, from, name } = data;
    const socketIdToCall = users[userToCall];
    if (socketIdToCall) {
      io.to(socketIdToCall).emit('callUser', { signal: signalData, from, name });
    }
  });

  // Signaling: Answer a call
  socket.on('answerCall', (data) => {
    const socketIdToCall = users[data.to];
    if (socketIdToCall) {
      io.to(socketIdToCall).emit('callAccepted', data.signal);
    }
  });

  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);
    // Find and remove user
    let disconnectedUser = null;
    for (const [username, id] of Object.entries(users)) {
      if (id === socket.id) {
        disconnectedUser = username;
        delete users[username];
        break;
      }
    }
    if (disconnectedUser) {
      io.emit('users', Object.keys(users));
    }
    socket.broadcast.emit('callEnded');
  });
});

app.get('/', (req, res) => {
  res.send('Server is running');
});

server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
