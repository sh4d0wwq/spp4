'use strict';

const fs = require('fs');
const path = require('path');
const game = require('./game');

function createStore(file) {
  const state = { version: 1, rooms: {} };

  function load() {
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }
    state.version = 1;
    state.rooms = {};
    for (const [code, room] of Object.entries(raw.rooms || {})) {
      state.rooms[code] = game.hydrateRoom({ ...room, code: room.code || code });
    }
  }

  function snapshot() {
    return JSON.stringify({
      version: 1,
      rooms: Object.fromEntries(
        Object.entries(state.rooms).map(([code, room]) => [code, game.serializeRoom(room)]),
      ),
    }, null, 2);
  }

  function saveNow() {
    const dir = path.dirname(file);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, snapshot());
    try {
      if (fs.existsSync(file)) fs.rmSync(file);
      fs.renameSync(tmp, file);
    } catch (error) {
      fs.copyFileSync(tmp, file);
      fs.rmSync(tmp, { force: true });
    }
  }

  let timer = null;
  function scheduleSave() {
    clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      try {
        saveNow();
      } catch (error) {
        console.error('Не удалось сохранить состояние:', error.message);
      }
    }, 200);
    if (timer.unref) timer.unref();
  }

  function flush() {
    clearTimeout(timer);
    timer = null;
    saveNow();
  }

  return { state, load, saveNow, scheduleSave, flush };
}

module.exports = { createStore };
