const express = require("express");
const socketio = require("socket.io");
const http = require("http");
const { Chess } = require("chess.js");
const path = require("path");
const crypto = require("crypto");

const app = express();
const server = http.createServer(app);
const io = socketio(server);

app.set("view engine", "ejs");
app.use(express.static(path.join(__dirname, "public")));

// -------------------- In-memory data --------------------
/**
 rooms structure:
 rooms[roomId] = {
   chess: Chess instance,
   white: socketId | null,
   black: socketId | null,
   watchers: Set(socketId),
   timers: { w: seconds, b: seconds },
   timerInterval: IntervalId | null,
   isTimerRunning: boolean
 }
*/
const rooms = Object.create(null);

// Quickplay queue (single waiting socket)
let quickWaiting = null; // { socketId, createdAt } or null

// -------------------- Helpers --------------------
const makeRoomId = () => {
  // 6-char alphanumeric
  return crypto.randomBytes(4).toString("hex").slice(0, 6).toUpperCase();
};

function createRoom(roomId) {
  const room = {
    chess: new Chess(),
    white: null,
    black: null,
    watchers: new Set(),
    timers: { w: 300, b: 300 }, // 5 minutes default
    timerInterval: null,
    isTimerRunning: false
  };
  rooms[roomId] = room;
  return room;
}

function startRoomTimer(roomId) {
  const room = rooms[roomId];
  if (!room || room.isTimerRunning) return;
  room.isTimerRunning = true;

  if (room.timerInterval) {
    clearInterval(room.timerInterval);
  }

  room.timerInterval = setInterval(() => {
    const turn = room.chess.turn(); // 'w' or 'b'
    if (!turn) return;

    if (room.timers[turn] > 0) room.timers[turn]--;

    // broadcast timers to room
    io.to(roomId).emit("timers", room.timers);

    if (room.timers[turn] <= 0) {
      clearInterval(room.timerInterval);
      room.timerInterval = null;
      room.isTimerRunning = false;
      // opponent wins on timeout
      const winner = turn === "w" ? "Black" : "White";
      io.to(roomId).emit("gameover", `${winner} (timeout)`);
    }
  }, 1000);
}

function stopRoomTimer(roomId) {
  const room = rooms[roomId];
  if (!room) return;
  if (room.timerInterval) {
    clearInterval(room.timerInterval);
    room.timerInterval = null;
  }
  room.isTimerRunning = false;
}

function cleanRoomIfEmpty(roomId) {
  const room = rooms[roomId];
  if (!room) return;
  if (!room.white && !room.black && room.watchers.size === 0) {
    stopRoomTimer(roomId);
    delete rooms[roomId];
    console.log(`Deleted empty room ${roomId}`);
  }
}

// -------------------- Routes --------------------
app.get("/", (req, res) => {
  res.render("index");
});

// Quickplay page - minimal page that auto-joins queue on client connect
app.get("/quickplay", (req, res) => {
  res.render("quickplay"); // we'll send a small quickplay view (see note)
});

// Create a friend room and redirect to it
app.get("/create-room", (req, res) => {
  const id = makeRoomId();
  createRoom(id);
  res.redirect(`/room/${id}`);
});

// Room page (game UI)
app.get("/room/:id", (req, res) => {
  const roomId = req.params.id.toUpperCase();
  // create if not exists
  if (!rooms[roomId]) createRoom(roomId);
  res.render("room", { roomId });
});

// -------------------- Socket.IO --------------------
io.on("connection", (socket) => {
  console.log("Socket connected:", socket.id);

  // Helper: join socket.io room for broadcasts
  function joinSocketRoom(roomId) {
    try {
      socket.join(roomId);
    } catch (e) { }
  }

  function leaveSocketRoom(roomId) {
    try {
      socket.leave(roomId);
    } catch (e) { }
  }

  // ---------------- Join an existing room (from room page)
  // client emits: socket.emit('joinRoom', roomId)
  socket.on("joinRoom", data => {
    let roomId, forcedRole;

    // support both: joinRoom("ABCDE") and joinRoom({ roomId: "ABCDE", role: "w" })
    if (typeof data === "string") {
      roomId = data.toUpperCase();
    } else {
      roomId = data.roomId.toUpperCase();
      forcedRole = data.role; // "w" or "b" or null
    }

    if (!rooms[roomId]) createRoom(roomId);
    const room = rooms[roomId];

    joinSocketRoom(roomId);
    socket.data.currentRoom = roomId;
    
    // =====================================
    //  ZOMBIE CLEANUP (Self-Healing)
    //  If the room thinks a socket is playing but that socket is gone, clear it.
    // =====================================
    if (room.white && !io.sockets.sockets.has(room.white)) {
      room.white = null;
    }
    if (room.black && !io.sockets.sockets.has(room.black)) {
      room.black = null;
    }

    // =====================================
    //  QUICKPLAY FIX: respect forced roles (ONLY IF VACANT)
    // =====================================
    if (forcedRole) {
      const targetRole = forcedRole === "w" ? "white" : "black";
      const currentHolder = room[targetRole];

      // Check if current holder is actually connected
      const isOccupied = currentHolder && io.sockets.sockets.has(currentHolder);

      if (!isOccupied) {
        // Role is free (or holder disconnected), so we can take it
        if (forcedRole === "w") {
          room.white = socket.id;
          socket.emit("init", { role: "w", fen: room.chess.fen(), timers: room.timers });
        } else {
          room.black = socket.id;
          socket.emit("init", { role: "b", fen: room.chess.fen(), timers: room.timers });
        }

        // Notify others
        if (room.white && room.black) {
          io.to(roomId).emit("boardstate", room.chess.fen());
          io.to(roomId).emit("timers", room.timers);
        }
        return;
      }
      // If occupied, fall through to normal join logic (ignore forcedRole)
    }

    // =====================================
    //  FRIEND ROOM LOGIC (normal join)
    // =====================================
    if (room.white === socket.id) {
      socket.emit("init", { role: "w", fen: room.chess.fen(), timers: room.timers });
    }
    else if (room.black === socket.id) {
      socket.emit("init", { role: "b", fen: room.chess.fen(), timers: room.timers });
    }
    else if (!room.white) {
      room.white = socket.id;
      socket.emit("init", { role: "w", fen: room.chess.fen(), timers: room.timers });

      if (!room.black) {
        socket.emit("waiting", {
          text: "Waiting for your friend to join...",
          link: `${getBaseUrl(socket.request)}/room/${roomId}`
        });
      }
    }
    else if (!room.black) {
      room.black = socket.id;

      io.to(room.white).emit("init", { role: "w", fen: room.chess.fen(), timers: room.timers });
      io.to(room.black).emit("init", { role: "b", fen: room.chess.fen(), timers: room.timers });

      //startRoomTimer(roomId);
      io.to(roomId).emit("boardstate", room.chess.fen());
      io.to(roomId).emit("timers", room.timers);
    }
    else {
      room.watchers.add(socket.id);
      socket.emit("init", { role: null, fen: room.chess.fen(), timers: room.timers });
      socket.emit("boardstate", room.chess.fen());
      socket.emit("timers", room.timers);
    }

  });

  socket.on("resign", roomId => {
    roomId = String(roomId || socket.data.currentRoom).toUpperCase();
    if (!rooms[roomId]) return;

    const room = rooms[roomId];
    let winner = "";
    if (socket.id === room.white) winner = "Black";
    else if (socket.id === room.black) winner = "White";

    io.to(roomId).emit("gameover", `${winner} wins (resignation)`);
    stopRoomTimer(roomId);
  });

  // ---------- DRAW OFFER ----------
  socket.on("offerDraw", roomId => {
    roomId = String(roomId || socket.data.currentRoom).toUpperCase();
    if (!rooms[roomId]) return;

    const room = rooms[roomId];
    const opponent =
      socket.id === room.white ? room.black :
        socket.id === room.black ? room.white : null;

    if (opponent) io.to(opponent).emit("drawOffered");
  });

  // ---------- DRAW ACCEPT ----------
  socket.on("acceptDraw", roomId => {
    roomId = String(roomId || socket.data.currentRoom).toUpperCase();
    if (!rooms[roomId]) return;

    io.to(roomId).emit("gameover", "Draw");
    stopRoomTimer(roomId);
  });
  // ---------------- Quick Play (enter queue)
  // client emits: socket.emit('enterQuickplay')
  socket.on("enterQuickplay", () => {
    // if already in queue, ignore
    if (quickWaiting && quickWaiting.socketId === socket.id) {
      socket.emit("info", { text: "Already searching..." });
      return;
    }

    // If no one waiting -> become the waiting player
    if (!quickWaiting) {
      quickWaiting = { socketId: socket.id, createdAt: Date.now() };
      socket.emit("looking", { text: "Looking for available players..." });
      console.log("Quickplay: waiting:", socket.id);

      // cleanup on disconnect will handle clearing quickWaiting
      socket.data.isInQuickplay = true;
      return;
    }

    // If we reach here, there's someone waiting -> create room and match
    // Validate waiting is still connected
    const waitingSocketId = quickWaiting.socketId;
    const waitingSocket = io.sockets.sockets.get(waitingSocketId);

    if (!waitingSocket) {
      // waiting disconnected, replace with current
      quickWaiting = { socketId: socket.id, createdAt: Date.now() };
      socket.data.isInQuickplay = true;
      socket.emit("looking", { text: "Looking for available players..." });
      return;
    }

    // Create new room and assign first waiting user as white, current as black
    const roomId = makeRoomId();
    const room = createRoom(roomId);

    // assign
    room.white = waitingSocketId;
    room.black = socket.id;

    // both sockets should join socket.io room
    waitingSocket.join(roomId);
    socket.join(roomId);

    waitingSocket.data.currentRoom = roomId;
    socket.data.currentRoom = roomId;
    // clear quickWaiting
    quickWaiting = null;
    waitingSocket.data.isInQuickplay = false;
    socket.data.isInQuickplay = false;

    // Inform both clients to navigate to room URL (client will handle redirect)
    io.to(waitingSocketId).emit("matched", { roomId, role: "w" });
    io.to(socket.id).emit("matched", { roomId, role: "b" });

    // send initial game state once they connect/join room page
    // We'll still rely on 'joinRoom' from client once they load the /room/:id page to initialize fully.

    console.log(`Quickplay matched ${waitingSocketId} <> ${socket.id} -> room ${roomId}`);
  });

  // ---------------- Move handler per room
  socket.on("move", (data) => {
    // data should include roomId and move object
    // But older clients might send move without roomId. We handle both.
    try {
      const roomId = socket.data.currentRoom || data.roomId;
      if (!roomId || !rooms[roomId]) return;

      const room = rooms[roomId];
      const mv = data.move || data; // support both shapes
      if (!mv || !mv.from || !mv.to) return;

      // Verify that the socket is allowed to move (owner of color)
      const turn = room.chess.turn(); // 'w' or 'b'
      if ((turn === "w" && socket.id !== room.white) || (turn === "b" && socket.id !== room.black)) {
        // not this player's turn
        return;
      }

      // attempt move
      const result = room.chess.move(mv, { sloppy: true });
      if (!result) return;

      // broadcast move and boardstate & timers
      io.to(roomId).emit("move", mv);
      io.to(roomId).emit("boardstate", room.chess.fen());
      io.to(roomId).emit("timers", room.timers);

      // restart timers safely
      stopRoomTimer(roomId);
      startRoomTimer(roomId);

      // check game over
      if (room.chess.isGameOver()) {
        stopRoomTimer(roomId);
        let winner = "Draw";
        if (room.chess.isCheckmate()) {
          winner = room.chess.turn() === "w" ? "Black" : "White";
        }
        io.to(roomId).emit("gameover", winner);
      }
    } catch (err) {
      console.log("Move error:", err && err.message);
    }
  });

  // client may emit move as { roomId, move: {from,to} } or simply move object
  // To be safe, above we try both shapes.

  // ---------------- Reset game in a room
  socket.on("resetgame", (roomId) => {
    roomId = String(roomId || socket.data.currentRoom || "").toUpperCase();
    if (!rooms[roomId]) return;
    const room = rooms[roomId];
    room.chess = new Chess();
    room.timers = { w: 300, b: 300 };
    stopRoomTimer(roomId);
    io.to(roomId).emit("boardstate", room.chess.fen());
    io.to(roomId).emit("timers", room.timers);
  });

  socket.on("resign", roomId => {
    roomId = (roomId || socket.data.currentRoom).toUpperCase();
    if (!rooms[roomId]) return;
    const room = rooms[roomId];

    const winner = socket.id === room.white ? "Black" : "White";
    io.to(roomId).emit("gameover", `${winner} wins (resignation)`);
    stopRoomTimer(roomId);
  });

  socket.on("offerDraw", roomId => {
    roomId = (roomId || socket.data.currentRoom).toUpperCase();
    if (!rooms[roomId]) return;

    const room = rooms[roomId];
    const opp = socket.id === room.white ? room.black : room.white;

    if (opp) io.to(opp).emit("drawOffered");
  });

  socket.on("acceptDraw", roomId => {
    roomId = (roomId || socket.data.currentRoom).toUpperCase();
    if (!rooms[roomId]) return;

    io.to(roomId).emit("gameover", "Draw");
    stopRoomTimer(roomId);
  });

  socket.on("declineDraw", roomId => {
    roomId = (roomId || socket.data.currentRoom).toUpperCase();
    if (!rooms[roomId]) return;

    const room = rooms[roomId];
    const opp = socket.id === room.white ? room.black : room.white;

    if (opp) io.to(opp).emit("drawDeclined");
  });

  // ---------------- disconnect handling ----------------
  socket.on("disconnect", () => {
    console.log("Socket disconnected:", socket.id);

    // If in quickplay queue, remove
    if (quickWaiting && quickWaiting.socketId === socket.id) {
      quickWaiting = null;
    }

    // If the socket had a currentRoom, handle leaving
    const roomId = socket.data.currentRoom;
    if (roomId && rooms[roomId]) {
      const room = rooms[roomId];

      // remove from white/black/watchers
      if (room.white === socket.id) {
        room.white = null;
      }
      if (room.black === socket.id) {
        room.black = null;
      }
      if (room.watchers.has(socket.id)) room.watchers.delete(socket.id);

      // notify remaining sockets in room
      io.to(roomId).emit("info", { text: "A player left the game." });
      // If both players left, clean up room
      if (!room.white && !room.black) {
        // close timers & delete room
        stopRoomTimer(roomId);
        delete rooms[roomId];
        console.log(`Room ${roomId} deleted because both players left.`);
      }
    }
  });

  // ---------------- Utility to get base URL (for room link) -------------
  function getBaseUrl(req) {
    // req may be undefined when called from socket; try to derive from socket.request
    const r = req || socket.request;
    if (!r) return `${serverAddress()}`;
    const protocol = r.headers && r.headers["x-forwarded-proto"] ? r.headers["x-forwarded-proto"] : "http";
    const host = r.headers && r.headers.host ? r.headers.host : `localhost:${process.env.PORT || 3000}`;
    return `${protocol}://${host}`;
  }

  function serverAddress() {
    // fallback
    return `http://localhost:${process.env.PORT || 3000}`;
  }
});

// -------------------- Tiny view for quickplay (server must have view quickplay.ejs) --------------------
// We'll render a tiny page that auto-joins quickplay via socket.
app.get("/views/quickplay-raw", (req, res) => {
  res.send(`<!doctype html><html><head><meta name="viewport" content="width=device-width"><title>Quickplay</title></head><body>
  <p>Looking for available players...</p>
  <script src="/socket.io/socket.io.js"></script>
  <script>
    const s = io();
    s.on('connect', ()=> {
      s.emit('enterQuickplay');
    });
    s.on('matched', (d)=> {
      if(d && d.roomId) {
        window.location = '/room/' + d.roomId;
      }
    });
    s.on('looking',(d)=> {
      document.body.innerHTML = '<p>' + (d && d.text ? d.text : 'Looking...') + '</p>';
    });
  </script>
  </body></html>`);
});

// -------------------- Start server --------------------
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));