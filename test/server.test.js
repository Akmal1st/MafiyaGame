const test = require("node:test");
const assert = require("node:assert");
const { io: connect } = require("socket.io-client");
const { createServer } = require("../server.js");

test("host creates room, 5 players join by code, everyone gets only their own role", async t => {
  const { server, io } = createServer();
  await new Promise(r => server.listen(0, r));
  const url = `http://localhost:${server.address().port}`;
  const sockets = [];
  t.after(() => { sockets.forEach(s => s.close()); io.close(); server.close(); });

  const client = () => { const s = connect(url, { transports: ["websocket"] }); sockets.push(s); return s; };
  const call = (s, ev, data) => new Promise(r => s.emit(ev, data, r));

  const host = client();
  const created = await call(host, "host:create", {});
  assert.ok(created.ok);
  const { code, hostToken } = created;

  const players = [];
  for (let i = 0; i < 5; i++) {
    const s = client();
    const r = await call(s, "player:join", { code, name: "Player" + i });
    assert.ok(r.ok, r.error);
    const secret = new Promise(res => s.once("secret", res));
    players.push({ s, r, secret });
  }

  const dup = await call(client(), "player:join", { code, name: "player0" });
  assert.strictEqual(dup.code, "name_taken");

  const notHost = await call(players[0].s, "host:start", { code, hostToken: "nope" });
  assert.strictEqual(notHost.code, "not_host");

  const started = await call(host, "host:start", { code, hostToken });
  assert.ok(started.ok);
  assert.strictEqual(started.state.roles.length, 5);

  const secrets = await Promise.all(players.map(p => p.secret));
  secrets.forEach((sec, i) => {
    const expected = started.state.roles.find(r => r.id === players[i].r.playerId).role;
    assert.strictEqual(sec.role, expected);
  });

  const late = await call(client(), "player:join", { code, name: "Late" });
  assert.strictEqual(late.code, "started");

  // A player reconnecting with their token gets their role back.
  const again = client();
  const resumed = await call(again, "player:resume", { code, token: players[2].r.token });
  assert.ok(resumed.ok);
  assert.strictEqual(resumed.secret.role, secrets[2].role);

  // Host pushes a death; players see it in the public state.
  const seen = new Promise(res => players[0].s.on("state", st => { if (st.players.some(p => p.dead)) res(st); }));
  await call(host, "host:game", { code, hostToken, game: { stage: "day", round: 1, dead: [players[1].r.playerId], winner: "" } });
  const st = await seen;
  assert.strictEqual(st.game.stage, "day");
  assert.ok(st.players.find(p => p.id === players[1].r.playerId).dead);
});

test("invite QR endpoint returns SVG", async t => {
  const { server, io } = createServer();
  await new Promise(r => server.listen(0, r));
  t.after(() => { io.close(); server.close(); });
  const res = await fetch(`http://localhost:${server.address().port}/qr.svg?t=${encodeURIComponent("http://x/?room=ABCDE")}`);
  assert.strictEqual(res.status, 200);
  assert.match(await res.text(), /^<svg/);
});
