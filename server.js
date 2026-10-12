'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const game = require('./src/game');
const { createStore } = require('./src/store');

const PUBLIC_DIR = path.join(__dirname, 'public');
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
};

function send(ws, message) {
  if (ws.readyState === 1) ws.send(JSON.stringify(message));
}

function startServer({ port = 0, dataFile } = {}) {
  const store = createStore(dataFile || path.join(__dirname, 'data', 'state.json'));
  store.load();

  const sockets = new Map();

  function roomSockets(code) {
    if (!sockets.has(code)) sockets.set(code, new Map());
    return sockets.get(code);
  }

  function broadcast(room, message, except) {
    const data = JSON.stringify(message);
    const byPlayer = roomSockets(room.code);
    for (const set of byPlayer.values()) {
      for (const ws of set) {
        if (ws !== except && ws.readyState === 1) ws.send(data);
      }
    }
  }

  function getRoom(code) {
    if (!store.state.rooms[code]) {
      if (Object.keys(store.state.rooms).length >= 100) return null;
      store.state.rooms[code] = game.createRoom(code);
    }
    return store.state.rooms[code];
  }

  function attach(room, player, ws) {
    ws.ctx = { room, player };
    const byPlayer = roomSockets(room.code);
    if (!byPlayer.has(player.id)) byPlayer.set(player.id, new Set());
    byPlayer.get(player.id).add(ws);
    player.connected = true;
  }

  function detach(ws) {
    const ctx = ws.ctx;
    if (!ctx) return;
    const byPlayer = roomSockets(ctx.room.code);
    const set = byPlayer.get(ctx.player.id);
    if (set) {
      set.delete(ws);
      if (set.size === 0) {
        byPlayer.delete(ctx.player.id);
        ctx.player.connected = false;
        broadcast(ctx.room, { type: 'presence', players: game.pubPlayers(ctx.room) });
        store.scheduleSave();
      }
    }
    ws.ctx = null;
  }

  function resultMessage(opId, result, player, room) {
    return {
      type: 'result',
      opId,
      status: result.status,
      error: result.error || null,
      conflict: result.conflict || null,
      duplicate: Boolean(result.duplicate),
      board: game.pubBoard(room),
      note: game.pubNote(room),
      you: game.pubPlayer(room, player),
      log: result.log || null,
    };
  }

  function perform(room, player, op) {
    const opId = game.cleanOpId(op && op.opId);
    if (!opId) {
      return { message: resultMessage(null, { status: 'error', error: 'bad_op' }, player, room), fresh: false };
    }
    const prev = game.remembered(room, opId);
    if (prev) {
      return {
        message: resultMessage(opId, { ...prev, duplicate: true }, player, room),
        fresh: false,
      };
    }
    const result = game.apply(room, player, op);
    game.remember(room, opId, {
      status: result.status,
      error: result.error || null,
      conflict: result.conflict || null,
      log: result.log || null,
    });
    if (result.status === 'applied' || result.log) {
      broadcast(room, {
        type: 'board',
        board: game.pubBoard(room),
        note: game.pubNote(room),
        log: result.log,
        players: game.pubPlayers(room),
      });
    }
    try {
      if (result.status !== 'error') store.saveNow();
    } catch (error) {
      console.error('Не удалось сохранить состояние:', error.message);
    }
    return { message: resultMessage(opId, result, player, room), fresh: true };
  }

  function welcome(room, player, results) {
    return {
      type: 'welcome',
      you: game.pubPlayer(room, player),
      players: game.pubPlayers(room),
      board: game.pubBoard(room),
      note: game.pubNote(room),
      log: room.log,
      results,
    };
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    let pathname = decodeURIComponent(url.pathname);
    if (pathname === '/') pathname = '/index.html';
    const file = path.normalize(path.join(PUBLIC_DIR, pathname));
    const relative = path.relative(PUBLIC_DIR, file);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }
    fs.readFile(file, (error, data) => {
      if (error) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Not found');
        return;
      }
      const type = TYPES[path.extname(file)] || 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
      res.end(data);
    });
  });

  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 64 * 1024 });

  wss.on('connection', (ws) => {
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    ws.on('message', (buf) => {
      if (!allow(ws)) return;
      let msg;
      try {
        msg = JSON.parse(buf.toString());
      } catch (error) {
        return;
      }
      if (!msg || typeof msg !== 'object') return;
      if (msg.type === 'ping') {
        send(ws, { type: 'pong', t: Date.now() });
        return;
      }
      if (msg.type === 'hello') {
        handleHello(ws, msg);
        return;
      }
      if (!ws.ctx) return;
      if (msg.type === 'op') {
        const { message } = perform(ws.ctx.room, ws.ctx.player, msg.op || {});
        send(ws, message);
        return;
      }
      if (msg.type === 'leave') {
        detach(ws);
        ws.close();
      }
    });
    ws.on('close', () => detach(ws));
  });

  function allow(ws) {
    const now = Date.now();
    if (!ws.rate || now - ws.rate.at > 1000) ws.rate = { at: now, n: 0 };
    ws.rate.n += 1;
    return ws.rate.n <= 50;
  }

  function handleHello(ws, msg) {
    if (ws.ctx) return;
    const code = game.cleanRoomCode(msg.room);
    const name = game.cleanPlayerName(msg.name);
    const clientId = game.cleanClientId(msg.clientId);
    if (!code || !name || !clientId) {
      send(ws, { type: 'error', error: 'bad_hello' });
      return;
    }
    const room = getRoom(code);
    if (!room) {
      send(ws, { type: 'error', error: 'rooms_full' });
      return;
    }
    const player = game.joinPlayer(room, { id: clientId, name });
    attach(room, player, ws);
    const pending = Array.isArray(msg.pending) ? msg.pending.slice(0, 40) : [];
    const results = [];
    for (const op of pending) results.push(perform(room, player, op).message);
    send(ws, welcome(room, player, results));
    broadcast(room, { type: 'presence', players: game.pubPlayers(room) }, ws);
    store.scheduleSave();
  }

  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
  }, 20000);
  if (heartbeat.unref) heartbeat.unref();

  let closed = null;
  return new Promise((resolve) => {
    server.listen(port, '0.0.0.0', () => {
      const address = server.address();
      resolve({
        port: address.port,
        store,
        close() {
          if (closed) return closed;
          clearInterval(heartbeat);
          for (const ws of [...wss.clients]) {
            detach(ws);
            ws.terminate();
          }
          try { store.flush(); } catch (error) { /* файл мог быть занят */ }
          closed = new Promise((done) => {
            let finished = false;
            const finish = () => {
              if (finished) return;
              finished = true;
              done();
            };
            wss.close(() => server.close(finish));
            setTimeout(finish, 1000).unref?.();
          });
          return closed;
        },
      });
    });
  });
}

module.exports = { startServer };

if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  let running = null;
  startServer({ port }).then((handle) => {
    running = handle;
    console.log(`Шахматы: http://localhost:${handle.port}`);
  });
  function shutdown() {
    const done = () => process.exit(0);
    if (!running) done();
    else running.close().then(done);
    setTimeout(done, 1500).unref?.();
  }
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
