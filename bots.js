// Bot "brains". The host's browser runs bots; each bot picks a target for its role's action
// using what that role is allowed to know. Works in the browser (window.MafiaBots) and in Node (tests).
(function (root) {
  const { isMafia } = typeof module !== "undefined" && module.exports ? require("./roles.js") : root.MafiaRoles;

  const pickRandom = (arr, rnd) => arr[Math.floor(rnd() * arr.length)];

  // What this bot has learned from its private results: id -> true/false.
  function knowledge(room, botId, kind) {
    const out = {};
    (room.notes[botId] || []).forEach(n => {
      if (n.k !== kind) return;
      const p = room.players.find(x => x.name === n.n);
      if (p) out[p.id] = n.v;
    });
    return out;
  }

  // Players who voted yesterday against `ids` (a hint that they suspect them).
  function accusersOf(room, ids) {
    return Object.keys(room.lastVotes || {}).map(Number).filter(v => ids.includes(room.lastVotes[v]));
  }

  // Today's vote count from phones and bots.
  function currentTally(room) {
    const t = {};
    Object.keys(room.picks).forEach(id => {
      const v = room.picks[id].vote;
      if (v !== undefined && !room.game.dead[id]) t[v] = (t[v] || 0) + 1;
    });
    return t;
  }

  function preferred(options, prefs, rnd) {
    for (const list of prefs) {
      const hit = list.filter(id => options.includes(id));
      if (hit.length) return pickRandom(hit, rnd);
    }
    return pickRandom(options, rnd);
  }

  // Returns the target id for this bot's action, or null to skip.
  function decide(store, room, botId, kind, rnd = Math.random) {
    const options = store.actionsFor(room, botId)[kind];
    if (!options || !options.length) return null;
    const role = room.roles[botId];
    const alive = room.players.filter(p => !room.game.dead[p.id]).map(p => p.id);
    const mafiaIds = alive.filter(id => isMafia(room.roles[id]));

    if (kind === "mk") {
      // Follow the team: the Don's choice first, then any teammate's.
      const team = mafiaIds.filter(id => id !== botId && room.picks[id] && room.picks[id].mk !== undefined);
      const don = team.find(id => room.roles[id] === "don");
      const follow = don !== undefined ? room.picks[don].mk : team.length ? room.picks[team[0]].mk : undefined;
      if (follow !== undefined && options.includes(follow)) return follow;
      // Otherwise hunt the detective the Don found, then whoever voted against the mafia.
      const donId = room.players.find(p => room.roles[p.id] === "don");
      const found = donId ? Object.entries(knowledge(room, donId.id, "dn")).filter(([, v]) => v).map(([id]) => +id) : [];
      return preferred(options, [found, accusersOf(room, mafiaIds)], rnd);
    }
    if (kind === "dn" || kind === "dt") {
      // Check someone not checked yet (the assistant also uses the detective's results).
      const known = { ...knowledge(room, botId, kind) };
      if (kind === "dt") room.players.filter(p => room.roles[p.id] === "det" || room.roles[p.id] === "ast")
        .forEach(p => Object.assign(known, knowledge(room, p.id, "dt")));
      const fresh = options.filter(id => known[id] === undefined && !(kind === "dn" && isMafia(room.roles[id])));
      return pickRandom(fresh.length ? fresh : options, rnd);
    }
    if (kind === "dc") {
      // Heal yourself once when the game gets dangerous, otherwise protect the most accused player.
      if (options.includes(botId) && room.game.round >= 2 && rnd() < 0.35) return botId;
      const votes = {};
      Object.values(room.lastVotes || {}).forEach(t => { votes[t] = (votes[t] || 0) + 1; });
      const accused = Object.keys(votes).map(Number).filter(id => votes[id] >= 2 && id !== botId);
      const others = options.filter(id => id !== botId);
      return others.length ? preferred(others, rnd() < 0.5 ? [accused] : [], rnd) : pickRandom(options, rnd);
    }
    if (kind === "sn") {
      // One bullet per game: wait a night, then shoot someone the town suspected yesterday.
      if (room.game.round < 2 || rnd() > 0.35) return null;
      const votes = {};
      Object.values(room.lastVotes || {}).forEach(t => { votes[t] = (votes[t] || 0) + 1; });
      const suspects = Object.keys(votes).map(Number).filter(id => votes[id] >= 2);
      return suspects.some(id => options.includes(id)) ? preferred(options, [suspects], rnd) : null;
    }
    if (kind === "jd") {
      // Pardon yourself if you are about to be exiled.
      const tally = currentTally(room);
      const top = Object.keys(tally).map(Number).sort((a, b) => tally[b] - tally[a])[0];
      return top === botId && options.includes(botId) ? botId : null;
    }
    if (kind === "mn") return preferred(options, [accusersOf(room, [botId])], rnd);
    if (kind === "ms") return pickRandom(options, rnd);

    if (kind === "vote") {
      const tally = currentTally(room);
      const leaders = Object.keys(tally).map(Number).sort((a, b) => tally[b] - tally[a]);
      if (isMafia(role)) {
        // Blend in: join the leading vote if it's not a teammate, otherwise push the most dangerous player.
        const lead = leaders.find(id => !isMafia(room.roles[id]) && options.includes(id));
        if (lead !== undefined && tally[lead] >= 2) return lead;
        return preferred(options.filter(id => !isMafia(room.roles[id])), [accusersOf(room, mafiaIds)], rnd) ?? null;
      }
      // Detective side: vote for a confirmed mafia member.
      if (role === "det" || role === "ast") {
        const known = {};
        room.players.filter(p => room.roles[p.id] === "det" || room.roles[p.id] === "ast")
          .forEach(p => Object.assign(known, knowledge(room, p.id, "dt")));
        const guilty = options.filter(id => known[id] === true);
        if (guilty.length) return pickRandom(guilty, rnd);
        const lead = leaders.find(id => options.includes(id) && known[id] !== false);
        if (lead !== undefined && tally[lead] >= 2) return lead;
        return preferred(options, [options.filter(id => known[id] === undefined)], rnd);
      }
      // Everyone else: follow the leader (the detective votes first when it has found someone),
      // sometimes abstain early in the game.
      const lead = leaders.find(id => options.includes(id));
      if (lead !== undefined) return lead;
      if (room.game.round === 1 && rnd() < 0.3) return null;
      return pickRandom(options, rnd);
    }
    return null;
  }

  // A detective-side bot that has found a mafia member votes right away, so others can follow.
  function urgent(store, room, botId, kind) {
    const role = room.roles[botId];
    if (kind !== "vote" || (role !== "det" && role !== "ast")) return false;
    const known = {};
    room.players.filter(p => room.roles[p.id] === "det" || room.roles[p.id] === "ast")
      .forEach(p => Object.assign(known, knowledge(room, p.id, "dt")));
    return (store.actionsFor(room, botId).vote || []).some(id => known[id] === true);
  }

  const api = { decide, urgent };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.MafiaBots = api;
})(typeof window !== "undefined" ? window : globalThis);
