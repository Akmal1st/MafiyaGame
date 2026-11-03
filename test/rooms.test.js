const test = require("node:test");
const assert = require("node:assert");
const { RoomStore, cleanName, ROOM_TTL_MS } = require("../room.js");
const { composition } = require("../roles.js");

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
  assert.deepStrictEqual(civ, { role: "civ", team: [], knows: [], actions: {}, picks: {}, notes: [] });
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
  const { stage, round, dead, winner } = room.game;
  assert.deepStrictEqual({ stage, round, dead, winner }, { stage: "night", round: 1, dead: { 1: true }, winner: "" });
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

test("restore brings back a saved room with players marked offline", () => {
  const s = new RoomStore();
  const room = roomWith(s, 5);
  s.start(room);
  const saved = JSON.parse(JSON.stringify(room));
  const s2 = new RoomStore();
  const r2 = s2.restore(saved);
  assert.strictEqual(s2.get(room.code), r2);
  assert.ok(r2.players.every(p => !p.connected));
  assert.deepStrictEqual(s2.secretFor(r2, 1), s.secretFor(room, 1));
});

function started(n) {
  const s = new RoomStore();
  const room = roomWith(s, n);
  s.start(room);
  const ids = role => room.players.filter(p => room.roles[p.id] === role).map(p => p.id);
  return { s, room, ids, one: role => ids(role)[0] };
}

test("night actions depend on role; civilians have none", () => {
  const { s, room, one, ids } = started(12);
  assert.deepStrictEqual(s.actionsFor(room, one("civ")), {});
  assert.deepStrictEqual(Object.keys(s.actionsFor(room, one("don"))).sort(), ["dn", "mk"]);
  assert.deepStrictEqual(Object.keys(s.actionsFor(room, one("det"))), ["dt"]);
  assert.deepStrictEqual(s.actionsFor(room, one("ast")), {});
  assert.deepStrictEqual(s.actionsFor(room, one("nurse")), {});
  // mafia cannot target their own team
  const mafia = [...ids("mafia"), ...ids("don")];
  assert.ok(s.actionsFor(room, one("mafia")).mk.every(id => !mafia.includes(id)));
  // the doctor may heal themselves
  assert.ok(s.actionsFor(room, one("doc")).dc.includes(one("doc")));
});

test("helpers take over when the main role is out", () => {
  const { s, room, one } = started(12);
  s.updateGame(room, { stage: "night", round: 1, dead: [one("det"), one("doc")], winner: "" });
  assert.ok(s.actionsFor(room, one("ast")).dt);
  assert.ok(s.actionsFor(room, one("nurse")).dc);
  assert.deepStrictEqual(s.actionsFor(room, one("det")), {}); // dead players do nothing
});

test("setPick validates and the Don decides the mafia kill", () => {
  const { s, room, one, ids } = started(12);
  const civ = ids("civ");
  assert.throws(() => s.setPick(room, one("civ"), "mk", civ[1]), { code: "no_action" });
  assert.throws(() => s.setPick(room, one("mafia"), "mk", one("don")), { code: "bad_target" });
  const [m1, m2] = ids("mafia");
  s.setPick(room, m1, "mk", civ[0]);
  s.setPick(room, m2, "mk", civ[0]);
  assert.strictEqual(s.phoneChoice(room, "mk"), civ[0]);
  s.setPick(room, one("don"), "mk", civ[1]);
  assert.strictEqual(s.phoneChoice(room, "mk"), civ[1]);
  // teammates see each other's picks, others don't
  assert.strictEqual(s.secretFor(room, m1).teamPicks.length, 2);
  assert.strictEqual(s.secretFor(room, one("det")).teamPicks, undefined);
  s.setPick(room, one("don"), "mk", null);
  assert.strictEqual(s.phoneChoice(room, "mk"), civ[0]);
});

test("day votes are tallied and picks reset when the stage changes", () => {
  const { s, room, ids } = started(6);
  s.updateGame(room, { stage: "day", round: 1, dead: [], winner: "" });
  const all = room.players.map(p => p.id);
  assert.throws(() => s.setPick(room, all[0], "vote", all[0]), { code: "bad_target" });
  s.setPick(room, all[0], "vote", all[1]);
  s.setPick(room, all[2], "vote", all[1]);
  s.setPick(room, all[3], "vote", all[0]);
  assert.deepStrictEqual(s.voteTally(room), { [all[1]]: 2, [all[0]]: 1 });
  s.updateGame(room, { stage: "night", round: 2, dead: [], winner: "" });
  assert.deepStrictEqual(s.voteTally(room), {});
  assert.ok(ids("civ").length > 0);
});

test("doctor self-heal once and mistress cannot repeat", () => {
  const { s, room, one } = started(8);
  room.selfHealUsed[one("doc")] = true;
  assert.ok(!s.actionsFor(room, one("doc")).dc.includes(one("doc")));
  const target = room.players.find(p => p.id !== one("mis")).id;
  room.lastBlock = target;
  assert.ok(!s.actionsFor(room, one("mis")).ms.includes(target));
});

test("no actions after a winner is declared", () => {
  const { s, room, one } = started(6);
  s.updateGame(room, { stage: "night", round: 1, dead: [], winner: "🏆" });
  assert.deepStrictEqual(s.actionsFor(room, one("det")), {});
});

test("notes are stored as clean structured data", () => {
  const { s, room, one } = started(6);
  s.addNote(room, one("det"), { k: "dt", r: 1, n: "<b>x</b>", v: 1, extra: "drop" });
  assert.deepStrictEqual(s.secretFor(room, one("det")).notes, [{ k: "dt", r: 1, n: "<b>x</b>", v: true }]);
});
