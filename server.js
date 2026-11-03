const path = require("path");
const http = require("http");
const express = require("express");
const { Server } = require("socket.io");
const QRCode = require("qrcode");
const { RoomStore, GameError } = require("./rooms.js");

function createServer({ store = new RoomStore() } = {}) {
  const app = express();
  const server = http.createServer(app);
  const io = new Server(server, { maxHttpBufferSize: 1e5 });

  app.disable("x-powered-by");
  app.use(express.static(path.join(__dirname, "public")));
  app.get("/healthz", (req, res) => res.send("ok"));

  // QR code for the invite link, so people in the room can just scan the host's screen.
  app.get("/qr.svg", async (req, res) => {
    const text = String(req.query.t || "");
    if (!text || text.length > 300) return res.status(400).end();
    try {
      const svg = await QRCode.toString(text, { type: "svg", margin: 1, errorCorrectionLevel: "M" });
      res.type("image/svg+xml").set("Cache-Control", "public, max-age=86400").send(svg);
    } catch {
      res.status(400).end();
    }
  });

  const roomCh = code => `room:${code}`;
  const hostCh = code => `host:${code}`;
  const playerCh = (code, id) => `p:${code}:${id}`;

  function broadcast(room) {
    io.to(roomCh(room.code)).emit("state", store.publicState(room));
    io.to(hostCh(room.code)).emit("host:state", store.hostView(room));
  }

  function sendSecrets(room) {
    room.players.forEach(p => io.to(playerCh(room.code, p.id)).emit("secret", store.secretFor(room, p.id)));
  }

  function chSize(name) {
    const s = io.sockets.adapter.rooms.get(name);
    return s ? s.size : 0;
  }

  io.on("connection", socket => {
    // Wrap every handler: validate the ack, turn GameError into {ok:false}.
    const on = (event, fn) => socket.on(event, async (data, ack) => {
      if (typeof ack !== "function") ack = () => {};
      try {
        ack({ ok: true, ...(await fn(data && typeof data === "object" ? data : {})) });
      } catch (e) {
        if (e instanceof GameError) ack({ ok: false, code: e.code, error: e.message });
        else { console.error(e); ack({ ok: false, code: "server", error: "Ошибка сервера" }); }
      }
    });

    let creates = 0;

    function bindHost(room) {
      socket.data = { code: room.code, host: true };
      socket.join([roomCh(room.code), hostCh(room.code)]);
      room.hostConnected = true;
    }

    function bindPlayer(room, player) {
      socket.data = { code: room.code, playerId: player.id };
      socket.join([roomCh(room.code), playerCh(room.code, player.id)]);
      player.connected = true;
    }

    const hostRoom = d => {
      const room = store.get(d.code);
      store.checkHost(room, d.hostToken);
      return room;
    };

    on("host:create", () => {
      if (++creates > 20) throw new GameError("limit", "Слишком много комнат");
      const room = store.create();
      bindHost(room);
      return { code: room.code, hostToken: room.hostToken, state: store.hostView(room) };
    });

    on("host:resume", d => {
      const room = hostRoom(d);
      bindHost(room);
      broadcast(room);
      return { state: store.hostView(room) };
    });

    on("host:kick", d => {
      const room = hostRoom(d);
      const p = store.remove(room, Number(d.playerId));
      if (p) {
        io.to(playerCh(room.code, p.id)).emit("kicked");
        io.in(playerCh(room.code, p.id)).socketsLeave([roomCh(room.code), playerCh(room.code, p.id)]);
      }
      broadcast(room);
      return {};
    });

    on("host:start", d => {
      const room = hostRoom(d);
      store.start(room);
      sendSecrets(room);
      broadcast(room);
      return { state: store.hostView(room) };
    });

    on("host:game", d => {
      const room = hostRoom(d);
      store.updateGame(room, d.game);
      broadcast(room);
      return {};
    });

    on("host:reset", d => {
      const room = hostRoom(d);
      store.reset(room);
      sendSecrets(room); // sends null -> players hide their old role
      broadcast(room);
      return { state: store.hostView(room) };
    });

    on("player:join", d => {
      const { room, player } = store.join(d.code, d.name);
      bindPlayer(room, player);
      broadcast(room);
      return { token: player.token, playerId: player.id, state: store.publicState(room), secret: null };
    });

    on("player:resume", d => {
      const room = store.get(d.code);
      const player = store.findPlayer(room, d.token);
      bindPlayer(room, player);
      broadcast(room);
      return { playerId: player.id, name: player.name, state: store.publicState(room), secret: store.secretFor(room, player.id) };
    });

    on("player:leave", d => {
      const room = store.get(d.code);
      const player = store.findPlayer(room, d.token);
      store.remove(room, player.id);
      socket.leave(roomCh(room.code));
      socket.leave(playerCh(room.code, player.id));
      socket.data = {};
      broadcast(room);
      return {};
    });

    socket.on("disconnect", () => {
      const { code, host, playerId } = socket.data || {};
      if (!code) return;
      let room;
      try { room = store.get(code); } catch { return; }
      if (host) room.hostConnected = chSize(hostCh(code)) > 0;
      else if (playerId) {
        const p = room.players.find(x => x.id === playerId);
        if (p) p.connected = chSize(playerCh(code, playerId)) > 0;
      }
      broadcast(room);
    });
  });

  const sweeper = setInterval(() => store.sweep(), 10 * 60 * 1000);
  sweeper.unref();
  server.on("close", () => clearInterval(sweeper));

  return { app, server, io, store };
}

if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  createServer().server.listen(port, () => console.log(`Mafia server: http://localhost:${port}`));
}

module.exports = { createServer };
