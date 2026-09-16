/* 站桩诊断：玩家完全不动，看妖物到底有没有机会打到人。
 * 拆开统计"进入攻击准备 → 死在蓄力/扑击中 → 真的扑到玩家"这三段，
 * 用来判断"站着不动不掉血"是因为前期太软，还是因为攻击判定根本没触发。 */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const DIR = 'C:/Users/Administrator/Desktop/road-defender';
const REPORT = path.join(DIR, 'dev', '_stand.txt');
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
  for (const seed of [20260911, 7, 42]) {
    const env = makeEnv();
    env.w.Math.random = seed ? seeded(seed) : Math.random;
    env.w.eval(fs.readFileSync(path.join(DIR, 'projector.js'), 'utf8'));
    env.w.eval(fs.readFileSync(path.join(DIR, 'game.js'), 'utf8'));
    await sleep(1400);
    env.w.document.getElementById('btnStart').click();

    const D = env.w.RD;
    let started = 0, killedSeen = 0, passed = 0, hits0 = 0;
    let hp = 100, firstHit = -1;
    const perSec = [];

    for (let i = 0; i < 90 * 60; i++) {
      for (const m of D.G.monsters) {
        if (!m._seen && (m.mode === 'windup' || m.mode === 'lunge')) { m._seen = true; started++; }
      }
      env.step(1, 16.67);
      const G2 = D.G;
      if (G2.hp < hp) { if (firstHit < 0) firstHit = (i + 1) / 60; hp = G2.hp; }
      for (const m of G2.monsters) {
        if (!m._seen || m._counted) continue;
        if (m.dead) { m._counted = true; killedSeen++; }
        else if (m.mode === 'walk' && m.y3d < D.CFG.playerY - 3) { m._counted = true; passed++; }
      }
      if ((i + 1) % (5 * 60) === 0) {
        perSec.push(((i + 1) / 60) + 's:活' + G2.monsters.length + '/hp' + G2.hp);
      }
    }
    hits0 = D.G.hits;

    console.log('── seed ' + seed + '（站桩 90 秒）──');
    console.log('  进入过攻击准备 ' + started + ' 只 → 在蓄力/扑击中被击杀 ' + killedSeen +
      '，玩家挨打 ' + hits0 + ' 次');
    console.log('  首次挨打：' + (firstHit > 0 ? firstHit.toFixed(1) + 's' : '90 秒内没挨打') + '，剩余血量 ' + hp);
    console.log('  ' + perSec.join('  '));
    console.log('');
    env.w.close();
  }
})();
