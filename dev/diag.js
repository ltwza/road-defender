/* 平衡诊断：不解"游戏能不能通关"，只回答一个更基础的问题 ——
 * 玩家挨打的那一刻，场上到底有没有一个"站得住"的位置？
 *   有  → 是走位决策/反应的问题（可玩，只是难）
 *   没有 → 是设计问题（落点把整条路铺满了，操作再准也没用）
 */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const DIR = 'C:/Users/Administrator/Desktop/road-defender';
const REPORT = path.join(DIR, 'dev', '_diag.txt');
const _lines = [];
const _log = console.log.bind(console);
console.log = (...a) => { const s = a.join(' '); _lines.push(s); _log(s); };
const _err = console.error.bind(console);
console.error = (...a) => { const s = a.join(' '); _lines.push('[ERR] ' + s); _err(s); };
process.on('uncaughtException', (e) => { console.error('UNCAUGHT: ' + (e && e.stack ? e.stack : e)); process.exit(1); });
process.on('unhandledRejection', (e) => { console.error('REJECT: ' + (e && e.stack ? e.stack : e)); process.exit(1); });
process.on('exit', () => { try { fs.writeFileSync(REPORT, _lines.join('\n') + '\n', 'utf8'); } catch (e) {} });

function seeded(seed) {
  let s = seed >>> 0;
  return function () { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

function makeEnv() {
  const html = fs.readFileSync(path.join(DIR, 'index.html'), 'utf8');
  const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true, url: 'http://localhost/' });
  const w = dom.window;
  const canvasEl = w.document.getElementById('game');
  Object.defineProperty(canvasEl, 'clientWidth', { value: 900, configurable: true });
  Object.defineProperty(canvasEl, 'clientHeight', { value: 700, configurable: true });
  const grad = { addColorStop() {} };
  const store = {};
  const ctxStub = new Proxy(store, {
    get(t, k) {
      if (k === 'createLinearGradient' || k === 'createRadialGradient') return () => grad;
      if (k === 'measureText') return () => ({ width: 0 });
      if (k in t) return t[k];
      return () => {};
    },
    set(t, k, v) { t[k] = v; return true; }
  });
  canvasEl.getContext = () => ctxStub;
  let rafQueue = [], ts = 0;
  w.requestAnimationFrame = function (cb) { rafQueue.push(cb); return rafQueue.length; };
  return {
    dom, w,
    step(n, dtMs, beforeEach) {
      for (let i = 0; i < n; i++) {
        if (beforeEach) beforeEach(i);
        const cbs = rafQueue; rafQueue = [];
        ts += dtMs;
        for (let j = 0; j < cbs.length; j++) cbs[j](ts);
      }
    }
  };
}

/* 会躲的模拟玩家。
 * 关键不是"现在哪里安全"，而是"这玩意儿砸下来那一刻，我会在哪" ——
 * 所以先算每个威胁的落地倒计时，再把"我保持某个方向全速跑"投影到那个时刻，
 * 看投影点会不会正好落在它的落点圈里。 */
function makeDodger(env, opt) {
  const o = opt || {};
  const delay = o.delayFrames || 0;
  const turnPenalty = o.turnPenalty === undefined ? 10 : o.turnPenalty;
  let cur = null, pending = null, cnt = 0;
  const dirOf = (k) => (k === 'd' ? 1 : k === 'a' ? -1 : 0);

  const setKey = (k) => {
    if (k === cur) return;
    if (cur) env.w.dispatchEvent(new env.w.KeyboardEvent('keyup', { key: cur }));
    if (k) env.w.dispatchEvent(new env.w.KeyboardEvent('keydown', { key: k }));
    cur = k;
  };

  return {
    tick() {
      const D = env.w.RD;
      if (!D || !D.G) return;
      const G = D.G, CFG = D.CFG, ATK = D.ATTACK;
      const LO = -2.05, HI = 2.05, V = CFG.playerMoveSpeed;

      // 每个威胁的落地倒计时（秒）
      function eta(m) {
        const dy = m.y3d - CFG.playerY - 1.2;
        const close = CFG.scrollSpeed + m.type.dash;
        if (m.mode === 'lunge') return Math.max(0, dy / close);
        return Math.max(0, m.type.windup - m.modeT) + Math.max(0, dy / close);
      }

      // 有没有正在逼近的威胁：有的话就不允许"停"（停 = 被锁定的落点必然是自己）
      let urgent = 0;
      for (const m of G.monsters) {
        if (m.dead || (m.mode !== 'lunge' && m.mode !== 'windup')) continue;
        const dy = m.y3d - CFG.playerY;
        if (dy < -2.5 || dy > ATK.range + 6) continue;
        urgent = Math.max(urgent, Math.max(0.18, Math.min(1, 1 - eta(m) / 1.6)));
      }
      const dirs = urgent >= 0.35 ? [-1, 1] : [-1, 0, 1];

      let bestDir = dirOf(cur), bestCost = Infinity;
      for (const d of dirs) {
        let cost = (d !== dirOf(cur)) ? turnPenalty : 0;
        for (let j = 0; j < G.monsters.length; j++) {
          const m = G.monsters[j];
          if (m.dead) continue;
          const dy = m.y3d - CFG.playerY;
          if (dy < -2.5 || dy > ATK.range + 6) continue;

          if (m.mode === 'lunge' || m.mode === 'windup') {
            const T = eta(m);
            const urgency = Math.max(0.18, Math.min(1, 1 - T / 1.6));
            const need = m.r + CFG.playerRadius;
            // 那一刻我会在哪：保持当前方向全速跑，撞墙就贴着墙
            const proj = Math.max(LO, Math.min(HI, G.x3d + d * V * T));
            const gap = Math.abs(proj - m.lungeX);
            if (gap < need) cost += (need - gap) * 340 * urgency;
            else if (gap < need + 0.45) cost += (need + 0.45 - gap) * 22 * urgency;
            // 别把自己逼到路沿：贴着墙就没有回旋余地了
            cost += Math.max(0, Math.abs(proj) - 1.55) * 3.5 * urgency;
          } else {
            // 还在走：它会锁到我那一刻的位置，只能别贴着它的列站
            const proj = Math.max(LO, Math.min(HI, G.x3d + d * V * 0.5));
            cost += Math.max(0, 1.4 - Math.abs(proj - m.x3d)) * 3.5;
          }
        }
        if (cost < bestCost) { bestCost = cost; bestDir = d; }
      }

      const next = bestDir > 0 ? 'd' : bestDir < 0 ? 'a' : (cur || 'd');
      if (next === cur) { pending = next; cnt = 0; return; }
      cnt = next === pending ? cnt + 1 : 0;
      pending = next;
      if (cnt >= delay) setKey(next);
    },
    release() { setKey(null); }
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async function () {
  const SEEDS = [20260911, 7, 42, 1234, 555, 90210];
  const COMBOS = [];
  for (const delayFrames of [8, 14, 20]) COMBOS.push({ turnPenalty: 2, delayFrames });
  for (const combo of COMBOS) {
   const { delayFrames, turnPenalty } = combo;
   const results = [];
   for (const seed of SEEDS) {
    const env = makeEnv();
    env.w.Math.random = seeded(seed);
    env.w.eval(fs.readFileSync(path.join(DIR, 'projector.js'), 'utf8'));
    env.w.eval(fs.readFileSync(path.join(DIR, 'game.js'), 'utf8'));
    await sleep(1400);
    env.w.document.getElementById('btnStart').click();

    const dodger = makeDodger(env, { delayFrames: delayFrames });
    const D = env.w.RD, G = () => D.G, CFG = D.CFG;

    let hits = 0, hitsNoSafe = 0, framesNoSafe = 0, frames = 0;
    let peakLocks = 0, lockSum = 0, lockFrames = 0;
    let prevHp = 100, deathT = -1, endedWin = false;
    const hitMoments = [];

    for (let i = 0; i < 200 * 60; i++) {
      dodger.tick();
      env.step(1, 16.67);
      frames++;
      const g = G();
      if (!g) break;
      if (env.w.document.getElementById('result').classList.contains('hidden') === false) {
        deathT = frames / 60;
        // 判"赢"必须看结算标题：撑满时长时结算面板同样会弹出，
        // 此时 deathT 是 179.98 而不是 180，用 deathT < 180 会把它误判成阵亡。
        endedWin = env.w.document.getElementById('resTitle').textContent === '通关';
        break;
      }

      // 当前所有"已锁定"的落点
      const locks = [];
      for (const m of g.monsters) {
        if (m.mode !== 'windup' && m.mode !== 'lunge') continue;
        if (m.y3d - CFG.playerY < -2.5 || m.y3d - CFG.playerY > D.ATTACK.range + 4) continue;
        locks.push(m.lungeX);
      }
      if (locks.length) {
        lockSum += locks.length; lockFrames++;
        peakLocks = Math.max(peakLocks, locks.length);
        // 17 档候选位置上，存不存在一个离所有落点都 >= 0.96 米的位置
        let safe = false;
        for (let c = 0; c < 17; c++) {
          const cx = -2.05 + 4.1 * c / 16;
          let okSpot = true;
          for (const lx of locks) if (Math.abs(cx - lx) < 0.96) { okSpot = false; break; }
          if (okSpot) { safe = true; break; }
        }
        if (!safe) framesNoSafe++;
      }

      if (g.hp < prevHp) {
        hits++;
        if (!locks.some((lx) => Math.abs(g.x3d - lx) > 0.96)) { /* 玩家本来就在危险区 */ }
        if (!locks.length) hitsNoSafe++;   // 挨打时场上连预警都没有
        hitMoments.push({ t: +(frames / 60).toFixed(1), n: locks.length, hp: g.hp });
      }
      prevHp = g.hp;
    }
    dodger.release();
    env.w.close();   // 释放 jsdom，否则几十个实例会把内存吃光被强杀

    const surv = endedWin ? 180 : (deathT > 0 ? deathT : 180);
    results.push(surv);
    const GG = D.G || {};
    console.log('  seed ' + String(seed).padEnd(9) +
      (endedWin ? '★通关 180.0s' : '阵亡 ' + deathT.toFixed(1).padStart(5) + 's') +
      '  挨打 ' + String(hits).padStart(2) + ' 次' +
      '  剩血 ' + String(Math.max(0, prevHp)).padStart(4) +
      '  安全位 ' + (((lockFrames - framesNoSafe) / Math.max(1, lockFrames)) * 100).toFixed(1) + '%' +
      '  平均落点 ' + (lockSum / Math.max(1, lockFrames)).toFixed(2) +
      '  峰值 ' + peakLocks +
      '  击杀 ' + (GG.kills || 0) +
      '  开火 ' + (GG.shotsFired || 0) +
      '  武器 ' + (GG.weapon || '?') +
      '  命中率 ' + (GG.shotsFired ? (GG.bulletHits / GG.shotsFired * 100).toFixed(0) + '%' : '—') +
      '  总伤害 ' + Math.round(GG.dmgDealt || 0) +
      '  单杀耗伤 ' + (GG.kills ? Math.round((GG.dmgDealt || 0) / GG.kills) : '—'));
  }
   const win = results.filter((r) => r >= 180).length;
   console.log('  >>> 组合 delay=' + delayFrames + ' turn=' + turnPenalty +
     '：通关 ' + win + '/' + results.length +
     '，平均存活 ' + (results.reduce((a, b) => a + b, 0) / results.length).toFixed(1) + 's\n');
  }
  console.log('扫描完毕');
})();
