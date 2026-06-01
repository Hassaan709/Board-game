const WebSocket = require('ws');
const http = require('http');
const crypto = require('crypto');

// Configuration
const PORT = process.env.PORT || 3000;
const MAX_PLAYERS_PER_ROOM = 2;
const ROOM_CODE_LENGTH = 6;
const INACTIVE_TIMEOUT = 300000; // 5 minutes
const RECONNECT_WINDOW = 60000; // 1 minute reconnection window

// Game types
const GAMES = {
  CONNECT4: 'connect4',
  TICTACTOE: 'tictactoe',
  DOTSBOXES: 'dotsboxes'
};

// Room storage
const rooms = new Map();
const players = new Map(); // socket -> player data
const disconnectedPlayers = new Map(); // playerId -> {roomCode, playerNumber, disconnectTime, gameState}

// Generate unique room code
function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // Removed similar looking characters
  let code = '';
  for (let i = 0; i < ROOM_CODE_LENGTH; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

// Generate player ID
function generatePlayerId() {
  return crypto.randomUUID();
}

// Create a new room
function createRoom(gameType, hostSocket) {
  const roomCode = generateRoomCode();
  const room = {
    code: roomCode,
    gameType: gameType,
    host: hostSocket,
    guest: null,
    gameState: null,
    currentPlayer: 1, // 1 = host, 2 = guest
    status: 'waiting', // waiting, playing, ended
    createdAt: Date.now(),
    lastActivity: Date.now(),
    moveHistory: [],
    disconnectedPlayers: new Map()
  };

  rooms.set(roomCode, room);
  return room;
}

// Join a room
function joinRoom(roomCode, guestSocket) {
  const room = rooms.get(roomCode);
  if (!room) return { error: 'Room not found' };
  if (room.status !== 'waiting') return { error: 'Room is full or game already started' };
  if (room.guest) return { error: 'Room is full' };

  room.guest = guestSocket;
  room.status = 'playing';
  room.lastActivity = Date.now();

  // Randomly assign first turn
  room.currentPlayer = Math.random() > 0.5 ? 1 : 2;

  return { success: true, room: room };
}

// Leave a room
function leaveRoom(socket) {
  const player = players.get(socket);
  if (!player || !player.roomCode) return;

  const room = rooms.get(player.roomCode);
  if (!room) return;

  // Store disconnected player info for reconnection
  const disconnectInfo = {
    roomCode: player.roomCode,
    playerNumber: player.playerNumber,
    disconnectTime: Date.now(),
    gameState: room.gameState,
    currentPlayer: room.currentPlayer,
    moveHistory: room.moveHistory
  };
  disconnectedPlayers.set(player.playerId, disconnectInfo);

  // Notify other player
  const otherSocket = player.playerNumber === 1 ? room.guest : room.host;
  if (otherSocket && otherSocket.readyState === WebSocket.OPEN) {
    sendMessage(otherSocket, {
      type: 'opponentDisconnected',
      message: 'Opponent disconnected. Waiting for reconnection...',
      reconnectWindow: RECONNECT_WINDOW
    });
  }

  // Set room to waiting for reconnection
  room.status = 'waiting_reconnect';

  // Clean up after reconnection window
  setTimeout(() => {
    if (room.status === 'waiting_reconnect') {
      // Player didn't reconnect
      if (otherSocket && otherSocket.readyState === WebSocket.OPEN) {
        sendMessage(otherSocket, {
          type: 'opponentLeft',
          message: 'Opponent did not reconnect. Match ended.'
        });
      }
      rooms.delete(player.roomCode);
      disconnectedPlayers.delete(player.playerId);
    }
  }, RECONNECT_WINDOW);

  players.delete(socket);
}

// Send message to socket
function sendMessage(socket, message) {
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(message));
  }
}

// Broadcast to all players in room
function broadcastToRoom(room, message, excludeSocket = null) {
  if (room.host && room.host !== excludeSocket && room.host.readyState === WebSocket.OPEN) {
    sendMessage(room.host, message);
  }
  if (room.guest && room.guest !== excludeSocket && room.guest.readyState === WebSocket.OPEN) {
    sendMessage(room.guest, message);
  }
}

// Validate move based on game type
function validateMove(room, playerNumber, moveData) {
  // Check if it's player's turn
  if (room.currentPlayer !== playerNumber) {
    return { valid: false, error: 'Not your turn' };
  }

  // Check if game is active
  if (room.status !== 'playing') {
    return { valid: false, error: 'Game not active' };
  }

  // Game-specific validation
  switch (room.gameType) {
    case GAMES.CONNECT4:
      return validateConnect4Move(room, moveData);
    case GAMES.TICTACTOE:
      return validateTicTacToeMove(room, moveData);
    case GAMES.DOTSBOXES:
      return validateDotsBoxesMove(room, moveData);
    default:
      return { valid: false, error: 'Unknown game type' };
  }
}

function validateConnect4Move(room, moveData) {
  const { column } = moveData;
  if (typeof column !== 'number' || column < 0 || column > 6) {
    return { valid: false, error: 'Invalid column' };
  }

  // Check if column is full
  if (!room.gameState) room.gameState = { board: Array(6).fill(null).map(() => Array(7).fill(0)) };
  const board = room.gameState.board;
  if (board[0][column] !== 0) {
    return { valid: false, error: 'Column is full' };
  }

  return { valid: true };
}

function validateTicTacToeMove(room, moveData) {
  const { index, phase } = moveData;
  if (typeof index !== 'number' || index < 0 || index > 8) {
    return { valid: false, error: 'Invalid position' };
  }

  if (!room.gameState) {
    room.gameState = {
      board: Array(9).fill(null),
      history: { X: [], O: [] },
      phase: 'place'
    };
  }

  const board = room.gameState.board;
  const player = room.currentPlayer === 1 ? 'X' : 'O';

  if (phase === 'place') {
    if (board[index] !== null) {
      return { valid: false, error: 'Position already occupied' };
    }
    if (room.gameState.history[player].length >= 3) {
      return { valid: false, error: 'All pieces placed' };
    }
  } else {
    // Move phase validation
    if (!moveData.selectedPiece && board[index] !== player) {
      return { valid: false, error: 'Select your piece first' };
    }
    if (moveData.selectedPiece && board[index] !== null) {
      return { valid: false, error: 'Destination occupied' };
    }
  }

  return { valid: true };
}

function validateDotsBoxesMove(room, moveData) {
  const { r, c, isHorizontal } = moveData;
  if (typeof r !== 'number' || typeof c !== 'number' || typeof isHorizontal !== 'boolean') {
    return { valid: false, error: 'Invalid move data' };
  }

  if (!room.gameState) {
    room.gameState = {
      hLines: Array(5).fill(null).map(() => Array(4).fill(0)),
      vLines: Array(4).fill(null).map(() => Array(5).fill(0)),
      boxes: Array(4).fill(null).map(() => Array(4).fill(0))
    };
  }

  const lines = isHorizontal ? room.gameState.hLines : room.gameState.vLines;
  if (lines[r][c] !== 0) {
    return { valid: false, error: 'Line already drawn' };
  }

  return { valid: true };
}

// Apply move to game state
function applyMove(room, playerNumber, moveData) {
  switch (room.gameType) {
    case GAMES.CONNECT4:
      return applyConnect4Move(room, playerNumber, moveData);
    case GAMES.TICTACTOE:
      return applyTicTacToeMove(room, playerNumber, moveData);
    case GAMES.DOTSBOXES:
      return applyDotsBoxesMove(room, playerNumber, moveData);
  }
}

function applyConnect4Move(room, playerNumber, moveData) {
  const { column } = moveData;
  const board = room.gameState.board;

  // Find lowest empty row
  let row = 5;
  while (row >= 0 && board[row][column] !== 0) row--;

  if (row >= 0) {
    board[row][column] = playerNumber;

    // Check win
    const winResult = checkConnect4Win(board, row, column, playerNumber);
    if (winResult) {
      return { win: true, winner: playerNumber, winCells: winResult };
    }

    // Check draw
    if (board[0].every(cell => cell !== 0)) {
      return { draw: true };
    }

    // Switch turn
    room.currentPlayer = room.currentPlayer === 1 ? 2 : 1;
    return { success: true };
  }

  return { error: 'Invalid move' };
}

function checkConnect4Win(board, row, col, player) {
  const directions = [[0, 1], [1, 0], [1, 1], [1, -1]];

  for (const [dr, dc] of directions) {
    const cells = [[row, col]];

    // Check positive direction
    for (let i = 1; i < 4; i++) {
      const r = row + dr * i, c = col + dc * i;
      if (r < 0 || r > 5 || c < 0 || c > 6 || board[r][c] !== player) break;
      cells.push([r, c]);
    }

    // Check negative direction
    for (let i = 1; i < 4; i++) {
      const r = row - dr * i, c = col - dc * i;
      if (r < 0 || r > 5 || c < 0 || c > 6 || board[r][c] !== player) break;
      cells.push([r, c]);
    }

    if (cells.length >= 4) return cells;
  }

  return null;
}

function applyTicTacToeMove(room, playerNumber, moveData) {
  const { index, phase, selectedPiece } = moveData;
  const player = playerNumber === 1 ? 'X' : 'O';
  const board = room.gameState.board;
  const history = room.gameState.history;

  if (phase === 'place') {
    board[index] = player;
    history[player].push(index);

    if (history.X.length === 3 && history.O.length === 3) {
      room.gameState.phase = 'move';
    }
  } else {
    board[index] = player;
    board[selectedPiece] = null;
    const idx = history[player].indexOf(selectedPiece);
    history[player][idx] = index;
  }

  // Check win
  const winResult = checkTicTacToeWin(board);
  if (winResult) {
    return { win: true, winner: playerNumber, winCells: winResult };
  }

  room.currentPlayer = room.currentPlayer === 1 ? 2 : 1;
  return { success: true, phase: room.gameState.phase };
}

function checkTicTacToeWin(board) {
  const wins = [[0,1,2], [3,4,5], [6,7,8], [0,3,6], [1,4,7], [2,5,8], [0,4,8], [2,4,6]];

  for (const [a, b, c] of wins) {
    if (board[a] && board[a] === board[b] && board[b] === board[c]) {
      return [a, b, c];
    }
  }
  return null;
}

function applyDotsBoxesMove(room, playerNumber, moveData) {
  const { r, c, isHorizontal } = moveData;
  const lines = isHorizontal ? room.gameState.hLines : room.gameState.vLines;
  lines[r][c] = playerNumber;

  // Check for completed boxes
  const completedBoxes = [];
  const boxes = room.gameState.boxes;

  if (isHorizontal) {
    // Check box above
    if (r > 0 && room.gameState.hLines[r-1][c] && room.gameState.vLines[r-1][c] && room.gameState.vLines[r-1][c+1]) {
      if (!boxes[r-1][c]) { boxes[r-1][c] = playerNumber; completedBoxes.push([r-1, c]); }
    }
    // Check box below
    if (r < 4 && room.gameState.hLines[r+1][c] && room.gameState.vLines[r][c] && room.gameState.vLines[r][c+1]) {
      if (!boxes[r][c]) { boxes[r][c] = playerNumber; completedBoxes.push([r, c]); }
    }
  } else {
    // Check box left
    if (c > 0 && room.gameState.vLines[r][c-1] && room.gameState.hLines[r][c-1] && room.gameState.hLines[r+1][c-1]) {
      if (!boxes[r][c-1]) { boxes[r][c-1] = playerNumber; completedBoxes.push([r, c-1]); }
    }
    // Check box right
    if (c < 4 && room.gameState.vLines[r][c+1] && room.gameState.hLines[r][c] && room.gameState.hLines[r+1][c]) {
      if (!boxes[r][c]) { boxes[r][c] = playerNumber; completedBoxes.push([r, c]); }
    }
  }

  // Count scores
  let p1Score = 0, p2Score = 0;
  for (const row of boxes) {
    for (const box of row) {
      if (box === 1) p1Score++;
      else if (box === 2) p2Score++;
    }
  }

  // Check if game over (all boxes filled)
  const totalBoxes = 16;
  if (p1Score + p2Score >= totalBoxes) {
    return {
      win: true,
      winner: p1Score > p2Score ? 1 : p1Score < p2Score ? 2 : 0,
      scores: [p1Score, p2Score]
    };
  }

  // If no boxes completed, switch turn
  if (completedBoxes.length === 0) {
    room.currentPlayer = room.currentPlayer === 1 ? 2 : 1;
  }

  return { success: true, completedBoxes, scores: [p1Score, p2Score] };
}

// WebSocket server
const server = http.createServer();
const wss = new WebSocket.Server({ server });

wss.on('connection', (socket) => {
  console.log('New connection');

  socket.on('message', (data) => {
    try {
      const message = JSON.parse(data);
      handleMessage(socket, message);
    } catch (e) {
      sendMessage(socket, { type: 'error', error: 'Invalid message format' });
    }
  });

  socket.on('close', () => {
    leaveRoom(socket);
  });

  socket.on('error', (err) => {
    console.error('Socket error:', err);
    leaveRoom(socket);
  });
});

function handleMessage(socket, message) {
  const { type, data } = message;

  switch (type) {
    case 'createRoom':
      handleCreateRoom(socket, data);
      break;

    case 'joinRoom':
      handleJoinRoom(socket, data);
      break;

    case 'makeMove':
      handleMakeMove(socket, data);
      break;

    case 'reconnect':
      handleReconnect(socket, data);
      break;

    case 'leaveRoom':
      leaveRoom(socket);
      break;

    case 'ping':
      sendMessage(socket, { type: 'pong' });
      break;

    default:
      sendMessage(socket, { type: 'error', error: 'Unknown message type: ' + type });
  }
}

function handleCreateRoom(socket, data) {
  const { gameType, playerName } = data;

  if (!GAMES[gameType.toUpperCase()]) {
    sendMessage(socket, { type: 'error', error: 'Invalid game type' });
    return;
  }

  const room = createRoom(gameType, socket);
  const playerId = generatePlayerId();

  players.set(socket, {
    playerId: playerId,
    playerNumber: 1,
    roomCode: room.code,
    playerName: playerName || 'Host'
  });

  sendMessage(socket, {
    type: 'roomCreated',
    roomCode: room.code,
    playerId: playerId,
    playerNumber: 1,
    message: 'Room created. Share the code with your opponent.'
  });
}

function handleJoinRoom(socket, data) {
  const { roomCode, playerName } = data;

  const result = joinRoom(roomCode, socket);
  if (result.error) {
    sendMessage(socket, { type: 'error', error: result.error });
    return;
  }

  const room = result.room;
  const playerId = generatePlayerId();

  players.set(socket, {
    playerId: playerId,
    playerNumber: 2,
    roomCode: room.code,
    playerName: playerName || 'Guest'
  });

  // Notify guest
  sendMessage(socket, {
    type: 'joinedRoom',
    roomCode: room.code,
    playerId: playerId,
    playerNumber: 2,
    gameType: room.gameType,
    currentPlayer: room.currentPlayer,
    message: 'Joined room. Game starting...'
  });

  // Notify host
  sendMessage(room.host, {
    type: 'opponentJoined',
    playerName: playerName || 'Guest',
    playerNumber: 2,
    currentPlayer: room.currentPlayer,
    message: 'Opponent joined. Game starting...'
  });

  // Initialize game state
  initializeGameState(room);

  // Broadcast game start
  broadcastToRoom(room, {
    type: 'gameStart',
    gameType: room.gameType,
    currentPlayer: room.currentPlayer,
    gameState: room.gameState
  });
}

function initializeGameState(room) {
  switch (room.gameType) {
    case GAMES.CONNECT4:
      room.gameState = { board: Array(6).fill(null).map(() => Array(7).fill(0)) };
      break;
    case GAMES.TICTACTOE:
      room.gameState = { board: Array(9).fill(null), history: { X: [], O: [] }, phase: 'place' };
      break;
    case GAMES.DOTSBOXES:
      room.gameState = {
        hLines: Array(5).fill(null).map(() => Array(4).fill(0)),
        vLines: Array(4).fill(null).map(() => Array(5).fill(0)),
        boxes: Array(4).fill(null).map(() => Array(4).fill(0))
      };
      break;
  }
}

function handleMakeMove(socket, data) {
  const player = players.get(socket);
  if (!player) {
    sendMessage(socket, { type: 'error', error: 'Not in a room' });
    return;
  }

  const room = rooms.get(player.roomCode);
  if (!room) {
    sendMessage(socket, { type: 'error', error: 'Room not found' });
    return;
  }

  // Validate move
  const validation = validateMove(room, player.playerNumber, data);
  if (!validation.valid) {
    sendMessage(socket, { type: 'error', error: validation.error });
    return;
  }

  // Apply move
  const result = applyMove(room, player.playerNumber, data);

  if (result.error) {
    sendMessage(socket, { type: 'error', error: result.error });
    return;
  }

  // Store move in history
  room.moveHistory.push({
    player: player.playerNumber,
    move: data,
    timestamp: Date.now()
  });
  room.lastActivity = Date.now();

  // Broadcast move to both players
  broadcastToRoom(room, {
    type: 'moveMade',
    player: player.playerNumber,
    move: data,
    gameState: room.gameState,
    currentPlayer: room.currentPlayer,
    result: result
  });

  // Handle game end
  if (result.win || result.draw) {
    room.status = 'ended';
    broadcastToRoom(room, {
      type: 'gameEnd',
      winner: result.winner,
      draw: result.draw,
      scores: result.scores,
      winCells: result.winCells
    });
  }
}

function handleReconnect(socket, data) {
  const { playerId, roomCode } = data;

  // Check if player was recently disconnected
  const disconnectInfo = disconnectedPlayers.get(playerId);
  if (!disconnectInfo) {
    sendMessage(socket, { type: 'error', error: 'Reconnection window expired or invalid player ID' });
    return;
  }

  const room = rooms.get(roomCode);
  if (!room || room.status !== 'waiting_reconnect') {
    sendMessage(socket, { type: 'error', error: 'Room no longer available' });
    return;
  }

  // Restore player
  players.set(socket, {
    playerId: playerId,
    playerNumber: disconnectInfo.playerNumber,
    roomCode: roomCode
  });

  // Restore room state
  if (disconnectInfo.playerNumber === 1) room.host = socket;
  else room.guest = socket;

  room.status = 'playing';
  room.gameState = disconnectInfo.gameState;
  room.currentPlayer = disconnectInfo.currentPlayer;
  room.moveHistory = disconnectInfo.moveHistory;

  // Remove from disconnected
  disconnectedPlayers.delete(playerId);

  // Notify player
  sendMessage(socket, {
    type: 'reconnected',
    roomCode: roomCode,
    playerNumber: disconnectInfo.playerNumber,
    gameState: room.gameState,
    currentPlayer: room.currentPlayer,
    message: 'Reconnected successfully!'
  });

  // Notify opponent
  const opponent = disconnectInfo.playerNumber === 1 ? room.guest : room.host;
  if (opponent && opponent.readyState === WebSocket.OPEN) {
    sendMessage(opponent, {
      type: 'opponentReconnected',
      message: 'Opponent reconnected!'
    });
  }
}

// Cleanup inactive rooms
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (now - room.lastActivity > INACTIVE_TIMEOUT) {
      // Notify players
      broadcastToRoom(room, {
        type: 'roomClosed',
        message: 'Room closed due to inactivity'
      });
      rooms.delete(code);
    }
  }
}, 60000); // Check every minute

server.listen(PORT, () => {
  console.log(`Multiplayer server running on port ${PORT}`);
  console.log(`WebSocket endpoint: ws://localhost:${PORT}`);
});

module.exports = { server, rooms, players };
