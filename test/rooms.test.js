const test = require("node:test");
const assert = require("node:assert");
const { RoomStore, cleanName, ROOM_TTL_MS } = require("../rooms.js");
const { composition } = require("../public/roles.js");

function roomWith(store, n) {
  const room = store.create();
  for (let i = 0; i < n; i++) store.join(room.code, "P" + i);
  return room;
}

test("composition always sums to N", () => {
  for (let N = 5; N <= 30; N++) {
    const c = composition(N);
    assert.strictEqual(Object.values(c).reduce((a, b) => a + b, 0), N);
    assert.ok(c.civ >= 1, `civ for ${N}`);
  }
});

test("room codes are 5 unambiguous characters", () => {
  const s = new RoomStore();
  const { code } = s.create();
  assert.match(code, /^[A-HJ-NP-Z2-9]{5}$/);
});

test("join validates names and codes", () => {
  const s = new RoomStore();
  const room = s.create();
  assert.throws(() => s.join("ZZZZZ", "A"), { code: "no_room" });
  assert.throws(() => s.join(room.code, "   "), { code: "bad_name" });
  s.join(room.code.toLowerCase(), "Akmal");
  assert.throws(() => s.join(room.code, " akmal "), { code: "name_taken" });
  assert.strictEqual(cleanName("  a\u0000  b ".padEnd(40, "x")).length, 20);
});

test("cannot start with fewer than 5, cannot join after start", () => {
  const s = new RoomStore();
  const room = roomWith(s, 4);
  assert.throws(() => s.start(room), { code: "few" });
  s.join(room.code, "P4");
  s.start(room);
  assert.throws(() => s.join(room.code, "Late"), { code: "started" });
  assert.throws(() => s.remove(room, 1), { code: "started" });
});

test("every player gets exactly the dealt composition", () => {
  const s = new RoomStore();
  const room = roomWith(s, 12);
  s.start(room);
  const counts = {};
  Object.values(room.roles).forEach(r => { counts[r] = (counts[r] || 0) + 1; });
  const c = composition(12);
  for (const k in c) assert.strictEqual(counts[k] || 0, c[k], k);
});

test("secrets: mafia see team, assistant sees detective, civilians see nothing", () => {
  const s = new RoomStore();
  const room = roomWith(s, 12);
  s.start(room);
  const idOf = role => room.players.find(p => room.roles[p.id] === role).id;
  const nameOf = id => room.players.find(p => p.id === id).name;

  const don = s.secretFor(room, idOf("don"));
  assert.strictEqual(don.team.length, 2);
  assert.ok(don.team.every(t => t.role === "mafia"));

  const ast = s.secretFor(room, idOf("ast"));
  assert.deepStrictEqual(ast.knows, [{ name: nameOf(idOf("det")), role: "det" }]);

  const nurse = s.secretFor(room, idOf("nurse"));
  assert.deepStrictEqual(nurse.knows, [{ name: nameOf(idOf("doc")), role: "doc" }]);

  const civ = s.secretFor(room, idOf("civ"));
  assert.deepStrictEqual(civ, { role: "civ", team: [], knows: [] });
});

test("public state never contains roles or tokens", () => {
  const s = new RoomStore();
  const room = roomWith(s, 6);
  s.start(room);
  const json = JSON.stringify(s.publicState(room));
  assert.ok(!json.includes("role"));
  room.players.forEach(p => assert.ok(!json.includes(p.token)));
  assert.ok(!json.includes(room.hostToken));
});

test("updateGame sanitizes host input", () => {
  const s = new RoomStore();
  const room = roomWith(s, 5);
  s.start(room);
  s.updateGame(room, { stage: "evil", round: -3, dead: [1, 999, "x"], winner: 5 });
  assert.deepStrictEqual(room.game, { stage: "night", round: 1, dead: { 1: true }, winner: "" });
});

test("reset returns to lobby and allows joining again", () => {
  const s = new RoomStore();
  const room = roomWith(s, 5);
  s.start(room);
  s.reset(room);
  assert.strictEqual(s.secretFor(room, 1), null);
  s.join(room.code, "New");
  assert.strictEqual(room.players.length, 6);
});

test("idle rooms are swept", () => {
  let t = 0;
  const s = new RoomStore({ now: () => t });
  const room = s.create();
  t = ROOM_TTL_MS + 1;
  s.sweep();
  assert.throws(() => s.get(room.code), { code: "no_room" });
});
