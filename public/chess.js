'use strict';

// Правила шахмат: генерация ходов, шах, мат, рокировка, взятие на проходе, превращение.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Chess = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const FILES = 'abcdefgh';
  const PROMOTE = ['q', 'r', 'b', 'n'];
  const PIECE_NAME = {
    k: 'король', q: 'ферзь', r: 'ладья', b: 'слон', n: 'конь', p: 'пешка',
  };

  function square(file, rank) {
    return FILES[file] + (rank + 1);
  }

  function parseSquare(value) {
    const text = String(value || '');
    if (!/^[a-h][1-8]$/.test(text)) return null;
    return { file: FILES.indexOf(text[0]), rank: Number(text[1]) - 1 };
  }

  function onBoard(file, rank) {
    return file >= 0 && file < 8 && rank >= 0 && rank < 8;
  }

  function pieceAt(pos, file, rank) {
    for (const piece of Object.values(pos.pieces)) {
      if (piece.alive && piece.file === file && piece.rank === rank) return piece;
    }
    return null;
  }

  function findKing(pos, color) {
    return Object.values(pos.pieces).find((piece) => piece.alive && piece.color === color && piece.type === 'k') || null;
  }

  function suffix(type, file) {
    if (type === 'k' || type === 'q') return '';
    return file === 0 ? 'a' : file === 7 ? 'h' : FILES[file];
  }

  function initialPosition() {
    const pieces = {};
    const back = ['r', 'n', 'b', 'q', 'k', 'b', 'n', 'r'];
    function add(color, type, file, rank, idSuffix) {
      const id = `${color}${type}${idSuffix}`;
      pieces[id] = { id, color, type, file, rank, alive: true, version: 0 };
    }
    back.forEach((type, file) => {
      const idSuffix = suffix(type, file);
      add('w', type, file, 0, idSuffix);
      add('b', type, file, 7, idSuffix);
    });
    for (let file = 0; file < 8; file += 1) {
      add('w', 'p', file, 1, FILES[file]);
      add('b', 'p', file, 6, FILES[file]);
    }
    return {
      pieces,
      turn: 'w',
      version: 0,
      castling: { wK: true, wQ: true, bK: true, bQ: true },
      ep: null,
      status: 'play',
      winner: null,
      check: false,
      last: null,
    };
  }

  function clone(pos) {
    return structuredClone(pos);
  }

  function opponent(color) {
    return color === 'w' ? 'b' : 'w';
  }

  function isAttacked(pos, file, rank, byColor) {
    const pawnDir = byColor === 'w' ? 1 : -1;
    for (const piece of Object.values(pos.pieces)) {
      if (!piece.alive || piece.color !== byColor) continue;
      const df = file - piece.file;
      const dr = rank - piece.rank;
      if (piece.type === 'p') {
        if (dr === pawnDir && Math.abs(df) === 1) return true;
      } else if (piece.type === 'n') {
        if ((Math.abs(df) === 1 && Math.abs(dr) === 2) || (Math.abs(df) === 2 && Math.abs(dr) === 1)) return true;
      } else if (piece.type === 'k') {
        if (Math.max(Math.abs(df), Math.abs(dr)) === 1) return true;
      } else if (piece.type === 'b' || piece.type === 'r' || piece.type === 'q') {
        const bishop = df !== 0 && Math.abs(df) === Math.abs(dr);
        const rook = df === 0 || dr === 0;
        const slides = (piece.type === 'b' && bishop) || (piece.type === 'r' && rook && (df !== 0 || dr !== 0))
          || (piece.type === 'q' && (bishop || (rook && (df !== 0 || dr !== 0))));
        if (!slides) continue;
        const stepFile = Math.sign(df);
        const stepRank = Math.sign(dr);
        let f = piece.file + stepFile;
        let r = piece.rank + stepRank;
        let blocked = false;
        while (f !== file || r !== rank) {
          if (pieceAt(pos, f, r)) { blocked = true; break; }
          f += stepFile;
          r += stepRank;
        }
        if (!blocked) return true;
      }
    }
    return false;
  }

  function inCheck(pos, color) {
    const king = findKing(pos, color);
    if (!king) return false;
    return isAttacked(pos, king.file, king.rank, opponent(color));
  }

  function pathClear(pos, squares) {
    return squares.every(([file, rank]) => !pieceAt(pos, file, rank));
  }

  function pushPawn(list, piece, toFile, toRank, extra) {
    const move = {
      pieceId: piece.id,
      fromFile: piece.file,
      fromRank: piece.rank,
      toFile,
      toRank,
      promotion: null,
      enPassant: false,
      castle: null,
      setsEp: null,
      ...extra,
    };
    const lastRank = piece.color === 'w' ? 7 : 0;
    if (toRank === lastRank) {
      for (const promotion of PROMOTE) list.push({ ...move, promotion });
    } else list.push(move);
  }

  function pseudo(pos, color) {
    const list = [];
    const dir = color === 'w' ? 1 : -1;
    const startRank = color === 'w' ? 1 : 6;
    for (const piece of Object.values(pos.pieces)) {
      if (!piece.alive || piece.color !== color) continue;
      if (piece.type === 'p') {
        const one = piece.rank + dir;
        if (onBoard(piece.file, one) && !pieceAt(pos, piece.file, one)) {
          pushPawn(list, piece, piece.file, one, {});
          const two = piece.rank + dir * 2;
          if (piece.rank === startRank && !pieceAt(pos, piece.file, two)) {
            pushPawn(list, piece, piece.file, two, { setsEp: { file: piece.file, rank: one } });
          }
        }
        for (const df of [-1, 1]) {
          const file = piece.file + df;
          const rank = piece.rank + dir;
          if (!onBoard(file, rank)) continue;
          const target = pieceAt(pos, file, rank);
          if (target && target.color !== color) pushPawn(list, piece, file, rank, {});
          if (pos.ep && pos.ep.file === file && pos.ep.rank === rank) {
            pushPawn(list, piece, file, rank, { enPassant: true });
          }
        }
      } else if (piece.type === 'n' || piece.type === 'k') {
        const deltas = piece.type === 'n'
          ? [[1, 2], [2, 1], [-1, 2], [-2, 1], [1, -2], [2, -1], [-1, -2], [-2, -1]]
          : [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];
        for (const [df, dr] of deltas) {
          const file = piece.file + df;
          const rank = piece.rank + dr;
          if (!onBoard(file, rank)) continue;
          const target = pieceAt(pos, file, rank);
          if (target && target.color === color) continue;
          list.push({
            pieceId: piece.id, fromFile: piece.file, fromRank: piece.rank, toFile: file, toRank: rank,
            promotion: null, enPassant: false, castle: null, setsEp: null,
          });
        }
      } else {
        const rays = piece.type === 'b'
          ? [[1, 1], [1, -1], [-1, 1], [-1, -1]]
          : piece.type === 'r'
            ? [[1, 0], [-1, 0], [0, 1], [0, -1]]
            : [[1, 1], [1, -1], [-1, 1], [-1, -1], [1, 0], [-1, 0], [0, 1], [0, -1]];
        for (const [df, dr] of rays) {
          let file = piece.file + df;
          let rank = piece.rank + dr;
          while (onBoard(file, rank)) {
            const target = pieceAt(pos, file, rank);
            if (target && target.color === color) break;
            list.push({
              pieceId: piece.id, fromFile: piece.file, fromRank: piece.rank, toFile: file, toRank: rank,
              promotion: null, enPassant: false, castle: null, setsEp: null,
            });
            if (target) break;
            file += df;
            rank += dr;
          }
        }
      }
    }
    const king = findKing(pos, color);
    const home = color === 'w' ? 0 : 7;
    if (king && king.file === 4 && king.rank === home) {
      const side = color === 'w' ? 'w' : 'b';
      if (pos.castling[`${side}K`] && pathClear(pos, [[5, home], [6, home]])) {
        list.push({
          pieceId: king.id, fromFile: 4, fromRank: home, toFile: 6, toRank: home,
          promotion: null, enPassant: false, castle: 'K', setsEp: null,
        });
      }
      if (pos.castling[`${side}Q`] && pathClear(pos, [[1, home], [2, home], [3, home]])) {
        list.push({
          pieceId: king.id, fromFile: 4, fromRank: home, toFile: 2, toRank: home,
          promotion: null, enPassant: false, castle: 'Q', setsEp: null,
        });
      }
    }
    return list;
  }

  function clearCastling(pos, piece) {
    if (!piece) return;
    if (piece.type === 'k') {
      pos.castling[`${piece.color}K`] = false;
      pos.castling[`${piece.color}Q`] = false;
    }
    if (piece.id === 'wra') pos.castling.wQ = false;
    if (piece.id === 'wrh') pos.castling.wK = false;
    if (piece.id === 'bra') pos.castling.bQ = false;
    if (piece.id === 'brh') pos.castling.bK = false;
  }

  function execute(pos, move) {
    const piece = pos.pieces[move.pieceId];
    const captured = move.enPassant
      ? pieceAt(pos, move.toFile, move.fromRank)
      : pieceAt(pos, move.toFile, move.toRank);
    if (captured) {
      captured.alive = false;
      captured.version += 1;
      clearCastling(pos, captured);
    }
    clearCastling(pos, piece);
    if (move.castle === 'K') {
      const rook = pieceAt(pos, 7, piece.rank);
      rook.file = 5;
      rook.version += 1;
    } else if (move.castle === 'Q') {
      const rook = pieceAt(pos, 0, piece.rank);
      rook.file = 3;
      rook.version += 1;
    }
    piece.file = move.toFile;
    piece.rank = move.toRank;
    piece.version += 1;
    if (move.promotion) piece.type = move.promotion;
    pos.ep = move.setsEp ? { file: move.setsEp.file, rank: move.setsEp.rank } : null;
    pos.last = { from: square(move.fromFile, move.fromRank), to: square(move.toFile, move.toRank) };
    pos.turn = opponent(piece.color);
    pos.version += 1;
    return pos;
  }

  function castleSafe(pos, move) {
    if (!move.castle) return true;
    const color = pos.pieces[move.pieceId].color;
    const home = color === 'w' ? 0 : 7;
    const files = move.castle === 'K' ? [4, 5, 6] : [4, 3, 2];
    return files.every((file) => !isAttacked(pos, file, home, opponent(color)));
  }

  function kingSafeAfter(pos, move) {
    if (!castleSafe(pos, move)) return false;
    const color = pos.pieces[move.pieceId].color;
    const next = execute(clone(pos), move);
    const king = findKing(next, color);
    return Boolean(king) && !isAttacked(next, king.file, king.rank, opponent(color));
  }

  function legalMoves(pos) {
    if (pos.status !== 'play') return [];
    return pseudo(pos, pos.turn).filter((move) => kingSafeAfter(pos, move));
  }

  function isCapture(pos, move) {
    if (move.enPassant) return true;
    const target = pieceAt(pos, move.toFile, move.toRank);
    return Boolean(target);
  }

  function san(pos, move) {
    if (move.castle === 'K') return decorate(pos, move, 'O-O');
    if (move.castle === 'Q') return decorate(pos, move, 'O-O-O');
    const piece = pos.pieces[move.pieceId];
    const letter = piece.type === 'p' ? '' : piece.type.toUpperCase();
    const capture = isCapture(pos, move);
    const rivals = legalMoves(pos).filter((other) => {
      if (other.pieceId === move.pieceId) return false;
      const otherPiece = pos.pieces[other.pieceId];
      return otherPiece.type === piece.type
        && other.toFile === move.toFile
        && other.toRank === move.toRank
        && (other.promotion || null) === (move.promotion || null);
    });
    let disambiguation = '';
    if (rivals.length && piece.type !== 'p') {
      const fileFree = rivals.every((other) => other.fromFile !== move.fromFile);
      const rankFree = rivals.every((other) => other.fromRank !== move.fromRank);
      if (fileFree) disambiguation = FILES[move.fromFile];
      else if (rankFree) disambiguation = String(move.fromRank + 1);
      else disambiguation = FILES[move.fromFile] + (move.fromRank + 1);
    }
    const pawnFile = piece.type === 'p' && capture ? FILES[move.fromFile] : '';
    let text = `${letter}${pawnFile}${disambiguation}${capture ? 'x' : ''}${square(move.toFile, move.toRank)}`;
    if (move.promotion) text += `=${move.promotion.toUpperCase()}`;
    return decorate(pos, move, text);
  }

  function decorate(pos, move, text) {
    const next = execute(clone(pos), move);
    const side = next.turn;
    const mate = legalMoves(next).length === 0;
    const check = inCheck(next, side);
    if (mate && check) return `${text}#`;
    if (check) return `${text}+`;
    return text;
  }

  function commit(pos, move) {
    const notation = san(pos, move);
    execute(pos, move);
    const side = pos.turn;
    const moves = legalMoves(pos);
    pos.check = inCheck(pos, side);
    if (moves.length === 0) {
      pos.status = pos.check ? 'checkmate' : 'stalemate';
      pos.winner = pos.check ? opponent(side) : null;
    } else {
      pos.status = 'play';
      pos.winner = null;
    }
    return notation;
  }

  function sameMove(move, spec) {
    const from = parseSquare(spec.from);
    const to = parseSquare(spec.to);
    if (!from || !to) return false;
    return move.pieceId === spec.pieceId
      && move.fromFile === from.file
      && move.fromRank === from.rank
      && move.toFile === to.file
      && move.toRank === to.rank
      && (move.promotion || null) === (spec.promotion || null);
  }

  function findMove(pos, spec) {
    return legalMoves(pos).find((move) => sameMove(move, spec)) || null;
  }

  function pieceName(piece) {
    if (!piece) return 'фигура';
    return `${PIECE_NAME[piece.type]} ${square(piece.file, piece.rank)}`;
  }

  function describeMove(pos, spec) {
    const from = parseSquare(spec.from);
    const to = parseSquare(spec.to);
    const piece = pos.pieces[spec.pieceId];
    const name = piece ? PIECE_NAME[piece.type] : 'фигура';
    if (!from || !to) return name;
    const promo = spec.promotion ? `=${spec.promotion.toUpperCase()}` : '';
    return `${name} ${square(from.file, from.rank)}–${square(to.file, to.rank)}${promo}`;
  }

  function fromPublic(board) {
    const pos = {
      pieces: {},
      turn: board.turn,
      version: board.version,
      castling: { ...board.castling },
      ep: board.ep ? parseSquare(board.ep) : null,
      status: board.status || 'play',
      winner: board.winner || null,
      check: Boolean(board.check),
      last: board.last || null,
    };
    for (const piece of board.pieces || []) {
      const at = parseSquare(piece.square);
      if (!at) continue;
      pos.pieces[piece.id] = {
        id: piece.id,
        color: piece.color,
        type: piece.type,
        file: at.file,
        rank: at.rank,
        alive: true,
        version: piece.version,
      };
    }
    return pos;
  }

  function pubPieces(pos) {
    return Object.values(pos.pieces)
      .filter((piece) => piece.alive)
      .map((piece) => ({
        id: piece.id,
        color: piece.color,
        type: piece.type,
        square: square(piece.file, piece.rank),
        version: piece.version,
      }));
  }

  return {
    FILES,
    PIECE_NAME,
    PROMOTE,
    square,
    parseSquare,
    initialPosition,
    clone,
    legalMoves,
    findMove,
    commit,
    san,
    inCheck,
    pieceAt,
    pieceName,
    describeMove,
    pubPieces,
    fromPublic,
    opponent,
  };
});
