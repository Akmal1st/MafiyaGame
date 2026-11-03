// Room state and rules. Runs in the host's browser (window.MafiaRoom) and in Node for tests.
(function (root) {
const { deal, isMafia, MIN_PLAYERS } = typeof module !== "undefined" && module.exports ? require("./roles.js") : root.MafiaRoles;
const randomBytes = n => globalThis.crypto.getRandomValues(new Uint8Array(n));

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O, 1/I
const CODE_LEN = 5;
const MAX_PLAYERS = 30;
const MAX_NAME = 20;
const MAX_ROOMS = 2000;
const ROOM_TTL_MS = 6 * 60 * 60 * 1000; // idle rooms are removed after 6 hours

const BOT_NAMES = ["Aziz", "Dilnoza", "Jasur", "Malika", "Bobur", "Nilufar", "Sardor", "Zarina", "Timur", "Lola",
  "Rustam", "Kamola", "Otabek", "Sevara", "Farrux", "Gulnora", "Shoxrux", "Madina", "Ulug'bek", "Nodira"];

class GameError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

const token = () => Array.from(randomBytes(18), b => b.toString(16).padStart(2, "0")).join("");

function randomCode() {
  let s = "";
  const bytes = randomBytes(CODE_LEN);
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

// Per-game state for phone actions.
function clearPlay(room) {
  room.picks = {};        // playerId -> {kind: targetId}; cleared each night/day
  room.notes = {};        // playerId -> [private results]
  room.selfHealUsed = {}; // healer id -> true once they healed themselves
  room.lastBlock = null;  // last night's mistress target (can't repeat)
  room.lastVotes = {};    // voterId -> targetId from the previous day (bots use it as a clue)
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
      picks: {}, notes: {}, selfHealUsed: {}, lastBlock: null, lastVotes: {},
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

  // Bots are players run by the host's browser (see bots.js).
  addBot(room) {
    if (room.started) throw new GameError("started", "Игра уже началась");
    if (room.players.length >= MAX_PLAYERS) throw new GameError("full", "Комната заполнена");
    const taken = new Set(room.players.map(p => p.name.toLowerCase()));
    let name = BOT_NAMES.map(n => "🤖 " + n).find(n => !taken.has(n.toLowerCase()));
    for (let i = 2; !name; i++) name = BOT_NAMES.map(n => `🤖 ${n} ${i}`).find(n => !taken.has(n.toLowerCase()));
    const player = { id: room.nextId++, token: token(), name, connected: true, bot: true };
    room.players.push(player);
    return player;
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
    clearPlay(room);
  }

  // Back to the lobby with the same players; new people may join again.
  reset(room) {
    room.started = false;
    room.roles = {};
    room.game = { stage: "lobby", round: 0, dead: {}, winner: "" };
    clearPlay(room);
  }

  // The host's device runs the game; it pushes the public part here for everyone to see.
  updateGame(room, g) {
    if (!room.started || !g || typeof g !== "object") return;
    const ids = new Set(room.players.map(p => p.id));
    const dead = {};
    if (Array.isArray(g.dead)) g.dead.forEach(id => { if (ids.has(id)) dead[id] = true; });
    const prev = room.game;
    room.game = {
      stage: g.stage === "day" ? "day" : "night",
      round: Number.isInteger(g.round) && g.round > 0 && g.round < 1000 ? g.round : room.game.round,
      dead,
      winner: typeof g.winner === "string" ? g.winner.slice(0, 80) : ""
    };
    // A new night or day starts with empty choices.
    if (prev.stage !== room.game.stage || prev.round !== room.game.round) {
      if (prev.stage === "day") {
        room.lastVotes = {};
        Object.keys(room.picks).forEach(id => { if (room.picks[id].vote !== undefined) room.lastVotes[id] = room.picks[id].vote; });
      }
      room.picks = {};
    }
  }

  // ----- actions players choose on their phones -----

  // Which actions this player can take right now: kind -> allowed target ids.
  actionsFor(room, playerId) {
    const g = room.game, role = room.roles[playerId];
    if (!room.started || !role || g.winner || g.dead[playerId]) return {};
    const alive = room.players.filter(p => !g.dead[p.id]).map(p => p.id);
    const others = alive.filter(id => id !== playerId);
    const aliveRole = k => alive.some(id => room.roles[id] === k);
    const out = {};
    if (g.stage === "day") { out.vote = others; return out; }
    if (isMafia(role)) out.mk = others.filter(id => !isMafia(room.roles[id]));
    if (role === "don") out.dn = others;
    if (role === "det" || (role === "ast" && !aliveRole("det"))) out.dt = others;
    if (role === "doc" || (role === "nurse" && !aliveRole("doc")))
      out.dc = room.selfHealUsed[playerId] ? others : alive;
    if (role === "man") out.mn = others;
    if (role === "mis") out.ms = others.filter(id => id !== room.lastBlock);
    return out;
  }

  // Player picks (or clears, with target null) a target for one of their actions.
  setPick(room, playerId, kind, target) {
    const allowed = this.actionsFor(room, playerId)[kind];
    if (!allowed) throw new GameError("no_action", "Сейчас это действие недоступно");
    const picks = room.picks[playerId] || (room.picks[playerId] = {});
    if (target === null || target === undefined || target === "") { delete picks[kind]; return; }
    target = Number(target);
    if (!allowed.includes(target)) throw new GameError("bad_target", "Этого игрока выбрать нельзя");
    picks[kind] = target;
  }

  // The target chosen on phones for a night action (null if nobody chose).
  // For the mafia kill the Don decides; otherwise the most popular choice wins.
  phoneChoice(room, kind) {
    const alive = id => !room.game.dead[id];
    const pickers = Object.keys(room.picks).map(Number).filter(id => alive(id) && room.picks[id][kind] !== undefined);
    if (!pickers.length) return null;
    if (kind === "mk") {
      const don = pickers.find(id => room.roles[id] === "don");
      if (don !== undefined) return room.picks[don].mk;
    }
    const tally = {};
    pickers.forEach(id => { const t = room.picks[id][kind]; tally[t] = (tally[t] || 0) + 1; });
    return Number(Object.keys(tally).sort((a, b) => tally[b] - tally[a])[0]);
  }

  // Day votes from phones: target id -> number of votes.
  voteTally(room) {
    const tally = {};
    Object.keys(room.picks).forEach(id => {
      const t = room.picks[id].vote;
      if (t !== undefined && !room.game.dead[id] && !room.game.dead[t]) tally[t] = (tally[t] || 0) + 1;
    });
    return tally;
  }

  // Who picked what, for the host to watch: [{id, kind, target}].
  pickList(room) {
    const out = [];
    room.players.forEach(p => {
      const pk = room.picks[p.id];
      if (pk && !room.game.dead[p.id]) Object.keys(pk).forEach(kind => out.push({ id: p.id, kind, target: pk[kind] }));
    });
    return out;
  }

  // A private result (e.g. the detective's check) shown only to this player.
  // note: {k: "dt" | "dn" | "blocked", r: round, n: target name, v: true/false}; each phone shows it in its own language.
  addNote(room, playerId, note) {
    const clean = { k: String(note.k || "").slice(0, 10), r: Number(note.r) || 0, n: String(note.n || "").slice(0, 40), v: !!note.v };
    (room.notes[playerId] || (room.notes[playerId] = [])).push(clean);
  }

  // What every participant may see.
  publicState(room) {
    return {
      code: room.code,
      started: room.started,
      hostConnected: room.hostConnected,
      minPlayers: MIN_PLAYERS,
      players: room.players.map(p => ({ id: p.id, name: p.name, connected: p.connected, dead: !!room.game.dead[p.id], bot: !!p.bot })),
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
    out.actions = this.actionsFor(room, playerId);
    out.picks = { ...(room.picks[playerId] || {}) };
    out.notes = (room.notes[playerId] || []).slice();
    // Mafia see what their teammates chose tonight.
    if (isMafia(role) && room.game.stage === "night")
      out.teamPicks = room.players
        .filter(p => p.id !== playerId && isMafia(room.roles[p.id]) && !room.game.dead[p.id] && room.picks[p.id] && room.picks[p.id].mk !== undefined)
        .map(p => ({ id: p.id, target: room.picks[p.id].mk }));
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

// Restore a room saved by the host (e.g. after a page reload).
RoomStore.prototype.restore = function (saved) {
  if (!saved || typeof saved.code !== "string" || !Array.isArray(saved.players)) return null;
  saved.players.forEach(p => { p.connected = !!p.bot; });
  ["picks", "notes", "selfHealUsed", "lastVotes"].forEach(k => { if (!saved[k] || typeof saved[k] !== "object") saved[k] = {}; });
  if (saved.lastBlock === undefined) saved.lastBlock = null;
  saved.touched = this.now();
  this.rooms.set(saved.code, saved);
  return saved;
};

const api = { RoomStore, GameError, cleanName, MAX_PLAYERS, MAX_NAME, ROOM_TTL_MS, CODE_LEN };
if (typeof module !== "undefined" && module.exports) module.exports = api;
else root.MafiaRoom = api;
})(typeof window !== "undefined" ? window : globalThis);
