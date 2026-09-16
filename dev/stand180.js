/* 站桩 180 秒（整局）存活率：回答"一动不动能不能通关"。
 *
 * 为什么值得单独测：主动攻击的落点是锁在"玩家当前位置"上的，
 * 所以站着不动时每一发预警圈都正好罩着自己 —— 理论上应该必挨打。
 * 但如果玩家 dps（靠掉落滚起来）能压过出怪血量/秒，妖物会在蓄力期就被打死，
 * 于是"站桩无敌"就会以另一种形式回来。这个脚本就是量这把尺子。
 */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const DIR = 'C:/Users/Administrator/Desktop/road-defender';
const REPORT = path.join(DIR, 'dev', '_stand180.txt');
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
/* 前 4 个固定种子用于回归对比；null = 不替换 Math.random，走真随机，用来量"真实站桩通关率"。
 * 真随机的样本要够多才有意义 —— 4 局的波动能差出一倍。 */
const SEEDS = [20260911, 7, 42, 1234, null, null, null, null, null, null, null, null];

/* 玩家 dps（和 game.js 的 playerStats 保持一致）。只用于报告，不参与判定。 */
function dpsOf(weapons, G) {
  const w = weapons[G.weapon];
  const cd = w.cd / (1 + G.buffs.rate * 0.12);
  const dmg = w.dmg * (1 + G.buffs.atk * 0.15);
  const crit = Math.min(0.92, 0.05 + G.buffs.crit * 0.06);
  const critMul = 1.5 + G.buffs.critDmg * 0.25;
  return (w.shots * dmg * (1 + crit * (critMul - 1))) / cd;
}

(async function () {
  const wins = [];
  for (const seed of SEEDS) {
    const env = makeEnv();
    if (seed !== null) env.w.Math.random = seeded(seed);
    env.w.eval(fs.readFileSync(path.join(DIR, 'projector.js'), 'utf8'));
    env.w.eval(fs.readFileSync(path.join(DIR, 'game.js'), 'utf8'));
    await sleep(1400);
    env.w.document.getElementById('btnStart').click();

    const D = env.w.RD;
    let endT = -1;
    for (let i = 0; i < 200 * 60; i++) {
      env.step(1, 16.67);
      if (!env.w.document.getElementById('result').classList.contains('hidden')) { endT = (i + 1) / 60; break; }
    }
    const title = env.w.document.getElementById('resTitle').textContent;
    const G = D.G;
    const dps = dpsOf(D.WEAPONS, G);
    const win = title === '通关';
    wins.push(win ? 1 : 0);
    console.log('  ' + String(seed === null ? '真随机' : 'seed ' + seed).padEnd(13) + (win ? '★站桩通关' : '站桩阵亡') +
      '  结束于 ' + endT.toFixed(1) + 's' +
      '  剩余血量 ' + Math.max(0, Math.round(G.hp)) +
      '  挨打 ' + G.hits + ' 次' +
      '  击杀 ' + G.kills +
      '  掉落 ' + G.dropsSpawned + '/捡到 ' + G.dropsPicked +
      '  武器 ' + D.WEAPONS[G.weapon].name +
      '  强化 ' + JSON.stringify(G.buffs) +
      '  估计 dps ' + dps.toFixed(0));
    env.w.close();
  }
  const w = wins.reduce((a, b) => a + b, 0);
  console.log('\n  >>> 站桩通关率 ' + w + '/' + wins.length +
    '（' + (w / wins.length * 100).toFixed(0) + '%）');
})();
