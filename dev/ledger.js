/* "漏怪台账"：把每一只妖物从出场到结局的分流记清楚。
 *
 * 起因：整局站桩统计里出现过"估计 dps 73 却击杀 228 只、全程只挨 1 次打、剩余满血"的局 ——
 * 末期出怪血量/秒 是 160，73 dps 不可能全清。要么 dps 估错了，要么漏怪真的没打到人。
 * 所以这里不猜，逐帧记：出场 → 进入攻击准备 → 扑击 → 命中玩家 / 被子弹打死 / 活着溜走。
 */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const DIR = 'C:/Users/Administrator/Desktop/road-defender';
const REPORT = path.join(DIR, 'dev', '_ledger.txt');
const _lines = [];
const _log = console.log.bind(console);
console.log = (...a) => { const s = a.join(' '); _lines.push(s); _log(s); };
process.on('exit', () => { try { fs.writeFileSync(REPORT, _lines.join('\n') + '\n', 'utf8'); } catch (e) {} });

function seeded(seed) {
  let s = seed >>> 0;
  return function () { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

function makeEnv() {
  const html = fs.readFileSync(path.join(DIR, 'index.html'), 'utf8');
  const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true, url: 'http://localhost/' });
  const w = dom.window;
  const el = w.document.getElementById('game');
  Object.defineProperty(el, 'clientWidth', { value: 900, configurable: true });
  Object.defineProperty(el, 'clientHeight', { value: 700, configurable: true });
  const grad = { addColorStop() {} };
  const store = {};
  const ctx = new Proxy(store, {
    get(t, k) {
      if (k === 'createLinearGradient' || k === 'createRadialGradient') return () => grad;
      if (k === 'measureText') return () => ({ width: 0 });
      if (k in t) return t[k];
      return () => {};
    },
    set(t, k, v) { t[k] = v; return true; }
  });
  el.getContext = () => ctx;
  let q = [], ts = 0;
  w.requestAnimationFrame = (cb) => { q.push(cb); return q.length; };
  return {
    dom, w,
    step(n, dtMs) {
      for (let i = 0; i < n; i++) {
        const cbs = q; q = []; ts += dtMs;
        for (const cb of cbs) cb(ts);
      }
    }
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async function () {
  for (const seed of [null, 42, 1234, 555]) {
    const env = makeEnv();
    if (seed !== null) env.w.Math.random = seeded(seed);
    env.w.eval(fs.readFileSync(path.join(DIR, 'projector.js'), 'utf8'));
    env.w.eval(fs.readFileSync(path.join(DIR, 'game.js'), 'utf8'));
    await sleep(1400);
    env.w.document.getElementById('btnStart').click();

    const D = env.w.RD, CFG = D.CFG, ATK = D.ATTACK;
    /* 状态表：用 WeakMap 记每只怪走到哪一步了 */
    const st = new WeakMap();
    const W = [];          // 每 30 秒一格
    let winStart = 0, prevHits = 0, prevKills = 0, prevDmg = 0;
    let landed = 0, escaped = 0, shotInWindup = 0, shotInLunge = 0, shotWalking = 0;
    let endT = -1, win = false;

    for (let i = 0; i < 200 * 60; i++) {
      const G = D.G;
      // 出场登记 + 状态推进
      for (const m of G.monsters) {
        let s = st.get(m);
        if (!s) { s = { w: false, l: false, wFrame: -1, lFrame: -1 }; st.set(m, s); }
        if (!s.w && (m.mode === 'windup' || m.mode === 'lunge' || m.mode === 'recover')) { s.w = true; s.wFrame = i; }
        if (!s.l && (m.mode === 'lunge' || m.mode === 'recover')) { s.l = true; s.lFrame = i; }
      }

      env.step(1, 16.67);

      const G2 = D.G;
      // 死亡归因：死的那一刻它在哪
      for (const m of G2.monsters) {
        const s = st.get(m);
        if (!s || !m.dead || s.done) continue;
        s.done = true;
        const dy = m.y3d - CFG.playerY;
        const nearPlayer = Math.abs(m.x3d - G2.x3d) < m.r + CFG.playerRadius + 0.25 && dy < 2.0 && dy > -2.0;
        if (nearPlayer && (s.l || s.w)) { s.result = 'landed'; landed++; }
        else if (!s.w) { s.result = 'shotWalking'; shotWalking++; }
        else if (s.l) { s.result = 'shotInLunge'; shotInLunge++; }
        else { s.result = 'shotInWindup'; shotInWindup++; }
      }
      // 溜走的：跑到玩家身后且从没进过攻击准备
      for (const m of G2.monsters) {
        const s = st.get(m);
        if (!s || s.done) continue;
        if (m.y3d < CFG.playerY - 4) {
          s.done = true;
          s.result = s.w ? 'passedAfterAttack' : 'passedNoAttack';
          escaped++;
        }
      }

      const hits = G2.hits, kills = G2.kills, dmg = G2.dmgDealt;
      if (hits > prevHits) prevHits = hits;
      if (i - winStart >= 30 * 60) {
        const GG = G2;
        const dps = dmg - prevDmg;
        W.push({ t: ((i + 1) / 60).toFixed(0), hp: GG.hp, kills: kills - prevKills, hits,
          dmg: Math.round(dps), alive: GG.monsters.length, wep: D.WEAPONS[GG.weapon].name });
        prevHits = hits; prevKills = kills; prevDmg = dmg; winStart = i;
      }

      if (!env.w.document.getElementById('result').classList.contains('hidden')) {
        endT = (i + 1) / 60; win = env.w.document.getElementById('resTitle').textContent === '通关'; break;
      }
    }

    const G = D.G;
    console.log('── ' + (seed === null ? '真随机' : 'seed ' + seed) + ' → ' +
      (win ? '★通关' : '阵亡') + ' ' + endT.toFixed(1) + 's，剩余血量 ' + Math.max(0, Math.round(G.hp)) + ' ──');
    console.log('  归因：扑到玩家 ' + landed + ' ｜ 蓄力中被射杀 ' + shotInWindup +
      ' ｜ 扑击中被射杀 ' + shotInLunge + ' ｜ 走路时被射杀 ' + shotWalking + ' ｜ 溜走 ' + escaped);
    console.log('  ' + '窗口'.padEnd(6) + '血量'.padEnd(6) + '本窗击杀'.padEnd(10) + '本窗总伤害'.padEnd(12) + '本窗dps'.padEnd(9) + '存活妖物  武器');
    for (const w of W) {
      console.log('  ' + (w.t + 's').padEnd(7) + String(w.hp).padEnd(7) + String(w.kills).padEnd(11) +
        String(w.dmg).padEnd(13) + String(w.dmg / 30).padEnd(10) + String(w.alive).padEnd(10) + w.wep);
    }
    console.log('');
    env.w.close();
  }
  console.log('对账完毕');
})();
