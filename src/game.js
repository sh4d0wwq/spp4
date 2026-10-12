'use strict';

// Комната шахматной партии: места за доской, ходы и конфликт устаревшей позиции.
const chess = require('../public/chess.js');

const WHITE = '#f3efe4';
const BLACK = '#2c241c';

function cleanPlayerName(value) {
  const name = String(value || '').replace(/\s+/g, ' ').trim().slice(0, 16);
  return name.length >= 2 ? name : null;
}

function cleanRoomCode(value) {
  const code = String(value || '')
    .trim()
    .toLocaleUpperCase('ru-RU')
    .replace(/[^0-9A-ZА-ЯЁ-]/g, '')
    .slice(0, 12);
  return code.length >= 2 ? code : null;
}

function cleanOpId(value) {
  const id = String(value || '');
  return /^[A-Za-z0-9_-]{4,80}$/.test(id) ? id : null;
}

function cleanClientId(value) {
  const id = String(value || '').toLowerCase();
  return /^[0-9a-f-]{8,40}$/.test(id) ? id : null;
}

function emptyNote() {
  return { text: '', version: 0, byName: null };
}

function createRoom(code) {
  return {
    code,
    position: chess.initialPosition(),
    note: emptyNote(),
    players: {},
    history: [],
    applied: [],
    appliedSet: {},
    log: [],
    seq: 0,
    lastByName: null,
  };
}

function pushLog(room, text) {
  room.seq += 1;
  const entry = { seq: room.seq, text, at: Date.now() };
  room.log.push(entry);
  if (room.log.length > 80) room.log.shift();
  return entry;
}

function seatOf(room, color) {
  return Object.values(room.players).find((player) => player.seat === color) || null;
}

function scoreOf() {
  return 0;
}

function pubPlayer(room, player) {
  return {
    id: player.id,
    name: player.name,
    seat: player.seat || null,
    connected: Boolean(player.connected),
    score: scoreOf(room, player.id),
  };
}

function pubPlayers(room) {
  return Object.values(room.players)
    .map((player) => pubPlayer(room, player))
    .sort((a, b) => (a.seat === 'w' ? -1 : a.seat === 'b' ? 0 : 1) - (b.seat === 'w' ? -1 : b.seat === 'b' ? 0 : 1)
      || a.name.localeCompare(b.name, 'ru'));
}

function pubNote(room) {
  const note = room.note || emptyNote();
  return { text: note.text || '', version: note.version || 0, byName: note.byName || null };
}

function pubBoard(room) {
  const pos = room.position;
  return {
    version: pos.version,
    turn: pos.turn,
    status: pos.status,
    winner: pos.winner,
    check: Boolean(pos.check),
    ep: pos.ep ? chess.square(pos.ep.file, pos.ep.rank) : null,
    castling: { ...pos.castling },
    last: pos.last ? { ...pos.last } : null,
    pieces: chess.pubPieces(pos),
    history: room.history.slice(-80),
  };
}

function joinPlayer(room, { id, name }) {
  const existing = room.players[id];
  if (existing) {
    existing.name = name;
    existing.connected = true;
    return existing;
  }
  const taken = new Set(Object.values(room.players).map((player) => player.seat).filter(Boolean));
  let seat = null;
  if (!taken.has('w')) seat = 'w';
  else if (!taken.has('b')) seat = 'b';
  const player = { id, name, seat, connected: true };
  room.players[id] = player;
  return player;
}

function remembered(room, opId) {
  return room.appliedSet[opId] || null;
}

function remember(room, opId, result) {
  if (!opId || room.appliedSet[opId]) return;
  room.appliedSet[opId] = result;
  room.applied.push(opId);
  while (room.applied.length > 2000) delete room.appliedSet[room.applied.shift()];
}

function fail(error) {
  return { status: 'error', error, conflict: null, board: null, log: null };
}

function sideName(color) {
  return color === 'w' ? 'Белые' : 'Чёрные';
}

function apply(room, player, op) {
  if (!op || typeof op !== 'object') return fail('bad_op');
  if (op.kind === 'move') return applyMove(room, player, op);
  if (op.kind === 'note') return applyNote(room, player, op);
  if (op.kind === 'seat') return applySeat(room, player, op);
  if (op.kind === 'resign') return applyResign(room, player);
  return fail('bad_op');
}

function cleanNoteText(value) {
  return String(value ?? '').replace(/\r\n/g, '\n').slice(0, 500);
}

function applyNote(room, player, op) {
  if (typeof op.text !== 'string' || typeof op.base?.version !== 'number') return fail('bad_op');
  if (!room.note) room.note = emptyNote();
  const text = cleanNoteText(op.text);
  const note = room.note;
  if (op.base.version !== note.version) {
    const log = pushLog(room, `${player.name}: записка разошлась с сервером`);
    return {
      status: 'conflict',
      error: null,
      conflict: {
        kind: 'note',
        policy: 'choose',
        label: 'Записка',
        yours: text,
        server: note.text,
        serverBy: note.byName || 'соперник',
        canReplay: true,
        replay: { text },
        version: note.version,
      },
      board: pubBoard(room),
      note: pubNote(room),
      log,
    };
  }
  const changed = text !== note.text;
  if (changed) room.note = { text, version: note.version + 1, byName: player.name };
  const log = changed
    ? pushLog(room, text ? `Записка обновлена (${player.name})` : `Записка очищена (${player.name})`)
    : null;
  return { status: 'applied', error: null, conflict: null, board: pubBoard(room), note: pubNote(room), log };
}

function promotionOf(value) {
  if (value == null || value === '') return null;
  const text = String(value).toLowerCase();
  return chess.PROMOTE.includes(text) ? text : undefined;
}

function applyMove(room, player, op) {
  const from = chess.parseSquare(op.from);
  const to = chess.parseSquare(op.to);
  const promotion = promotionOf(op.promotion);
  if (!from || !to || promotion === undefined || typeof op.pieceId !== 'string') return fail('bad_op');
  if (typeof op.base?.position !== 'number' || typeof op.base?.piece !== 'number') return fail('bad_op');

  const pos = room.position;
  const piece = pos.pieces[op.pieceId];
  if (!piece) return fail('bad_op');
  const spec = { pieceId: op.pieceId, from: op.from, to: op.to, promotion };
  const stale = pos.version !== op.base.position || !piece.alive || piece.version !== op.base.piece
    || chess.square(piece.file, piece.rank) !== op.from;

  if (stale) {
    const replay = piece.alive ? chess.findMove(pos, spec) : null;
    const log = pushLog(room, `${player.name} не успел: ${chess.describeMove(pos, spec)}`);
    return {
      status: 'conflict',
      error: null,
      conflict: {
        policy: replay ? 'choose' : 'reject',
        pieceId: piece.id,
        label: chess.pieceName(piece.alive ? piece : { ...piece, file: from.file, rank: from.rank }),
        yours: chess.describeMove(pos, spec),
        server: room.history.length ? room.history[room.history.length - 1].san : 'начальная позиция',
        serverBy: room.lastByName || 'соперник',
        canReplay: Boolean(replay),
        replay: replay ? { pieceId: spec.pieceId, from: spec.from, to: spec.to, promotion: spec.promotion } : null,
        position: pos.version,
        piece: piece.alive ? piece.version : op.base.piece,
      },
      board: pubBoard(room),
      log,
    };
  }

  if (!player.seat) return fail('spectator');
  if (player.seat !== piece.color) return fail('not_your_piece');
  if (pos.status !== 'play') return fail('game_over');
  if (pos.turn !== player.seat) return fail('not_your_turn');

  const move = chess.findMove(pos, spec);
  if (!move) return fail(spec.promotion == null && needsPromotion(piece, to.rank) ? 'promotion' : 'illegal');

  const notation = chess.commit(pos, move);
  room.lastByName = player.name;
  room.history.push({ san: notation, color: piece.color, byName: player.name });
  if (room.history.length > 200) room.history.shift();
  const mark = pos.status === 'checkmate' ? ' — мат' : pos.status === 'stalemate' ? ' — пат' : '';
  const log = pushLog(room, `${sideName(piece.color)}: ${notation}${mark}`);
  return { status: 'applied', error: null, conflict: null, board: pubBoard(room), log };
}

function needsPromotion(piece, rank) {
  if (piece.type !== 'p') return false;
  return piece.color === 'w' ? rank === 7 : rank === 0;
}

function applySeat(room, player, op) {
  const seat = op.seat == null || op.seat === '' ? null : op.seat;
  if (seat !== null && seat !== 'w' && seat !== 'b') return fail('bad_op');
  if (seat) {
    const holder = seatOf(room, seat);
    if (holder && holder.id !== player.id) return fail('seat_taken');
  }
  if (player.seat && player.seat !== seat) {
    const other = player.seat;
    if (seatOf(room, other)?.id === player.id) player.seat = null;
  }
  player.seat = seat;
  const text = seat
    ? `${player.name} садится ${seat === 'w' ? 'белыми' : 'чёрными'}`
    : `${player.name} освобождает место`;
  const log = pushLog(room, text);
  return { status: 'applied', error: null, conflict: null, board: pubBoard(room), log };
}

function applyResign(room, player) {
  if (player.seat !== 'w' && player.seat !== 'b') return fail('spectator');
  if (room.position.status !== 'play') return fail('game_over');
  room.position.status = 'resign';
  room.position.winner = chess.opponent(player.seat);
  room.position.check = false;
  const log = pushLog(room, `${player.name} сдаётся. Победа ${sideName(room.position.winner).toLowerCase()}`);
  return { status: 'applied', error: null, conflict: null, board: pubBoard(room), log };
}

function serializeRoom(room) {
  const players = {};
  for (const [id, player] of Object.entries(room.players)) {
    players[id] = { id: player.id, name: player.name, seat: player.seat || null, connected: false };
  }
  return {
    code: room.code,
    position: room.position,
    note: room.note || emptyNote(),
    players,
    history: room.history,
    applied: room.applied,
    appliedSet: room.appliedSet,
    log: room.log,
    seq: room.seq,
    lastByName: room.lastByName,
  };
}

function hydrateRoom(raw) {
  if (!raw?.position?.pieces) return createRoom(raw.code || 'ПАРТИЯ');
  const room = createRoom(raw.code || 'ПАРТИЯ');
  room.position = raw.position;
  room.note = raw.note && typeof raw.note.text === 'string' ? {
    text: String(raw.note.text).slice(0, 500),
    version: Number(raw.note.version) || 0,
    byName: raw.note.byName || null,
  } : emptyNote();
  room.players = raw.players || {};
  room.history = Array.isArray(raw.history) ? raw.history : [];
  room.applied = Array.isArray(raw.applied) ? raw.applied : [];
  room.appliedSet = raw.appliedSet || {};
  room.log = Array.isArray(raw.log) ? raw.log : [];
  room.seq = raw.seq || 0;
  room.lastByName = raw.lastByName || null;
  for (const player of Object.values(room.players)) player.connected = false;
  return room;
}

module.exports = {
  WHITE,
  BLACK,
  chess,
  cleanPlayerName,
  cleanRoomCode,
  cleanOpId,
  cleanClientId,
  createRoom,
  joinPlayer,
  apply,
  remembered,
  remember,
  pubPlayer,
  pubPlayers,
  pubBoard,
  pubNote,
  serializeRoom,
  hydrateRoom,
};
