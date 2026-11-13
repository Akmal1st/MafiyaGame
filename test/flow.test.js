const test = require("node:test");
const assert = require("node:assert");
const { RoomStore } = require("../room.js");
const { composition, customComposition, isMafia } = require("../roles.js");

function setup(n, opts = {}) {
  let t = 1000;
  const s = new RoomStore({ now: () => t });
  const room = s.create();
  for (let i = 0; i < n; i++) s.join(room.code, "P" + i);
  if (opts.settings) s.setSettings(room, opts.settings);
  s.start(room);
  const one = r => room.players.find(p => room.roles[p.id] === r)?.id;
  const civs = () => room.players.filter(p => room.roles[p.id] === "civ" && !room.game.dead[p.id]).map(p => p.id);
  return { s, room, one, civs, tick: ms => { t += ms; } };
}

test("auto composition adds sniper, lucky and judge for big games and always leaves civilians", () => {
  assert.strictEqual(composition(12).sn, 0);
  assert.strictEqual(composition(13).sn, 1);
  assert.strictEqual(composition(15).lk, 1);
  assert.strictEqual(composition(17).jd, 1);
  for (let N = 5; N <= 30; N++) assert.ok(composition(N).civ >= 1, "N=" + N);
});

test("custom composition validates the host's counts", () => {
  assert.strictEqual(customComposition(8, { mafia: 0 }).error, "need_mafia");
  assert.strictEqual(customComposition(8, { mafia: 4 }).error, "too_many_mafia");
  assert.strictEqual(customComposition(6, { mafia: 1, det: 1, doc: 1, man: 1, mis: 1, sn: 1 }).error, "too_many_roles");
  const ok = customComposition(10, { mafia: 2, don: 1, det: 1, doc: 1, sn: 5 });
  assert.deepStrictEqual([ok.comp.sn, ok.comp.civ], [1, 4]); // single roles capped at 1
  const { room } = setup(10, { settings: { mode: "custom", counts: { mafia: 1, don: 1, det: 1, doc: 1, man: 0, mis: 0, sn: 1, lk: 1, jd: 1 } } });
  const counts = {};
  Object.values(room.roles).forEach(r => { counts[r] = (counts[r] || 0) + 1; });
  assert.deepStrictEqual(counts, { mafia: 1, don: 1, det: 1, doc: 1, sn: 1, lk: 1, jd: 1, civ: 3 });
});

test("night: doctor saves, lucky survives once, sniper shoots once, notes go to detective", () => {
  const { s, room, one, civs } = setup(10, { settings: { mode: "custom", counts: { mafia: 2, don: 0, det: 1, doc: 1, sn: 1, lk: 1 } } });
  const [c1, c2] = civs();
  const maf = room.players.find(p => room.roles[p.id] === "mafia").id;
  s.setPick(room, maf, "mk", one("lk"));
  s.setPick(room, one("doc"), "dc", c1);
  s.setPick(room, one("sn"), "sn", c1);
  s.setPick(room, one("det"), "dt", maf);
  s.resolveNight(room);
  assert.strictEqual(room.game.stage, "day");
  assert.ok(!room.game.dead[one("lk")], "lucky survives");
  assert.ok(!room.game.dead[c1], "doctor saved the sniper's target");
  assert.ok(room.used.lucky && room.used.sniper);
  assert.deepStrictEqual(room.game.news, { k: "night", r: 1, died: [] });
  assert.deepStrictEqual(s.secretFor(room, one("det")).notes[0], { k: "dt", r: 1, n: s.name(room, maf), v: true });
  assert.ok(!s.actionsFor(room, one("sn")).sn, "sniper has no second shot");
  s.resolveVote(room, () => 0, true);
  s.setPick(room, maf, "mk", one("lk"));
  s.resolveNight(room);
  assert.ok(room.game.dead[one("lk")], "second attempt kills the lucky one");
  assert.ok(room.log.length > 5);
  assert.ok(c2);
});

test("day: judge pardons once; tie exiles nobody", () => {
  const { s, room, one, civs } = setup(10, { settings: { mode: "custom", counts: { mafia: 2, det: 1, doc: 1, jd: 1 } } });
  s.resolveNight(room);
  const [c1, c2] = civs();
  const voters = room.players.map(p => p.id).filter(id => id !== c1);
  voters.forEach(id => s.setPick(room, id, "vote", c1));
  s.setPick(room, one("jd"), "jd", c1);
  s.resolveVote(room);
  assert.ok(!room.game.dead[c1]);
  assert.strictEqual(room.game.news.pardoned, c1);
  assert.ok(room.used.judge);
  s.resolveNight(room);
  const alive = s.aliveIds(room);
  s.setPick(room, alive[0], "vote", c2);
  s.setPick(room, alive[1] === c2 ? alive[2] : alive[1], "vote", alive[0] === c2 ? alive[3] : alive[0]);
  s.resolveVote(room);
  assert.ok(room.game.news.tie || room.game.news.out === null);
});

test("reveal shows roles of players who are out; everyone at the end", () => {
  const { s, room, civs } = setup(6, { settings: { reveal: true } });
  const c = civs()[0];
  s.setDead(room, c, true);
  const pub = s.publicState(room);
  assert.strictEqual(pub.players.find(p => p.id === c).role, "civ");
  assert.ok(pub.players.filter(p => p.id !== c).every(p => p.role === undefined));
  const { s: s2, room: r2, civs: civ2 } = setup(6);
  s2.setDead(r2, civ2()[0], true);
  assert.ok(s2.publicState(r2).players.every(p => p.role === undefined));
  r2.players.filter(p => isMafia(r2.roles[p.id])).forEach(p => s2.setDead(r2, p.id, true));
  assert.strictEqual(r2.game.winner, "civ");
  assert.ok(s2.publicState(r2).players.every(p => p.role));
});

test("timers count down and auto mode starts one per phase", () => {
  const { s, room, tick } = setup(6, { settings: { auto: true, timers: { night: 30, day: 90 } } });
  assert.strictEqual(s.timerState(room).total, 30);
  tick(10000);
  assert.strictEqual(s.timerState(room).left, 20000);
  assert.ok(!s.timerExpired(room));
  tick(20000);
  assert.ok(s.timerExpired(room));
  s.resolveNight(room);
  assert.strictEqual(s.timerState(room).total, 90);
});

test("phaseDone tracks when everyone has acted or voted", () => {
  const { s, room } = setup(5);
  assert.ok(!s.phaseDone(room));
  room.players.forEach(p => Object.entries(s.actionsFor(room, p.id)).forEach(([k, ids]) => s.setPick(room, p.id, k, ids[0])));
  assert.ok(s.phaseDone(room));
});

test("chat only for players who are out", () => {
  const { s, room, civs } = setup(6);
  const [a, b] = civs();
  assert.throws(() => s.addChat(room, a, "hi"), { code: "no_chat" });
  s.setDead(room, a, true);
  s.addChat(room, a, "  salom  ");
  assert.deepStrictEqual(s.secretFor(room, a).chat, [{ id: a, name: s.name(room, a), text: "salom" }]);
  assert.strictEqual(s.secretFor(room, b).chat, undefined);
});

test("host can join as a player", () => {
  const s = new RoomStore();
  const room = s.create();
  const hp = s.setHostPlayer(room, "Akmal");
  assert.ok(hp.host && room.hostPlayerId === hp.id);
  for (let i = 0; i < 4; i++) s.join(room.code, "P" + i);
  assert.throws(() => s.join(room.code, "akmal"), { code: "name_taken" });
  s.setHostPlayer(room, null);
  assert.strictEqual(room.players.length, 4);
});

test("auto composition keeps the killers to about a third of the table", () => {
  assert.strictEqual(composition(7).man, 0, "no maniac in small games");
  assert.strictEqual(composition(10).man, 1);
  assert.strictEqual(composition(20).mafia + composition(20).don, 5);
  for (let N = 5; N <= 30; N++) {
    const c = composition(N), killers = c.mafia + c.don + c.man;
    assert.ok(killers * 3 <= N + 1, "N=" + N + " killers=" + killers);
  }
});

test("mistress: a distracted mafia member is left out of the kill; the last one can't kill", () => {
  const { s, room, one, civs } = setup(8, { settings: { mode: "custom", counts: { mafia: 1, don: 1, det: 1, doc: 1, mis: 1 } } });
  const [c1, c2] = civs();
  const don = one("don"), maf = one("mafia");
  s.setPick(room, don, "mk", c1);
  s.setPick(room, maf, "mk", c2);
  s.setPick(room, one("mis"), "ms", don);
  s.resolveNight(room);
  assert.ok(!room.game.dead[c1], "the Don was distracted, his pick does not count");
  assert.ok(room.game.dead[c2], "the other mafia member still kills");
  s.resolveVote(room, id => (id === maf ? 5 : 0));
  assert.ok(room.game.dead[maf]);
  const c3 = civs()[0];
  s.setPick(room, don, "mk", c3);
  s.setPick(room, one("mis"), "ms", one("det") === undefined ? c3 : one("det"));
  s.resolveNight(room);
  assert.ok(room.game.dead[c3], "mistress on someone else: the kill goes through");
  s.resolveVote(room, () => 0, true);
  const c4 = civs()[0];
  s.setPick(room, don, "mk", c4);
  s.setPick(room, one("mis"), "ms", don);
  s.resolveNight(room);
  assert.ok(!room.game.dead[c4], "the only mafia member was distracted: nobody dies");
  assert.ok(room.log.some(l => l[2] === "lg_maf_blocked"));
});

test("a distracted sniper keeps the bullet", () => {
  const { s, room, one, civs } = setup(9, { settings: { mode: "custom", counts: { mafia: 1, det: 1, doc: 1, mis: 1, sn: 1 } } });
  const maf = one("mafia");
  s.setPick(room, one("sn"), "sn", maf);
  s.setPick(room, one("mis"), "ms", one("sn"));
  s.resolveNight(room);
  assert.ok(!room.game.dead[maf]);
  assert.ok(!room.used.sniper, "bullet not spent");
  s.resolveVote(room, () => 0, true);
  assert.ok(s.actionsFor(room, one("sn")).sn, "can shoot again");
  assert.ok(civs().length);
});
