const socket = io();
const chess = new Chess();

// DOM references (some are assigned later during init)
let boardEl = null;
let popup = null;
let popupText = null;
let playAgain = null;
let topTimer = null;
let bottomTimer = null;

let role = null;

// Desktop drag
let dragged = null;
let source = null;

// Tap-to-tap
let selectedSource = null;
let selectedElement = null;

// Mobile drag
let touchDrag = {
  active: false,
  startSquare: null,
  floating: null,
  lastTargetSquare: null
};

// Sounds
const moveSound = new Audio("/sounds/move.mp3");
const captureSound = new Audio("/sounds/capture.mp3");
const endSound = new Audio("/sounds/gameover.mp3");
const checkSound = new Audio("/sounds/check.mp3");

// Format timer
const fmt = s =>
  `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;

// Piece images
const pieceImage = p => {
  const t = { k: "K", q: "Q", r: "R", b: "B", n: "N", p: "P" };
  return `/pieces/${p.color}${t[p.type]}.svg`;
};

// ---------------- HIGHLIGHT HELPERS ----------------
function clearHighlights() {
  document.querySelectorAll(".square.dot, .square.capture").forEach(sq => {
    sq.classList.remove("dot");
    sq.classList.remove("capture");
  });

  // Remove yellow highlight from all squares
  document.querySelectorAll(".square.selected").forEach(sq => {
    sq.classList.remove("selected");
  });
}

function highlightMoves(row, col) {
  clearHighlights();

  // Highlight the clicked/dragged square in yellow
  const sourceSq = document.querySelector(`.square[data-row='${row}'][data-col='${col}']`);
  if (sourceSq) sourceSq.classList.add("selected");

  const from = `${String.fromCharCode(97 + col)}${8 - row}`;
  const moves = chess.moves({ square: from, verbose: true }) || [];

  moves.forEach(mv => {
    const r = 8 - parseInt(mv.to[1]);
    const c = mv.to.charCodeAt(0) - 97;
    const sq = document.querySelector(`.square[data-row='${r}'][data-col='${c}']`);
    if (!sq) return;
    if (mv.flags && mv.flags.includes("c")) sq.classList.add("capture");
    else sq.classList.add("dot");
  });
}

function clearSelectionUI() {
  clearHighlights(); // Removes dots and yellow square
  selectedElement = null;
  selectedSource = null;
}

// ---------------- EVENT ATTACHER ----------------
function attachPieceEvents(piece, r, c) {
  // Create a clone to strip old event listeners
  const newPiece = piece.cloneNode(true);

  // Replace the original piece in the DOM with the clone
  if (piece.parentNode) {
    piece.replaceWith(newPiece);
  } else {
    // If for some reason it's not in the DOM, we can't replace it.
    // But in our usage, it should always be appended first.
    // We'll just use the piece passed in (but this implies listeners might stack if not careful, 
    // though we usually only call this on fresh pieces or after move).
    // Ideally, we should ensure it's in the DOM.
  }

  // Now we work with newPiece (which is in the DOM)
  const finalPiece = newPiece;

  // mark draggable depending on role
  // Use safe check for board state
  const boardRow = chess.board()[r];
  const boardSq = boardRow ? boardRow[c] : null;

  const isMyPiece = role && boardSq && (role === boardSq.color);
  finalPiece.draggable = isMyPiece;

  // FIX: If it's not my piece, make it transparent to clicks/drops so we can capture it easily
  // by dropping onto the square underneath.
  if (!isMyPiece) {
    finalPiece.style.pointerEvents = "none";
  } else {
    finalPiece.style.pointerEvents = "auto";
  }

  // ---- DESKTOP DRAG START ----
  finalPiece.addEventListener("dragstart", e => {
    if (!finalPiece.draggable) return;
    dragged = finalPiece;
    source = { row: r, col: c };
    e.dataTransfer.setData("text/plain", "");

    // custom drag image
    const img = finalPiece.querySelector("img");
    if (img) {
      const dragImg = img.cloneNode(true);
      dragImg.style.position = "absolute";
      dragImg.style.top = "-9999px";
      document.body.appendChild(dragImg);
      const w = dragImg.width || 70;
      const h = dragImg.height || 70;
      e.dataTransfer.setDragImage(dragImg, w / 2, h / 2);
      setTimeout(() => {
        const clone = document.querySelector("body > img[style*='-9999px']");
        if (clone) clone.remove();
      }, 1000);
    }

    // Highlight the SQUARE (yellow), not the piece
    highlightMoves(r, c);
    finalPiece.classList.add("dragging");
  });

  finalPiece.addEventListener("dragend", () => {
    dragged = null;
    source = null;
    finalPiece.classList.remove("dragging");
    clearHighlights(); // Clears dots and yellow square
  });

  // ---- TOUCH (mobile) ----
  finalPiece.addEventListener("touchstart", e => {
    e.preventDefault();
    e.stopPropagation();

    const sq = chess.board()[r] && chess.board()[r][c];
    if (!sq || role !== sq.color) return;

    touchDrag.active = true;
    touchDrag.startSquare = { row: r, col: c };
    touchDrag.lastTargetSquare = null;

    const img = finalPiece.querySelector("img");
    const floating = img.cloneNode(true);
    floating.style.position = "fixed";
    floating.style.left = `${e.touches[0].clientX}px`;
    floating.style.top = `${e.touches[0].clientY}px`;
    floating.style.transform = "translate(-50%, -50%)";
    floating.style.zIndex = 9999;
    floating.style.pointerEvents = "none";
    floating.classList.add("touch-floating");
    document.body.appendChild(floating);
    touchDrag.floating = floating;

    highlightMoves(r, c);
    selectedSource = { row: r, col: c };
  }, { passive: false });

  finalPiece.addEventListener("touchmove", e => {
    if (!touchDrag.active || !touchDrag.floating) return;
    e.preventDefault();
    const t = e.touches[0];
    touchDrag.floating.style.left = `${t.clientX}px`;
    touchDrag.floating.style.top = `${t.clientY}px`;

    const el = document.elementFromPoint(t.clientX, t.clientY);
    if (!el) return;
    const sqEl = el.closest(".square");
    if (!sqEl) {
      touchDrag.lastTargetSquare = null;
      return;
    }
    touchDrag.lastTargetSquare = {
      row: parseInt(sqEl.dataset.row),
      col: parseInt(sqEl.dataset.col)
    };
  }, { passive: false });

  finalPiece.addEventListener("touchend", e => {
    if (!touchDrag.active) return;
    e.preventDefault();
    e.stopPropagation();

    let target = touchDrag.lastTargetSquare;
    if (!target) {
      const t = e.changedTouches[0];
      const el = document.elementFromPoint(t.clientX, t.clientY);
      const sqEl = el && el.closest(".square");
      if (sqEl) {
        target = {
          row: parseInt(sqEl.dataset.row),
          col: parseInt(sqEl.dataset.col)
        };
      }
    }

    if (touchDrag.floating) touchDrag.floating.remove();

    if (target && (target.row !== touchDrag.startSquare.row || target.col !== touchDrag.startSquare.col)) {
      handleMove(touchDrag.startSquare, target);
      clearSelectionUI();
    }

    touchDrag = {
      active: false,
      startSquare: null,
      floating: null,
      lastTargetSquare: null
    };
  }, { passive: false });

  // ---- CLICK SELECT ----
  finalPiece.addEventListener("click", (e) => {
    const sq = chess.board()[r] && chess.board()[r][c];

    if (sq && role === sq.color) {
      e.stopPropagation();

      if (selectedSource && selectedSource.row === r && selectedSource.col === c) {
        clearSelectionUI();
      } else {
        clearSelectionUI();
        selectedSource = { row: r, col: c };
        highlightMoves(r, c);
      }
    }
  });
}

// ---------------- BOARD RENDER ----------------
function renderBoard() {
  if (!boardEl) return;
  const board = chess.board();

  // FIRST TIME: build board
  if (!boardEl.dataset.initialized) {
    boardEl.innerHTML = "";
    boardEl.dataset.initialized = "1";

    board.forEach((row, r) => {
      row.forEach((sq, c) => {
        const cell = document.createElement("div");
        cell.classList.add("square", (r + c) % 2 ? "dark" : "light");
        cell.dataset.row = r;
        cell.dataset.col = c;
        cell.style.left = `${c * 80}px`;
        cell.style.top = `${r * 80}px`;
        // keep cell relative so pieces (if any) can be inside

        // Tap-to-tap movement
        cell.addEventListener("click", () => {
          if (selectedSource) {
            handleMove(selectedSource, { row: r, col: c });
            clearSelectionUI();
          }
        });

        cell.addEventListener("touchend", e => {
          if (selectedSource) {
            e.preventDefault();
            handleMove(selectedSource, { row: r, col: c });
            clearSelectionUI();
          }
        }, { passive: false });

        // Add piece if exists
        if (sq) {
          const piece = document.createElement("div");
          piece.classList.add("piece", sq.color === "w" ? "white" : "black");

          const img = document.createElement("img");
          img.src = pieceImage(sq);
          img.classList.add("piece-img");
          piece.appendChild(img);

          cell.appendChild(piece);

          // Attach events:
          attachPieceEvents(piece, r, c);
        }

        // Drag target behavior
        cell.addEventListener("dragover", e => e.preventDefault());
        cell.addEventListener("drop", e => {
          e.preventDefault();
          if (dragged && source) handleMove(source, { row: r, col: c });
          clearHighlights();
        });

        boardEl.appendChild(cell);
      });
    });

    if (role === "b") boardEl.classList.add("flipped");
    else boardEl.classList.remove("flipped");

    return;
  }

  // AFTER INITIAL RENDER: update piece DOMs to match engine state
  updateBoardPieces(board);
}

function updateBoardPieces(board) {
  // Diffing logic: only update squares that changed
  board.forEach((row, r) => {
    row.forEach((sq, c) => {
      const cell = document.querySelector(`.square[data-row='${r}'][data-col='${c}']`);
      if (!cell) return;

      const existingPieces = cell.querySelectorAll(".piece");

      // Case 1: Empty square in new state
      if (!sq) {
        existingPieces.forEach(p => p.remove());
        return;
      }

      // Case 2: Piece exists in new state
      // Check if existing piece matches
      if (existingPieces.length > 0) {
        // If we have duplicates, just clear all and recreate to be safe
        if (existingPieces.length > 1) {
          existingPieces.forEach(p => p.remove());
        } else {
          const existingPiece = existingPieces[0];
          const img = existingPiece.querySelector("img");
          const currentSrc = img ? img.getAttribute("src") : "";
          const newSrc = pieceImage(sq);

          // If same piece (color & type), do nothing
          if (currentSrc === newSrc) {
            // Ensure draggable is correct (in case turn changed or role changed, though usually piece change implies that)
            const isMyPiece = role && sq.color === role;
            existingPiece.draggable = isMyPiece;

            // FIX: Ensure pointer-events is correct (in case it was set to none for opponent)
            if (!isMyPiece) {
              existingPiece.style.pointerEvents = "none";
            } else {
              existingPiece.style.pointerEvents = "auto";
            }
            return;
          }

          // If different piece, remove old
          existingPiece.remove();
        }
      }

      // Add new piece
      const piece = document.createElement("div");
      piece.classList.add("piece", sq.color === "w" ? "white" : "black");

      const img = document.createElement("img");
      img.src = pieceImage(sq);
      img.classList.add("piece-img");
      piece.appendChild(img);

      cell.appendChild(piece);

      // Attach events
      attachPieceEvents(piece, r, c);
    });
  });
}

// ---------------- MOVE ANIMATION ----------------
function movePieceDOM(from, to, mvResult) {
  const fromSq = document.querySelector(`.square[data-row='${from.r}'][data-col='${from.c}']`);
  const toSq = document.querySelector(`.square[data-row='${to.r}'][data-col='${to.c}']`);
  const SQUARE_SIZE = 80; // Size of a square in pixels

  if (!fromSq || !toSq) return;

  const piece = fromSq.querySelector(".piece");
  if (!piece) return;

  // 1. Calculate Start and End positions (in pixels, relative to the board)
  const x_start = from.c * SQUARE_SIZE;
  const y_start = from.r * SQUARE_SIZE;
  const x_end = to.c * SQUARE_SIZE;
  const y_end = to.r * SQUARE_SIZE;

  // 2. Create a floating clone for animation
  const img = piece.querySelector("img");
  const floating = piece.cloneNode(true);

  // 3. Apply styles for floating piece
  floating.classList.remove("dragging"); // FIX: Ensure it's visible!
  floating.style.position = "absolute";
  floating.style.margin = "0";
  floating.style.zIndex = 9999;
  floating.style.pointerEvents = "none";

  // Set the CSS transition property for transform
  // INCREASED to 100ms for smoother frame pacing
  floating.style.transition = "transform 100ms cubic-bezier(0.2, 0.8, 0.2, 1)";

  // Set initial position using transform: translate(). This is the starting point.
  let startTransform = `translate(${x_start}px, ${y_start}px)`;

  // Counter-rotate the piece if the board is flipped (to keep the piece upright)
  if (boardEl.classList.contains("flipped")) {
    startTransform += " rotate(-180deg)";
  }

  floating.style.transform = startTransform;

  // Set initial piece dimensions for the clone
  const pieceWidth = img ? img.getBoundingClientRect().width : SQUARE_SIZE;
  const pieceHeight = img ? img.getBoundingClientRect().height : SQUARE_SIZE;
  floating.style.width = `${pieceWidth}px`;
  floating.style.height = `${pieceHeight}px`;

  // Append to the board container (the origin for absolute positioning)
  boardEl.appendChild(floating);

  // 4. Remove original immediately so target square is free
  // FIX: Remove ALL pieces from source square to prevent ghosts
  const allFromPieces = fromSq.querySelectorAll(".piece");
  allFromPieces.forEach(p => p.remove());

  // 5. Handle captures (removed from DOM before animation)
  if (mvResult && mvResult.captured) {
    // regular capture: remove piece in target square
    const cap = toSq.querySelector(".piece");
    if (cap) cap.remove();

    // en-passant capture (flag 'e'): captured pawn is behind 'to' square
    if (mvResult.flags && mvResult.flags.includes("e")) {
      const capRow = from.r;
      const capCol = to.c;
      const epSq = document.querySelector(`.square[data-row='${capRow}'][data-col='${capCol}']`);
      const epPiece = epSq && epSq.querySelector(".piece");
      if (epPiece) epPiece.remove();
    }
  }

  // 6. Start animation (move floating to target)
  requestAnimationFrame(() => {
    // FORCE REFLOW: This ensures the browser registers the 'start' position
    // before we set the 'end' position. Crucial for smooth animation.
    void floating.offsetWidth;

    let targetTransform = `translate(${x_end}px, ${y_end}px)`;
    if (boardEl.classList.contains("flipped")) {
      targetTransform += " rotate(-180deg)";
    }
    // This style change triggers the smooth CSS transition
    floating.style.transform = targetTransform;
  });

  // 7. After animation, perform cleanup and final DOM update
  // USE transitionend for perfect timing (no more setTimeout desync)
  const onTransitionEnd = () => {
    // Promotion logic (modified to use the floating element)
    if (mvResult && mvResult.promotion) {
      const imgEl = floating.querySelector("img");
      if (imgEl) {
        const color = mvResult.color || (mvResult.san && mvResult.san[0] === mvResult.san[0].toUpperCase() ? 'w' : 'b');
        imgEl.src = `/pieces/${(mvResult.color || 'w')}${mvResult.promotion.toUpperCase()}.svg`;
      }
    }

    // Reset styles and append to target cell (it will inherit the piece's absolute positioning of left:0, top:0 relative to the square)
    floating.style.position = "";
    floating.style.transform = "";
    floating.style.transition = "";
    floating.style.width = "";
    floating.style.height = "";
    floating.style.zIndex = "";
    floating.style.pointerEvents = "";

    // Append the piece to its final square
    // FIX: Clear target square of any ghosts before appending
    const allToPieces = toSq.querySelectorAll(".piece");
    allToPieces.forEach(p => p.remove());

    toSq.appendChild(floating);

    // Reattach events on the moved piece
    attachPieceEvents(floating, to.r, to.c);

    // handle rook move for castling (move rook DOM to correct square)
    let rookMove = null;
    if (mvResult && mvResult.flags) {
      if (mvResult.flags.includes("k")) {
        // king-side: rook from col7 to col5
        rookMove = {
          from: { r: from.r, c: 7 },
          to: { r: from.r, c: 5 }
        };
      } else if (mvResult.flags.includes("q")) {
        // queen-side: rook from col0 to col3
        rookMove = {
          from: { r: from.r, c: 0 },
          to: { r: from.r, c: 3 }
        };
      }
    }

    if (rookMove) {
      const rookFromSq = document.querySelector(`.square[data-row='${rookMove.from.r}'][data-col='${rookMove.from.c}']`);
      const rookToSq = document.querySelector(`.square[data-row='${rookMove.to.r}'][data-col='${rookMove.to.c}']`);
      if (rookFromSq && rookToSq) {
        const rookPiece = rookFromSq.querySelector(".piece");
        if (rookPiece) {
          rookToSq.appendChild(rookPiece);
          attachPieceEvents(rookPiece, rookMove.to.r, rookMove.to.c);
        }
      }
    }

    // Cleanup listener
    floating.removeEventListener("transitionend", onTransitionEnd);
  };

  floating.addEventListener("transitionend", onTransitionEnd);
}

// ---------------- HANDLE MOVES ----------------
function handleMove(s, t) {
  if (!s) return;
  if (s.row === t.row && s.col === t.col) return;

  const mv = {
    from: `${String.fromCharCode(97 + s.col)}${8 - s.row}`,
    to: `${String.fromCharCode(97 + t.col)}${8 - t.row}`,
    promotion: "q"
  };

  socket.emit("move", { roomId: ROOM_ID, move: mv });
}

// ---------------- TIMERS ----------------
function updateTimers(t) {
  if (!t) return;
  if (!topTimer || !bottomTimer) return;
  if (role === "b") {
    bottomTimer.innerText = fmt(t.b);
    topTimer.innerText = fmt(t.w);
  } else {
    bottomTimer.innerText = fmt(t.w);
    topTimer.innerText = fmt(t.b);
  }
}

// ======================================================
// SOCKET EVENTS
// ======================================================

// -------- QUICK PLAY MATCHED --------
socket.on("matched", d => {
  if (d && d.roomId && d.role) {
    // save role for joinRoom
    sessionStorage.setItem("quickplayRole", d.role);

    window.location = `/room/${d.roomId}`;
  }
});

// -------- WAITING SCREEN (Friend Mode or Quickplay) --------
socket.on("waiting", d => {
  const gameEl = document.getElementById("game");
  const waitEl = document.getElementById("waiting");
  if (gameEl) gameEl.classList.add("hidden");
  if (waitEl) waitEl.classList.remove("hidden");

  const wt = document.getElementById("wait-text");
  if (wt && d && d.text) wt.innerText = d.text;

  if (d && d.link) {
    const rl = document.getElementById("room-link");
    if (rl) rl.innerText = d.link;
  }
});

// -------- INITIAL SETUP --------
socket.on("init", data => {
  sessionStorage.removeItem("quickplayRole");
  role = data.role;

  const waitingEl = document.getElementById("waiting");
  const gameEl = document.getElementById("game");
  if (waitingEl) waitingEl.classList.add("hidden");
  if (gameEl) gameEl.classList.remove("hidden");

  boardEl = document.querySelector(".chessboard");
  popup = document.getElementById("popup");
  popupText = document.getElementById("popup-text");
  playAgain = document.getElementById("play-again");
  topTimer = document.getElementById("top-timer");
  bottomTimer = document.getElementById("bottom-timer");

  // confirm/draw boxes & buttons (safe getters)
  window.myBox = document.getElementById("my-confirm-box");
  window.myText = document.getElementById("my-confirm-text");
  window.myYes = document.getElementById("my-yes");
  window.myNo = document.getElementById("my-no");

  window.oppBox = document.getElementById("opp-confirm-box");
  window.oppText = document.getElementById("opp-confirm-text");
  window.oppYes = document.getElementById("opp-yes");
  window.oppNo = document.getElementById("opp-no");

  // draw message element
  window.drawMessage = document.getElementById("draw-message");

  // buttons
  window.resignBtn = document.getElementById("resign-btn");
  window.drawBtn = document.getElementById("draw-btn");

  // load position and render
  if (data && data.fen) chess.load(data.fen);
  renderBoard();
  updateTimers(data.timers);
});

// -------- BOARD UPDATE --------
socket.on("boardstate", fen => {
  // OPTIMIZATION: If we already have this state (e.g. from local move), ignore
  if (chess.fen() === fen) return;

  chess.load(fen);
  renderBoard();
  clearSelectionUI();
});

// -------- MOVE EVENT --------
socket.on("move", mv => {
  // apply move to engine first (get flags, captured, promotion etc)
  const mvResult = chess.move(mv);

  // compute from-to squares for animation
  const from = {
    r: 8 - parseInt(mv.from[1]),
    c: mv.from.charCodeAt(0) - 97
  };

  const to = {
    r: 8 - parseInt(mv.to[1]),
    c: mv.to.charCodeAt(0) - 97
  };

  // animate DOM change
  movePieceDOM(from, to, mvResult);

  clearSelectionUI();

  if (chess.in_check()) {
    checkSound.play();
    return;
  }

  if (mvResult && mvResult.captured) captureSound.play();
  else moveSound.play();
});

// -------- TIMERS --------
socket.on("timers", t => updateTimers(t));

// -------- DRAW OFFERED (opponent) --------
socket.on("drawOffered", () => {
  if (window.oppText && window.oppBox) {
    window.oppText.innerText = "Opponent offers draw";
    window.oppBox.classList.remove("hidden");

    // attach handlers (replace previous to avoid multiple bindings)
    if (window.oppYes) {
      window.oppYes.onclick = () => {
        socket.emit("acceptDraw", ROOM_ID);
        window.oppBox.classList.add("hidden");
      };
    }
    if (window.oppNo) {
      window.oppNo.onclick = () => {
        socket.emit("declineDraw", ROOM_ID);
        window.oppBox.classList.add("hidden");
      };
    }
  } else {
    if (popupText && popup) {
      popupText.innerText = "Opponent offers a draw";
      popup.classList.add("show");
      setTimeout(() => popup.classList.remove("show"), 2000);
    }
  }
});

// -------- OFFER ACCEPTED/DECLINED FEEDBACK (from server) --------
socket.on("drawDeclined", () => {
  if (window.drawMessage) {
    window.drawMessage.innerText = "Opponent declined your draw request.";
    setTimeout(() => {
      if (window.drawMessage) window.drawMessage.innerText = "";
    }, 3000);
  } else if (popup && popupText) {
    popupText.innerText = "Opponent declined your draw request.";
    popup.classList.add("show");
    setTimeout(() => popup.classList.remove("show"), 2000);
  }
});

socket.on("drawAccepted", () => {
  if (popup && popupText) {
    popupText.innerText = "Draw agreed";
    popup.classList.add("show");
    setTimeout(() => popup.classList.remove("show"), 2000);
  }
});

// -------- GAME OVER --------
socket.on("gameover", winner => {
  let txt = "";

  // ========== RESIGNATION ==========
  let w = (winner || "").toString().trim().toLowerCase();

  if (w.includes("resign")) {
    let whiteResigned = w.includes("white");
    let blackResigned = w.includes("black");

    if (whiteResigned) {
      txt = role === "b" ? "You resigned! 💀" : "Opponent resigned — you win! 😎";
    } else if (blackResigned) {
      txt = role === "w" ? "You resigned! 💀" : "Opponent resigned — you win! 😎";
    } else {
      txt = "Opponent resigned — you win! 😎";
    }
  }
  // ========== TIMEOUT ==========
  else if (typeof winner === "string" && winner.includes("timeout")) {
    if (role === "w" && winner.startsWith("White")) txt = "EZ Timeout Win 😎";
    else if (role === "b" && winner.startsWith("Black")) txt = "Time’s up, victory is mine 🕒🔥";
    else txt = "Skill issue? 🫵😂";
  }
  // ========== DRAW ==========
  else if (winner === "Draw") txt = "Both are noobs";
  // ========== CHECKMATE ==========
  else if (winner === "White") {
    txt = role === "w" ? "You win 😎" : "You got outplayed bro 💀";
  } else if (winner === "Black") {
    txt = role === "b" ? "You win 😎" : "You got outplayed bro 💀";
  }

  if (popupText && popup) {
    popupText.innerText = txt;
    popup.classList.add("show");
  } else {
    try { alert(txt); } catch (e) { }
  }

  if (endSound) endSound.play();
});

// -------- RESET BUTTON --------
if (document.getElementById("play-again")) {
  document.getElementById("play-again").onclick = () => {
    socket.emit("resetgame", ROOM_ID);
    if (popup) popup.classList.remove("show");
  };
}

// -------- RESIGN / DRAW buttons (client-side confirm boxes) --------
function safeAttachResignDraw() {
  if (window.resignBtn && window.myBox && window.myText && window.myYes && window.myNo) {
    window.resignBtn.onclick = () => {
      window.myText.innerText = "Are you sure you want to resign?";
      window.myBox.classList.remove("hidden");

      window.myYes.onclick = () => {
        socket.emit("resign", ROOM_ID);
        window.myBox.classList.add("hidden");
      };
      window.myNo.onclick = () => {
        window.myBox.classList.add("hidden");
      };
    };
  }

  if (window.drawBtn && window.myBox && window.myText && window.myYes && window.myNo) {
    window.drawBtn.onclick = () => {
      window.myText.innerText = "Offer a draw?";
      window.myBox.classList.remove("hidden");

      window.myYes.onclick = () => {
        socket.emit("offerDraw", ROOM_ID);
        window.myBox.classList.add("hidden");
      };
      window.myNo.onclick = () => {
        window.myBox.classList.add("hidden");
      };
    };
  }
}

// Try to attach immediately (elements present when script loaded after HTML)
// but also retry briefly if necessary (in case init hasn't run)
safeAttachResignDraw();
setTimeout(safeAttachResignDraw, 250);
setTimeout(safeAttachResignDraw, 1000);

// -------- JOIN ROOM ON PAGE LOAD --------
if (typeof ROOM_ID !== "undefined" && ROOM_ID) {
  const quickRole = sessionStorage.getItem("quickplayRole"); // "w" or "b" or null
  socket.emit("joinRoom", { roomId: ROOM_ID, role: quickRole });
}