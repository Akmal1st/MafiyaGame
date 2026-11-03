const test = require("node:test");
const assert = require("node:assert");
const { RoomStore } = require("../room.js");
const { decide } = require("../bots.js");
const { isMafia } = require("../roles.js");

function botRoom(n, seed = 1) {
  let x = seed;
  const rnd = () => { x = (x * 16807) % 2147483647; return x / 2147483647; };
  const s = new RoomStore({ rnd });
  const room = s.create();
  for (let i = 0; i < n; i++) s.addBot(room);
  s.start(room);
  return { s, room, rnd, one: r => room.players.find(p => room.roles[p.id] === r).id };
}

test("addBot gives unique names and bots count as connected", () => {
  const s = new RoomStore();
  const room = s.create();
  for (let i = 0; i < 25; i++) s.addBot(room);
  const names = room.players.map(p => p.name);
  assert.strictEqual(new Set(names).size, 25);
  assert.ok(room.players.every(p => p.bot && p.connected));
  assert.ok(s.publicState(room).players.every(p => p.bot));
});

test("every bot decision is a legal pick, across many seeds and sizes", () => {
  for (let seed = 1; seed <= 40; seed++) {
    for (const n of [5, 8, 12, 20]) {
      const { s, room, rnd } = botRoom(n, seed);
      for (const stage of ["night", "day"]) {
        s.updateGame(room, { stage, round: 2, dead: [], winner: "" });
        room.players.forEach(p => {
          const acts = s.actionsFor(room, p.id);
          Object.keys(acts).forEach(kind => {
            const t = decide(s, room, p.id, kind, rnd);
            if (t !== null) s.setPick(room, p.id, kind, t); // throws if illegal
          });
        });
      }
    }
  }
});

test("mafia bots follow the Don and never target teammates", () => {
  const { s, room, rnd, one } = botRoom(20, 7);
  const don = one("don");
  const target = s.actionsFor(room, don).mk[0];
  s.setPick(room, don, "mk", target);
  room.players.filter(p => room.roles[p.id] === "mafia").forEach(p => {
    assert.strictEqual(decide(s, room, p.id, "mk", rnd), target);
  });
});

test("detective bot votes for a mafia member it has found", () => {
  const { s, room, rnd, one } = botRoom(12, 3);
  const det = one("det");
  const maf = room.players.find(p => isMafia(room.roles[p.id]));
  s.addNote(room, det, { k: "dt", r: 1, n: maf.name, v: true });
  s.updateGame(room, { stage: "day", round: 1, dead: [], winner: "" });
  assert.strictEqual(decide(s, room, det, "vote", rnd), maf.id);
});

test("detective bot does not re-check known players", () => {
  const { s, room, rnd, one } = botRoom(6, 5);
  const det = one("det");
  const others = s.actionsFor(room, det).dt;
  others.slice(0, -1).forEach(id => s.addNote(room, det, { k: "dt", r: 1, n: room.players.find(p => p.id === id).name, v: false }));
  assert.strictEqual(decide(s, room, det, "dt", rnd), others[others.length - 1]);
});
