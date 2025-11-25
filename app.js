const express = require("express");
const socketio = require("socket.io");
const http = require("http");
const https = require("https"); // Required for fixing Telegram timeout
const { Chess } = require("chess.js");
const path = require("path");
const crypto = require("crypto");
const { Telegraf, Markup } = require('telegraf');

const app = express();
const server = http.createServer(app);
const io = socketio(server);

app.set("view engine", "ejs");
app.use(express.static(path.join(__dirname, "public")));

// ==========================================
// CONFIGURATION
// ==========================================
const BOT_TOKEN = "8332605905:AAEPxxEvTpkiYO6LjV7o1-ASa5ufIqxtGGs"; 
// FIXED: Updated to your new Render URL
const GAME_URL = "https://telegramchessbot.onrender.com"; 
const GAME_SHORT_NAME = "Optimal_Chess"; // Your Game Name from BotFather

// ==========================================
// GAME STATE
// ==========================================
const rooms = Object.create(null);

const makeRoomId = () => crypto.randomBytes(4).toString("hex").slice(0, 6).toUpperCase();

function createRoom(roomId) {
  const room = {
    chess: new Chess(),
    white: null,
    black: null,
    watchers: new Set(),
    timers: { w: 600, b: 600 },
    timerInterval: null,
    isTimerRunning: false,
    settings: null 
  };
  rooms[roomId] = room;
  return room;
}

function startRoomTimer(roomId) {
  const room = rooms[roomId];
  if (!room || room.isTimerRunning) return;
  room.isTimerRunning = true;

  if (room.timerInterval) clearInterval(room.timerInterval);

  room.timerInterval = setInterval(() => {
    const turn = room.chess.turn();
    if (!turn) return;

    if (room.timers[turn] > 0) room.timers[turn]--;
    io.to(roomId).emit("timers", room.timers);

    if (room.timers[turn] <= 0) {
      clearInterval(room.timerInterval);
      room.isTimerRunning = false;
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

// ==========================================
// ROUTES
// ==========================================
app.get("/", (req, res) => res.render("index"));
app.get("/room/:id", (req, res) => {
  const roomId = req.params.id.toUpperCase();
  if (!rooms[roomId]) createRoom(roomId);
  res.render("room", { roomId });
});

// ==========================================
// SOCKET.IO LOGIC
// ==========================================
io.on("connection", (socket) => {
  socket.on("check_room_status", (roomId) => {
    roomId = roomId.toUpperCase();
    if (!rooms[roomId]) createRoom(roomId);
    const room = rooms[roomId];
    
    if (!room.settings) {
        socket.emit("room_status", "empty"); 
    } else {
        socket.emit("room_status", "waiting");
    }
  });

  socket.on("initialize_room", (data) => {
      const { roomId, settings } = data;
      const rId = roomId.toUpperCase();
      if (!rooms[rId]) return;

      rooms[rId].settings = settings;
      const t = parseInt(settings.time) || 600;
      rooms[rId].timers = { w: t, b: t };
  });

  socket.on("joinRoom", data => {
    let roomId, forcedRole;
    if (typeof data === "string") roomId = data.toUpperCase();
    else { roomId = data.roomId.toUpperCase(); forcedRole = data.role; }

    if (!rooms[roomId]) createRoom(roomId);
    const room = rooms[roomId];

    socket.join(roomId);
    socket.data.currentRoom = roomId;

    if (forcedRole === "w") {
      room.white = socket.id;
      socket.emit("init", { role: "w", fen: room.chess.fen(), timers: room.timers });
    } 
    else if (forcedRole === "b") {
      room.black = socket.id;
      socket.emit("init", { role: "b", fen: room.chess.fen(), timers: room.timers });
    }
    else {
      if (room.white && !room.black) {
        room.black = socket.id;
        socket.emit("init", { role: "b", fen: room.chess.fen(), timers: room.timers });
      }
      else if (room.black && !room.white) {
        room.white = socket.id;
        socket.emit("init", { role: "w", fen: room.chess.fen(), timers: room.timers });
      }
      else {
        room.watchers.add(socket.id);
        socket.emit("init", { role: null, fen: room.chess.fen(), timers: room.timers });
      }
    }

    if (room.white && room.black) {
      io.to(roomId).emit("boardstate", room.chess.fen());
      io.to(roomId).emit("timers", room.timers);
    }
  });

  socket.on("move", (data) => {
    try {
      const roomId = socket.data.currentRoom || data.roomId;
      if (!roomId || !rooms[roomId]) return;
      const room = rooms[roomId];
      const mv = data.move;

      const turn = room.chess.turn();
      if ((turn === "w" && socket.id !== room.white) || (turn === "b" && socket.id !== room.black)) return;

      const result = room.chess.move(mv);
      if (!result) return;

      io.to(roomId).emit("move", mv);
      io.to(roomId).emit("boardstate", room.chess.fen());
      io.to(roomId).emit("timers", room.timers);

      stopRoomTimer(roomId);
      startRoomTimer(roomId);

      if (room.chess.isGameOver()) {
        stopRoomTimer(roomId);
        let winner = "";
        if (room.chess.isCheckmate()) winner = room.chess.turn() === "w" ? "Black" : "White";
        else if (room.chess.isDraw()) winner = "Draw";
        else winner = "Game Over";
        io.to(roomId).emit("gameover", winner);
      }
    } catch (err) {}
  });

  socket.on("disconnect", () => {
    const roomId = socket.data.currentRoom;
    if (roomId && rooms[roomId]) {
      const room = rooms[roomId];
      if (room.white === socket.id) room.white = null;
      if (room.black === socket.id) room.black = null;
      if (!room.white && !room.black) {
        stopRoomTimer(roomId);
        delete rooms[roomId];
      }
    }
  });
});

// ==========================================
// TELEGRAM BOT LOGIC (POLLING MODE)
// ==========================================

// FIX 1: Use custom agent to prevent ETIMEDOUT on Render
const agent = new https.Agent({ family: 4 });
const bot = new Telegraf(BOT_TOKEN, { telegram: { agent } });

// 1. START COMMAND
bot.command('start', (ctx) => {
    ctx.replyWithPhoto(
        "https://upload.wikimedia.org/wikipedia/commons/6/6f/ChessSet.jpg", 
        {
            caption: "<b>Welcome to Chess Master!</b>\n\nClick below to start.",
            parse_mode: "HTML",
            reply_markup: {
                inline_keyboard: [[
                    { text: "🎮 Create New Game", callback_data: "create_game" }
                ]]
            }
        }
    );
});

// 2. ACTION (Sends the Forwardable Game Card)
bot.action("create_game", (ctx) => {
    const roomId = makeRoomId();
    const shareUrl = `https://t.me/${ctx.botInfo.username}/OptimalChess?startapp=${roomId}`;

    // We store the room ID in a temporary variable for this user's session
    // This is a hack because callback_game doesn't support payload directly in Telegram API
    // BUT for the URL button, it should work.
    
    ctx.replyWithGame(GAME_SHORT_NAME, {
        reply_markup: {
            inline_keyboard: [
                // 1. Play Button (Callback Game) - We will map this to the room in the gameQuery
                [{ text: "♟️ Open Chess", callback_game: {} }],
                
                // 2. URL Button - Explicit Link
                [{ text: "🚀 Play Room " + roomId, url: shareUrl }],
                
                // 3. Share Button
                [{ text: "📤 Share Game", switch_inline_query: roomId }]
            ]
        }
    });
});

// 3. INLINE QUERY (Sharing via @BotName)
bot.on('inline_query', (ctx) => {
    const roomId = ctx.inlineQuery.query || makeRoomId(); 
    const shareUrl = `https://t.me/${ctx.botInfo.username}/OptimalChess?startapp=${roomId}`;

    const result = {
        type: 'game',
        id: roomId,
        game_short_name: GAME_SHORT_NAME,
        reply_markup: {
            inline_keyboard: [
                [{ text: "♟️ Open Chess", callback_game: {} }],
                [{ text: "🚀 Play Room " + roomId, url: shareUrl }]
            ]
        }
    };

    return ctx.answerInlineQuery([result], { cache_time: 0 });
});

// 4. GAME CALLBACK (CRITICAL FIX)
// This handles the "Play" button click (the callback_game button)
bot.gameQuery((ctx) => {
    // The 'gameQuery' usually doesn't contain the custom payload directly in 'callback_query.data' 
    // for game buttons created via Inline Query in the same way.
    
    // HOWEVER, if we used the Inline Query method (which forwarding uses), 
    // the `ctx.callbackQuery.game_short_name` is "Optimal_Chess".
    
    // IMPORTANT: We need to know WHICH room to open.
    // When a game is shared via Inline Query, the "id" we set in the result (the roomId) 
    // is passed back as `inline_message_id` but NOT the actual text ID.
    
    // TRICK: We cannot easily get the custom room ID from a generic "Play" button click 
    // on a forwarded message without a database mapping `inline_message_id` -> `roomId`.
    
    // BUT, the URL button (2nd button) DOES contain the ID.
    // So we tell the user to click the 2nd button if the first one fails or opens home.
    
    // Let's try to redirect them to the specific room if we can find it in the URL logic,
    // otherwise default to the game URL.
    
    let url = GAME_URL;
    
    // If we had a database, we would look up: db.find(ctx.callbackQuery.inline_message_id)
    // Since we don't, we just send them to the main page where the client-side script
    // in index.ejs (which we added earlier) handles the 'start_param' if they clicked the link.
    
    // For the "Open Chess" button, since we can't attach the dynamic ID to `callback_game` payload
    // without a DB, it will just open the lobby. 
    // Users MUST click "Play Room XYZ" (Button 2) or the Share Link.
    
    return ctx.answerGameQuery(url);
});

// ==========================================
// SERVER LAUNCH (SIMPLE POLLING)
// ==========================================

// Start the Express Server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));

// Start the Bot (with error handling for conflicts)
bot.launch().then(() => {
    console.log('🚀 Bot started (Polling Mode)');
}).catch((err) => {
    console.log('⚠️ Bot launch error:', err.message);
    // If conflict error, it means another instance is running. 
    // Render will eventually kill the old one, so we can ignore it for now.
});

// Enable graceful stop
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));