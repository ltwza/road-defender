/* 端到端逻辑验证：真实加载 index.html + projector.js + game.js，
 * 用 stub 的 Canvas 2D 上下文跑完整帧循环，验证两条通关路径与设置面板。 */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const DIR = 'C:/Users/Administrator/Desktop/road-defender';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* Windows 控制台是 GBK，中文日志经管道重定向会乱码 —— 顺手落一份 UTF-8 报告 */
const REPORT = path.join(DIR, 'dev', '_report.txt');
const _lines = [];
const _log = console.log.bind(console);
console.log = (...a) => { const s = a.join(' '); _lines.push(s); _log(s); };
process.on('exit', () => { try { fs.writeFileSync(REPORT, _lines.join('\n') + '\n', 'utf8'); } catch (e) {} });

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('  [FAIL] ' + m); } };

/* 等条件成立，而不是睡一个固定时长。
 * 加载动画是 setInterval(260ms)×4 + setTimeout(300ms) 拼出来的，
 * 原来固定 sleep(1400) 只剩 60ms 余量，机器一忙就假红（实测偶发）。 */
async function waitFor(fn, timeout = 6000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if (fn()) return true;
    await sleep(25);
  }
  return false;
}
const waitHome = (env) => waitFor(() => !hidden(env.w, 'home'));

function makeEnv() {
  const html = fs.readFileSync(path.join(DIR, 'index.html'), 'utf8');
  const dom = new JSDOM(html, {
    runScripts: 'outside-only',
    pretendToBeVisual: true,
    url: 'http://localhost/'
  });
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

  let rafQueue = [];
  let ts = 0;
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
    },
    hasRaf() { return rafQueue.length > 0; }
  };
}

/* 确定性伪随机：代替 Math.random，让"真随机"的测试可复现 */
function seeded(seed) {
  let s = seed >>> 0;
  return function () { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

/* 会躲的模拟玩家。
 * 它看到的和真人完全一样：RD.G 里的妖物位置、mode、预警落点 lungeX
 * （也就是屏幕上那些红色预警圈）。区别只有两点：
 *   1. 233ms 反应延迟 —— 真人视觉反应差不多就是这个量级；
 *   2. 它不做任何预知，只按"这玩意儿砸下来那一刻我会在哪"来选方向。
 * 换句话说，它做不到人类做不到的事：它能通关，就说明这游戏能通关。
 *
 * 算法：对"继续向左 / 向右"两个选项，把每个威胁的落地倒计时算出来，
 * 再把自己"保持该方向全速跑"投影到那一刻，看投影点会不会落在它的落点圈里。 */
function makeDodger(env, opt) {
  const o = opt || {};
  const delay = o.delayFrames === undefined ? 14 : o.delayFrames;   // ≈233ms
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

      // 距落地还有多久（秒）
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
      // 有威胁在逼近就不允许"停"：站着不动时，妖物锁定的落点必然就是自己
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
            cost += Math.max(0, Math.abs(proj) - 1.55) * 3.5 * w;   // 别把自己逼到路沿
          } else {
            const proj = Math.max(LO, Math.min(HI, G.x3d + d * V * 0.5));
            cost += Math.max(0, 1.4 - Math.abs(proj - m.x3d)) * 3.5;
          }
        }
        // 顺手捡掉落：真人不会白白放过血瓶和武器。
        // 权重刻意压得很低，绝不会为了捡东西去撞预警圈。
        for (const dp of G.drops) {
          const ddy = dp.y3d - CFG.playerY;
          if (ddy < 0 || ddy > 42) continue;
          const Td = ddy / CFG.scrollSpeed;                     // 还有多久掠过玩家
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

function loadScripts(w) {
  w.eval(fs.readFileSync(path.join(DIR, 'projector.js'), 'utf8'));
  w.eval(fs.readFileSync(path.join(DIR, 'game.js'), 'utf8'));
}

const hidden = (w, id) => w.document.getElementById(id).classList.contains('hidden');
const txt = (w, id) => w.document.getElementById(id).textContent;

/* ═══════════════ 测试 A：真实随机 + 玩家不动 → 必然失败 ═══════════════ */
async function testA() {
  console.log('=== 测试 A：加载 → 主页 → 开局 → 失败结算 ===');
  const env = makeEnv();
  loadScripts(env.w);

  ok(!hidden(env.w, 'loading') && hidden(env.w, 'home'), '初始停在加载界面');
  await waitHome(env);
  ok(env.hasRaf(), '主循环已启动（rAF 已入队）');
  ok(hidden(env.w, 'loading') && !hidden(env.w, 'home'), '加载结束后进入主页');
  ok(hidden(env.w, 'hud'), '主页时 HUD 隐藏');

  env.w.document.getElementById('btnStart').click();
  ok(!hidden(env.w, 'hud'), '开始后 HUD 显示');
  ok(txt(env.w, 'hpText').indexOf('100') === 0, '初始血量 100：' + txt(env.w, 'hpText'));
  ok(txt(env.w, 'weaponName') === '飞剑', '初始武器为飞剑');
  ok(txt(env.w, 'timeText') === '3:00', '倒计时初始 3:00：' + txt(env.w, 'timeText'));

  env.step(60 * 9, 16.67);        // 9 秒：妖物已进入射程
  ok(parseInt(txt(env.w, 'scoreText'), 10) > 0, '9 秒后已击杀得分：' + txt(env.w, 'scoreText'));
  ok(txt(env.w, 'timeText') !== '3:00', '倒计时在走：' + txt(env.w, 'timeText'));

  /* 站着不动：绝大概率会被扑死（dev/stand180.js 两轮各 12 局，只通关 1 局和 2 局；
   * 首次挨打约 17s，阵亡集中在 31~140s），但不能拿"必死"当断言 ——
   * 少数局会靠掉落滚起射速/攻击雪球（dps 200+，末期出怪才 160 HP/秒），反过来把出怪全清掉。
   * 这里改成：先让它自然挨打（把血量、积分这些真实数据跑出来），
   * 若还没死就直接把血量打到 0，走一遍真实的 G.hp <= 0 → endGame(false) 失败路径。 */
  const NATURAL = 60 * 90;
  let frames = 60 * 9;
  while (frames < NATURAL && hidden(env.w, 'result')) { env.step(1, 16.67); frames++; }
  const naturalDeath = !hidden(env.w, 'result');
  if (!naturalDeath) {
    env.w.RD.G.hp = -1;   // 直接触发 updatePlaying 里的失败判定
    while (frames < 200 * 60 && hidden(env.w, 'result')) { env.step(1, 16.67); frames++; }
  }
  ok(!hidden(env.w, 'result'), '出现结算（用了 ' + (frames / 60).toFixed(1) + ' 秒）');
  console.log('  结局来源：' + (naturalDeath ? '站着不动被扑死（真实挨打路径）'
    : '本局站桩没死（掉落滚雪球），改为直接给血量清零走失败分支'));
  ok(txt(env.w, 'resTitle') === '失败', '结算标题为「失败」：' + txt(env.w, 'resTitle'));
  const score = parseInt(txt(env.w, 'resScore'), 10);
  const kills = parseInt(txt(env.w, 'resKills'), 10);
  console.log('  结算：积分 ' + score + '，击杀 ' + kills + '，存活 ' + txt(env.w, 'resTime') +
    '，' + txt(env.w, 'resBest'));
  ok(score > 0 && kills > 0, '有击杀与积分');
  ok(txt(env.w, 'resBest').indexOf('新纪录') === 0, '首局记为新高分');

  env.w.document.getElementById('btnResHome').click();
  ok(!hidden(env.w, 'home') && hidden(env.w, 'result'), '返回主页正常');
  ok(txt(env.w, 'bestScore').indexOf(String(score)) > 0, '主页显示历史最高分：' + txt(env.w, 'bestScore'));
  env.w.document.getElementById('btnStart').click();
  ok(!hidden(env.w, 'hud') && txt(env.w, 'scoreText') === '0', '再来一局状态被重置');
  env.step(60 * 10, 16.67);
  ok(parseInt(txt(env.w, 'scoreText'), 10) > 0, '重开后逻辑仍正常（积分 ' + txt(env.w, 'scoreText') + '）');
  return { score, kills };
}

/* ═══════════════ 测试 B：妖物主动攻击的威胁 → 走位躲避 → 撑满 3:00 通关 ═══════════════ */
async function testB() {
  console.log('\n=== 测试 B：主动攻击的威胁 → 走位躲避 → 撑满 3:00 通关 ===');
  const env = makeEnv();
  env.w.Math.random = seeded(20260911);   // 三列随机出怪、随机落点误差、随机掉落，但整局可复现
  loadScripts(env.w);
  await waitHome(env);

  env.w.document.getElementById('btnStart').click();
  ok(parseFloat(txt(env.w, 'hpText')) === 100, '开局满血：' + txt(env.w, 'hpText'));

  /* ① 先证明"主动攻击"真的有威胁：原地不动必然挨打 */
  let f1 = 0;
  while (f1 < 34 * 60 && hidden(env.w, 'result') && parseFloat(txt(env.w, 'hpText')) >= 100) {
    env.step(1, 16.67); f1++;
  }
  const hpStill = parseFloat(txt(env.w, 'hpText'));
  ok(hpStill < 100 || !hidden(env.w, 'result'),
    '原地不动会被妖物主动扑到掉血（首次挨打于 ' + (f1 / 60).toFixed(1) + 's，剩 ' + txt(env.w, 'hpText') + '）');
  env.step(8 * 60, 16.67);    // 再站 8 秒，血应继续掉
  ok(parseFloat(txt(env.w, 'hpText')) < hpStill || !hidden(env.w, 'result'),
    '继续站桩会持续掉血：' + txt(env.w, 'hpText'));

  /* ② 用游戏内设置里的"重新开始"换一个会躲的玩家 */
  env.w.document.getElementById('btnSettingsInGame').click();
  ok(!hidden(env.w, 'settings'), '游戏中可打开设置');
  ok(!hidden(env.w, 'btnResume') && !hidden(env.w, 'btnRestart') && !hidden(env.w, 'btnBackHome'),
    '游戏中设置含继续/重开/返回主页');
  ok(hidden(env.w, 'btnCloseSetHome'), '游戏中不显示主页版关闭按钮');

  const before = txt(env.w, 'timeText');
  env.step(120, 16.67);
  ok(txt(env.w, 'timeText') === before, '打开设置时游戏暂停（倒计时冻结）');

  const range = env.w.document.getElementById('volRange');
  range.value = '25';
  range.dispatchEvent(new env.w.Event('input'));
  ok(txt(env.w, 'volVal') === '25%', '音量滑块生效：' + txt(env.w, 'volVal'));

  const vib = env.w.document.getElementById('vibToggle');
  const vibOn = vib.classList.contains('on');
  vib.click();
  ok(vib.classList.contains('on') !== vibOn, '震动开关可切换');

  env.w.document.getElementById('btnRestart').click();
  ok(hidden(env.w, 'settings') && parseFloat(txt(env.w, 'hpText')) === 100,
    '重开后满血：' + txt(env.w, 'hpText'));
  env.step(60, 16.67);
  ok(txt(env.w, 'timeText') !== before, '重开后倒计时从 3:00 重新走');

  /* ③ 会躲的玩家：一路躲到通关 */
  const dodger = makeDodger(env);
  let frames = 0, minHp = 100, log = [];
  while (frames < 200 * 60 && hidden(env.w, 'result')) {
    env.step(1, 16.67, dodger.tick);
    frames++;
    const hp = parseFloat(txt(env.w, 'hpText'));
    if (!isNaN(hp)) minHp = Math.min(minHp, hp);
    if (frames % (15 * 60) === 0) log.push((frames / 60) + 's→' + txt(env.w, 'hpText'));
  }
  dodger.release();
  env.w.dispatchEvent(new env.w.KeyboardEvent('keyup', { key: 'a' }));
  env.w.dispatchEvent(new env.w.KeyboardEvent('keyup', { key: 'd' }));

  console.log('  血量轨迹：' + log.join('，') + '；最低 ' + minHp);
  ok(!hidden(env.w, 'result'), '撑满时长后出现结算（用了 ' + (frames / 60).toFixed(1) + ' 秒）');
  ok(txt(env.w, 'resTitle') === '通关', '会躲的玩家可以通关：结算标题为「通关」，实际为「' + txt(env.w, 'resTitle') + '」');
  console.log('  结算：积分 ' + txt(env.w, 'resScore') + '，击杀 ' + txt(env.w, 'resKills') +
    '，存活 ' + txt(env.w, 'resTime') + '，' + txt(env.w, 'resBest'));
  ok(txt(env.w, 'resTime') === '3:00', '存活时间为 3:00');
  ok(parseInt(txt(env.w, 'resScore'), 10) > 0, '通关时也有积分：' + txt(env.w, 'resScore'));

  // 实测掉落拾取率与挨打次数（这几个数才是手感对不对的真实依据）
  const GS = env.w.RD.G;
  const pick = GS.dropsSpawned ? GS.dropsPicked / GS.dropsSpawned : 0;
  console.log('  掉落 ' + GS.dropsSpawned + ' 个，捡到 ' + GS.dropsPicked + ' 个（' +
    (pick * 100).toFixed(0) + '%）；全程挨打 ' + GS.hits + ' 次；最终强化 ' + JSON.stringify(GS.buffs));
  ok(GS.dropsSpawned > 10, '通关过程中确实有掉落产生（' + GS.dropsSpawned + ' 个）');
  ok(pick > 0.15, '走位过程中能顺手捡到一部分掉落（' + (pick * 100).toFixed(0) + '% > 15%）');
  ok(GS.hits >= 1, '通关过程中确实挨过打（' + GS.hits + ' 次）—— 说明"没打死就会被撞"是真的');
  ok(GS.hits <= 14, '但挨打次数在可承受范围内（' + GS.hits + ' 次 ≤ 14）');

  // 主页 → 设置（应无游戏内按钮）
  env.w.document.getElementById('btnResHome').click();
  env.w.document.getElementById('btnHomeSettings').click();
  ok(!hidden(env.w, 'settings'), '主页可打开设置');
  ok(hidden(env.w, 'btnResume') && hidden(env.w, 'btnRestart') && hidden(env.w, 'btnBackHome'),
    '主页设置不含返回主页/重开按钮');
  ok(!hidden(env.w, 'btnCloseSetHome'), '主页设置用「关闭」按钮');
  env.w.document.getElementById('btnCloseSetHome').click();
  ok(hidden(env.w, 'settings'), '主页设置可关闭');
}

/* ═══════════════ 测试 C：设置持久化 ═══════════════ */
async function testC() {
  console.log('\n=== 测试 C：设置持久化 ===');
  const raw = fs.readFileSync(path.join(DIR, 'game.js'), 'utf8');
  ok(raw.indexOf("localStorage.setItem('rd_settings'") > 0, '设置写入 localStorage');
  ok(raw.indexOf("localStorage.getItem('rd_best')") > 0, '最高分读取 localStorage');
  const env = makeEnv();
  loadScripts(env.w);
  await waitHome(env);
  const range = env.w.document.getElementById('volRange');
  range.value = '10';
  range.dispatchEvent(new env.w.Event('input'));
  const saved = JSON.parse(env.w.localStorage.getItem('rd_settings') || '{}');
  ok(saved.volume === 0.1, '音量持久化：' + JSON.stringify(saved));
}

/* ═══════════════ 测试 D：移动方式 = 左右拖动（且绝不是"点哪走哪"） ═══════════════ */
async function testD() {
  console.log('\n=== 测试 D：左右拖动移动 ===');
  const env = makeEnv();
  env.w.Math.random = seeded(20260911);
  loadScripts(env.w);
  await waitHome(env);
  env.w.document.getElementById('btnStart').click();

  const D = env.w.RD;
  const canvas = env.w.document.getElementById('game');
  const screenX = () => D.project(D.G.x3d, D.CFG.playerY).pos.x;
  /* 指针事件只要带上 clientX 就够 —— 游戏的拖动只读这个（外加 pointerId 做指针捕获） */
  const pev = (type, x) => {
    const e = new env.w.Event(type, { bubbles: true, cancelable: true });
    e.clientX = x;
    e.clientY = 420;
    e.pointerId = 1;
    return e;
  };
  const down = (x) => canvas.dispatchEvent(pev('pointerdown', x));
  const move = (x) => canvas.dispatchEvent(pev('pointermove', x));
  const up = () => env.w.dispatchEvent(pev('pointerup', 0));

  ok(D.G.drag === false, '开局未处于拖动状态');

  /* ① 轻轻点一下（按下即抬起、不移动）不该让人物动 —— 这条直接钉死"点哪走哪"的旧行为 */
  const x0 = D.G.x3d;
  down(660);
  up();
  env.step(6, 16.67);
  ok(Math.abs(D.G.x3d - x0) < 1e-6, '轻点一下不移动（旧「点哪走哪」已移除）：x3d ' + D.G.x3d.toFixed(3));

  /* ② 拖动 1:1：手指横移多少像素，人物在屏幕上就横移多少像素 */
  let px0 = screenX();
  down(400);
  move(480);                       // +80px
  let px1 = screenX();
  ok(D.G.drag === true, '按下后进入拖动状态');
  ok(Math.abs((px1 - px0) - 80) < 3,
    '手指 +80px → 人物屏幕位移 ' + (px1 - px0).toFixed(1) + 'px（1:1 跟随，误差 <3px）');
  move(360);                       // 拖回去
  let px2 = screenX();
  ok(Math.abs((px2 - px1) + 120) < 3,
    '反向拖 -120px → 人物反向位移 ' + (px2 - px1).toFixed(1) + 'px');

  /* ③ 松手即停：抬起之后继续移动指针，人物不能再跟着跑 */
  up();
  env.step(2, 16.67);
  const hold = D.G.x3d;
  move(700);
  move(200);
  env.step(6, 16.67);
  ok(Math.abs(D.G.x3d - hold) < 1e-6, '松手后指针再动也不跟（松手即停）：x3d ' + D.G.x3d.toFixed(3));

  /* ④ 拖到边界要停住，不能越界 */
  down(450);
  move(450 + 2000);
  const left = D.G.x3d;
  ok(Math.abs(left - 2.05) < 1e-6, '持续右拖钳制在右边界：' + left.toFixed(3));
  move(450 - 2000);
  const right = D.G.x3d;
  ok(Math.abs(right + 2.05) < 1e-6, '持续左拖钳制在左边界：' + right.toFixed(3));
  up();
  /* 走一帧把这一轮的位移记账冲掉：真实运行时帧循环一直在跑，不会积压 */
  env.step(1, 16.67);

  /* ⑤ 侧倾/拖影用的速度量要真的动起来（拖过去之后 vx 应指向拖动方向） */
  down(450);
  move(560);
  env.step(1, 16.67);
  ok(D.G.vx > 0.5, '右拖后侧移速度为正（驱动侧倾与拖影）：vx ' + D.G.vx.toFixed(2));
  up();
  env.step(30, 16.67);
  ok(Math.abs(D.G.vx) < 0.5, '松手站定后侧移速度归零：vx ' + D.G.vx.toFixed(2));

  /* ⑥ 键盘没被砍掉 */
  const kx = D.G.x3d;
  env.w.dispatchEvent(new env.w.KeyboardEvent('keydown', { key: 'd' }));
  env.step(12, 16.67);
  env.w.dispatchEvent(new env.w.KeyboardEvent('keyup', { key: 'd' }));
  ok(D.G.x3d > kx + 0.5, '键盘 D 仍可移动：' + kx.toFixed(2) + ' → ' + D.G.x3d.toFixed(2));

  /* ⑦ 暂停（设置面板打开）时拖动不应生效 */
  env.w.document.getElementById('btnSettingsInGame').click();
  const px3 = D.G.x3d;
  down(300);
  move(600);
  env.step(4, 16.67);
  ok(Math.abs(D.G.x3d - px3) < 1e-6, '暂停中拖动无效：x3d ' + D.G.x3d.toFixed(3));
  up();
  env.w.document.getElementById('btnResume').click();
  env.w.close();
}

/* ═══════════════ 测试 E：路旁景物 ═══════════════
 * 装饰物是纯视觉的，但它的**契约**是可以钉死的：
 *   · 不能长到路面上（挡住妖物 / 干扰判断）
 *   · 世界必须稳定（同一里程每次看到的是同一棵树，不会随帧数抖动或重掷）
 *   · 数量有界（不随 scroll 越跑越多 → 没有泄漏）
 *   · 每个 kinds 里的名字都得真的存在（写错一个字母就是一整类物件永远不出现）
 * 靠 RD.sceneItems 枚举真实代码，不复制一份逻辑到测试里。 */
async function testE() {
  console.log('\n=== 测试 E：路旁景物 ===');
  const env = makeEnv();
  loadScripts(env.w);
  await waitHome(env);
  env.w.document.getElementById('btnStart').click();

  const D = env.w.RD;
  const SCENE = D.SCENE, PROPS = D.PROPS, CFG = D.CFG;

  /* 枚举一次，返回 [{kind,x3d,y3d,alpha,sx,sy}] */
  const collect = (scroll) => {
    const out = [];
    D.sceneItems(scroll, (kind, x3d, y3d, q, alpha) => {
      out.push({ kind, x3d, y3d, alpha, sx: q.pos.x, sy: q.pos.y });
    });
    return out;
  };

  /* ① kinds 里不能有拼错的名字 */
  const bad = [];
  SCENE.belts.forEach((b) => b.kinds.forEach((k) => { if (!PROPS[k]) bad.push(k); }));
  ok(bad.length === 0, 'belts 里的物件名都存在于 PROPS' + (bad.length ? '（未知：' + bad.join(',') + '）' : ''));

  /* ② 世界稳定：同一里程枚举两次，结果必须逐项完全一致 */
  const a1 = collect(137.5), a2 = collect(137.5);
  const sig = (arr) => arr.map((o) => o.kind + ':' + o.x3d.toFixed(4) + ':' + o.y3d.toFixed(3)).join('|');
  ok(sig(a1) === sig(a2), '同一里程两次枚举完全一致（' + a1.length + ' 项）');
  ok(a1.length > 0, '该里程确实有景物（' + a1.length + ' 项）');

  /* ③ 推进一个槽位后，整体只是"平移"，不该整片重掷。
   *    判据：深度相同的那批物件，种类与横向位置应当大量重合。 */
  const step1 = collect(137.5 + SCENE.belts[0].spacing);
  const keyOf = (o) => o.kind + '@' + o.x3d.toFixed(2);
  const setA = new Set(a1.map(keyOf));
  const reuse = step1.filter((o) => setA.has(keyOf(o))).length / Math.max(1, step1.length);
  ok(reuse > 0.45, '前进一个槽位后景物大面积复用（复用率 ' + (reuse * 100).toFixed(0) + '%）→ 世界是钉住的，不是每帧重掷');

  /* ④ 绝不侵入路面：|x3d| 减去该物件自身的横向半径，必须仍留在路面之外。
   *    这张表是照 PROPS 里的绘制代码逐个算出来的**最坏情况**（参数取最大），
   *    不是拍的估值 —— 第一版我就凭印象填，结果漏掉了"竹叶其实伸到 1.06 米"，
   *    测试因此放过了真实的越界。
   *    允许最多越界 0.30 米：竹叶/灌木梢探到路沿上方一点是刻意的，看着自然；
   *    超过这个量就说明 minX 或某个物件被改大了，必须拦住。 */
  const halfWidth = {
    grass: 0.32,      // 草叶摆幅 ±0.32
    bush: 0.50,       // w 最大 1.0
    rock: 0.70,       // w 最大 1.4
    bamboo: 0.86,     // 竹杆 ±0.34 再 + 竹叶 0.52
    pine: 1.52,       // 树高 7.4 × 冠幅系数 0.41
    broadleaf: 2.71,  // 树高 5.6 × 0.74 × 起伏 1.2 + 偏移 0.22
    banner: 0.44,
    hut: 2.15,        // 屋宽 4.3
    gate: 4.08,       // 檐口 ±w×0.92
    pagoda: 2.30
  };
  const roadHalf = CFG.roadWidth / 2;
  const OVERHANG = 0.30;
  let worst = null, worstGap = Infinity;
  for (const scroll of [0, 60, 400, 1500, 9000]) {
    for (const o of collect(scroll)) {
      const gap = Math.abs(o.x3d) - (halfWidth[o.kind] || 0) - roadHalf;
      if (gap < worstGap) { worstGap = gap; worst = o.kind + ' x=' + o.x3d.toFixed(2) + ' @scroll' + scroll; }
    }
  }
  console.log('  最贴近路面的景物：' + worst + '（' + (worstGap >= 0 ? '离路面还有 ' + worstGap.toFixed(2) + ' 米'
    : '探到路沿上方 ' + (-worstGap).toFixed(2) + ' 米') + '）');
  ok(worstGap >= -OVERHANG, '没有景物明显压到路面上（最坏 ' + worstGap.toFixed(2) +
    ' 米，允许探入 ' + OVERHANG + ' 米以内）');

  /* ⑤ 数量有界：scroll 拉到极远，可见物件数必须仍落在同一区间里。
   *    注意不能断言"恒定" —— 每条带是按等间距槽位取的，进出视野的槽位是否被
   *    density 命中是独立事件，所以总数本身就有约 ±8% 的二项波动（实测 σ≈8.6 个）。
   *    这里要抓的是**随里程漂移**（比如 maxDepth 依赖 scroll，物件越铺越多）。 */
  const SCROLLS = [];
  for (let i = 0; i < 40; i++) SCROLLS.push(i * 12345);
  const counts = SCROLLS.map((s) => collect(s).length);
  const visible = SCROLLS.map((s) => collect(s).filter((o) => o.sx > -140 && o.sx < 900 + 140).length);
  const mn = Math.min(...counts), mx = Math.max(...counts);
  const vmn = Math.min(...visible), vmx = Math.max(...visible);
  console.log('  40 个里程（0 ~ 48 万米）的景物数：' + mn + ' ~ ' + mx + '，其中屏幕内 ' + vmn + ' ~ ' + vmx);
  ok(mn > 80 && mx < 180, '枚举总数始终落在 80~180 区间（实测 ' + mn + '~' + mx + '）→ 不随里程增长');
  ok(vmn > 70, '任意里程下屏幕内都有足够景物（最少 ' + vmn + ' 个）→ 不会开着开着两侧空掉');
  ok(vmx / vmn < 1.6, '屏幕内数量波动 ' + ((vmx / vmn - 1) * 100).toFixed(0) + '%（<60%）→ 密度不漂移');

  /* ⑥ 雾值必须落在 [fogMin, 1]：越远越淡，但绝不消失 */
  const alphas = collect(137.5).map((o) => o.alpha);
  ok(Math.min(...alphas) >= SCENE.fogMin - 1e-9, '最淡的景物也不会淡于 fogMin=' + SCENE.fogMin);
  ok(Math.max(...alphas) <= 1 + 1e-9, '最浓的景物不会超过 1');
  const deep = collect(137.5).filter((o) => o.y3d > 300).map((o) => o.alpha);
  ok(deep.every((a) => a >= SCENE.fogMin), '300 米外的远景物仍保留 ' + SCENE.fogMin + ' 的不透明度（地平线附近不会空掉）');

  /* ⑦ 深度分层：屏幕纵向必须被铺开，不能全挤在地平线或者全挤在底部。
   *    把屏幕按深度切成三段，每段都该有东西。 */
  const items = collect(137.5).filter((o) => o.sx > -140 && o.sx < 900 + 140);
  const band = (lo, hi) => items.filter((o) => o.y3d >= lo && o.y3d < hi).length;
  const near = band(0, 30), mid = band(30, 120), far = band(120, 1e9);
  console.log('  近景(0~30m) ' + near + ' 个 / 中景(30~120m) ' + mid + ' 个 / 远景(>120m) ' + far + ' 个');
  ok(near > 0 && mid > 0 && far > 0, '近 / 中 / 远三段都有景物 —— 两侧不会出现整段空白');

  env.w.close();
}

/* ═══════════════ 测试 F：词条图标行与属性面板 ═══════════════
 * 起因是用户的抱怨："身上有什么 buff、数值各自多少、武器什么效果完全不知道"。
 * 所以这一组钉的是"看得见 + 数字对得上"：
 *   · 图标行与血条同宽（同一张卡片的内宽），溢出时从左往右、从下往上换行；
 *   · 槽位固定（武器 1 格 + 词条 4 格），未获得只变灰、不消失；
 *   · 角标写的是累计数值（"+45%"），不是层数；
 *   · 整条可点 → 面板展开/收起，而且轻点不动人、**从它身上拖还能移动人物**；
 *   · 面板里的数字必须等于开火真正用的那份 playerStats()，不能是另一套说法。 */
async function testF() {
  console.log('\n=== 测试 F：词条图标行与属性面板 ===');
  const env = makeEnv();
  env.w.Math.random = seeded(4242);
  loadScripts(env.w);
  await waitHome(env);
  env.w.document.getElementById('btnStart').click();

  const D = env.w.RD;
  const doc = env.w.document;
  const strip = doc.getElementById('statStrip');
  const icoRow = doc.getElementById('icoRow');
  const hpBar = doc.querySelector('#statStrip .hp-bar');
  const panel = doc.getElementById('statPanel');
  const arrow = doc.getElementById('statsArrow');

  /* 指针事件只要 clientX 和 pointerId 就够（拖动和死区判定都只读这两个） */
  const pev = (type, x) => {
    const e = new env.w.Event(type, { bubbles: true, cancelable: true });
    e.clientX = x; e.clientY = 840; e.pointerId = 1;
    return e;
  };
  const tap = (x) => { strip.dispatchEvent(pev('pointerdown', x)); env.w.dispatchEvent(pev('pointerup', x)); };
  const screenX = () => D.project(D.G.x3d, D.CFG.playerY).pos.x;
  const icons = () => Array.prototype.slice.call(icoRow.querySelectorAll('.buff-ico'));
  const badgeOf = (i) => { const l = icons()[i].querySelector('.lv'); return l ? l.textContent : null; };

  /* ① 宽度契约：图标行与血条是同一张卡片的兄弟，两者都没有自己的宽度
   *    → 自然都等于卡片内宽，也就是"图标行最多和血条一样宽"。
   *    jsdom 不做排版，量不到像素，所以这里校验的是结构 + 样式表里的真实声明。 */
  ok(icoRow.parentElement === strip && hpBar.parentElement === strip,
    '图标行与血条同属一张卡片 → 宽度都等于卡片内宽');
  const stIco = env.w.getComputedStyle(icoRow);
  ok(stIco.flexWrap === 'wrap-reverse',
    '图标行溢出时向上换行：flex-wrap = ' + stIco.flexWrap + '（从左往右铺、铺满往上换行）');
  const css = Array.prototype.map.call(doc.styleSheets, (s) => {
    try { return Array.prototype.map.call(s.cssRules, (r) => r.cssText).join('\n'); } catch (e) { return ''; }
  }).join('\n').replace(/\s+/g, '');
  ok(/\.ico-row\{[^}]*flex-wrap:wrap-reverse/.test(css), '样式表里 .ico-row 确实是 flex-wrap:wrap-reverse');
  ok(!/\.ico-row\{[^}]*[^-]width:/.test(css), '图标行没有单独设宽度 → 与血条严格同宽');

  /* ② 槽位固定：武器 1 格（不可叠加）+ 每个词条 1 格 */
  const want = 1 + D.BUFF_LIST.length;
  ok(icons().length === want, '图标行固定 ' + want + ' 格（武器 1 + 词条 ' + D.BUFF_LIST.length + '）：' + icons().length);
  ok(icons().every((e) => e.querySelector('svg')), '每一格都自带 SVG 图标（不靠 emoji，字体缺字也不会开天窗）');
  ok(icons().filter((e) => e.classList.contains('off')).length === D.BUFF_LIST.length,
    '开局 ' + D.BUFF_LIST.length + ' 个词条格全部变灰但不消失（位置稳定，便于形成肌肉记忆）');
  ok(badgeOf(0) === null, '武器格不带角标（武器不可叠加）');

  /* ③ 角标 = 累计数值，不是层数 */
  D.G.buffs = { atk: 3, rate: 2, crit: 4, critDmg: 2 };
  env.step(5, 16.67);                       // 跑几帧让 updateHud 落地
  ok(badgeOf(1) === '+45%', '攻击力 3 层 → 角标 +45%：' + badgeOf(1));
  ok(badgeOf(2) === '+24%', '攻速 2 层 → 角标 +24%：' + badgeOf(2));
  ok(badgeOf(3) === '+24%', '暴击率 4 层 → 角标 +24%：' + badgeOf(3));
  ok(badgeOf(4) === '+0.50', '暴击伤害 2 层 → 角标 +0.50：' + badgeOf(4));
  ok(icons().slice(1).every((e) => !e.classList.contains('off')), '拿到层数后对应格子不再变灰');

  /* ④ 角标上的数必须能在 playerStats 里对上（UI 不是另写一套算法） */
  const st = D.playerStats();
  ok(Math.abs(st.crit - 0.29) < 1e-9, '暴击率 5% + 4×6% = 29%：' + (st.crit * 100).toFixed(0) + '%');
  ok(Math.abs(st.critMul - 2.0) < 1e-9, '暴击倍率 1.50 + 2×0.25 = 2.00×：' + st.critMul.toFixed(2));
  ok(Math.abs(st.dmg - 13 * 1.45) < 1e-9, '单发伤害 13 × (1+3×15%) = ' + st.dmg.toFixed(2));

  /* ⑤ 整条可点：展开 / 收起。轻点不动人，而且展开时会把时间冻住 */
  ok(D.G.statsOpen === false && panel.classList.contains('hidden'), '开局属性面板是收起的');
  const x0 = D.G.x3d;
  tap(240);
  env.step(4, 16.67);
  ok(Math.abs(D.G.x3d - x0) < 1e-6, '轻点信息条不移动人物：x3d ' + D.G.x3d.toFixed(3));
  ok(D.G.statsOpen === true && !panel.classList.contains('hidden'), '点一下信息条 → 面板展开');
  ok(arrow.textContent === '属性 ▴', '箭头跟着翻转：' + arrow.textContent);
  ok(D.state === 'paused', '展开面板时冻结时间（面板盖在人物身上，不冻就没法边看边躲）');
  tap(240);
  ok(D.G.statsOpen === false && panel.classList.contains('hidden'), '再点一下 → 面板收起');
  ok(D.state === 'playing', '收起面板后自动恢复计时');

  /* ⑥ 从信息条上横向拖必须"交棒"给游戏 ——
   *    拇指天然压在屏幕底部，这条不成立的话最常用的操作会直接失效。
   *    所以这一段必须在面板收起（playing）时做。 */
  const s0 = screenX();
  strip.dispatchEvent(pev('pointerdown', 300));
  strip.dispatchEvent(pev('pointermove', 400));            // +100px，越过 7px 死区
  const s1 = screenX();
  ok(D.G.drag === true, '在信息条上横向拖动会交棒给游戏（进入拖动状态）');
  ok(Math.abs((s1 - s0) - 100) < 3,
    '从信息条上拖 +100px → 人物屏幕位移 ' + (s1 - s0).toFixed(1) + 'px（与在画布上拖一致，死区不丢位移）');
  env.w.dispatchEvent(pev('pointerup', 400));
  env.step(4, 16.67);
  ok(D.G.statsOpen === false, '拖动不会误触发开关（7px 死区判定为拖动而非点击）');
  ok(D.G.drag === false, '抬起后退出拖动状态');

  /* ⑦ 面板数字 == playerStats（同一个来源，不可能"说明和实现不一致"） */
  tap(240);
  const rows = D.statsRows();
  const find = (k) => { const r = rows.filter((x) => x.k === k)[0]; return r ? r.v : null; };
  const st2 = D.playerStats();
  ok(find('单发伤害') === st2.dmg.toFixed(1), '面板单发伤害 = playerStats().dmg：' + find('单发伤害'));
  ok(find('攻击间隔') === st2.cd.toFixed(2) + ' 秒', '面板攻击间隔 = playerStats().cd：' + find('攻击间隔'));
  ok(find('期望每秒伤害') === st2.dps.toFixed(1), '面板期望 dps = playerStats().dps：' + find('期望每秒伤害'));
  const dpsWant = st2.dmg * st2.w.shots * (1 + st2.crit * (st2.critMul - 1)) / st2.cd;
  ok(Math.abs(st2.dps - dpsWant) < 1e-9, 'dps 口径 = 单发×弹道×(1+暴击×额外倍率)÷间隔 = ' + dpsWant.toFixed(1));
  ok(rows.filter((x) => x.k && x.k.indexOf('+') >= 0).length === 4, '4 个词条全部列进面板');
  ok(rows.some((x) => x.k === '攻击力 +3 层'), '面板同时给出层数与数值，例如「攻击力 +3 层」');

  const ptext = panel.textContent.replace(/\s+/g, ' ');
  ok(ptext.indexOf('伤害 ×1.45') >= 0, '面板里读到攻击力的实际数值「伤害 ×1.45」');
  ok(ptext.indexOf('暴击率 29%') >= 0, '面板里读到暴击率的实际数值「暴击率 29%」');
  ok(ptext.indexOf('暴击倍率 2.00×') >= 0, '面板里读到暴击倍率的实际数值「暴击倍率 2.00×」');
  ok(ptext.indexOf('武器 · 飞剑') >= 0, '面板里点明了当前武器：武器 · 飞剑');

  /* ⑧ 面板里的「收起」也能关 */
  doc.getElementById('statsClose').click();
  ok(D.G.statsOpen === false && panel.classList.contains('hidden'), '面板里的「收起 ▴」同样能关闭');

  /* ⑨ 换武器后：图标、信息条、面板三处一起跟上，且给出穿透这类关键差异 */
  D.G.weapon = 'cloud';
  env.step(5, 16.67);
  ok(doc.getElementById('weaponName').textContent === '穿云剑',
    '信息条上的武器名同步：' + doc.getElementById('weaponName').textContent);
  tap(240);
  ok(panel.textContent.indexOf('可穿 3 个目标') >= 0, '面板给出武器的关键差异（穿云剑：可穿 3 个目标）');
  ok(D.statsRows().filter((x) => x.k === '弹道')[0].v.indexOf('直线') >= 0, '单发武器标为直线弹道');
  tap(240);

  /* ⑩ 状态复位：打开设置会自动收起，重开一局不继承 */
  tap(240);
  ok(D.G.statsOpen === true, '先展开面板备用');
  doc.getElementById('btnSettingsInGame').click();
  ok(D.G.statsOpen === false, '打开设置时面板自动收起（回来不会一头撞在面板上）');
  doc.getElementById('btnRestart').click();
  env.step(4, 16.67);
  ok(D.G.statsOpen === false, '重新开始后新一局不继承展开状态');
  ok(icons().filter((e) => e.classList.contains('off')).length === D.BUFF_LIST.length,
    '新一局图标格回到全部变灰');
  ok(doc.getElementById('weaponName').textContent === '飞剑', '新一局武器回到飞剑');

  /* ⑪ Esc 的优先级：先收面板，而不是去开关设置。
   *    否则会出现"面板还盖着人物，游戏却在跑"的错位状态。 */
  tap(240);
  ok(D.G.statsOpen === true, '再展开一次备用');
  env.w.dispatchEvent(new env.w.KeyboardEvent('keydown', { key: 'Escape' }));
  ok(D.G.statsOpen === false, 'Esc 收起属性面板（而不是弹设置）');
  ok(D.state === 'playing' && doc.getElementById('settings').classList.contains('hidden'),
    'Esc 收面板后恢复计时，且设置弹层没被打开');

  env.w.close();
}

/* ═══════════════ 测试 G：老浏览器 / 微信内置浏览器的触摸兜底 ═══════════════
 * 背景：Pointer Events 要 Chrome 55 / iOS 13 才有。安卓微信内置浏览器的旧 X5 内核是
 * Chromium 53，pointer* 一个都不派发。没有兜底的话，在那个环境里游戏是"画面正常但人物
 * 完全不动、属性面板也点不开"—— 而这个坑只会在别人手机上复现，自己手机测不出来。
 * 这条测试把一个"没有 PointerEvent"的 window 整个造出来验： */
async function testG() {
  console.log('\n=== 测试 G：无 PointerEvent 环境的触摸兜底 ===');

  /* ① 反过来先验：现代浏览器下不能同时挂 pointer 和 touch，
   *    否则一次触摸会被两条路径各处理一遍，位移直接翻倍（拖 100px 走 200px）。 */
  const modern = makeEnv();
  modern.w.Math.random = seeded(20260916);
  loadScripts(modern.w);
  await waitHome(modern);
  modern.w.document.getElementById('btnStart').click();
  const M = modern.w.RD;
  const mCanvas = modern.w.document.getElementById('game');
  const mt = (type, x) => {
    const e = new modern.w.Event(type, { bubbles: true, cancelable: true });
    e.touches = (x === undefined) ? [] : [{ clientX: x, clientY: 420, identifier: 7 }];
    return e;
  };
  ok(typeof modern.w.PointerEvent === 'function', '环境自检：jsdom 提供 PointerEvent');
  const mx0 = M.G.x3d;
  mCanvas.dispatchEvent(mt('touchstart', 400));
  mCanvas.dispatchEvent(mt('touchmove', 520));
  modern.step(2, 16.67);
  ok(M.G.drag === false && Math.abs(M.G.x3d - mx0) < 1e-6,
    '有 PointerEvent 时不注册 touch 监听（不会双触发、位移不翻倍）');
  modern.w.close();

  /* ② 造一个 Chromium 53 那样的世界：把 window.PointerEvent 提前删掉。
   *    必须在 loadScripts 之前删 —— 事件源是在 bindInput 里一次性决定的。 */
  const old = makeEnv();
  delete old.w.PointerEvent;
  ok(typeof old.w.PointerEvent === 'undefined', '环境自检：已模拟成无 PointerEvent 的旧内核');
  old.w.Math.random = seeded(20260916);
  loadScripts(old.w);
  await waitHome(old);

  const D = old.w.RD;
  const doc = old.w.document;
  const canvas = doc.getElementById('game');
  const strip = doc.getElementById('statStrip');
  const screenX = () => D.project(D.G.x3d, D.CFG.playerY).pos.x;
  const tev = (type, x, y) => {
    const e = new old.w.Event(type, { bubbles: true, cancelable: true });
    e.touches = (x === undefined) ? [] : [{ clientX: x, clientY: y === undefined ? 420 : y, identifier: 7 }];
    return e;
  };
  const tdown = (x) => canvas.dispatchEvent(tev('touchstart', x));
  const tmove = (x) => canvas.dispatchEvent(tev('touchmove', x));
  const tup = () => old.w.dispatchEvent(tev('touchend'));   // touchend 的 touches 是空的

  doc.getElementById('btnStart').click();
  ok(D.state === 'playing', '旧内核下也能正常进入对局（与事件源无关）');

  /* 落在画布上的触摸必须能拖动人物，且仍是 1:1 */
  const px0 = screenX();
  tdown(380);
  ok(D.G.drag === true, '触摸按下进入拖动状态（旧内核可用）');
  tmove(460);                                   // +80px
  const px1 = screenX();
  ok(Math.abs((px1 - px0) - 80) < 3,
    '触摸 +80px → 人物屏幕位移 ' + (px1 - px0).toFixed(1) + 'px（1:1，误差 <3px）');
  tup();
  old.step(2, 16.67);
  const held = D.G.x3d;
  tmove(900);
  old.step(2, 16.67);
  ok(Math.abs(D.G.x3d - held) < 1e-6, '触摸抬起即停（touchend 有效）');

  /* ③ 信息条在触摸环境下同样要能"点开/收起"属性面板。
   *    面板是 HUD 的唯一入口，点不开等于玩家看不到自己的属性 —— 上一轮刚修过同类缺陷。 */
  const tapStrip = () => {
    strip.dispatchEvent(tev('touchstart', 240, 820));
    old.w.dispatchEvent(tev('touchend'));
  };
  ok(D.G.statsOpen === false, '开局属性面板是收起的');
  tapStrip();
  ok(D.G.statsOpen === true, '触摸点一下信息条能展开属性面板');
  tapStrip();
  ok(D.G.statsOpen === false, '再点一下能收起');

  /* ④ 拇指压在信息条上横挪：应当判定为"拖动"而不是"点击"，人物跟着走且面板不弹开。
   *    先把人物挪回路中间 —— 上面那 80px 已经把他推到了右边界 2.05m，
   *    在这里再往右拖会有大半截被边界钳掉，量出来的位移就不是拖动量了。 */
  D.G.x3d = 0;
  old.step(1, 16.67);
  const px2 = screenX();
  strip.dispatchEvent(tev('touchstart', 300, 820));
  strip.dispatchEvent(tev('touchmove', 400, 820));            // +100px
  const px3 = screenX();
  ok(Math.abs((px3 - px2) - 100) < 3,
    '从信息条上触摸拖动 +100px → 人物位移 ' + (px3 - px2).toFixed(1) + 'px（死区后不丢位移）');
  ok(D.G.statsOpen === false, '拖动不会被误判成点击（面板没被弹开）');
  old.w.dispatchEvent(tev('touchend'));
  old.step(2, 16.67);
  const held2 = D.G.x3d;
  strip.dispatchEvent(tev('touchmove', 700, 820));            // 已抬手，不该再跟
  old.step(2, 16.67);
  ok(Math.abs(D.G.x3d - held2) < 1e-6, '信息条上抬手后不再跟随触摸');

  old.w.close();
}

(async function () {
  try {
    await testA();
    await testB();
    await testC();
    await testD();
    await testE();
    await testF();
    await testG();
  } catch (e) {
    fail++;
    console.log('  [ERROR] ' + (e && e.stack ? e.stack.split('\n').slice(0, 4).join('\n') : e));
  }
  console.log('\n==== 结果: ' + pass + ' 通过 / ' + fail + ' 失败 ====');
  process.exit(fail ? 1 : 0);
})();
