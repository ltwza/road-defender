/* ============================================================================
 *  经济基线 —— 金币价格表到底该定多少，只能量出来，不能拍脑袋。
 *
 *  它回答一个问题：**一局能挣多少金币？**
 *  然后拿这个数去校验 MAPS / SKINS 里的 price：
 *  价格 ÷ 单局收入 = "要打多少局"，这个倍数才是玩家真正感受到的东西。
 *  定得太低 → 商城两局就买空，后期没有目标；
 *  定得太高 → 地图成了永远够不着的摆设（用户要求"地图大概是 10 多局往上"）。
 *
 *  三种玩家一起量，因为它们差得很远，价格必须对着**最弱的那一档**也能看到希望：
 *    · 熟练（233ms 反应）—— 通关线，收入上限
 *    · 一般（400ms 反应）—— 多数人的水平，价格应该对着它定
 *    · 发呆（完全不操作）—— 收入下限，用来确认"再菜也有进账"
 *
 *  金币值直接读 RD.MONSTERS[key].coin，不在这里另抄一份 ——
 *  抄一份就意味着改了 game.js 而这里量出来的还是老数。
 *
 *  用法：node dev/economy.js
 * ========================================================================== */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const DIR = 'C:/Users/Administrator/Desktop/road-defender';
const REPORT = path.join(DIR, 'dev', '_economy.txt');
const _lines = [];
const _log = console.log.bind(console);
console.log = (...a) => { const s = a.join(' '); _lines.push(s); _log(s); };
process.on('uncaughtException', (e) => { console.log('UNCAUGHT: ' + (e && e.stack ? e.stack : e)); process.exit(1); });
process.on('unhandledRejection', (e) => { console.log('REJECT: ' + (e && e.stack ? e.stack : e)); process.exit(1); });
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
    step(n, dtMs) {
      for (let i = 0; i < n; i++) {
        const cbs = rafQueue; rafQueue = [];
        ts += dtMs;
        for (let j = 0; j < cbs.length; j++) cbs[j](ts);
      }
    }
  };
}

/* 会躲的模拟玩家（与 dev/e2e-test.js 里那份同源，含"顺手捡掉落"）。
 * 金币不靠捡，所以捡不捡掉落其实不影响收入 —— 保留它是为了让存活时长接近真人，
 * 而存活时长直接决定"还能打多少只"。 */
function makeDodger(env, opt) {
  const o = opt || {};
  const delay = o.delayFrames === undefined ? 14 : o.delayFrames;
  const turnPenalty = o.turnPenalty === undefined ? 2 : o.turnPenalty;
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
      const eta = (m) => {
        const dy = m.y3d - CFG.playerY - 1.2;
        const close = CFG.scrollSpeed + m.type.dash;
        if (m.mode === 'lunge') return Math.max(0, dy / close);
        return Math.max(0, m.type.windup - m.modeT) + Math.max(0, dy / close);
      };
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
        for (const m of G.monsters) {
          if (m.dead) continue;
          const dy = m.y3d - CFG.playerY;
          if (dy < -2.5 || dy > ATK.range + 6) continue;
          if (m.mode === 'lunge' || m.mode === 'windup') {
            const T = eta(m);
            const w = Math.max(0.18, Math.min(1, 1 - T / 1.6));
            const need = m.r + CFG.playerRadius;
            const proj = Math.max(LO, Math.min(HI, G.x3d + d * V * T));
            const gap = Math.abs(proj - m.lungeX);
            if (gap < need) cost += (need - gap) * 340 * w;
            else if (gap < need + 0.45) cost += (need + 0.45 - gap) * 22 * w;
            cost += Math.max(0, Math.abs(proj) - 1.55) * 3.5 * w;
          } else {
            const proj = Math.max(LO, Math.min(HI, G.x3d + d * V * 0.5));
            cost += Math.max(0, 1.4 - Math.abs(proj - m.x3d)) * 3.5;
          }
        }
        for (const dp of G.drops) {
          const ddy = dp.y3d - CFG.playerY;
          if (ddy < 0 || ddy > 42) continue;
          const Td = ddy / CFG.scrollSpeed;
          const urg = Math.max(0, Math.min(1, 1 - Td / 3.5));
          const projD = Math.max(LO, Math.min(HI, G.x3d + d * V * Td));
          cost -= Math.max(0, 1.7 - Math.abs(projD - dp.x3d)) * 7 * urg;
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

/* 跑一局，返回该局的账。
 * 按怪种分类的击杀数：死的怪会在数组里留一帧（killMonster 之后还要等下一帧
 * updateMonsters 才 splice），逐帧扫一遍就能归因，不必改 game.js 暴露任何东西。
 * ⚠ 有个坑：**扑中玩家的妖物也会置 dead**（hitPlayer 里干的），但 G.kills 不涨。
 *   所以不能见到 dead 就算击杀 —— 用 G.kills 的增量当上界，多出来的那些优先
 *   按"贴脸扑击"排除掉（那正是 hitPlayer 的判定条件）。
 *   账不平的话下面会显式报出来，避免"明细看着挺像样、其实全错"。
 * 金币总数直接读 G.coins（权威值），不在这里自己加。 */
async function runOne(seed, policy) {
  const env = makeEnv();
  env.w.Math.random = seeded(seed);
  env.w.eval(fs.readFileSync(path.join(DIR, 'projector.js'), 'utf8'));
  env.w.eval(fs.readFileSync(path.join(DIR, 'game.js'), 'utf8'));
  await sleep(900);
  env.w.document.getElementById('btnStart').click();

  const dodger = policy.noInput ? null : makeDodger(env, { delayFrames: policy.delayFrames });
  const D = env.w.RD, CFG = D.CFG;
  const byType = {};
  const seenDead = new Set();
  let deaths = 0, prevHp = 100, prevKills = 0, endedWin = false, dur = 180, bookErr = 0;

  for (let i = 0; i < 200 * 60; i++) {
    if (dodger) dodger.tick();
    env.step(1, 16.67);
    const g = D.G;
    if (!g) break;

    const newDead = [];
    for (const m of g.monsters) {
      if (m.dead && !seenDead.has(m)) { seenDead.add(m); newDead.push(m); }
    }
    const dk = (g.kills || 0) - prevKills;
    prevKills = g.kills || 0;
    if (newDead.length && dk > 0) {
      let cand = newDead;
      if (newDead.length > dk) {
        cand = newDead.filter((m) => !(m.mode === 'lunge' && (m.y3d - CFG.playerY) < 1.8));
        if (cand.length < dk) cand = newDead.slice(0, dk);
      }
      cand.slice(0, dk).forEach((m) => { byType[m.key] = (byType[m.key] || 0) + 1; });
    } else if (newDead.length > dk) {
      bookErr += newDead.length - dk;   // 只可能是"扑中玩家"，正常
    }

    if (env.w.document.getElementById('result').classList.contains('hidden') === false) {
      endedWin = env.w.document.getElementById('resTitle').textContent === '通关';
      dur = endedWin ? CFG.roundDuration : +(i / 60).toFixed(1);
      break;
    }
    if (g.hp < prevHp) deaths++;
    prevHp = g.hp;
  }
  if (dodger) dodger.release();
  const g = D.G || {};
  const sum = Object.keys(byType).reduce((s, k) => s + byType[k], 0);
  /* ⚠ G.coins 里可能已经混进了通关奖励：endGame() 在置 state='result' **之前**
   *   就把 CFG.coinBonusWin 加进 G.coins 了，而上面那个 break 是看到 result 界面才退出的。
   *   不把这笔扣掉的话，"一局掉落多少"会被抬高整整 120（实测：同 seed 同击杀数，
   *   读数从 49 变成 169）—— 拿这个虚高的数去定价，地图就会被算得太便宜。
   *   掉落收入才是"手有多快"的度量；通关奖励是"活下来了"的度量，两者分开看。 */
  const bonus = endedWin ? CFG.coinBonusWin : 0;
  const dropped = Math.max(0, (g.coins || 0) - bonus);
  const out = {
    seed, policy: policy.name, win: endedWin, dur, bonus,
    kills: g.kills || 0, coins: dropped, total: g.coins || 0, score: g.score || 0,
    hits: deaths, byType, bookOK: sum === (g.kills || 0)
  };
  env.w.close();
  return out;
}

const median = (a) => {
  const s = a.slice().sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const avg = (a) => a.reduce((x, y) => x + y, 0) / Math.max(1, a.length);

/* 单独起一个最小环境，只为读出生效的价格表。
 * runOne 里的 env 跑完就 close 了，拿不到 RD —— 与其把价格抄一份到这里（会过期），
 * 不如再开一个空环境把真值读出来。 */
async function readCatalog() {
  const env = makeEnv();
  env.w.eval(fs.readFileSync(path.join(DIR, 'projector.js'), 'utf8'));
  env.w.eval(fs.readFileSync(path.join(DIR, 'game.js'), 'utf8'));
  await sleep(900);
  const D = env.w.RD;
  const cat = { MAPS: D.MAPS, SKINS: D.SKINS, CFG: D.CFG };
  env.w.close();
  return cat;
}

(async function () {
  const SEEDS = [20260911, 7, 42, 1234];
  const POLICIES = [
    { name: '熟练', delayFrames: 14 },
    { name: '一般', delayFrames: 24 },
    { name: '发呆', noInput: true }
  ];

  const all = [];
  for (const p of POLICIES) {
    console.log('── 政策：' + p.name + (p.delayFrames ? '（延迟 ' + p.delayFrames + ' 帧 ≈ ' +
      Math.round(p.delayFrames * 16.67) + 'ms）' : '（完全不操作）') + ' ──');
    for (const seed of SEEDS) {
      const r = await runOne(seed, p);
      all.push(r);
      const by = Object.keys(r.byType).map((k) => k + ' ' + r.byType[k]).join(' · ') || '—';
      console.log('  seed ' + String(seed).padEnd(9) +
        (r.win ? '★通关' : '阵亡') + ' ' + String(r.dur).padStart(5) + 's' +
        '  击杀 ' + String(r.kills).padStart(3) +
        '  掉落 ' + String(r.coins).padStart(4) +
        (r.bonus ? ' + 奖励 ' + r.bonus + ' = 到手 ' + String(r.total).padStart(4) : '        （无奖励）') +
        '  积分 ' + String(r.score).padStart(5) +
        '  挨打 ' + String(r.hits).padStart(2) +
        (r.bookOK ? '' : ' [账不平!]') +
        '  明细 ' + by);
    }
    const rs = all.filter((x) => x.policy === p.name);
    console.log('  >>> ' + p.name + '：掉落均值 ' + avg(rs.map((x) => x.coins)).toFixed(1) +
      ' 中位 ' + median(rs.map((x) => x.coins)) +
      ' 区间 ' + Math.min.apply(null, rs.map((x) => x.coins)) + '~' + Math.max.apply(null, rs.map((x) => x.coins)) +
      '，到手均值 ' + avg(rs.map((x) => x.total)).toFixed(1) +
      '，通关 ' + rs.filter((x) => x.win).length + '/' + rs.length +
      '，每只均价 ' + (avg(rs.map((x) => x.coins)) / Math.max(1, avg(rs.map((x) => x.kills)))).toFixed(2) + ' 金币\n');
  }

  console.log('════════ 汇总 ════════');
  const 熟练 = avg(all.filter((x) => x.policy === '熟练').map((x) => x.coins));
  const 一般 = avg(all.filter((x) => x.policy === '一般').map((x) => x.coins));
  const 发呆 = avg(all.filter((x) => x.policy === '发呆').map((x) => x.coins));
  const 熟练到手 = avg(all.filter((x) => x.policy === '熟练').map((x) => x.total));
  const 一般到手 = avg(all.filter((x) => x.policy === '一般').map((x) => x.total));
  console.log('单局**掉落**收入（不含通关奖励，4 局平均）：熟练 ' + 熟练.toFixed(0) +
    ' · 一般 ' + 一般.toFixed(0) + ' · 发呆 ' + 发呆.toFixed(0));
  console.log('单局**到手**（掉落 + 通关奖励）：熟练 ' + 熟练到手.toFixed(0) + ' · 一般 ' + 一般到手.toFixed(0));

  /* 价格换算必须读**游戏里真实的价格**，不能在这里再抄一份表 ——
   * 抄一份的下场是"改了 MAPS 的价格，这里还在按老价格算局数"，
   * 然后拿着过期的结论去判断定价合不合适。 */
  const RD = await readCatalog();
  const 局 = (p, base) => (p / Math.max(1, base)).toFixed(1);
  console.log('\n价格 ↔ 局数换算（读的是 MAPS / SKINS 里的真实 price）：');
  console.log('  局数按三个基线算：最快（熟练且通关 ' + 熟练到手.toFixed(0) + '/局）、' +
    '熟练纯掉落 ' + 熟练.toFixed(0) + '、' + '一般 ' + 一般到手.toFixed(0) + '。');
  console.log('  ⚠ 判断"贵不贵"要看**最快那一列** —— 连最顺的人都要打这么多局，慢的只会更久。');
  console.log('  ' + '商品'.padEnd(11) + '价格'.padStart(6) + '   最快   熟练   一般');
  const row = (name, price) => console.log('  ' + name.padEnd(11) + String(price).padStart(6) +
    '  ' + 局(price, 熟练到手).padStart(6) + 局(price, 熟练).padStart(7) + 局(price, 一般到手).padStart(7) +
    (price === 0 ? '   （初始赠送，不售卖）' : ''));
  RD.MAPS.filter((m) => m.price > 0).forEach((m) => row('地图 ' + m.name, m.price));
  RD.SKINS.filter((s) => s.price > 0).forEach((s) => row('皮肤 ' + s.name, s.price));

  const paidMaps = RD.MAPS.filter((m) => m.price > 0).map((m) => m.price);
  const paidSkins = RD.SKINS.filter((s) => s.price > 0).map((s) => s.price);
  console.log('\n  最便宜的地图 ' + Math.min.apply(null, paidMaps) + ' vs 最贵的皮肤 ' + Math.max.apply(null, paidSkins) +
    ' → ' + (Math.min.apply(null, paidMaps) > Math.max.apply(null, paidSkins) ? '地图更贵 ✓' : '⚠ 皮肤贵过地图了'));
  console.log('  地图区间（最快基线）：' + 局(Math.min.apply(null, paidMaps), 熟练到手) + '~' +
    局(Math.max.apply(null, paidMaps), 熟练到手) + ' 局');
  console.log('  地图区间（一般玩家）：' + 局(Math.min.apply(null, paidMaps), 一般到手) + '~' +
    局(Math.max.apply(null, paidMaps), 一般到手) + ' 局');
  console.log('  通关奖励 ' + RD.CFG.coinBonusWin + ' 金币 ≈ 熟练玩家一局掉落的 ' +
    (RD.CFG.coinBonusWin / Math.max(1, 熟练) * 100).toFixed(0) + '%（"活下来"确实值钱，但不该盖过"打得多"）');
  console.log('  皮肤区间（最快基线）：' + 局(Math.min.apply(null, paidSkins), 熟练到手) + '~' +
    局(Math.max.apply(null, paidSkins), 熟练到手) + ' 局 —— 比地图早拿到');

  console.log('\n按怪种的金币产出占比（全部局）：');
  const tot = {};
  all.forEach((r) => Object.keys(r.byType).forEach((k) => { tot[k] = (tot[k] || 0) + r.byType[k]; }));
  const coinOf = { slime: 1, bat: 2, brute: 4, elite: 9 };
  const grand = Object.keys(tot).reduce((s, k) => s + tot[k] * (coinOf[k] || 0), 0);
  Object.keys(tot).forEach((k) => {
    const c = tot[k] * (coinOf[k] || 0);
    console.log('  ' + k.padEnd(7) + ' 击杀 ' + String(tot[k]).padStart(4) + ' 只 × ' + coinOf[k] +
      ' = ' + String(c).padStart(5) + ' 金币（' + (c / grand * 100).toFixed(1) + '%）');
  });
  console.log('扫描完毕');
})();
