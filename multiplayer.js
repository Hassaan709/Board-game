// ==================== MULTIPLAYER ENGINE ====================
// WebSocket-based multiplayer system for Board Games
// Supports: Connect 4, Tic Tac Toe, Dots & Boxes

const MultiplayerEngine = (function() {
  // Configuration
  const WS_URL = window.location.hostname === 'localhost' 
    ? 'ws://localhost:3000' 
    : 'wss://your-render-app.onrender.com'; // Replace with your deployed server URL

  // State
  let ws = null;
  let currentRoom = null;
  let playerId = null;
  let playerNumber = null;
  let reconnectTimer = null;
  let pingInterval = null;
  let isConnecting = false;

  // Event callbacks
  const callbacks = {
    onRoomCreated: null,
    onJoinedRoom: null,
    onOpponentJoined: null,
    onGameStart: null,
    onMoveReceived: null,
    onGameEnd: null,
    onOpponentDisconnected: null,
    onOpponentReconnected: null,
    onOpponentLeft: null,
    onError: null,
    onReconnected: null
  };

  // Connect to WebSocket server
  function connect() {
    if (ws && ws.readyState === WebSocket.OPEN) return;
    if (isConnecting) return;

    isConnecting = true;

    try {
      ws = new WebSocket(WS_URL);

      ws.onopen = function() {
        isConnecting = false;
        console.log('Connected to multiplayer server');
        startPing();

        // If we were in a room, try to reconnect
        if (currentRoom && playerId) {
          send({
            type: 'reconnect',
            data: { playerId: playerId, roomCode: currentRoom }
          });
        }
      };

      ws.onmessage = function(event) {
        try {
          const message = JSON.parse(event.data);
          handleMessage(message);
        } catch (e) {
          console.error('Invalid message:', event.data);
        }
      };

      ws.onclose = function() {
        isConnecting = false;
        stopPing();

        // Attempt reconnection after 3 seconds
        if (currentRoom) {
          reconnectTimer = setTimeout(function() {
            console.log('Attempting reconnection...');
            connect();
          }, 3000);
        }
      };

      ws.onerror = function(err) {
        isConnecting = false;
        console.error('WebSocket error:', err);
        if (callbacks.onError) callbacks.onError('Connection error. Please check your internet connection.');
      };
    } catch (e) {
      isConnecting = false;
      console.error('Failed to connect:', e);
      if (callbacks.onError) callbacks.onError('Failed to connect to server.');
    }
  }

  // Send message to server
  function send(message) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(message));
    } else {
      console.error('WebSocket not connected');
      if (callbacks.onError) callbacks.onError('Not connected to server.');
    }
  }

  // Handle incoming messages
  function handleMessage(message) {
    console.log('Received:', message.type);

    switch (message.type) {
      case 'roomCreated':
        currentRoom = message.roomCode;
        playerId = message.playerId;
        playerNumber = message.playerNumber;
        if (callbacks.onRoomCreated) callbacks.onRoomCreated(message);
        break;

      case 'joinedRoom':
        currentRoom = message.roomCode;
        playerId = message.playerId;
        playerNumber = message.playerNumber;
        if (callbacks.onJoinedRoom) callbacks.onJoinedRoom(message);
        break;

      case 'opponentJoined':
        if (callbacks.onOpponentJoined) callbacks.onOpponentJoined(message);
        break;

      case 'gameStart':
        if (callbacks.onGameStart) callbacks.onGameStart(message);
        break;

      case 'moveMade':
        if (callbacks.onMoveReceived) callbacks.onMoveReceived(message);
        break;

      case 'gameEnd':
        if (callbacks.onGameEnd) callbacks.onGameEnd(message);
        break;

      case 'opponentDisconnected':
        if (callbacks.onOpponentDisconnected) callbacks.onOpponentDisconnected(message);
        break;

      case 'opponentReconnected':
        if (callbacks.onOpponentReconnected) callbacks.onOpponentReconnected(message);
        break;

      case 'opponentLeft':
        currentRoom = null;
        playerId = null;
        playerNumber = null;
        if (callbacks.onOpponentLeft) callbacks.onOpponentLeft(message);
        break;

      case 'reconnected':
        currentRoom = message.roomCode;
        playerNumber = message.playerNumber;
        if (callbacks.onReconnected) callbacks.onReconnected(message);
        break;

      case 'roomClosed':
        currentRoom = null;
        playerId = null;
        playerNumber = null;
        if (callbacks.onOpponentLeft) callbacks.onOpponentLeft(message);
        break;

      case 'error':
        if (callbacks.onError) callbacks.onError(message.error);
        break;

      case 'pong':
        // Heartbeat received
        break;
    }
  }

  // Start ping interval
  function startPing() {
    pingInterval = setInterval(function() {
      send({ type: 'ping' });
    }, 30000); // Ping every 30 seconds
  }

  // Stop ping interval
  function stopPing() {
    if (pingInterval) {
      clearInterval(pingInterval);
      pingInterval = null;
    }
  }

  // Public API
  return {
    // Connection
    connect: connect,
    disconnect: function() {
      if (reconnectTimer) clearTimeout(reconnectTimer);
      stopPing();
      if (ws) ws.close();
      ws = null;
      currentRoom = null;
      playerId = null;
      playerNumber = null;
    },
    isConnected: function() {
      return ws && ws.readyState === WebSocket.OPEN;
    },

    // Room management
    createRoom: function(gameType, playerName) {
      connect();
      // Wait for connection then send
      setTimeout(function() {
        send({
          type: 'createRoom',
          data: { gameType: gameType, playerName: playerName }
        });
      }, 500);
    },

    joinRoom: function(roomCode, playerName) {
      connect();
      setTimeout(function() {
        send({
          type: 'joinRoom',
          data: { roomCode: roomCode, playerName: playerName }
        });
      }, 500);
    },

    leaveRoom: function() {
      send({ type: 'leaveRoom' });
      currentRoom = null;
    },

    // Game actions
    makeMove: function(moveData) {
      send({
        type: 'makeMove',
        data: moveData
      });
    },

    // Getters
    getRoomCode: function() { return currentRoom; },
    getPlayerNumber: function() { return playerNumber; },
    getPlayerId: function() { return playerId; },
    isHost: function() { return playerNumber === 1; },

    // Event registration
    onRoomCreated: function(cb) { callbacks.onRoomCreated = cb; },
    onJoinedRoom: function(cb) { callbacks.onJoinedRoom = cb; },
    onOpponentJoined: function(cb) { callbacks.onOpponentJoined = cb; },
    onGameStart: function(cb) { callbacks.onGameStart = cb; },
    onMoveReceived: function(cb) { callbacks.onMoveReceived = cb; },
    onGameEnd: function(cb) { callbacks.onGameEnd = cb; },
    onOpponentDisconnected: function(cb) { callbacks.onOpponentDisconnected = cb; },
    onOpponentReconnected: function(cb) { callbacks.onOpponentReconnected = cb; },
    onOpponentLeft: function(cb) { callbacks.onOpponentLeft = cb; },
    onError: function(cb) { callbacks.onError = cb; },
    onReconnected: function(cb) { callbacks.onReconnected = cb; }
  };
})();
