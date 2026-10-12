'use strict';

const SESSION_KEY = 'chess-session-v1';
const PROFILE_KEY = 'chess-profile';
const CLIENT_KEY = 'chess-client-id';
const GLYPH = { k: '♚', q: '♛', r: '♜', b: '♝', n: '♞', p: '♟' };
const ERROR_TEXT = {
  not_your_turn: 'Сейчас ход соперника',
  not_your_piece: 'Это фигура другого цвета',
  spectator: 'Сначала сядьте за доску',
  illegal: 'Так ходить нельзя',
  promotion: 'Выберите фигуру для превращения',
  game_over: 'Партия уже закончена',
  seat_taken: 'Это место занято',
  bad_op: 'Некорректный ход',
  bad_hello: 'Проверьте имя и код партии',
  rooms_full: 'Свободных партий не осталось',
};

const $ = (id) => document.getElementById(id);
const joinForm = $('join-form');
const nameInput = $('name-input');
const roomInput = $('room-input');
const lobbyError = $('lobby-error');
const roomLabel = $('room-label');
const statusEl = $('status');
const queueEl = $('queue');
const turnTitle = $('turn-title');
const turnLine = $('turn-line');
const playersEl = $('players');
const movesEl = $('moves');
const logEl = $('log');
const boardWrap = $('board-wrap');
const modal = $('modal');
const modalBody = $('modal-body');
const modalReplay = $('modal-replay');
const promo = $('promo');
const promoChoices = $('promo-choices');
const toasts = $('toasts');
const noteInput = $('note-input');
const noteMeta = $('note-meta');
const noteSave = $('note-save');
const modalKicker = $('modal-kicker');
const modalTitle = $('modal-title');
const modalKeep = $('modal-keep');

let clientId = '';
let name = '';
let room = '';
let inGame = false;
let shouldReconnect = false;
let online = false;
let welcomed = false;
let browserOffline = false;
let attempt = 0;
let socket = null;
let serverYou = null;
let serverPlayers = [];
let serverBoard = null;
let serverNote = { text: '', version: 0, byName: null };
let pending = [];
let conflictQueue = [];
let log = [];
let seenSeq = new Set();
let selected = null;
let promoMove = null;
let openConflictId = null;

function clientIdOf() {
  let id = localStorage.getItem(CLIENT_KEY);
  if (!id || !/^[0-9a-f-]{8,40}$/.test(id)) {
    id = crypto.randomUUID().toLowerCase();
    localStorage.setItem(CLIENT_KEY, id);
  }
  return id;
}

function cleanRoom(value) {
  return String(value || '').trim().toLocaleUpperCase('ru-RU').replace(/[^0-9A-ZА-ЯЁ-]/g, '').slice(0, 12);
}

function suggestRoom() {
  const words = ['КЛУБ', 'ТУРНИР', 'ДЕБЮТ', 'ГАМБИТ', 'ЛАДЬЯ', 'ФЕРЗЬ'];
  return `${words[Math.floor(Math.random() * words.length)]}-${Math.floor(10 + Math.random() * 89)}`;
}

function readJson(key) {
  try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch (error) { return null; }
}

function publicOp(op) {
  const copy = { ...op };
  delete copy.sent;
  delete copy.sentAt;
  return copy;
}

function saveSession() {
  if (!inGame) return;
  localStorage.setItem(SESSION_KEY, JSON.stringify({
    inGame: true,
    name,
    room,
    pending: pending.map(publicOp),
    conflicts: conflictQueue,
    snapshot: { you: serverYou, players: serverPlayers, board: serverBoard, note: serverNote, log },
  }));
}

function toast(text) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = text;
  toasts.appendChild(el);
  while (toasts.children.length > 3) toasts.firstChild.remove();
  setTimeout(() => el.remove(), 4200);
}

function setStatus(state) {
  const text = {
    online: 'В сети',
    offline: 'Нет сети · партия сохранена',
    connecting: 'Соединение…',
  };
  statusEl.dataset.state = state;
  statusEl.textContent = text[state] || text.connecting;
}

function appendLog(entry) {
  if (!entry || seenSeq.has(entry.seq)) return;
  seenSeq.add(entry.seq);
  log.push(entry);
  if (log.length > 80) seenSeq.delete(log.shift().seq);
}

function takeNote(note) {
  if (!note) return;
  serverNote = { text: note.text || '', version: note.version || 0, byName: note.byName || null };
}

function mySeat() {
  return serverYou && serverYou.seat;
}

function send(message) {
  if (!(socket && socket.readyState === WebSocket.OPEN)) return false;
  socket.send(JSON.stringify(message));
  return true;
}

function commit(op) {
  op.opId = op.opId || `op-${crypto.randomUUID()}`;
  pending.push(op);
  saveSession();
  render();
  flushPending();
}

function flushPending() {
  if (!online || !welcomed) return;
  const now = Date.now();
  for (const op of pending) {
    if (op.sent && now - op.sentAt < 800) continue;
    if (!send({ type: 'op', op: publicOp(op) })) continue;
    op.sent = true;
    op.sentAt = now;
  }
}

function noteConflict(result) {
  if (!result.conflict) return;
  if (conflictQueue.some((item) => item.opId === result.opId)) return;
  conflictQueue.push({ opId: result.opId, ...result.conflict });
  saveSession();
  showConflict();
}

function onWelcome(msg) {
  serverYou = msg.you;
  serverPlayers = msg.players || [];
  serverBoard = msg.board;
  takeNote(msg.note);
  log = msg.log || [];
  seenSeq = new Set(log.map((entry) => entry.seq));
  const results = msg.results || [];
  const done = new Set(results.map((result) => result.opId).filter(Boolean));
  pending = pending.filter((op) => !done.has(op.opId));
  for (const op of pending) op.sent = false;
  welcomed = true;
  online = true;
  setStatus('online');
  for (const result of results) {
    if (result.status === 'error' && result.error) toast(ERROR_TEXT[result.error] || 'Ход отклонён');
    if (result.status === 'conflict') noteConflict(result);
  }
  saveSession();
  render();
  flushPending();
}

function onResult(msg) {
  const done = pending.find((op) => op.opId === msg.opId);
  if (msg.you) serverYou = msg.you;
  if (msg.board) serverBoard = msg.board;
  takeNote(msg.note);
  if (msg.log) appendLog(msg.log);
  if (done) {
    pending = pending.filter((op) => op.opId !== msg.opId);
    if (msg.status === 'error') toast(ERROR_TEXT[msg.error] || 'Ход отклонён');
    if (msg.status === 'conflict') noteConflict(msg);
  }
  saveSession();
  render();
  flushPending();
}

function onMessage(msg) {
  if (msg.type === 'result') onResult(msg);
  else if (msg.type === 'board') {
    if (msg.board) serverBoard = msg.board;
    takeNote(msg.note);
    if (msg.players) {
      serverPlayers = msg.players;
      const me = msg.players.find((player) => player.id === clientId);
      if (me) serverYou = me;
    }
    if (msg.log) appendLog(msg.log);
    saveSession();
    render();
    flushPending();
  } else if (msg.type === 'presence') {
    serverPlayers = msg.players || serverPlayers;
    const me = serverPlayers.find((player) => player.id === clientId);
    if (me) serverYou = me;
    saveSession();
    render();
  } else if (msg.type === 'error') {
    shouldReconnect = false;
    inGame = false;
    document.documentElement.dataset.screen = 'lobby';
    lobbyError.textContent = ERROR_TEXT[msg.error] || 'Не удалось войти';
  }
}

function connect() {
  if (!inGame || browserOffline) return;
  if (socket && (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN)) return;
  setStatus('connecting');
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const current = new WebSocket(`${proto}//${location.host}/ws`);
  socket = current;
  welcomed = false;
  const buffer = [];
  current.onopen = () => {
    if (socket !== current) return;
    online = true;
    attempt = 0;
    current.send(JSON.stringify({
      type: 'hello', clientId, name, room, pending: pending.map(publicOp),
    }));
  };
  current.onmessage = (event) => {
    if (socket !== current) return;
    let msg;
    try { msg = JSON.parse(event.data); } catch (error) { return; }
    if (!welcomed) {
      if (msg.type === 'welcome') {
        onWelcome(msg);
        buffer.splice(0).forEach(onMessage);
      } else if (msg.type === 'error') onMessage(msg);
      else buffer.push(msg);
      return;
    }
    onMessage(msg);
  };
  current.onclose = () => {
    if (socket !== current) return;
    online = false;
    welcomed = false;
    for (const op of pending) op.sent = false;
    if (!inGame || !shouldReconnect) return;
    setStatus('offline');
    saveSession();
    render();
    if (browserOffline || navigator.onLine === false) return;
    const delay = Math.min(8000, 400 * 2 ** attempt);
    attempt += 1;
    setTimeout(connect, delay);
  };
}

function viewPosition() {
  if (!serverBoard) return null;
  const pos = Chess.fromPublic(serverBoard);
  for (const op of pending) {
    if (op.kind !== 'move') continue;
    const move = Chess.findMove(pos, op);
    if (move) Chess.commit(pos, move);
  }
  return pos;
}

function sideLabel(color) {
  return color === 'w' ? 'белых' : 'чёрных';
}

function statusSentence(pos) {
  if (!pos) return 'Ждём доску.';
  if (pos.status === 'checkmate') return `Мат. Победили ${pos.winner === 'w' ? 'белые' : 'чёрные'}.`;
  if (pos.status === 'stalemate') return 'Пат. Ничья.';
  if (pos.status === 'resign') return `Сдача. Победили ${pos.winner === 'w' ? 'белые' : 'чёрные'}.`;
  const turn = pos.turn === 'w' ? 'Ход белых' : 'Ход чёрных';
  if (!mySeat()) return `${turn}. Вы наблюдаете.`;
  if (pos.check) return `${turn}, шах.`;
  return mySeat() === pos.turn ? `${turn} — ваш ход.` : `${turn}.`;
}

function render() {
  if (!inGame) return;
  const pos = viewPosition();
  const orientation = mySeat() === 'b' ? 'b' : 'w';
  const files = orientation === 'b' ? [7, 6, 5, 4, 3, 2, 1, 0] : [0, 1, 2, 3, 4, 5, 6, 7];
  const ranks = orientation === 'b' ? [0, 1, 2, 3, 4, 5, 6, 7] : [7, 6, 5, 4, 3, 2, 1, 0];
  const moves = pos && pos.status === 'play' ? Chess.legalMoves(pos) : [];
  const mine = selected ? moves.filter((move) => Chess.square(move.fromFile, move.fromRank) === selected && (!mySeat() || pos.turn === mySeat())) : [];

  boardWrap.replaceChildren();
  const rankBox = document.createElement('div');
  rankBox.className = 'ranks';
  for (const rank of ranks) {
    const span = document.createElement('span');
    span.textContent = String(rank + 1);
    rankBox.appendChild(span);
  }
  const board = document.createElement('div');
  board.className = 'board';
  const fileBox = document.createElement('div');
  fileBox.className = 'files';
  for (const file of files) {
    const span = document.createElement('span');
    span.textContent = Chess.FILES[file];
    fileBox.appendChild(span);
  }
  for (const rank of ranks) {
    for (const file of files) {
      const id = Chess.square(file, rank);
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `sq ${(file + rank) % 2 === 0 ? 'dark' : 'light'}`;
      button.dataset.sq = id;
      const piece = pos && Chess.pieceAt(pos, file, rank);
      if (pos?.last && (pos.last.from === id || pos.last.to === id)) button.classList.add('last');
      if (selected === id) button.classList.add('selected');
      const target = mine.find((move) => Chess.square(move.toFile, move.toRank) === id);
      if (target) {
        const mark = document.createElement('span');
        mark.className = piece ? 'ring' : 'dot';
        button.appendChild(mark);
      }
      if (piece) {
        const glyph = document.createElement('span');
        glyph.className = `piece ${piece.color}`;
        glyph.textContent = GLYPH[piece.type];
        button.appendChild(glyph);
        button.setAttribute('aria-label', `${id}, ${Chess.PIECE_NAME[piece.type]}`);
      } else button.setAttribute('aria-label', id);
      board.appendChild(button);
    }
  }
  boardWrap.append(rankBox, board, fileBox);

  roomLabel.textContent = room;
  queueEl.textContent = pending.length ? `Ждёт подтверждения: ${pending.length}` : '';
  turnTitle.textContent = mySeat() === 'w' ? 'Вы играете белыми' : mySeat() === 'b' ? 'Вы играете чёрными' : 'Вы наблюдаете';
  turnLine.textContent = statusSentence(pos);

  const whiteBusy = serverPlayers.some((player) => player.seat === 'w' && player.id !== clientId);
  const blackBusy = serverPlayers.some((player) => player.seat === 'b' && player.id !== clientId);
  $('seat-white').disabled = whiteBusy || mySeat() === 'w';
  $('seat-black').disabled = blackBusy || mySeat() === 'b';
  $('resign').disabled = !mySeat() || !pos || pos.status !== 'play';

  playersEl.replaceChildren();
  for (const player of serverPlayers) {
    const li = document.createElement('li');
    const seat = player.seat === 'w' ? 'белые' : player.seat === 'b' ? 'чёрные' : 'смотрит';
    li.textContent = `${player.name} — ${seat}${player.connected ? '' : ', не в сети'}`;
    playersEl.appendChild(li);
  }
  if (!serverPlayers.length) {
    const li = document.createElement('li');
    li.textContent = 'Пока никого.';
    playersEl.appendChild(li);
  }

  movesEl.replaceChildren();
  const history = serverBoard?.history || [];
  if (!history.length) {
    const li = document.createElement('li');
    li.textContent = 'Ходов ещё нет.';
    movesEl.appendChild(li);
  }
  for (let i = 0; i < history.length; i += 2) {
    const li = document.createElement('li');
    const no = Math.floor(i / 2) + 1;
    li.textContent = `${no}. ${history[i].san}${history[i + 1] ? ` ${history[i + 1].san}` : ''}`;
    movesEl.appendChild(li);
  }

  logEl.replaceChildren();
  const lines = log.slice(-8).reverse();
  for (const entry of lines) {
    const li = document.createElement('li');
    li.textContent = entry.text;
    logEl.appendChild(li);
  }
  syncNote();
}

function queuedNote() {
  for (let i = pending.length - 1; i >= 0; i -= 1) {
    if (pending[i].kind === 'note') return pending[i];
  }
  return null;
}

function syncNote() {
  const queued = queuedNote();
  if (document.activeElement !== noteInput) {
    const next = queued ? queued.text : (serverNote?.text || '');
    if (noteInput.value !== next) noteInput.value = next;
  }
  if (queued) noteMeta.textContent = 'Запись ещё не подтверждена';
  else if (serverNote?.byName) noteMeta.textContent = `Последняя запись: ${serverNote.byName}`;
  else noteMeta.textContent = 'Пока пусто. Текст виден всем в партии.';
  const current = noteInput.value.replace(/\r\n/g, '\n');
  const target = queued ? queued.text : (serverNote?.text || '');
  noteSave.disabled = current === target;
}

function pieceOn(pos, square) {
  const at = Chess.parseSquare(square);
  return at ? Chess.pieceAt(pos, at.file, at.rank) : null;
}

function chooseSquare(square) {
  if (!serverYou || !mySeat() || !modal.hidden || !promo.hidden) return;
  const pos = viewPosition();
  if (!pos || pos.status !== 'play') return;
  const piece = pieceOn(pos, square);
  const moves = Chess.legalMoves(pos).filter((move) => !mySeat() || pos.turn === mySeat());
  if (selected) {
    const choices = moves.filter((move) => Chess.square(move.fromFile, move.fromRank) === selected
      && Chess.square(move.toFile, move.toRank) === square);
    if (choices.length) {
      if (choices.length > 1 || choices[0].promotion) openPromo(choices);
      else sendMove(choices[0]);
      return;
    }
  }
  if (piece && piece.color === pos.turn && (!mySeat() || piece.color === mySeat())) {
    selected = square;
    render();
    return;
  }
  selected = null;
  render();
}

function sendMove(move) {
  const from = Chess.square(move.fromFile, move.fromRank);
  const serverPiece = (serverBoard?.pieces || []).find((item) => item.id === move.pieceId);
  const pieceVersion = serverPiece ? serverPiece.version : 0;
  selected = null;
  promoMove = null;
  promo.hidden = true;
  commit({
    kind: 'move',
    pieceId: move.pieceId,
    from,
    to: Chess.square(move.toFile, move.toRank),
    promotion: move.promotion,
    base: { position: serverBoard ? serverBoard.version : 0, piece: pieceVersion },
  });
}

function openPromo(choices) {
  promoMove = choices;
  promoChoices.replaceChildren();
  const titles = { q: 'ферзь', r: 'ладья', b: 'слон', n: 'конь' };
  for (const move of choices) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = GLYPH[move.promotion];
    button.title = titles[move.promotion];
    button.addEventListener('click', () => sendMove(move));
    promoChoices.appendChild(button);
  }
  promo.hidden = false;
}

function showConflict() {
  const current = conflictQueue[0];
  if (!current) {
    modal.hidden = true;
    openConflictId = null;
    return;
  }
  if (openConflictId === current.opId) return;
  openConflictId = current.opId;
  modalBody.replaceChildren();
  if (current.kind === 'note') {
    modalKicker.textContent = 'конфликт записки';
    modalTitle.textContent = 'Записку уже изменили';
    const yoursLabel = document.createElement('p');
    yoursLabel.textContent = 'Ваш текст';
    const yours = document.createElement('pre');
    yours.textContent = current.yours || 'пусто';
    const serverLabel = document.createElement('p');
    serverLabel.textContent = `Текст на сервере (${current.serverBy})`;
    const serverText = document.createElement('pre');
    serverText.textContent = current.server || 'пусто';
    const block = document.createElement('div');
    block.className = 'note-compare';
    block.append(yoursLabel, yours, serverLabel, serverText);
    modalBody.appendChild(block);
    modalKeep.textContent = 'Оставить текст на сервере';
    modalReplay.textContent = 'Записать мой текст';
  } else {
    modalKicker.textContent = 'конфликт ходов';
    modalTitle.textContent = 'Доска уже изменилась';
    const lead = document.createElement('p');
    lead.textContent = current.canReplay
      ? `Пока вы ходили (${current.yours}), ${current.serverBy} уже сделал ${current.server}. Ваш ход ещё возможен.`
      : `${current.label}: ход «${current.yours}» уже невозможен. На доске ${current.server} (${current.serverBy}).`;
    modalBody.appendChild(lead);
    modalKeep.textContent = 'Оставить ход на сервере';
    modalReplay.textContent = 'Повторить мой ход';
  }
  modalReplay.hidden = !current.canReplay;
  modal.hidden = false;
}

function keepServer() {
  const current = conflictQueue.shift();
  openConflictId = null;
  if (current?.kind === 'note') noteInput.value = serverNote?.text || '';
  saveSession();
  modal.hidden = true;
  showConflict();
  render();
}

function replayMove() {
  const current = conflictQueue.shift();
  openConflictId = null;
  modal.hidden = true;
  if (current?.kind === 'note' && current.replay) {
    noteInput.value = current.replay.text || '';
    commit({
      kind: 'note',
      text: current.replay.text || '',
      base: { version: current.version },
    });
  } else if (current?.replay) {
    commit({
      kind: 'move',
      ...current.replay,
      base: { position: current.position, piece: current.piece },
    });
  }
  showConflict();
}

function joinGame(event) {
  event.preventDefault();
  lobbyError.textContent = '';
  const nextName = nameInput.value.replace(/\s+/g, ' ').trim();
  const code = cleanRoom(roomInput.value);
  if (nextName.length < 2) {
    lobbyError.textContent = 'Имя — хотя бы 2 символа';
    return;
  }
  if (code.length < 2) {
    lobbyError.textContent = 'Нужен код партии из букв или цифр';
    return;
  }
  name = nextName;
  room = code;
  localStorage.setItem(PROFILE_KEY, JSON.stringify({ name }));
  inGame = true;
  shouldReconnect = true;
  pending = [];
  conflictQueue = [];
  serverBoard = null;
  serverNote = { text: '', version: 0, byName: null };
  serverPlayers = [];
  serverYou = null;
  log = [];
  seenSeq = new Set();
  selected = null;
  document.documentElement.dataset.screen = 'game';
  history.replaceState(null, '', `/?room=${encodeURIComponent(room)}`);
  saveSession();
  render();
  connect();
}

function leaveGame() {
  shouldReconnect = false;
  inGame = false;
  pending = [];
  conflictQueue = [];
  if (socket) socket.close();
  socket = null;
  localStorage.removeItem(SESSION_KEY);
  document.documentElement.dataset.screen = 'lobby';
  modal.hidden = true;
  promo.hidden = true;
}

function boot() {
  clientId = clientIdOf();
  const profile = readJson(PROFILE_KEY);
  if (profile?.name) nameInput.value = profile.name;
  const params = new URLSearchParams(location.search);
  const session = readJson(SESSION_KEY);
  roomInput.value = params.get('room') || suggestRoom();
  if (!(session?.inGame && session.snapshot?.board)) return;
  name = session.name || name;
  room = session.room || room;
  pending = Array.isArray(session.pending) ? session.pending : [];
  conflictQueue = Array.isArray(session.conflicts) ? session.conflicts : [];
  serverYou = session.snapshot.you || null;
  serverPlayers = session.snapshot.players || [];
  serverBoard = session.snapshot.board;
  serverNote = session.snapshot.note || serverNote;
  log = session.snapshot.log || [];
  seenSeq = new Set(log.map((entry) => entry.seq));
  inGame = true;
  shouldReconnect = true;
  document.documentElement.dataset.screen = 'game';
  if (nameInput.value.trim().length < 2) nameInput.value = name;
  render();
  showConflict();
  connect();
}

joinForm.addEventListener('submit', joinGame);
$('random-room').addEventListener('click', () => { roomInput.value = suggestRoom(); });
$('copy-link').addEventListener('click', async () => {
  const link = `${location.origin}/?room=${encodeURIComponent(room)}`;
  try {
    await navigator.clipboard.writeText(link);
    toast('Ссылка на партию скопирована');
  } catch (error) {
    toast(link);
  }
});
$('leave').addEventListener('click', leaveGame);
$('seat-white').addEventListener('click', () => commit({ kind: 'seat', seat: 'w' }));
$('seat-black').addEventListener('click', () => commit({ kind: 'seat', seat: 'b' }));
$('resign').addEventListener('click', () => commit({ kind: 'resign' }));
$('modal-keep').addEventListener('click', keepServer);
modalReplay.addEventListener('click', replayMove);
function saveNote() {
  const text = noteInput.value.replace(/\r\n/g, '\n').slice(0, 500);
  noteInput.value = text;
  const waiting = [...pending].reverse().find((op) => op.kind === 'note' && !op.sent);
  if (waiting) {
    waiting.text = text;
    waiting.base = { version: serverNote ? serverNote.version : 0 };
    saveSession();
    render();
    flushPending();
    return;
  }
  if (text === (serverNote?.text || '')) return;
  commit({ kind: 'note', text, base: { version: serverNote ? serverNote.version : 0 } });
}

noteInput.addEventListener('input', syncNote);
noteSave.addEventListener('click', saveNote);
boardWrap.addEventListener('click', (event) => {
  const square = event.target.closest('.sq');
  if (square) chooseSquare(square.dataset.sq);
});
window.addEventListener('offline', () => {
  browserOffline = true;
  if (!inGame) return;
  if (socket && socket.readyState < WebSocket.CLOSING) socket.close();
  else {
    online = false;
    welcomed = false;
    setStatus('offline');
    saveSession();
  }
});
window.addEventListener('online', () => {
  browserOffline = false;
  if (inGame && shouldReconnect) connect();
});
window.addEventListener('beforeunload', saveSession);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') saveSession();
});
setInterval(() => {
  if (socket && socket.readyState === WebSocket.OPEN) send({ type: 'ping' });
}, 4000);

boot();
