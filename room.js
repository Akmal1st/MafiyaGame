// Room state and rules. Runs in the host's browser (window.MafiaRoom) and in Node for tests.
(function (root) {
const { deal, isMafia, MIN_PLAYERS, composition, customComposition } = typeof module !== "undefined" && module.exports ? require("./roles.js") : root.MafiaRoles;
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
  room.used = { sniper: false, judge: false, lucky: false }; // one-time abilities
  room.log = [];          // host-only history: [stageKey, round, textKey, ...args]
  room.chat = [];         // chat of players who are out: {id, name, text}
  room.history = [];      // public: what happened each night / day (the news, kept for the whole game)
  room.nudges = {};       // playerId -> how many reminders the host sent ("your turn")
  room.notice = null;     // last announcement from the host: {id, text}
}

const DEFAULT_SETTINGS = () => ({
  mode: "auto",           // "auto": roles by player count; "custom": host's counts
  counts: { mafia: 2, don: 0, det: 1, ast: 0, doc: 1, nurse: 0, man: 0, mis: 0, sn: 0, jd: 0, lk: 0 },
  reveal: false,          // show the role of players who are out
  auto: false,            // automatic host: phases end by themselves; the host plays too
  timers: { night: 60, day: 120 } // seconds per phase in automatic mode
});
const OPTIONAL = ["sn", "jd"];
const KILLERS = { mk: "maf", mn: "man", sn: "sn" };

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
      game: { stage: "lobby", round: 0, dead: {}, winner: "", news: null, timer: null },
      settings: DEFAULT_SETTINGS(),
      hostPlayerId: null,
      picks: {}, notes: {}, selfHealUsed: {}, lastBlock: null, lastVotes: {},
      used: { sniper: false, judge: false, lucky: false }, log: [], chat: [],
      history: [], nudges: {}, notice: null, noticeSeq: 0,
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

  // ----- settings (lobby) -----

  setSettings(room, s) {
    if (room.started) throw new GameError("started", "Игра уже началась");
    if (!s || typeof s !== "object") return;
    const cur = room.settings;
    if (s.mode === "auto" || s.mode === "custom") cur.mode = s.mode;
    if (s.counts && typeof s.counts === "object")
      Object.keys(cur.counts).forEach(k => { if (s.counts[k] !== undefined) cur.counts[k] = Math.max(0, Math.min(MAX_PLAYERS, Math.floor(Number(s.counts[k]) || 0))); });
    if (s.reveal !== undefined) cur.reveal = !!s.reveal;
    if (s.auto !== undefined) cur.auto = !!s.auto;
    if (s.timers && typeof s.timers === "object") {
      const clamp = (v, lo, hi, d) => { v = Math.floor(Number(v)); return Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : d; };
      cur.timers.night = clamp(s.timers.night, 15, 600, cur.timers.night);
      cur.timers.day = clamp(s.timers.day, 30, 1200, cur.timers.day);
    }
  }

  // Roles for the current number of players: {comp} or {error}.
  compositionFor(room) {
    const N = room.players.length;
    if (N < MIN_PLAYERS) return { error: "few" };
    return room.settings.mode === "custom" ? customComposition(N, room.settings.counts) : { comp: composition(N) };
  }

  // The host joins the game as a player (automatic host mode) or leaves it (name null).
  setHostPlayer(room, rawName) {
    if (room.started) throw new GameError("started", "Игра уже началась");
    if (rawName === null || rawName === undefined) {
      if (room.hostPlayerId !== null) this.remove(room, room.hostPlayerId);
      room.hostPlayerId = null;
      return null;
    }
    const name = cleanName(rawName);
    if (!name) throw new GameError("bad_name", "Введите имя");
    const existing = room.players.find(p => p.id === room.hostPlayerId);
    if (room.players.some(p => p !== existing && p.name.toLowerCase() === name.toLowerCase()))
      throw new GameError("name_taken", "Это имя уже занято");
    if (existing) { existing.name = name; return existing; }
    if (room.players.length >= MAX_PLAYERS) throw new GameError("full", "Комната заполнена");
    const player = { id: room.nextId++, token: token(), name, connected: true, host: true };
    room.players.unshift(player);
    room.hostPlayerId = player.id;
    return player;
  }

  start(room) {
    const N = room.players.length;
    if (N < MIN_PLAYERS) throw new GameError("few", `Нужно минимум ${MIN_PLAYERS} игроков`);
    const { comp, error } = this.compositionFor(room);
    if (error) throw new GameError(error, error);
    const roles = deal(N, this.rnd, comp);
    room.roles = {};
    room.players.forEach((p, i) => { room.roles[p.id] = roles[i]; });
    room.started = true;
    room.game = { stage: "night", round: 1, dead: {}, winner: "", news: null, timer: null };
    clearPlay(room);
    if (room.settings.auto) this.startTimer(room, "night", room.settings.timers.night);
  }

  // Back to the lobby with the same players; new people may join again.
  reset(room) {
    room.started = false;
    room.roles = {};
    room.game = { stage: "lobby", round: 0, dead: {}, winner: "", news: null, timer: null };
    clearPlay(room);
  }

  // ----- game flow (run by the host's device) -----

  name(room, id) { const p = room.players.find(x => x.id === id); return p ? p.name : "?"; }
  aliveIds(room) { return room.players.filter(p => !room.game.dead[p.id]).map(p => p.id); }
  aliveWith(room, role) { return this.aliveIds(room).find(id => room.roles[id] === role); }

  // "civ", "maf", "man" or "" while the game goes on.
  winner(room) {
    const a = this.aliveIds(room);
    const m = a.filter(i => isMafia(room.roles[i])).length, mn = a.filter(i => room.roles[i] === "man").length, c = a.length - m - mn;
    if (!m && !mn) return "civ";
    if (mn && m + c <= 1) return "man";
    if (!mn && m >= c) return "maf";
    return "";
  }

  _log(room, ...entry) { room.log.push(entry); if (room.log.length > 500) room.log.shift(); }
  _history(room, news) {
    if (!Array.isArray(room.history)) room.history = [];
    room.history.push(JSON.parse(JSON.stringify(news)));
    if (room.history.length > 100) room.history.shift();
  }

  _advance(room, stage, round) {
    const prev = room.game;
    if (prev.stage === "day") {
      room.lastVotes = {};
      Object.keys(room.picks).forEach(id => { if (room.picks[id].vote !== undefined) room.lastVotes[id] = room.picks[id].vote; });
    }
    room.picks = {};
    room.game.stage = stage;
    room.game.round = round;
    room.game.winner = this.winner(room);
    room.game.timer = null;
    if (room.settings.auto && !room.game.winner) this.startTimer(room, stage, room.settings.timers[stage]);
  }

  // Host marks a player out / back in by hand.
  setDead(room, id, dead) {
    if (!room.players.some(p => p.id === id)) return;
    if (dead) room.game.dead[id] = true; else delete room.game.dead[id];
    this._history(room, { k: "manual", r: room.game.round, s: room.game.stage, id, dead: !!dead });
    this._log(room, room.game.stage === "night" ? "lg_night" : "lg_day", room.game.round, "lg_manual", this.name(room, id), !!dead);
    room.game.winner = this.winner(room);
  }

  // Resolves the night. choose(kind) gives the host's override or null to use the phones' choice.
  resolveNight(room, choose = () => null) {
    if (!room.started || room.game.stage !== "night" || room.game.winner) return;
    const R0 = room.game.round, nm = id => this.name(room, id);
    const L = (k, ...a) => this._log(room, "lg_night", R0, k, ...a);
    const forced = k => { const v = choose(k); return v !== null && v !== undefined && v !== "" ? Number(v) : null; };
    const pick = (k, skip) => { const v = forced(k); return v !== null ? v : this.phoneChoice(room, k, skip); };
    const alive = id => id !== null && !room.game.dead[id];
    const ms = pick("ms");
    const blocked = id => id !== undefined && id !== null && id === ms;
    // A distracted mafia member does not take part in the kill; the others still decide.
    // If no other mafia member is left, there is no mafia kill tonight.
    const mk = pick("mk", ms);
    if (mk === null && ms !== null && isMafia(room.roles[ms]) && !this.aliveIds(room).some(id => isMafia(room.roles[id]) && id !== ms)) L("lg_maf_blocked");
    const mn = pick("mn"), dc = pick("dc"), dt = pick("dt"), dn = pick("dn");
    const sn = !room.used.sniper ? pick("sn") : null;
    if (ms !== null) L("lg_blocked", nm(ms));
    room.lastBlock = ms;
    let saved = null;
    if (dc !== null) {
      // The nurse heals only after the doctor is out.
      const doc = this.aliveWith(room, "doc"), healer = doc !== undefined ? doc : this.aliveWith(room, "nurse");
      if (healer !== undefined && !blocked(healer)) {
        saved = dc; L("lg_healed", nm(dc));
        if (dc === healer) room.selfHealUsed[healer] = true;
      } else L("lg_heal_fail", nm(dc));
    }
    if (dt !== null) {
      const det = this.aliveWith(room, "det"), checker = det !== undefined ? det : this.aliveWith(room, "ast");
      if (blocked(checker)) { L("lg_det_fail"); if (checker !== undefined) this.addNote(room, checker, { k: "blocked", r: R0 }); }
      else { const res = isMafia(room.roles[dt]); L("lg_det", nm(dt), res); if (checker !== undefined) this.addNote(room, checker, { k: "dt", r: R0, n: nm(dt), v: res }); }
    }
    if (dn !== null) {
      const don = this.aliveWith(room, "don");
      if (blocked(don)) { L("lg_don_fail"); if (don !== undefined) this.addNote(room, don, { k: "blocked", r: R0 }); }
      else { const res = room.roles[dn] === "det"; L("lg_don", nm(dn), res); if (don !== undefined) this.addNote(room, don, { k: "dn", r: R0, n: nm(dn), v: res }); }
    }
    const died = [];
    [["mk", mk], ["mn", mn], ["sn", sn]].forEach(([kind, tg]) => {
      if (tg === null || !alive(tg)) return;
      const by = KILLERS[kind];
      if (kind === "mn" && blocked(this.aliveWith(room, "man"))) { L("lg_man_blocked"); return; }
      // A distracted sniper keeps the bullet for another night.
      if (kind === "sn" && blocked(this.aliveWith(room, "sn"))) { L("lg_sn_blocked"); return; }
      if (kind === "sn") room.used.sniper = true;
      if (tg === saved) { L("lg_saved", by, nm(tg)); return; }
      if (room.roles[tg] === "lk" && !room.used.lucky) { room.used.lucky = true; L("lg_lucky", by, nm(tg)); return; }
      room.game.dead[tg] = true; died.push(tg); L("lg_killed", by, nm(tg));
    });
    if (!died.length) L("lg_nobody_died");
    room.game.news = { k: "night", r: R0, died };
    this._history(room, room.game.news);
    this._advance(room, "day", R0);
  }

  // Resolves the day vote. count(id) gives the votes for a player (default: phones).
  resolveVote(room, count, skip = false) {
    if (!room.started || room.game.stage !== "day" || room.game.winner) return;
    const R0 = room.game.round, tally = this.voteTally(room);
    count = count || (id => tally[id] || 0);
    const D = (k, ...a) => this._log(room, "lg_day", R0, k, ...a);
    const a = this.aliveIds(room);
    let max = 0; a.forEach(i => { max = Math.max(max, count(i)); });
    const top = a.filter(i => count(i) === max);
    let out = null, tie = false, pardoned = null;
    if (skip || max === 0) D("lg_no_exile");
    else if (top.length > 1) { tie = true; D("lg_tie", top.map(i => this.name(room, i)).join(", "), max); }
    else {
      const judge = this.aliveWith(room, "jd");
      const pardon = judge !== undefined && !room.used.judge && room.picks[judge] ? room.picks[judge].jd : undefined;
      if (pardon === top[0]) { room.used.judge = true; pardoned = top[0]; D("lg_pardoned", this.name(room, top[0]), max); }
      else { out = top[0]; room.game.dead[out] = true; D("lg_exiled", this.name(room, out), max); }
    }
    room.game.news = { k: "day", r: R0, out, tie, pardoned };
    this._history(room, room.game.news);
    this._advance(room, "night", R0 + 1);
  }

  // ----- timers (shown on every phone) -----

  startTimer(room, label, seconds) {
    seconds = Math.max(1, Math.min(3600, Math.floor(Number(seconds)) || 60));
    room.game.timer = { label: String(label).slice(0, 10), ends: this.now() + seconds * 1000, total: seconds };
  }
  stopTimer(room) { room.game.timer = null; }
  // Adds time to the running timer (or starts one for the current phase).
  extendTimer(room, seconds) {
    if (!room.started || room.game.winner) return;
    seconds = Math.max(1, Math.min(600, Math.floor(Number(seconds)) || 30));
    const tm = room.game.timer;
    if (!tm) return this.startTimer(room, room.game.stage, seconds);
    const left = Math.max(0, tm.ends - this.now());
    tm.ends = this.now() + Math.min(3600 * 1000, left + seconds * 1000);
    tm.total = Math.max(tm.total, Math.ceil((tm.ends - this.now()) / 1000));
  }

  // ----- host helpers: who is still choosing, reminders, announcements -----

  // Living players who still have to choose something in this phase.
  waitingFor(room) {
    if (!room.started || room.game.winner) return [];
    const night = room.game.stage === "night";
    return this.aliveIds(room).filter(id => {
      const need = night ? this.requiredActions(room, id) : ["vote"];
      return need.some(k => !(room.picks[id] && room.picks[id][k] !== undefined));
    });
  }
  // Reminds everyone who still has to choose (their phone beeps and vibrates). Returns how many.
  nudge(room) {
    if (!room.nudges) room.nudges = {};
    const ids = this.waitingFor(room).filter(id => { const p = room.players.find(x => x.id === id); return p && !p.bot && !p.host; });
    ids.forEach(id => { room.nudges[id] = (room.nudges[id] || 0) + 1; });
    return ids.length;
  }
  // A short message from the host shown on every phone; empty text removes it.
  announce(room, text) {
    text = String(text || "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 200);
    room.noticeSeq = (room.noticeSeq || 0) + 1;
    room.notice = text ? { id: room.noticeSeq, text } : null;
  }
  timerState(room) {
    const tm = room.game.timer;
    return tm ? { label: tm.label, left: Math.max(0, tm.ends - this.now()), total: tm.total } : null;
  }
  timerExpired(room) { const tm = room.game.timer; return !!tm && this.now() >= tm.ends; }

  // Automatic host: is everyone done with this phase?
  // Actions a player must pick before the phase can end (the sniper's one shot is optional).
  requiredActions(room, id) { return Object.keys(this.actionsFor(room, id)).filter(k => !OPTIONAL.includes(k)); }
  phaseDone(room) {
    const alive = this.aliveIds(room);
    if (room.game.stage === "night") {
      return alive.every(id => this.requiredActions(room, id).every(k => room.picks[id] && room.picks[id][k] !== undefined));
    }
    return alive.every(id => room.picks[id] && room.picks[id].vote !== undefined);
  }

  // ----- chat for players who are out -----

  canChat(room, playerId) { return room.started && (!!room.game.dead[playerId] || !!room.game.winner); }
  addChat(room, playerId, text) {
    if (!this.canChat(room, playerId)) throw new GameError("no_chat", "Чат доступен только выбывшим");
    text = String(text || "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 200);
    if (!text) return;
    room.chat.push({ id: playerId, name: this.name(room, playerId), text });
    if (room.chat.length > 60) room.chat.shift();
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
      winner: typeof g.winner === "string" ? g.winner.slice(0, 80) : "",
      news: prev.news || null,
      timer: prev.timer || null
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
    if (g.stage === "day") {
      out.vote = others;
      if (role === "jd" && !room.used.judge) out.jd = alive;
      return out;
    }
    if (role === "sn" && !room.used.sniper) out.sn = others;
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
  phoneChoice(room, kind, skip = null) {
    const alive = id => !room.game.dead[id];
    const pickers = Object.keys(room.picks).map(Number).filter(id => alive(id) && id !== skip && room.picks[id][kind] !== undefined);
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
    const reveal = room.settings.reveal || !!room.game.winner;
    const c = this.compositionFor(room);
    return {
      code: room.code,
      started: room.started,
      hostConnected: room.hostConnected,
      minPlayers: MIN_PLAYERS,
      settings: { mode: room.settings.mode, reveal: room.settings.reveal, auto: room.settings.auto, timers: { ...room.settings.timers } },
      comp: c.comp || null,
      compError: c.error || "",
      players: room.players.map(p => {
        const dead = !!room.game.dead[p.id];
        const o = { id: p.id, name: p.name, connected: p.connected, dead, bot: !!p.bot, host: !!p.host };
        if (room.started && (dead || room.game.winner) && reveal) o.role = room.roles[p.id];
        return o;
      }),
      game: { stage: room.game.stage, round: room.game.round, winner: room.game.winner, news: room.game.news || null, timer: this.timerState(room) },
      history: (room.history || []).slice(-40),
      notice: room.notice || null
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
    if (this.canChat(room, playerId)) out.chat = room.chat.slice();
    out.nudge = (room.nudges && room.nudges[playerId]) || 0;
    return out;
  }

  // Host sees everyone's role.
  hostView(room) {
    return {
      ...this.publicState(room),
      roles: room.started ? room.players.map(p => ({ id: p.id, name: p.name, role: room.roles[p.id] })) : [],
      log: room.log.slice(),
      chat: room.chat.slice(),
      used: { ...room.used },
      hostPlayerId: room.hostPlayerId,
      waiting: this.waitingFor(room),
      fullSettings: JSON.parse(JSON.stringify(room.settings))
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
  saved.players.forEach(p => { if (p.host) p.connected = true; });
  ["picks", "notes", "selfHealUsed", "lastVotes"].forEach(k => { if (!saved[k] || typeof saved[k] !== "object") saved[k] = {}; });
  if (!saved.used) saved.used = { sniper: false, judge: false, lucky: false };
  if (!Array.isArray(saved.log)) saved.log = [];
  if (!Array.isArray(saved.chat)) saved.chat = [];
  if (!Array.isArray(saved.history)) saved.history = [];
  if (!saved.nudges || typeof saved.nudges !== "object") saved.nudges = {};
  if (saved.notice === undefined) saved.notice = null;
  if (!saved.settings) saved.settings = DEFAULT_SETTINGS();
  if (saved.hostPlayerId === undefined) saved.hostPlayerId = null;
  if (saved.lastBlock === undefined) saved.lastBlock = null;
  saved.touched = this.now();
  this.rooms.set(saved.code, saved);
  return saved;
};

const api = { RoomStore, GameError, cleanName, MAX_PLAYERS, MAX_NAME, ROOM_TTL_MS, CODE_LEN };
if (typeof module !== "undefined" && module.exports) module.exports = api;
else root.MafiaRoom = api;
})(typeof window !== "undefined" ? window : globalThis);
