const test = require("node:test");
const assert = require("node:assert");
const { RoomStore } = require("../room.js");

function setup(n) {
  let t = 1000;
  const s = new RoomStore({ now: () => t });
  const room = s.create();
  for (let i = 0; i < n; i++) s.join(room.code, "P" + i);
  s.start(room);
  return { s, room, tick: ms => { t += ms; } };
}

test("game history keeps every night and day result for all players", () => {
  const { s, room } = setup(6);
  s.resolveNight(room);
  s.resolveVote(room, () => 0, true);
  const st = s.publicState(room);
  assert.deepStrictEqual(st.history.map(h => h.k), ["night", "day"]);
  assert.strictEqual(st.history[0].r, 1);
  const id = room.players[0].id;
  s.setDead(room, id, true);
  assert.deepStrictEqual(s.publicState(room).history.at(-1), { k: "manual", r: 2, s: "night", id, dead: true });
  s.reset(room);
  assert.deepStrictEqual(s.publicState(room).history, []);
});

test("timer can be extended without restarting it", () => {
  const { s, room, tick } = setup(5);
  s.startTimer(room, "disc", 60);
  tick(50000);
  s.extendTimer(room, 30);
  assert.strictEqual(s.timerState(room).left, 40000);
  assert.strictEqual(s.timerState(room).label, "disc");
  s.stopTimer(room);
  s.extendTimer(room, 30);
  assert.strictEqual(s.timerState(room).left, 30000);
  assert.strictEqual(s.timerState(room).label, "night");
});

test("host sees who is still choosing and can remind only them", () => {
  const { s, room } = setup(6);
  const waiting = s.waitingFor(room);
  // At night only players with a role action are waited for.
  assert.ok(waiting.length >= 3 && waiting.length < 6);
  const first = waiting[0], kind = Object.keys(s.actionsFor(room, first))[0];
  s.setPick(room, first, kind, s.actionsFor(room, first)[kind][0]);
  assert.ok(!s.waitingFor(room).includes(first) || s.requiredActions(room, first).length > 1);
  const n = s.nudge(room);
  assert.strictEqual(n, s.waitingFor(room).length);
  s.waitingFor(room).forEach(id => assert.strictEqual(s.secretFor(room, id).nudge, 1));
  // Day: everyone alive must vote.
  s.resolveNight(room);
  assert.strictEqual(s.waitingFor(room).length, s.aliveIds(room).length);
});

test("announcements reach every phone and can be removed", () => {
  const { s, room } = setup(5);
  s.announce(room, "  Hammasi\u0000 tayyormi? ");
  assert.deepStrictEqual(s.publicState(room).notice, { id: 1, text: "Hammasi  tayyormi?" });
  s.announce(room, "");
  assert.strictEqual(s.publicState(room).notice, null);
  s.announce(room, "x".repeat(500));
  assert.strictEqual(s.publicState(room).notice.text.length, 200);
  assert.strictEqual(s.publicState(room).notice.id, 3);
});

test("restoring an old saved room fills in the new fields", () => {
  const s = new RoomStore();
  const room = s.create();
  delete room.history; delete room.nudges; delete room.notice;
  const r = s.restore(JSON.parse(JSON.stringify(room)));
  assert.deepStrictEqual(r.history, []);
  assert.deepStrictEqual(r.nudges, {});
  assert.strictEqual(r.notice, null);
});
