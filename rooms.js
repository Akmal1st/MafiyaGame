// Room state and rules, independent of the network layer so it can be unit-tested.
const crypto = require("crypto");
const { deal, isMafia, MIN_PLAYERS } = require("./public/roles.js");

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O, 1/I
const CODE_LEN = 5;
const MAX_PLAYERS = 30;
const MAX_NAME = 20;
const MAX_ROOMS = 2000;
const ROOM_TTL_MS = 6 * 60 * 60 * 1000; // idle rooms are removed after 6 hours

class GameError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

const token = () => crypto.randomBytes(18).toString("base64url");

function randomCode() {
  let s = "";
  const bytes = crypto.randomBytes(CODE_LEN);
  for (let i = 0; i < CODE_LEN; i++) s += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return s;
}

function cleanName(raw) {
  if (typeof raw !== "string") return "";
  // collapse whitespace, strip control characters
  return raw.replace(/[\u0000-\u001f\u007f]/g, "").replace(/\s+/g, " ").trim().slice(0, MAX_NAME);
}

function normCode(raw) {
  return typeof raw === "string" ? raw.trim().toUpperCase() : "";
}

class RoomStore {
  constructor({ now = () => Date.now(), rnd } = {}) {
    this.rooms = new Map();
    this.now = now;
    this.rnd = rnd;
  }

  create() {
    if (this.rooms.size >= MAX_ROOMS) this.sweep();
    if (this.rooms.size >= MAX_ROOMS) throw new GameError("busy", "Сервер перегружен, попробуйте позже");
    let code;
    do code = randomCode(); while (this.rooms.has(code));
    const room = {
      code,
      hostToken: token(),
      hostConnected: true,
      players: [], // {id, token, name, connected}
      started: false,
      roles: {}, // playerId -> role key
      game: { stage: "lobby", round: 0, dead: {}, winner: "" },
      nextId: 1,
      touched: this.now()
    };
    this.rooms.set(code, room);
    return room;
  }

  get(code) {
    const room = this.rooms.get(normCode(code));
    if (!room) throw new GameError("no_room", "Комната не найдена. Проверьте ссылку.");
    room.touched = this.now();
    return room;
  }

  checkHost(room, hostToken) {
    if (!hostToken || hostToken !== room.hostToken) throw new GameError("not_host", "Только ведущий может это сделать");
  }

  join(code, rawName) {
    const room = this.get(code);
    const name = cleanName(rawName);
    if (!name) throw new GameError("bad_name", "Введите имя");
    if (room.started) throw new GameError("started", "Игра уже началась. Дождитесь следующей.");
    if (room.players.length >= MAX_PLAYERS) throw new GameError("full", "Комната заполнена");
    if (room.players.some(p => p.name.toLowerCase() === name.toLowerCase()))
      throw new GameError("name_taken", "Это имя уже занято — добавьте фамилию или цифру");
    const player = { id: room.nextId++, token: token(), name, connected: true };
    room.players.push(player);
    return { room, player };
  }

  findPlayer(room, playerToken) {
    const p = room.players.find(x => x.token === playerToken);
    if (!p) throw new GameError("no_player", "Вы не в этой комнате");
    return p;
  }

  remove(room, playerId) {
    if (room.started) throw new GameError("started", "Нельзя убрать игрока во время игры — отметьте его выбывшим");
    const i = room.players.findIndex(p => p.id === playerId);
    if (i < 0) return null;
    return room.players.splice(i, 1)[0];
  }

  start(room) {
    const N = room.players.length;
    if (N < MIN_PLAYERS) throw new GameError("few", `Нужно минимум ${MIN_PLAYERS} игроков`);
    const roles = deal(N, this.rnd);
    room.roles = {};
    room.players.forEach((p, i) => { room.roles[p.id] = roles[i]; });
    room.started = true;
    room.game = { stage: "night", round: 1, dead: {}, winner: "" };
  }

  // Back to the lobby with the same players; new people may join again.
  reset(room) {
    room.started = false;
    room.roles = {};
    room.game = { stage: "lobby", round: 0, dead: {}, winner: "" };
  }

  // The host's device runs the game; it pushes the public part here for everyone to see.
  updateGame(room, g) {
    if (!room.started || !g || typeof g !== "object") return;
    const ids = new Set(room.players.map(p => p.id));
    const dead = {};
    if (Array.isArray(g.dead)) g.dead.forEach(id => { if (ids.has(id)) dead[id] = true; });
    room.game = {
      stage: g.stage === "day" ? "day" : "night",
      round: Number.isInteger(g.round) && g.round > 0 && g.round < 1000 ? g.round : room.game.round,
      dead,
      winner: typeof g.winner === "string" ? g.winner.slice(0, 80) : ""
    };
  }

  // What every participant may see.
  publicState(room) {
    return {
      code: room.code,
      started: room.started,
      hostConnected: room.hostConnected,
      minPlayers: MIN_PLAYERS,
      players: room.players.map(p => ({ id: p.id, name: p.name, connected: p.connected, dead: !!room.game.dead[p.id] })),
      game: { stage: room.game.stage, round: room.game.round, winner: room.game.winner }
    };
  }

  // What only this player may see: their role and who they know.
  secretFor(room, playerId) {
    const role = room.roles[playerId];
    if (!role) return null;
    const others = k => room.players.filter(p => p.id !== playerId && k(room.roles[p.id]));
    const out = { role, team: [], knows: [] };
    if (isMafia(role)) out.team = others(isMafia).map(p => ({ name: p.name, role: room.roles[p.id] }));
    if (role === "ast") out.knows = others(r => r === "det").map(p => ({ name: p.name, role: "det" }));
    if (role === "nurse") out.knows = others(r => r === "doc").map(p => ({ name: p.name, role: "doc" }));
    return out;
  }

  // Host sees everyone's role.
  hostView(room) {
    return {
      ...this.publicState(room),
      roles: room.started ? room.players.map(p => ({ id: p.id, name: p.name, role: room.roles[p.id] })) : []
    };
  }

  sweep() {
    const t = this.now();
    for (const [code, room] of this.rooms) if (t - room.touched > ROOM_TTL_MS) this.rooms.delete(code);
  }
}

module.exports = { RoomStore, GameError, cleanName, MAX_PLAYERS, MAX_NAME, ROOM_TTL_MS };
