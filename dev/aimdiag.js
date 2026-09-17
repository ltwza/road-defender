/* 弹道散布诊断：多发武器在实战距离上，到底有几发能打中同一只妖物？
 *
 * 只回答一个问题 —— 「开一枪，n 发子弹里有几发命中靶子」。
 * 不模拟走位、不让靶子移动：把系统刷的怪每帧挤掉，只留一只钉死位置的靶子，
 * 于是「命中几发」直接等于弹道散开的绝对量，不受怪移动/玩家移动干扰。
 * 开火只允许发生一次（打完后把 fireTimer 顶死），避免第二枪污染计数。
 */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const DIR = 'C:/Users/Administrator/Desktop/road-defender';
const REPORT = path.join(DIR, 'dev', '_aimdiag.txt');
const _lines = [];
const _log = console.log.bind(console);
console.log = (...a) => { const s = a.join(' '); _lines.push(s); _log(s); };
const _err = console.error.bind(console);
console.error = (...a) => { const s = a.join(' '); _lines.push('[ERR] ' + s); _err(s); };
process.on('uncaughtException', (e) => { console.error('UNCAUGHT: ' + (e && e.stack ? e.stack : e)); });
process.on('unhandledRejection', (e) => { console.error('REJECT: ' + (e && e.stack ? e.stack : e)); });
process.on('exit', () => { try { fs.writeFileSync(REPORT, _lines.join('\n') + '\n', 'utf8'); } catch (e) {} });

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const f = (v, d) => Number(v).toFixed(d === undefined ? 1 : d);

(async function () {
  const env = makeEnv();
  env.w.eval(fs.readFileSync(path.join(DIR, 'projector.js'), 'utf8'));
  env.w.eval(fs.readFileSync(path.join(DIR, 'game.js'), 'utf8'));
  await sleep(1500);
  env.w.document.getElementById('btnStart').click();

  const D = env.w.RD;
  const CFG = D.CFG, WP = D.WEAPONS, MON = D.MONSTERS;
  const G = D.G;
  const TARGET = MON.slime;                       // 拿小妖当靶子：命中容差最小的一档（0.76m）
  const TOL = TARGET.r + 0.32;

  function trial(wkey, dist, relX) {
    G.bullets.length = 0;
    G.drops.length = 0;
    G.aimLock = null;
    G.bulletHits = 0; G.shotsFired = 0; G.dmgDealt = 0;
    G.weapon = wkey;
    G.fireTimer = 0;
    const px = 0;                                  // 玩家钉在中列，靶子按 relX 摆
    G.x3d = px;
    const m = {
      key: 'slime', type: TARGET,
      x3d: px + relX, y3d: CFG.playerY + dist,
      hp: 1e9, maxHp: 1e9, speed: 0, r: TARGET.r, dmg: 0,
      wob: 0, mode: 'walk', modeT: 0, lungeX: 0, hitFlash: 0, dead: false
    };
    const fx = m.x3d, fy = m.y3d;
    const frames = Math.ceil(((dist + 8) / CFG.bulletSpeed) / 0.01667) + 4;
    env.step(frames, 16.67, () => {
      G.monsters.length = 0;                       // 每帧挤掉系统刷的怪
      G.monsters.push(m);
      m.x3d = fx; m.y3d = fy; m.hp = 1e9; m.dead = false;
      m.mode = 'walk'; m.modeT = 0;
      G.weapon = wkey;
      G.x3d = px;
      G.spawnTimer = 1e9;
      G.buffs = { atk: 0, rate: 0, crit: 0, critDmg: 0 };   // 去掉词条：只测弹道，不测伤害
      if (G.shotsFired > 0) G.fireTimer = 1e9;    // 只允许开一枪
    });
    return { fired: G.shotsFired, hits: G.bulletHits };
  }

  /* 各发在目标深度处相对目标中心的横向偏离（米）。
   * 口径与 game.js 一致：spreadM 本身就是"在目标所在深度处散开多少米"，
   * 所以不需要再乘距离 —— 这正是把散布从"角度"改成"米"的意义所在。 */
  function offsets(wkey) {
    const w = WP[wkey], n = w.shots;
    const out = [];
    for (let i = 0; i < n; i++) {
      out.push(Math.abs(n === 1 ? 0 : (i - (n - 1) / 2) * (w.spreadM || 0)));
    }
    return out;
  }

  _lines.push('靶子：小妖（判定半径 ' + f(TOL, 2) + 'm）　玩家固定在中列，靶子摆在正前方 / 右侧一路');
  _lines.push('命中容差 = 妖物半径 ' + f(TARGET.r, 2) + ' + 弹道判定 0.32 = ' + f(TOL, 2) + 'm');
  _lines.push('');
  const DISTS = [12, 17, 25, 40, 60];
  const WKEYS = ['sword', 'twin', 'fan', 'cloud'];
  const RELS = [0, 4 / 3];

  for (const relX of RELS) {
    _lines.push('── 靶子在玩家正前方偏 ' + f(relX, 2) + 'm 处 ──');
    _lines.push('武器'.padEnd(8) + '距离'.padEnd(7) + '发射'.padEnd(6) + '命中'.padEnd(6) +
      '命中率'.padEnd(9) + '最外侧偏离 / 容差');
    for (const wkey of WKEYS) {
      for (const dist of DISTS) {
        const r = trial(wkey, dist, relX);
        const offs = offsets(wkey);
        const worst = Math.max.apply(null, offs);
        if (r.fired === 0) { _lines.push(wkey + ' 未开火？'); continue; }
        _lines.push(
          WP[wkey].name.padEnd(8) +
          (dist + 'm').padEnd(7) +
          String(r.fired).padEnd(6) +
          String(r.hits).padEnd(6) +
          (r.hits / r.fired * 100).toFixed(0).padStart(3) + '%     ' +
          f(worst, 2) + 'm / ' + f(TOL, 2) + 'm' + (worst > TOL ? '   ← 已超出容差' : ''));
      }
      _lines.push('');
    }
  }

  /* 汇总：整局实战里各武器的真实命中率。
   * 让系统正常刷怪、自动玩家用键盘来回横移（不死，只统计弹道）。
   * 每轮只跑 10 秒：四把武器 × 三轮 = 120 秒，不会撞上 180 秒的通关结算 ——
   * 结算一触发帧循环就停了，后面测出来的会是"0 开火"这种假数据。 */
  _lines.push('── 实战抽样：系统正常刷怪，自动玩家来回横移，统计真实命中率（每把武器 30 秒）──');
  for (const wkey of WKEYS) {
    let hits = 0, fired = 0;
    for (let t = 0; t < 3; t++) {
      const g0 = D.G;                    // 每次现取：D.G 是 getter，游戏重开后对象会换
      g0.monsters.length = 0; g0.bullets.length = 0; g0.drops.length = 0;
      g0.hp = g0.maxHp; g0.aimLock = null;
      g0.bulletHits = 0; g0.shotsFired = 0;
      g0.weapon = wkey; g0.fireTimer = 0; g0.spawnTimer = 0;
      let dir = 1;
      env.step(10 * 60, 16.67, (i) => {
        const g = D.G;
        g.weapon = wkey;                 // 掉落换掉的武器按回去
        g.hp = g.maxHp;                  // 不死，只看弹道
        if (i % 45 === 0) dir = -dir;
        g.x3d = Math.max(-2.05, Math.min(2.05, g.x3d + dir * CFG.playerMoveSpeed * 0.01667));
      });
      hits += D.G.bulletHits; fired += D.G.shotsFired;
    }
    /* 口径是"命中次数 ÷ 发射子弹数"，不是"命中率"：
     * 穿云剑穿透 3，一发打中三个目标会算三次，所以它的值可以超过 100%。 */
    _lines.push(WP[wkey].name.padEnd(8) + '开火 ' + String(fired).padStart(4) +
      '　命中 ' + String(hits).padStart(4) +
      '　命中/发射 ' + (fired ? (hits / fired * 100).toFixed(0) : '0') + '%' +
      (WP[wkey].pierce > 0 ? '  ← 穿透 ' + WP[wkey].pierce + ' 发，可 > 100%' : ''));
  }

  env.w.close();
})();
