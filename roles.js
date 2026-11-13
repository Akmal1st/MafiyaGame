// Shared between the browser (window.MafiaRoles) and the server (require).
(function (root) {
  const R = {
    civ: { n: "Мирный житель", e: "👤", c: "#4f8a5b", d: "Днём ищи мафию и голосуй. Особых способностей нет — твоё оружие логика." },
    mafia: { n: "Мафия", e: "🔫", c: "#b3262f", d: "Ночью вместе с командой выбираете жертву. Днём притворяйся мирным." },
    don: { n: "Дон мафии", e: "🎩", c: "#6b1d2c", d: "Глава мафии. Ночью ищет детектива: ведущий кивает, если выбранный — детектив." },
    det: { n: "Детектив", e: "🕵️", c: "#3b6fb0", d: "Каждую ночь проверяешь одного игрока: ведущий показывает, мафия он или нет." },
    ast: { n: "Помощник детектива", e: "🔎", c: "#5b8fc7", d: "Знает, кто детектив, и помогает ему. Если детектив выбыл — продолжает проверки." },
    doc: { n: "Доктор", e: "💉", c: "#2f9e8f", d: "Каждую ночь лечишь одного игрока — спасаешь от убийства. Себя можно лечить лишь один раз." },
    nurse: { n: "Медсестра", e: "🩺", c: "#52b8aa", d: "Помощница доктора. Если доктора убили — ты берёшь его роль и лечишь вместо него." },
    man: { n: "Маньяк", e: "🔪", c: "#d9822b", d: "Играешь сам за себя. Каждую ночь убиваешь одного. Победа — остаться последним." },
    mis: { n: "Любовница", e: "💋", c: "#c2549b", d: "Каждую ночь выбираешь игрока: он пропускает своё ночное действие. Не выбирай одного дважды подряд." },
    sn: { n: "Снайпер", e: "🎯", c: "#8a6d3b", d: "Один раз за игру можешь ночью застрелить любого игрока." },
    jd: { n: "Судья", e: "⚖️", c: "#7b5ea7", d: "Один раз за игру можешь днём помиловать игрока, которого изгоняют." },
    lk: { n: "Везунчик", e: "🍀", c: "#3c9d4f", d: "Переживёшь первое покушение на тебя." }
  };
  const ORDER = ["civ", "mafia", "don", "det", "ast", "doc", "nurse", "man", "mis", "sn", "jd", "lk"];
  // Roles that can appear at most once; mafia and civilians can repeat.
  const SINGLE = ["don", "det", "ast", "doc", "nurse", "man", "mis", "sn", "jd", "lk"];
  const MIN_PLAYERS = 5;

  function composition(N) {
    // About one mafia per four players; the maniac joins from 10 players so the town is not outnumbered early.
    const m = N <= 7 ? 1 : N <= 11 ? 2 : N <= 15 ? 3 : N <= 19 ? 4 : 5 + Math.floor((N - 20) / 5);
    const c = {};
    c.don = N >= 10 ? 1 : 0;
    c.mafia = m - c.don;
    c.det = 1; c.doc = 1;
    c.man = N >= 10 ? 1 : 0;
    c.mis = N >= 8 ? 1 : 0;
    c.nurse = N >= 11 ? 1 : 0;
    c.ast = N >= 12 ? 1 : 0;
    c.sn = N >= 13 ? 1 : 0;
    c.lk = N >= 15 ? 1 : 0;
    c.jd = N >= 17 ? 1 : 0;
    const used = Object.values(c).reduce((a, b) => a + b, 0);
    c.civ = N - used;
    return c;
  }

  function shuffle(a, rnd = Math.random) {
    a = a.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  // Returns an array of role keys, one per player, in random order.
  function deal(N, rnd, comp) {
    const c = comp || composition(N), list = [];
    ORDER.forEach(k => { for (let j = 0; j < c[k]; j++) list.push(k); });
    return shuffle(list, rnd);
  }

  const isMafia = k => k === "mafia" || k === "don";

  // Custom setup from the host: counts of special roles; civilians fill the rest.
  // Returns {comp} or {error: code}.
  function customComposition(N, counts) {
    const c = {};
    ORDER.forEach(k => {
      if (k === "civ") return;
      let v = Math.floor(Number(counts && counts[k]) || 0);
      v = Math.max(0, SINGLE.includes(k) ? Math.min(1, v) : Math.min(N, v));
      c[k] = v;
    });
    if (c.mafia + c.don < 1) return { error: "need_mafia" };
    const used = Object.values(c).reduce((a, b) => a + b, 0);
    if (used > N - 1) return { error: "too_many_roles" };
    if ((c.mafia + c.don) * 2 >= N) return { error: "too_many_mafia" };
    c.civ = N - used;
    return { comp: c };
  }

  const api = { R, ORDER, SINGLE, MIN_PLAYERS, composition, customComposition, shuffle, deal, isMafia };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.MafiaRoles = api;
})(typeof window !== "undefined" ? window : globalThis);
