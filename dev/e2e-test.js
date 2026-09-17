/* 端到端逻辑验证：真实加载 index.html + projector.js + game.js，
 * 用 stub 的 Canvas 2D 上下文跑完整帧循环，验证两条通关路径与设置面板。 */
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const DIR = 'C:/Users/Administrator/Desktop/road-defender';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* jsdom 没带 canvas 实现，商城的缩略图会让它刷一屏
 * "HTMLCanvasElement's getContext() method: without installing the canvas npm package"。
 * 那是**预期内**的降级（renderMapThumb 里 `if (!c2 || !tw) return;` 兜住了，真机上照画不误），
 * 所以只滤掉这一条 —— 把所有 jsdomError 一起吞掉的话，真正的错误也会被淹。
 * 注意 jsdom 29 的 API 是 forwardTo(console, {jsdomErrors})，老版本叫 sendTo。 */
const vconsole = new VirtualConsole();
vconsole.forwardTo(console, { jsdomErrors: 'none' });
vconsole.on('jsdomError', (e) => {
  if (String((e && e.message) || e).indexOf('getContext') >= 0) return;
  console.error('  [jsdom] ' + ((e && e.message) || e));
});

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
    url: 'http://localhost/',
    virtualConsole: vconsole
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

  /* 枚举一次，返回 [{kind,x3d,y3d,alpha,sx,sy}]。mapKey 传了就枚举那张地图的景物。 */
  const collect = (scroll, mapKey) => {
    const out = [];
    D.sceneItems(scroll, (kind, x3d, y3d, q, alpha) => {
      out.push({ kind, x3d, y3d, alpha, sx: q.pos.x, sy: q.pos.y });
    }, mapKey);
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
   *    ⚠ 往 PROPS 里加新物件时**必须同时往这张表里加一行**：查不到的名字按 0 算，
   *    物件于是可以悄悄怼到路面上而不报错（沙漠那张图的几种就是这么补进来的）。
   *    允许最多越界 0.30 米：竹叶/灌木梢探到路沿上方一点是刻意的，看着自然；
   *    超过这个量就说明 minX 或某个物件被改大了，必须拦住。
   *    ⚠ 逐张地图跑，不能只跑当前装备的那张 —— 沙漠图有 7 种独有物件，
   *    只测夜景的话它们一次都不会被枚举到。 */
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
    pagoda: 2.30,
    /* ── 以下 10 种是沙漠图专属 ── */
    cactus: 0.64,     // 右臂外沿 w*0.5(0.21) + u*0.26 − u*0.09 + 臂宽 u*0.26
    cactusClump: 0.86, // 最宽一丛：5 片摊开 0.72w0 + 半片 0.27w0（w0 最大 0.74）
    yucca: 0.45,      // 剑叶尖 ±u*0.42 再 + 线宽一半
    deadbush: 0.40,   // 枯枝尖 ±u*0.38 再 + 线宽一半
    dune: 0.70,       // 丘宽最大 1.4 → 半径 0.7（迎风坡那瓣 w*0.38 更窄）
    mesa: 2.30,       // 台面宽最大 4.6 → ±2.3
    ruin: 0.83,       // 柱宽 0.96，脚边碎块外沿 w*0.86
    tent: 1.50,       // 帐宽最大 3.0 → ±1.5（支杆在 w*0.02，可忽略）
    palm: 1.99,       // 干倾斜 0.49（lean 0.3 × 高 5.8 × 0.28）+ 叶展 1.5（frond 1.2 × 1.25）
    obelisk: 0.42      // 高 6.4 × 0.13 → 宽 0.83 → ±0.42
  };
  const roadHalf = CFG.roadWidth / 2;
  const OVERHANG = 0.30;
  const MAPKEYS = D.MAPS.map((m) => m.key);
  for (const mk of MAPKEYS) {
    let worst = null, worstGap = Infinity;
    for (const scroll of [0, 60, 400, 1500, 9000]) {
      for (const o of collect(scroll, mk)) {
        const gap = Math.abs(o.x3d) - (halfWidth[o.kind] || 0) - roadHalf;
        if (gap < worstGap) { worstGap = gap; worst = o.kind + ' x=' + o.x3d.toFixed(2) + ' @scroll' + scroll; }
      }
    }
    console.log('  [' + mk + '] 最贴近路面的景物：' + worst + '（' + (worstGap >= 0 ? '离路面还有 ' + worstGap.toFixed(2) + ' 米'
      : '探到路沿上方 ' + (-worstGap).toFixed(2) + ' 米') + '）');
    ok(worstGap >= -OVERHANG, '[' + mk + '] 没有景物明显压到路面上（最坏 ' + worstGap.toFixed(2) +
      ' 米，允许探入 ' + OVERHANG + ' 米以内）');
  }
  /* ④b 表里不许有"查不到名字"的漏网：每张地图 kinds 里出现的种类都必须在表里 */
  const missing = [];
  MAPKEYS.forEach((mk) => D.beltsFor(mk).forEach((b) => b.kinds.forEach((k) => {
    if (halfWidth[k] === undefined) missing.push(mk + ':' + k);
  })));
  ok(missing.length === 0, '每张地图的每种物件都登记了横向半宽' +
    (missing.length ? '（漏了：' + missing.join('、') + ' —— 漏一个就等于放它去压路面）' : ''));

  /* ④c 每张地图的景物必须**真的是那张图的种类**，而且真的有东西。
   *     只换颜色不换种类的话，沙漠图里会长出竹林 —— 那种"贴图换了、模型没换"
   *     的错看着像美术问题，其实是数据没生效。 */
  const kindSet = (mk) => {
    const s = new Set();
    for (const sc of [0, 137.5, 900, 5000]) collect(sc, mk).forEach((o) => s.add(o.kind));
    return s;
  };
  MAPKEYS.forEach((mk) => {
    const ks = kindSet(mk);
    ok(ks.size >= 3, '[' + mk + '] 该地图确实铺出了景物（' + ks.size + ' 种：' +
      Array.from(ks).slice(0, 8).join('/') + '）');
  });
  const desertKinds = kindSet('desert');
  const nightKinds = kindSet('night');
  ok(desertKinds.has('cactus') && desertKinds.has('dune') && desertKinds.has('mesa'),
    '沙漠图里出现了沙漠专属物件（cactus/dune/mesa）');
  ok(!nightKinds.has('cactus') && !nightKinds.has('mesa') && !nightKinds.has('obelisk'),
    '夜景里不会冒出仙人掌/台地/方尖碑（换地图真的换了种类，不是只换了颜色）');
  /* ④d 沙漠里不许长树 —— 这条是用户直接点出来的："沙漠里怎么会有树"。
   *     上一版沙漠的第二/三带铺的是 palm、第一带还塞了两个 grass，
   *     画出来是一片棕榈林；更糟的是棕榈叶读到了**夜图**的深绿（见 ④e）。
   *     查 beltsFor 的**数据**而不是采样出来的 kindSet：采样只有 4 个里程，
   *     碰巧没抽到某个种类就等于放过它。 */
  const TREE_KINDS = ['pine', 'broadleaf', 'bamboo', 'palm', 'grass', 'bush'];
  const desertFlat = D.beltsFor('desert').reduce((a, b) => a.concat(b.kinds), []);
  const treesInDesert = TREE_KINDS.filter((k) => desertFlat.indexOf(k) >= 0);
  ok(treesInDesert.length === 0, '沙漠里不种树也不长草（查到的：' +
    (treesInDesert.join('/') || '无') + '）');
  const nCactus = desertFlat.filter((k) => k === 'cactus' || k === 'cactusClump').length;
  ok(nCactus >= 3, '仙人掌是沙漠的主体：' + desertFlat.length + ' 个槽位里占 ' + nCactus + ' 个');
  ok(nightKinds.has('pine') || nightKinds.has('broadleaf'),
    '别的地图照旧有树 —— 修的是沙漠，不是把树从整个世界删掉');

  /* ④e 主题完整性：某张地图用到的**每一种道具**，它读的每个 th.xxx 都必须在
   *     **这张图自己的 over.P** 里显式写过。
   *     为什么非要"显式"：主题是 deepMerge 出来的，缺的键会安静地回落到 BASE_THEME。
   *     这次的 bug 正是如此 —— 新加的沙漠道具只把色值写在了 BASE_THEME，
   *     于是沙漠图的仙人掌与棕榈叶读到的其实是**夜图**的深绿，在黄沙上绿得刺眼，
   *     而代码一个错都不报；沙丘/台地那几个碰巧也是沙色才没露馅，纯属运气。
   *     依赖关系直接从 PROPS 源码里扫，省得再手抄一张会和代码走散的对照表。 */
  const propColors = {};
  (() => {
    const src = fs.readFileSync(path.join(DIR, 'game.js'), 'utf8');
    const s0 = src.indexOf('var PROPS = {');
    const body = src.slice(s0, src.indexOf('\n  };', s0));
    const parts = body.split(/\n    (\w+): function \(bx, by, u, r\) \{/);
    for (let i = 1; i < parts.length; i += 2) {
      const ks = {};
      /* ⚠ 必须带 \b：不加的话 Math.floor / Math.max / Math.PI 里的
       *   "…th." 会被当成主题键扫出来（Math 的尾巴正好是 th），
       *   于是三张图一起报"缺 floor/max/PI"这种根本不存在的色值。 */
      (parts[i + 1].match(/\bth\.([A-Za-z0-9_]+)/g) || []).forEach((m) => { ks[m.slice(3)] = 1; });
      propColors[parts[i]] = Object.keys(ks);
    }
  })();
  ok(Object.keys(propColors).length >= 15, '从 PROPS 源码里扫出 ' +
    Object.keys(propColors).length + ' 种道具的配色依赖');
  MAPKEYS.forEach((mk) => {
    const md = D.MAPS.filter((x) => x.key === mk)[0];
    const exp = (md && md.over && md.over.P) || D.theme(mk).P;   // 基准图没有 over，它自己就是源
    const merged = D.theme(mk).P;
    const notExp = {}, undef = {};
    D.beltsFor(mk).reduce((a, b) => a.concat(b.kinds), []).forEach((k) => {
      (propColors[k] || []).forEach((key) => {
        if (exp[key] === undefined) notExp[k + '.' + key] = 1;
        if (merged[key] === undefined) undef[k + '.' + key] = 1;
      });
    });
    const a = Object.keys(notExp), b = Object.keys(undef);
    ok(a.length === 0, '[' + mk + '] 用到的色值都在本图 over.P 里显式写过' +
      (a.length ? '（缺 ' + a.join('、') + ' —— 会静默回落到基准主题，画出来是别张图的颜色）' : ''));
    ok(b.length === 0, '[' + mk + '] 合并后的主题里没有 undefined 色值' +
      (b.length ? '（' + b.join('、') + '）' : ''));
  });

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

/* ═══════════════ 测试 H：齐射弹道 ═══════════════
 * 多发武器（双股剑 / 三才剑阵）的散布口径必须是"米"，不是"相邻两发的夹角"。
 * 这是踩过的坑：原先用固定夹角 0.12 / 0.20 弧度，而妖物要到 17 米（ATTACK.range）
 * 才进入交火 —— 0.20 弧度在 17 米处横向偏 17·tan(0.20) = 3.45 米，
 * 而妖物判定半径只有 0.76 米（半径 0.44 + 弹道 0.32），路半宽也才 2 米。
 * 于是"开了枪、子弹全从怪旁边飞过去"：双股剑 17 米外两发全空、三才剑阵永远只中一发。
 *
 * 这条用例不看代码怎么写，只看结果：每帧挤掉系统刷的怪、只留一只钉死位置的靶子，
 * 开一枪，数实际命中了几发。用的是游戏真实的命中判定，不复制一份逻辑进来。 */
async function testH() {
  console.log('\n=== 测试 H：齐射弹道（多发武器必须全部命中）===');
  const env = makeEnv();
  env.w.Math.random = seeded(909);
  loadScripts(env.w);
  await waitHome(env);
  env.w.document.getElementById('btnStart').click();

  const D = env.w.RD;
  const CFG = D.CFG, WP = D.WEAPONS, MON = D.MONSTERS;
  const target = MON.slime;                  // 小妖：场上最常见的靶子
  const TOL_WORST = MON.bat.r + 0.32;        // 解析判据按最严的一档（飞蝠）算

  function salvo(wkey, dist, relX) {
    let G = D.G;
    G.bullets.length = 0; G.drops.length = 0; G.aimLock = null;
    G.bulletHits = 0; G.shotsFired = 0;
    G.weapon = wkey; G.fireTimer = 0;
    const px = 0;                            // 玩家钉在中列
    G.x3d = px;
    const m = {
      key: target.key, type: target,
      x3d: px + relX, y3d: CFG.playerY + dist,
      hp: 1e9, maxHp: 1e9, speed: 0, r: target.r, dmg: 0,
      wob: 0, mode: 'walk', modeT: 0, lungeX: 0, hitFlash: 0, dead: false
    };
    const fx = m.x3d, fy = m.y3d;
    const frames = Math.ceil((dist + 8) / CFG.bulletSpeed / 0.01667) + 4;
    env.step(frames, 16.67, () => {
      G = D.G;
      G.monsters.length = 0;                 // 场上有几只怪、在哪，全由本用例说了算
      G.monsters.push(m);
      m.x3d = fx; m.y3d = fy; m.hp = 1e9; m.dead = false;
      m.mode = 'walk'; m.modeT = 0;
      G.weapon = wkey; G.x3d = px;
      G.buffs = { atk: 0, rate: 0, crit: 0, critDmg: 0 };   // 去掉词条：只测弹道，不测伤害
      if (G.shotsFired > 0) G.fireTimer = 1e9;               // 只允许开一枪
    });
    return { fired: G.shotsFired, hits: G.bulletHits };
  }

  const DISTS = [8, 12, 17, 25, 40, 60];
  const WKEYS = ['sword', 'twin', 'fan', 'cloud'];

  /* ① 解析判据：最外侧那一发在目标深度处离目标中心多远，必须小于命中半径。
   *    和下面"真开枪"互为对照 —— 解析说能全中，实弹就必须全中。 */
  WKEYS.forEach((k) => {
    const w = WP[k];
    if (w.shots === 1) return;
    const worst = ((w.shots - 1) / 2) * w.spreadM;
    ok(worst < TOL_WORST, WP[k].name + ' 最外侧偏离 ' + worst.toFixed(2) + 'm < 命中半径 ' +
      TOL_WORST.toFixed(2) + 'm（齐射展宽 ' + ((w.shots - 1) * w.spreadM).toFixed(1) + 'm）');
    ok(w.spreadM > 0, WP[k].name + ' 的齐射确实散开了（spreadM = ' + w.spreadM +
      '），不是几发重叠在一起冒充多段伤害');
  });

  /* ② 实弹：逐武器 × 逐距离 × 正前方/侧路，数真实命中发数 */
  for (const k of WKEYS) {
    const w = WP[k];
    const rows = [];
    let allHit = true;
    for (const relX of [0, 4 / 3]) {
      for (const dist of DISTS) {
        const r = salvo(k, dist, relX);
        if (r.fired !== w.shots || r.hits !== r.fired) allHit = false;
        rows.push(dist + 'm' + (relX ? '侧' : '') + ' ' + r.hits + '/' + r.fired);
      }
    }
    console.log('  ' + w.name + '：' + rows.join('　'));
    ok(allHit, w.name + ' 在 8~60 米、正前方与侧路都全部命中');
  }

  env.w.close();
}

/* ═══════════════ 测试 I：移动端视口与安全区 ═══════════════
 * 这一组钉的是「手机上面板下半截被裁、还拉不动」那类缺陷。
 * 它的特点是**在电脑上完全正常**，所以只能靠契约断言守着：
 * 移动浏览器的 100vh 是"大视口"（地址栏收起时的高度），比真实可视区高
 * （iPhone 竖屏实测差 100~140px）。#app 按它撑高，HUD 底部就被锚到屏幕外；
 * 而属性面板的 max-height 也是按大视口算的，于是它并**不溢出**，
 * 怎么拉都拉不动 —— 看着像面板坏了，其实是整块被浏览器 UI 盖住。 */
async function testI() {
  console.log('\n=== 测试 I：移动端视口与安全区 ===');
  const html = fs.readFileSync(path.join(DIR, 'index.html'), 'utf8');
  const raw = fs.readFileSync(path.join(DIR, 'game.js'), 'utf8');

  /* ── 静态契约：少任何一条，手机上就会出上面那个症状 ── */
  ok(html.indexOf('--vh-full:100vh') > 0, ':root 里 --vh-full 有 vh 兜底（老浏览器）');
  ok(html.indexOf('@supports (height:100dvh)') > 0 && html.indexOf('--vh-full:100dvh') > 0,
    '--vh-full 在支持 dvh 时改用 100dvh（跟随真实可视区）');
  ok(/#app\{[^}]*height:var\(--vh-full\)/.test(html), '#app 高度走 var(--vh-full)');
  ok(!/#app\{[^}]*height:100vh/.test(html), '#app 不再直接用 100vh（那会在手机上被裁）');
  ok(!/\.stat-panel\{[^}]*max-height:36vh/.test(html),
    '属性面板不再用裸 36vh（它按大视口算，算出来的空间在手机上并不存在）');
  ok(/\.stat-panel\{[^}]*max-height:calc\(var\(--vh-full\)/.test(html),
    '属性面板 max-height 基于 var(--vh-full)');
  ok(html.indexOf('env(safe-area-inset-bottom') > 0, '#hud 底部让出 iPhone Home 条');
  ok(html.indexOf('viewport-fit=cover') > 0,
    'viewport meta 带 viewport-fit=cover（否则 safe-area 恒为 0）');

  /* ── game.js 侧的兜底链路 ── */
  ok(/function syncViewportHeight/.test(raw), 'game.js 有 syncViewportHeight()');
  ok(/visualViewport[\s\S]{0,120}?\.height/.test(raw),
    'syncViewportHeight 读的是 visualViewport.height（比 vh 准）');
  ok(/function resize\(\)\s*\{\s*syncViewportHeight\(\)/.test(raw), 'resize() 每次都会重新同步');
  ok(/visualViewport\.addEventListener\('resize'/.test(raw),
    '监听了 visualViewport 的 resize（iOS 上地址栏伸缩不一定派发 window.resize）');

  /* ── 真跑一遍：值必须"跟着变化走"，而不是一次性写死 ── */
  const env = makeEnv();
  loadScripts(env.w);
  await waitHome(env);
  const de = env.w.document.documentElement;

  Object.defineProperty(env.w, 'visualViewport', {
    value: { height: 704, width: 390, addEventListener() {} }, configurable: true
  });
  env.w.dispatchEvent(new env.w.Event('resize'));
  ok(de.style.getPropertyValue('--vh-full') === '704px',
    '可视高 704 → --vh-full 写成 704px（真的按可视区走，不是死钉 100vh）');

  env.w.visualViewport.height = 640;
  env.w.dispatchEvent(new env.w.Event('resize'));
  ok(de.style.getPropertyValue('--vh-full') === '640px',
    '可视高改成 640 → --vh-full 跟着变（地址栏伸缩能跟上）');

  delete env.w.visualViewport;
  env.w.dispatchEvent(new env.w.Event('resize'));
  ok(de.style.getPropertyValue('--vh-full') === env.w.innerHeight + 'px',
    '没有 visualViewport 的老内核回落到 innerHeight（' + env.w.innerHeight + 'px）');

  env.w.close();
}

/* ═══════════════ 测试 J：路沿的宽度必须随透视收缩 ═══════════════
 * 这一组钉的是「远处的路沿又粗又亮」。
 *
 * 病根很小：路沿用 ctx.lineWidth = 3（固定屏幕像素，外加 8px 辉光）
 * 从近端一路 stroke 到消失点，而路宽是按 (1−t) 收缩到 0 的 ——
 * 于是「路沿宽 ÷ 路宽」随距离失控：22 米处 1.2%、193 米处 10.1%、
 * 414 米处 23.1%（dev/curbdiag.js 实测），屏幕上就是远处路沿比整条路还宽。
 * 顺带 alpha 恒定 0.5，远处路面已经暗下去了路沿却不变，
 * 明暗差反而从 62 涨到 80 个亮度级 —— 所以还「又亮」。
 *
 * 断言分两层，缺一不可：
 *   · 比值恒定 + 单调不增 —— 钉住「别再用固定像素」；
 *   · 末端深度够远 —— 钉住「别用截断冒充收缩」。
 *     把路沿在 10 米处一砍，比值同样是恒定的，但那是把问题藏起来，不是修好。
 */
async function testJ() {
  console.log('\n=== 测试 J：路沿线宽随透视收缩 ===');
  const raw = fs.readFileSync(path.join(DIR, 'game.js'), 'utf8');

  /* ── 静态契约 ── */
  ok(/function curbSegments/.test(raw), '路沿几何抽成了 curbSegments()（枚举与绘制分离）');
  ok(/wM\s*:\s*[\d.]+/.test(raw), '路沿宽度以「米」定义，而不是屏幕像素');
  ok(/CURB\.wM\s*\*\s*pxPerMeter/.test(raw), '宽度按「米 × 该深度像素密度」换算');

  /* 线宽必须在 drawCurb 的函数体里断言，不能拿整份源码去正则 ——
   * game.js 里另有一处 ctx.lineWidth = 3（飘字的黑描边，那是正当的固定像素），
   * 还有注解这次病根的注释文本，混在一起断言必然误报（第一版就误报了）。 */
  const i0 = raw.indexOf('function drawCurb');
  const i1 = raw.indexOf('\n  function ', i0 + 10);
  const curbFn = i0 < 0 ? '' : raw.slice(i0, i1 > 0 ? i1 : i0 + 1500);
  ok(curbFn.length > 100, '能定位到 drawCurb 的函数体');
  ok(!/lineWidth\s*=\s*[\d.]/.test(curbFn), 'drawCurb 里没有写死的 lineWidth');
  ok(/lineWidth\s*=\s*s\.w/.test(curbFn), 'drawCurb 的线宽来自该段算出来的宽度');

  const env = makeEnv();
  loadScripts(env.w);
  const ready = await waitFor(() => env.w.RD && env.w.RD.curbSegments().length > 0);
  ok(ready, 'boot 之后路沿几何可用');
  if (!ready) { env.w.close(); return; }

  const segs = env.w.RD.curbSegments();
  ok(segs.length >= 20, '路沿分成足够多的段（' + segs.length + ' ≥ 20，否则收缩会成台阶）');

  /* ── 比值恒定：这就是「世界量」的定义性质 ── */
  const ratios = segs.map((s) => s.w / s.roadW);
  const rMin = Math.min.apply(null, ratios), rMax = Math.max.apply(null, ratios);
  ok(rMax / rMin < 1.02,
    '「路沿宽 ÷ 路宽」全程恒定（' + rMin.toFixed(5) + ' ~ ' + rMax.toFixed(5) +
    '，极差 ' + ((rMax / rMin - 1) * 100).toFixed(2) + '%）');

  /* ── 单调：宽度和透明度都不能出现「越远越粗 / 越亮」 ── */
  let wBad = 0, aBad = 0;
  for (let i = 1; i < segs.length; i++) {
    if (segs[i].w > segs[i - 1].w + 1e-9) wBad++;
    if (segs[i].alpha > segs[i - 1].alpha + 1e-9) aBad++;
  }
  ok(wBad === 0, '线宽随深度单调不增（越远越细）');
  ok(aBad === 0, '不透明度随深度单调不增（越远越淡）');

  /* ── 明度衰减：远端必须「亮不起来」 ── */
  const first = segs[0], last = segs[segs.length - 1];
  ok(first.alpha > 0.45 && first.alpha < 0.65,
    '近端不透明度保持原样（' + first.alpha.toFixed(3) + '，约合改动前的 0.5）');
  ok(last.alpha < 0.10, '远端不透明度衰减到 0.10 以下（' + last.alpha.toFixed(3) + '）');
  ok(last.alpha / first.alpha < 0.20,
    '首尾不透明度之比 < 20%（' + ((last.alpha / first.alpha) * 100).toFixed(1) + '%）');

  /* ── 覆盖深度：别用「截断」冒充「收缩」 ── */
  ok(last.depth > 150,
    '路沿一直画到 ' + last.depth.toFixed(0) + ' 米（> 150 米，不是早早砍掉了事）');

  /* ── 与屏幕宽度无关：米制宽度的必然结果，固定像素做不到 ──
   * 固定 3px 在 480 宽的窗口里比例碰巧是对的，换 1400 宽就只剩三分之一。 */
  const canvasEl = env.w.document.getElementById('game');
  Object.defineProperty(canvasEl, 'clientWidth', { value: 1400, configurable: true });
  env.w.dispatchEvent(new env.w.Event('resize'));
  const r2 = env.w.RD.curbSegments().map((s) => s.w / s.roadW);
  ok(Math.abs(Math.max.apply(null, r2) - rMax) < 1e-9,
    '画布 900 → 1400，比值一点不变（' + Math.max.apply(null, r2).toFixed(5) +
    '）—— 因为宽度是米，不是像素');

  env.w.close();
}

/* ═══════════════ 测试 K：金币经济（掉落 → 局内显示 → 结算入账 → 存档） ═══════════════
 * 金币是**跨局持久**的货币，所以它比积分危险：积分算错了只是数字难看，
 * 金币算错了要么让玩家白打（没入账），要么凭空发财（重复入账）。
 * 这一组因此钉三件事：
 *   · 掉落数值有依据、口径与 score 分开（coin 是"值多少钱"，score 是"打得好不好"）；
 *   · 任何一条离开对局的路径都会入账，且**只入账一次**（bankRun 幂等）；
 *   · 存档读进来必须逐字段校验 —— 一个不存在的皮肤 key 会让绘制抛异常，
 *     症状是"打开就白屏"，而且清缓存才好。
 */
async function testK() {
  console.log('\n=== 测试 K：金币经济 ===');
  const raw = fs.readFileSync(path.join(DIR, 'game.js'), 'utf8');

  const env = makeEnv();
  env.w.Math.random = seeded(7788);
  loadScripts(env.w);
  await waitHome(env);
  const D = env.w.RD, CFG = D.CFG, MON = D.MONSTERS;

  /* ── ① 掉落数值 ── */
  const keys = Object.keys(MON);
  ok(keys.length >= 4, '妖物 ' + keys.length + ' 种');
  let coinBad = null;
  keys.forEach((k) => { if (!Number.isInteger(MON[k].coin) || MON[k].coin <= 0) coinBad = k; });
  ok(!coinBad, '每种妖物都有正整数掉落金币' + (coinBad ? '（' + coinBad + ' 不合法）' : ''));

  /* coin 与 score 是两套口径（一个"值多少钱"、一个"打得好不好"），
   * 但排序不该互相打架 —— 否则会出现"打高分的怪反而掉得少"这种说不通的设定。 */
  const byScore = keys.slice().sort((a, b) => MON[a].score - MON[b].score);
  const ladder = byScore.map((k) => MON[k].name + ' ' + MON[k].score + '分/' + MON[k].coin + '币');
  let mono = true;
  for (let i = 1; i < byScore.length; i++) {
    if (MON[byScore[i]].coin < MON[byScore[i - 1]].coin) mono = false;
  }
  console.log('  掉落阶梯：' + ladder.join(' → '));
  ok(mono, '掉落金币随妖物价值单调不降（' + ladder.join(' → ') + '）');

  const sumCoin = byScore.reduce((s, k) => s + MON[k].coin, 0);
  ok(sumCoin < 20, '四种妖物的掉落总和 ' + sumCoin + ' 是一局能打死几十只的量级（不是几百）');

  /* ── ② 真杀一遍：逐种各杀一只，核对"局内金币 = 掉落之和" ──
   * 不复制一份掉落逻辑到测试里 —— 摆一只血量为 1 的靶子，让真实的弹道打它。 */
  env.w.document.getElementById('btnStart').click();
  ok(D.G.coins === 0 && D.G.coinGain === 0, '开局金币归零（coins=' + D.G.coins + '，coinGain=' + D.G.coinGain + '）');

  const killOne = (mk) => {
    const t = MON[mk];
    const k0 = D.G.kills, c0 = D.G.coins, g0 = D.G.coinGain;
    const pen = {
      key: mk, type: t, x3d: 0, y3d: CFG.playerY + 10,
      hp: 1, maxHp: 1, speed: 0, r: t.r, dmg: 0,
      wob: 0, mode: 'walk', modeT: 0, lungeX: 0, hitFlash: 0, dead: false
    };
    let f = 0;
    while (f < 180 && D.G.kills === k0) {
      env.step(1, 16.67, () => {
        const G = D.G;
        G.monsters.length = 0;          // 场上有谁全由本用例说了算
        G.monsters.push(pen);
        pen.x3d = 0; pen.y3d = CFG.playerY + 10; pen.hp = 1; pen.dead = false;
        pen.mode = 'walk'; pen.modeT = 0;
        G.x3d = 0; G.weapon = 'sword'; G.fireTimer = 0; G.hp = 100;
      });
      f++;
    }
    return { killed: D.G.kills > k0, dCoin: D.G.coins - c0, dGain: D.G.coinGain - g0, frames: f };
  };

  let expectCoin = 0, allOk = true;
  byScore.forEach((mk) => {
    const r = killOne(mk);
    expectCoin += MON[mk].coin;
    if (!r.killed || r.dCoin !== MON[mk].coin || r.dGain !== 1) allOk = false;
    console.log('  击杀 ' + MON[mk].name + '：+' + r.dCoin + ' 金币（期望 ' + MON[mk].coin +
      '），进账 ' + r.dGain + ' 次，用了 ' + r.frames + ' 帧');
  });
  ok(allOk, '每次击杀恰好入账一次，且数额等于该妖物的掉落');
  ok(D.G.coins === expectCoin, '局内金币 = 各次掉落之和（' + D.G.coins + ' = ' + expectCoin + '）');

  /* ── ③ 局内 HUD 显示 ── */
  D.G.bullets.length = 0;               // 清掉在飞的弹，免得它们在镜头外又打死几只
  env.step(8, 16.67);                   // updateHud 每 4 帧跑一次
  ok(txt(env.w, 'coinText') === String(D.G.coins),
    'HUD 金币与局内数据一致（' + txt(env.w, 'coinText') + '）');
  ok(env.w.document.getElementById('coinLine').classList.contains('pop'),
    '有新进账时 HUD 金币跳了一下（.pop 类被加上）');

  /* ── ④ 结算入账 ── */
  const gain = D.G.coins;
  D.G.hp = -1;                          // 直接走真实的 hp<=0 → endGame(false) 失败分支
  let f = 0;
  while (f < 240 && hidden(env.w, 'result')) { env.step(1, 16.67); f++; }
  ok(!hidden(env.w, 'result'), '血量清零后进入结算');
  ok(txt(env.w, 'resTitle') === '失败', '走的是失败分支：' + txt(env.w, 'resTitle'));
  ok(txt(env.w, 'resCoinGain') === '+' + gain, '结算页显示本局金币 +' + gain + '：' + txt(env.w, 'resCoinGain'));
  ok(D.profile.coins === gain, '结算后余额 = 本局金币（' + D.profile.coins + '）');
  ok(D.profile.earned === gain, '累计收入同步累加（' + D.profile.earned + '）');
  ok(D.profile.runs === 1, '存档记了 1 局（' + D.profile.runs + '）');
  ok(txt(env.w, 'resCoinBal').indexOf(String(gain)) >= 0 && txt(env.w, 'resCoinBal').indexOf('通关奖励') < 0,
    '失败局显示余额、不显示通关奖励：' + txt(env.w, 'resCoinBal'));

  /* ── ⑤ 幂等：同一笔钱不许记两遍 ── */
  D.bankRun(); D.bankRun();
  ok(D.profile.coins === gain && D.profile.runs === 1,
    '重复调用入账无效（幂等）：余额仍 ' + D.profile.coins + '，局数仍 ' + D.profile.runs);

  env.w.document.getElementById('btnResHome').click();
  ok(!hidden(env.w, 'home') && hidden(env.w, 'result'), '结算 → 返回主页正常');
  ok(D.profile.coins === gain, '「结算 → 返回主页」不会把同一笔钱记两遍（仍 ' + D.profile.coins + '）');
  ok(txt(env.w, 'homeCoins') === String(gain), '主页顶部显示当前金币：' + txt(env.w, 'homeCoins'));

  /* ── ⑥ 中途退出也入账（击杀是真实发生的，没有作弊空间）── */
  env.w.document.getElementById('btnStart').click();
  D.G.coins = 33; D.G.coinGain = 1;
  env.w.document.getElementById('btnSettingsInGame').click();
  env.w.document.getElementById('btnBackHome').click();
  ok(D.profile.coins === gain + 33, '中途返回主页，本局已挣的照样入账（' + D.profile.coins + '）');
  ok(D.profile.runs === 2, '中途退出也记一局（' + D.profile.runs + '）');

  /* ── ⑦ 从设置里「重新开始」：先把旧局的钱记上，再开新局 ──
   * 顺序反了的话 newGame() 会把 G 整个换掉，那笔钱就再也拿不到了。 */
  const beforeRestart = D.profile.coins, runs0 = D.profile.runs;
  env.w.document.getElementById('btnStart').click();
  D.G.coins = 7; D.G.coinGain = 1;
  env.w.document.getElementById('btnSettingsInGame').click();
  env.w.document.getElementById('btnRestart').click();
  ok(D.profile.coins === beforeRestart + 7,
    '「重新开始」先把上一局的 7 枚入账（' + beforeRestart + ' → ' + D.profile.coins + '）');
  ok(D.G.coins === 0 && D.profile.runs === runs0 + 1, '新一局金币归零、局数 +1');

  /* ── ⑧ 通关奖励必须有 ── */
  ok(/coinBonusWin:\s*\d+/.test(raw), 'CFG 里有通关奖励 coinBonusWin');
  ok(CFG.coinBonusWin > 0 && CFG.coinBonusWin < MON.elite.coin * 40,
    '通关奖励 ' + CFG.coinBonusWin + ' 金币是个"多打几成"的量级（不是一局暴富）');

  env.w.close();

  /* ── ⑨ 存档逐字段校验：坏存档不许把玩家锁死或弄白屏 ── */
  const env2 = makeEnv();
  env2.w.localStorage.setItem('rd_profile', JSON.stringify({
    coins: 1234.7, earned: -5, runs: 'not-a-number',
    ownedMaps: ['不存在的地图'], map: 'day',
    ownedSkins: ['greek', 'wuxia', '怪皮肤'], skin: '怪皮肤',
    gender: '外星'
  }));
  loadScripts(env2.w);
  await waitHome(env2);
  const P2 = env2.w.RD.profile;
  ok(!hidden(env2.w, 'home'), '存档被改坏也照样进主页（不会白屏）');
  ok(P2.coins === 1234, '余额向下取整：1234.7 → ' + P2.coins);
  ok(P2.earned === 0 && P2.runs === 0, '非法 earned/runs 被丢弃（' + P2.earned + ' / ' + P2.runs + '）');
  ok(P2.ownedMaps.indexOf('不存在的地图') < 0 && P2.ownedMaps.indexOf('night') >= 0,
    '未知地图 key 被过滤，初始地图强制补回：' + JSON.stringify(P2.ownedMaps));
  ok(P2.map === 'night', '装备位指向"没买过的地图"时回落到初始款：' + P2.map);
  ok(P2.ownedSkins.indexOf('怪皮肤') < 0 && P2.ownedSkins.length === 2,
    '未知皮肤 key 被过滤，合法的保留：' + JSON.stringify(P2.ownedSkins));
  ok(P2.skin === 'wuxia', '皮肤位回落到初始款：' + P2.skin);
  ok(P2.gender === 'male', '非法性别回落到 male：' + P2.gender);
  ok(txt(env2.w, 'homeCoins') === '1234', '主页显示校验后的余额：' + txt(env2.w, 'homeCoins'));
  env2.w.close();
}

/* ═══════════════ 测试 L：商城（筛选 / 预览 / 购买 / 装备 / 性别 / 三张地图） ═══════════════
 * 商城错起来最贵的地方不是"按钮不好看"，而是：扣了钱没到手、没扣钱却到手、
 * 买了地图之后回不去夜景、存档坏了开不出商城。
 * 所以这一组全部走**真实 DOM 点击**，不直接调内部函数去"演"一遍。
 */
async function testL() {
  console.log('\n=== 测试 L：商城 ===');
  const env = makeEnv();
  env.w.Math.random = seeded(5150);
  loadScripts(env.w);
  await waitHome(env);
  const D = env.w.RD, MAPS = D.MAPS, SKINS = D.SKINS;

  /* ── ① 价格：初始款免费，地图贵过皮肤一大档 ──
   * 基线来自 dev/economy.js 的实测（同一套机器人走位政策，同一批种子）：
   *   最快 —— 会躲且通关：掉落 521 + 通关奖励 120 = 641 金币/局
   *   不擅走位（会被追到墙边变靶子）：227 + 120 = 347 金币/局
   * 定价检查**用最快那一档**：连最顺的人都要打这么多局，慢的只会更久。
   * 这两个数写在这里是故意的 —— 改价之后如果不再满足"10 多局往上"，
   * 这里会拦下来，而不是等到玩家抱怨太便宜。
   * ⚠ 别用"掉落 521"当基线：那是扣掉通关奖励的数，玩家钱包里没有"扣掉"这一说。 */
  const RUN_BEST = 641, RUN_TYPICAL = 347;
  const freeMaps = MAPS.filter((m) => m.price === 0);
  const freeSkins = SKINS.filter((s) => s.price === 0);
  ok(freeMaps.length === 1 && freeMaps[0].key === 'night', '只有初始地图免费：' + freeMaps.map((m) => m.key).join(','));
  ok(freeSkins.length === 1 && freeSkins[0].key === 'wuxia', '只有初始皮肤免费：' + freeSkins.map((s) => s.key).join(','));

  const paidMaps = MAPS.filter((m) => m.price > 0).map((m) => m.price);
  const paidSkins = SKINS.filter((s) => s.price > 0).map((s) => s.price);
  const minMap = Math.min.apply(null, paidMaps), maxMap = Math.max.apply(null, paidMaps);
  const maxSkin = Math.max.apply(null, paidSkins);
  ok(minMap > maxSkin, '最便宜的地图 (' + minMap + ') 也贵过最贵的皮肤 (' + maxSkin + ') —— 「地图可以贵一点」');
  ok(minMap / RUN_BEST >= 10, '最便宜的地图 ≈ ' + (minMap / RUN_BEST).toFixed(1) + ' 局（最快基线 ' +
    RUN_BEST + '/局）≥ 10 局 —— 「10 多局金币的价格往上」');
  ok(maxMap / RUN_BEST < 20, '最贵的地图 ≈ ' + (maxMap / RUN_BEST).toFixed(1) + ' 局（最快基线）< 20，没贵到劝退');
  ok(minMap / RUN_TYPICAL >= 15, '对不擅走位的玩家（' + RUN_TYPICAL + '/局）最便宜的地图也要 ' +
    (minMap / RUN_TYPICAL).toFixed(1) + ' 局 —— 是个"值得攒"的目标');
  paidSkins.forEach((p) => ok(p / RUN_BEST < 6, p + ' 金币的皮肤 ≈ ' + (p / RUN_BEST).toFixed(1) +
    ' 局（最快基线）< 6 局，比地图早拿到'));

  /* ── ② 每款皮肤都得有男款女款，而且真的不一样 ── */
  let dupGender = null, sameBody = null;
  SKINS.forEach((s) => {
    if (!s.male || !s.female) { dupGender = s.key; return; }
    if (s.male.hair === s.female.hair && s.male.shK === s.female.shK && s.male.hipK === s.female.hipK) sameBody = s.key;
  });
  ok(!dupGender, '每款皮肤都有男款与女款两套体型参数' + (dupGender ? '（' + dupGender + ' 缺一套）' : ''));
  ok(!sameBody, '男女款参数确实不同（不是复制了一份' + (sameBody ? '：' + sameBody : '') + '）');

  /* ── ③ 主题 / 地图：夜图色值必须与抽主题前逐字一致 ── */
  const night = D.theme('night');
  ok(night.road[1] === '#232833' && night.sky[0] === '#080d18' && night.curb === '120,190,255',
    '夜图路面色 = 改动前的原值（road[1]=' + night.road[1] + '，sky[0]=' + night.sky[0] + '，curb=' + night.curb + '）');
  ok(night.fogMin === 0.30 && night.fogD === 75 && night.vig === 0.55 && night.flies === 14,
    '夜图的雾/暗角/萤火参数也没漂（fogMin=' + night.fogMin + '，fogD=' + night.fogD +
    '，vig=' + night.vig + '，flies=' + night.flies + '）');
  ok(D.theme('day').sky[0] === '#3f7fc4' && D.theme('day').fogD === 95 && D.theme('day').flies === 0,
    '白昼图有自己的天空、雾参数与"没有萤火"');
  ok(D.theme('desert').sky[0] === '#33406f' && D.theme('desert').flies === 9,
    '沙漠图有自己的天空与浮尘数量');

  /* deepMerge 的意义就在这里：地图只覆盖部分色值，
   * 用"整块替换"的话 BASE_THEME 里没被覆盖的字段会变成 undefined ——
   * 那种崩溃只在切到那张地图时出现，最难查。 */
  const baseP = Object.keys(night.P);
  MAPS.forEach((m) => {
    const th = D.theme(m.key);
    const missP = baseP.filter((k) => th.P[k] === undefined);
    ok(missP.length === 0, '[' + m.key + '] 景物配色没有缺项' +
      (missP.length ? '（缺 ' + missP.join(',') + ' → 切过去就画不出来）' : ''));
    const lp = th.lamp;
    ok(lp && lp.glow && lp.glow.length === 3 && lp.light && lp.light.length === 3 && typeof lp.poolA === 'number',
      '[' + m.key + '] 灯笼的三档色标与光池齐全（白天是"不点灯"，但仍然要有值）');
    const missTop = ['sky', 'ground', 'ridge', 'treeLine', 'haze', 'road', 'verge'].filter((k) => th[k] === undefined);
    ok(missTop.length === 0, '[' + m.key + '] 顶层主题字段齐全' + (missTop.length ? '（缺 ' + missTop.join(',') + '）' : ''));
  });

  /* ── ④ 玩法性的颜色故意不进主题：换地图必须一模一样 ──
   * "哪个圈是要命的"得跨地图通用，否则换张图要重新学一遍 —— 那不是美术，是 bug。
   * 用静态契约查：MONSTERS 的定义块里不许出现 theme( —— 出现了就说明妖物颜色会随地图变。 */
  const rawSrc = fs.readFileSync(path.join(DIR, 'game.js'), 'utf8');
  const iM = rawSrc.indexOf('var MONSTERS');
  const monBlock = rawSrc.slice(iM, rawSrc.indexOf('};', iM) + 2);
  ok(iM > 0 && monBlock.length > 200, '能定位到 MONSTERS 的定义块');
  ok(monBlock.indexOf('theme(') < 0, '妖物的颜色不读主题（换地图妖物长得一样，预警圈也是同一个）');

  /* ── ⑤ 筛选器 ── */
  env.w.document.getElementById('btnShop').click();
  ok(!hidden(env.w, 'shop') && hidden(env.w, 'home'), '主页点「商城」进入商城');

  const cardCount = () => env.w.document.querySelectorAll('#shopGrid .card').length;
  const tabEl = (t) => env.w.document.querySelector('#shopTabs [data-tab="' + t + '"]');
  ok(env.w.document.querySelectorAll('#shopTabs [data-tab]').length === 3,
    '有 3 个筛选项：' + Array.from(env.w.document.querySelectorAll('#shopTabs [data-tab]'))
      .map((b) => b.textContent).join(' / '));
  ok(cardCount() === MAPS.length + SKINS.length, '默认「全部」列出所有商品（' + cardCount() + ' 张卡）');

  tabEl('map').click();
  ok(cardCount() === MAPS.length, '点「地图」只剩 ' + cardCount() + ' 张卡（= ' + MAPS.length + ' 张地图）');
  ok(hidden(env.w, 'genderRow'), '地图页隐藏性别开关（免得让人以为地图也分男女）');
  ok(D.shop.items().every((i) => i.kind === 'map'), '地图筛选下没有混进皮肤');

  tabEl('skin').click();
  ok(cardCount() === SKINS.length, '点「皮肤」只剩 ' + cardCount() + ' 张卡（= ' + SKINS.length + ' 款皮肤）');
  ok(!hidden(env.w, 'genderRow'), '皮肤页才出现性别开关');
  ok(D.shop.items().every((i) => i.kind === 'skin'), '皮肤筛选下没有混进地图');
  ok(cardCount() === env.w.document.querySelectorAll('#shopGrid .thumbcv').length,
    '每张卡都有自己的预览画布');

  /* ── ⑥ 初始款的呈现（这是用户专门追问过的一点）── */
  const cardOf = (key) => env.w.document.querySelector('#shopGrid [data-key="' + key + '"]').closest('.card');
  const tagOf = (key) => { const t = cardOf(key).querySelector('.tag'); return t ? t.textContent : ''; };
  const footOf = (key) => cardOf(key).querySelector('.cfoot').textContent;

  ok(tagOf('wuxia') === '使用中', '正用着的初始皮肤标「使用中」：' + tagOf('wuxia'));
  ok(cardOf('wuxia').querySelector('[data-act="buy"]') === null, '初始皮肤卡片上没有购买按钮（不售卖）');
  ok(footOf('wuxia').indexOf('购买') < 0, '初始皮肤也不显示价格：' + footOf('wuxia'));

  /* ── ⑦ 买地图：走真实的"点购买 → 二次确认 → 确认扣款" ── */
  tabEl('map').click();                 // 上一步停在皮肤页，买地图得先切回地图页
  const dayKey = MAPS.filter((m) => m.price > 0)[0].key;
  const dayPrice = MAPS.filter((m) => m.price > 0)[0].price;
  ok(cardOf(dayKey) !== null, '切到地图页后能看到 ' + dayKey + ' 的卡片');
  D.profile.coins = dayPrice; D.shop.paint();
  ok(!!cardOf(dayKey).querySelector('[data-act="buy"]'), '余额够时地图卡上有「购买」按钮');
  ok(cardOf(dayKey).querySelector('.cprice').textContent.indexOf(String(dayPrice)) >= 0,
    '卡片上写清了价格：' + cardOf(dayKey).querySelector('.cprice').textContent);

  cardOf(dayKey).querySelector('[data-act="buy"]').click();
  ok(!hidden(env.w, 'buyConfirm'), '点「购买」先弹二次确认，不是点了就扣钱');
  ok(txt(env.w, 'bcPrice') === dayPrice + ' 金币', '确认层写清价格：' + txt(env.w, 'bcPrice'));
  ok(txt(env.w, 'bcSub').indexOf('购买后剩余 0') >= 0, '确认层写了买完剩多少：' + txt(env.w, 'bcSub').replace(/\s+/g, ' '));
  ok(!env.w.document.getElementById('bcOk').disabled, '余额够 → 确认按钮可点');

  env.w.document.getElementById('bcOk').click();
  ok(hidden(env.w, 'buyConfirm'), '确认后弹层关闭');
  ok(D.profile.coins === 0, '扣款正确：' + dayPrice + ' → ' + D.profile.coins);
  ok(D.shop.owns('map', dayKey), '已拥有 ' + dayKey);
  ok(D.profile.map === dayKey, '买完直接装备（不用再点一次「使用」）：' + D.profile.map);
  ok(cardOf(dayKey).classList.contains('using'), '刚买的卡片变成「使用中」');
  ok(txt(env.w, 'shopCoins') === '0', '商城顶部余额同步：' + txt(env.w, 'shopCoins'));

  /* ── ⑧ 初始地图：不售卖、不标"已拥有"、但永远留着入口 ── */
  ok(tagOf('night') === '初始', '换成别的图后，初始图标签是「初始」而不是「已拥有」：' + tagOf('night'));
  ok(footOf('night').indexOf('初始赠送') >= 0, '初始图写「初始赠送」：' + footOf('night'));
  ok(cardOf('night').querySelector('[data-act="buy"]') === null, '初始图没有购买按钮');
  ok(cardOf('night').querySelector('[data-act="equip"]') !== null,
    '初始图永远留着「使用」入口 —— 否则买了新地图就再也换不回夜景了');

  /* ── ⑨ 余额不足：能点、但点不动 ── */
  const desKey = MAPS.filter((m) => m.price > 0)[1].key;
  const desPrice = MAPS.filter((m) => m.price > 0)[1].price;
  D.profile.coins = 100; D.shop.paint();
  ok(cardOf(desKey).querySelector('.cprice').classList.contains('poor'),
    '钱不够时价格标成红色（.poor）');
  cardOf(desKey).querySelector('[data-act="buy"]').click();
  ok(txt(env.w, 'bcSub').indexOf('还差 ' + (desPrice - 100)) >= 0,
    '确认层提示还差多少：' + txt(env.w, 'bcSub').replace(/\s+/g, ' '));
  ok(env.w.document.getElementById('bcOk').disabled, '余额不足 → 确认按钮禁用');
  ok(txt(env.w, 'bcOk') === '金币不足', '按钮文案改成「金币不足」：' + txt(env.w, 'bcOk'));
  env.w.document.getElementById('bcOk').click();
  ok(D.profile.coins === 100 && !D.shop.owns('map', desKey),
    '禁用状态下点不动：钱没少（' + D.profile.coins + '），东西也没到手');
  env.w.document.getElementById('bcCancel').click();
  ok(hidden(env.w, 'buyConfirm'), '取消能关掉弹层');

  /* ── ⑩ 没买的东西装备不上；已买的能来回切 ── */
  ok(D.shop.equip('map', desKey) === false && D.profile.map === dayKey,
    '没买过的地图装备不上（equip 返回 false，装备位不变）');
  cardOf('night').querySelector('[data-act="equip"]').click();
  ok(D.profile.map === 'night', '点「使用」能切回初始地图：' + D.profile.map);
  ok(D.shop.owns('map', dayKey), '切回初始图不会丢掉买过的图：' + JSON.stringify(D.profile.ownedMaps));

  /* ── ⑪ 缩略图真的走了渲染管线（不是一块纯色）── */
  const beforeTheme = D.theme();
  const rec = (kind, key, gender) => {
    if (gender) D.shop.setGender(gender);
    const c = fakeCanvas(132, 168);
    D.shop.renderThumb(c, kind, key);
    return c;
  };
  const cDes = rec('map', desKey);
  ok(cDes.calls.length > 50, '沙漠缩略图产生了 ' + cDes.calls.length + ' 次绘制调用（真的跑了 sky/road/scenery）');
  ok(cDes.calls.filter((s) => s.indexOf('fillStyle=') === 0).length > 5,
    '缩略图用了 ' + cDes.calls.filter((s) => s.indexOf('fillStyle=') === 0).length + ' 种填充色，不是一块纯色');
  ok(D.theme() === beforeTheme, '画完「别的」地图的缩略图后，当前装备的主题没被换掉（withTarget 还原了）');

  let thumbErr = null;
  MAPS.forEach((m) => {
    try { rec('map', m.key); } catch (e) { thumbErr = m.name + '：' + e.message; }
  });
  ok(!thumbErr, '三张地图的缩略图都画得出来' + (thumbErr ? '（' + thumbErr + '）' : ''));

  /* 皮肤立绘：14 种组合都要画得出来，而且男女款画出来的几何必须不一样 ——
   * "只有男女两个开关、皮肤本身不变"这件事，最终就体现在这里。 */
  let poseErr = null;
  SKINS.forEach((s) => ['male', 'female'].forEach((g) => {
    try { rec('skin', s.key, g); } catch (e) { poseErr = s.key + '/' + g + '：' + e.message; }
  }));
  ok(!poseErr, SKINS.length + ' 款皮肤 × 男女 = ' + (SKINS.length * 2) + ' 张立绘全部画得出来' +
    (poseErr ? '（' + poseErr + '）' : ''));

  const maleSig = rec('skin', 'wuxia', 'male').calls.join('|');
  const femSig = rec('skin', 'wuxia', 'female').calls.join('|');
  ok(maleSig !== femSig, '同一款皮肤换成女款，画出来的几何不一样（不是只换了个颜色）');
  ok(maleSig.split('|').length > 35, '立绘的绘制调用有 ' + maleSig.split('|').length + ' 次，是一整套人物');
  ok(rec('skin', 'wuxia', 'male').calls.join('|') === maleSig, '同一性别两次渲染逐条一致（没掺随机或时间）');

  /* 调试钩子自己也得是能用的：RD.shop 里曾同时挂了 tab(t) 和 get tab()，
   * 对象字面量同名键后者胜 —— 函数被 getter 覆盖成字符串，调用时静默失效。 */
  ok(typeof D.shop.tab === 'function', 'RD.shop.tab 是可调用的切页函数（没被同名 getter 覆盖）');
  D.shop.tab('map');
  ok(D.shop.currentTab === 'map' && cardCount() === MAPS.length,
    'RD.shop.tab("map") 真的切了页：' + D.shop.currentTab + '，' + cardCount() + ' 张卡');

  /* ── ⑫ 性别开关：切换时皮肤与已拥有清单一点不动 ── */
  D.shop.setGender('male');
  D.shop.tab('skin');
  const segs = env.w.document.querySelectorAll('#genderSeg [data-gender]');
  ok(segs.length === 2, '性别开关有两档：' + Array.from(segs).map((b) => b.textContent).join(' / '));
  const skin0 = D.profile.skin, owned0 = D.profile.ownedSkins.join(',');
  env.w.document.querySelector('#genderSeg [data-gender="female"]').click();
  ok(D.profile.gender === 'female', '点「女款」生效');
  ok(D.profile.skin === skin0 && D.profile.ownedSkins.join(',') === owned0,
    '切性别不改皮肤（皮肤仍 ' + D.profile.skin + '，已拥有 ' + D.profile.ownedSkins.join('/') + '）');
  ok(env.w.document.querySelector('#genderSeg [data-gender="female"]').classList.contains('on'),
    '女款档位高亮');
  env.w.document.querySelector('#genderSeg [data-gender="male"]').click();
  ok(D.profile.gender === 'male' && D.profile.skin === skin0, '切回男款同样不动皮肤');

  /* ── ⑬ 买皮肤 ── */
  D.profile.coins = 900; D.shop.paint();
  const greekKey = SKINS.filter((s) => s.price === 900)[0].key;
  cardOf(greekKey).querySelector('[data-act="buy"]').click();
  env.w.document.getElementById('bcOk').click();
  ok(D.profile.coins === 0 && D.profile.skin === greekKey,
    '买皮肤并自动装备（余额 ' + D.profile.coins + '，皮肤 ' + D.profile.skin + '）');
  ok(D.shop.owns('skin', greekKey) && !D.shop.owns('skin', 'persian'), '只解锁买下的那一款');
  ok(D.profile.gender === 'male', '买皮肤不会顺手改性别：' + D.profile.gender);

  /* ── ⑭ 存档：写盘 + "刷新页面"后还在 ── */
  const savedRaw = env.w.localStorage.getItem('rd_profile');
  ok(!!savedRaw, '商城操作写了存档 rd_profile');
  const savedP = JSON.parse(savedRaw);
  ok(savedP.coins === 0 && savedP.ownedMaps.indexOf(dayKey) >= 0 &&
    savedP.ownedSkins.indexOf(greekKey) >= 0 && savedP.skin === greekKey,
    '存档内容对得上：' + JSON.stringify(savedP));

  env.w.document.getElementById('btnShopBack').click();
  ok(!hidden(env.w, 'home') && hidden(env.w, 'shop'), '返回按钮回到主页');
  ok(txt(env.w, 'homeCoins') === String(D.profile.coins), '主页金币与存档一致：' + txt(env.w, 'homeCoins'));

  const env3 = makeEnv();
  env3.w.localStorage.setItem('rd_profile', savedRaw);
  loadScripts(env3.w);
  await waitHome(env3);
  const P3 = env3.w.RD.profile;
  ok(P3.ownedMaps.indexOf(dayKey) >= 0 && P3.ownedSkins.indexOf(greekKey) >= 0 &&
    P3.skin === greekKey && P3.map === 'night',
    '「刷新页面」后买过的地图与皮肤都还在（地图 ' + P3.map + '，皮肤 ' + P3.skin + '）');
  ok(txt(env3.w, 'homeCoins') === String(P3.coins), '刷新后主页余额照旧：' + txt(env3.w, 'homeCoins'));

  env3.w.close();
  env.w.close();
}

/* 记录型 2D 上下文：把每一次绘制调用记下来。
 * 用它回答两个问题："这张缩略图到底画了东西没有"、"男女款画出来是不是同一张"。
 * 断言的是**调用序列**而不是像素 —— 像素受 DPR、字体、抗锯齿影响，调用序列不会。 */
function fakeCanvas(w, h) {
  const calls = [];
  const grad = { addColorStop() {} };
  const target = {
    calls,
    createLinearGradient: () => grad,
    createRadialGradient: () => grad,
    measureText: () => ({ width: 0 })
  };
  const ctx = new Proxy(target, {
    get(t, k) {
      if (k in t) return t[k];
      return function () {
        const a = Array.prototype.slice.call(arguments)
          .map((v) => (typeof v === 'number' ? v.toFixed(2) : String(v)));
        calls.push(k + '(' + a.join(',') + ')');
      };
    },
    set(t, k, v) { calls.push(k + '=' + v); t[k] = v; return true; }
  });
  return { width: w, height: h, calls, getContext: () => ctx };
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
    await testH();
    await testI();
    await testJ();
    await testK();
    await testL();
  } catch (e) {
    fail++;
    console.log('  [ERROR] ' + (e && e.stack ? e.stack.split('\n').slice(0, 4).join('\n') : e));
  }
  console.log('\n==== 结果: ' + pass + ' 通过 / ' + fail + ' 失败 ====');
  process.exit(fail ? 1 : 0);
})();
