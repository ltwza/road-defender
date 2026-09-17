/* ============================================================================
 *  实机截图 —— 用系统里的 Chrome 无头模式给游戏拍真实渲染帧
 *
 *  为什么需要它：jsdom 里 canvas 是桩，只能断言坐标，看不到画面。
 *  改视觉（场景装饰、配色、HUD）时，"断言全绿"说明不了好不好看，必须看图。
 *
 *  实现要点（踩过的坑）：
 *    × 不要用 chrome --screenshot + --virtual-time-budget ——
 *      游戏有一个常驻的 requestAnimationFrame 循环，页面永远不 idle，
 *      虚拟时间根本推不动，拍到的永远是加载页。
 *    √ 改成 CDP 驱动：起一个带 remote-debugging-port 的 Chrome，
 *      用 WebSocket 连上去 → Page.navigate → 真时间等几秒 → Page.captureScreenshot。
 *      Node 22 自带 WebSocket 和 fetch，不需要任何 npm 依赖。
 *
 *  另外会注入一小段脚本：跳过加载动画、直接开局，并把妖物钉在固定位置，
 *  这样改前改后构图完全一致，能直接对比。
 *
 *  用法：
 *    node dev/shot.js before            → dev/shots/before.png
 *    node dev/shot.js hero --fire       → 保留玩家开火
 *    node dev/shot.js hero --wait=6000  → 加载后再等 6 秒才拍
 * ========================================================================== */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const DIR = path.join(__dirname, '..');
const OUTDIR = path.join(__dirname, 'shots');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

const name = process.argv[2] || 'shot';
const keepFire = process.argv.includes('--fire');
const waitArg = process.argv.find((a) => a.startsWith('--wait='));
const WAIT = waitArg ? parseInt(waitArg.slice(7), 10) : 4200;
/* --clip=x,y,w,h 局部放大：480x900 整图缩到聊天窗口里只剩几百像素宽，
 * 细节（树形、光池、边缘）根本看不清，必须能截一块放大来看。 */
const clipArg = process.argv.find((a) => a.startsWith('--clip='));
const CLIP = clipArg ? clipArg.slice(7).split(',').map(Number) : null;
/* --dpr=N 拉高像素密度：装饰物是矢量填充，开销基本跟像素数走，
 * DPR 1 测出来的数字对手机（DPR 2~3）没有参考价值。 */
const dprArg = process.argv.find((a) => a.startsWith('--dpr='));
const DPR = dprArg ? Math.max(1, Math.min(3, parseInt(dprArg.slice(6), 10) || 1)) : 1;
/* --weapon=fan 指定手上拿哪把武器。
 * 默认 twin 是历史原因（HUD 截图的落点），拍齐射弹道时要显式指定。 */
const weaponArg = process.argv.find((a) => a.startsWith('--weapon='));
const WEAPON = weaponArg ? weaponArg.slice(9) : 'twin';
/* --map=day / --skin=greek / --gender=female：直接改存档里的"当前装备"再截图。
 * 加地图/皮肤时，"这张图长什么样"必须能一眼看到，否则只能靠想象。
 * --shop=all|map|skin：不开局，直接进商城拍商品卡（缩略图就是真实渲染管线画的，
 * 所以这一张图等于把所有地图/皮肤都过了一遍）。 */
const MAP_ARG = (process.argv.find((a) => a.startsWith('--map=')) || '').slice(6);
const SKIN_ARG = (process.argv.find((a) => a.startsWith('--skin=')) || '').slice(7);
const GENDER_ARG = (process.argv.find((a) => a.startsWith('--gender=')) || '').slice(9);
const SHOP_ARG = (process.argv.find((a) => a.startsWith('--shop=')) || '').slice(7);
/* --coins=9000：给存档塞一笔钱再截图。
 * 没有它的话商城永远显示"余额 0"，所有价格都是红的（.poor）——
 * 而"买得起"和"买不起"是两种完全不同的卡片状态（价格色 + 按钮文案），
 * 只拍一种等于没验。 */
const COINS_ARG = process.argv.find((a) => a.startsWith('--coins='));
const COINS = COINS_ARG ? Math.max(0, parseInt(COINS_ARG.slice(8), 10) || 0) : null;
const SEED = 20260916;
const PORT = 9223;
/* --probe=<js> / --probefile=<路径>：在页面里求值一段代码，把结果打到终端。
 * 截图只能告诉你"看起来不对"，看不出**为什么**不对 ——
 * 卡片文字整块不见了这种事，得去读真实 DOM 的 getBoundingClientRect / getComputedStyle。
 * 页面此时已经跑完注入脚本（该开的局、该进的商城都已经在状态里），
 * 所以这里可以直接量任何元素。
 *
 * 探针一长就该走 --probefile：命令行参数里的换行和缩进在传递途中会被搅坏，
 * 症状是"探针明明有返回值，但页面状态不对" —— 那种错最难查。
 * 写文件传路径就没有这层转义。 */
const PROBEFILE = (process.argv.find((a) => a.startsWith('--probefile=')) || '').slice(12);
const PROBE = PROBEFILE
  ? fs.readFileSync(path.resolve(PROBEFILE), 'utf8')
  : ((process.argv.find((a) => a.startsWith('--probe=')) || '').slice(8));
/* --bare：只留风景，清掉妖物/掉落/飘字。
 * 量"远处的路和景物长什么样"时必须用它 —— 妖物钉在屏幕下半部分，
 * 会把逐行的对比度统计整片抬起来，量出来的剖面是妖物的轮廓而不是场景的。
 * 也让"这张地图本身好不好看"这件事能和玩法元素分开看。 */
const BARE = process.argv.includes('--bare');

/* 钉住的场景：妖物绝不越过玩家，构图每次一致。
 * 深度 17~86 米 → 覆盖"快到跟前 / 中景 / 远景"三档，正好能看出
 * 妖物的大小递减和路两侧装饰物是否对得上（伪 3D 最容易穿帮的地方）。 */
const STAGE = [
  { key: 'elite', x: -1.33, y: 86 },
  { key: 'brute', x: 1.33, y: 68 },
  { key: 'slime', x: -1.33, y: 52 },
  { key: 'bat', x: 0.0, y: 44 },
  { key: 'slime', x: 1.33, y: 34 },
  { key: 'slime', x: -1.33, y: 24 },
  { key: 'slime', x: 1.33, y: 17 } // 这一只在攻击射程内 → 亮落点预警圈
];

const inject = `
<script>
(function () {
  var SEED = ${SEED}, FIRE = ${keepFire ? 'true' : 'false'}, HOME = ${process.argv.includes('--home') ? 'true' : 'false'};
  var OPEN = ${process.argv.includes('--stats') ? 'true' : 'false'};
  var WEAPON = ${JSON.stringify(WEAPON)};
  var WRAP = ${process.argv.includes('--wrap') ? 'true' : 'false'};
  var SHOP = ${JSON.stringify(SHOP_ARG)};
  var MAP = ${JSON.stringify(MAP_ARG)};
  var SKIN = ${JSON.stringify(SKIN_ARG)};
  var GENDER = ${JSON.stringify(GENDER_ARG)};
  var COINS = ${COINS === null ? 'null' : COINS};
  var STAGE = ${JSON.stringify(STAGE)};
  var BARE = ${BARE ? 'true' : 'false'};
  var s = SEED >>> 0;
  Math.random = function () { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  var didOpen = false, didWrap = false;
  var WRAP_N = 11;

  /* --wrap：造 11 个真词条塞进 BUFF_LIST，用来验证"铺满往上换行"。
   * 不能往 #icoRow 里直接插 DOM —— 图标行是 updateHud 整段 innerHTML 重写的，
   * 插进去的下一帧就被冲掉了（第一版就是这么白忙的）。
   * 挂到 BUFF_LIST 上才是走真实渲染路径。 */
  function mkFake(i) {
    return {
      key: 't' + i, name: '测试' + i, color: '#8194ad', stackable: true,
      icon: '<circle cx="12" cy="12" r="6.4"/><path d="M12 5.6v3.2"/>',
      badge: function () { return '+' + (i + 1) * 7 + '%'; },
      effect: function (n) { return '测试词条 ' + n + ' 层'; },
      note: '仅供截图校验布局'
    };
  }

  /* 换装备：直接改存档里的当前装备。theme() 每次绘制都现读 profile.map，
   * 所以改完立刻生效；但暗角的渐变对象是按地图缓存的，得发一次 resize 让它重建。 */
  function applyEquip() {
    var D = window.RD;
    if (!D || !D.profile) return;
    if (MAP && D.profile.map !== MAP) {
      D.profile.map = MAP;
      window.dispatchEvent(new Event('resize'));
    }
    if (SKIN) D.profile.skin = SKIN;
    if (GENDER) D.profile.gender = GENDER;
    if (COINS !== null) {
      D.profile.coins = COINS;
      D.profile.earned = COINS;
      if (D.updateCoinDisplays) D.updateCoinDisplays();
      if (D.saveProfile) D.saveProfile();
    }
  }

  function tryStart() {
    var home = document.getElementById('home');
    var btn = document.getElementById('btnStart');
    if (!home || !btn || home.classList.contains('hidden')) { setTimeout(tryStart, 40); return; }
    applyEquip();
    if (SHOP) {
      /* 不开局，直接进商城：商品卡的缩略图就是真实渲染管线画的，
       * 所以这一张截图等于把所有地图/皮肤都看了一遍。 */
      var shopBtn = document.getElementById('btnShop');
      if (shopBtn) shopBtn.click();
      var tab = document.querySelector('#shopTabs [data-tab="' +
        (SHOP === 'map' ? 'map' : SHOP === 'skin' ? 'skin' : 'all') + '"]');
      if (tab) tab.click();
      return;
    }
    if (HOME) return;                 // --home：停在主界面，拍首页背景
    btn.click();
    stage();
  }

  /* 每帧把场景钉回去（妖物位置会被 updatePlaying 改掉）。
   * 本 rAF 在 game.js 之后注册 → 同帧内后执行 → 覆盖生效。 */
  function stage() {
    requestAnimationFrame(function tick() {
      var D = window.RD;
      if (D && D.G) {
        var G = D.G;
        G.t = 74;                          // HUD 显示个中局时间
        G.hp = 78; G.score = 1280;         // 血条留点信息量
        if (BARE) {
          /* 风景帧：一只妖物都不留。清完直接返回，不走下面的 STAGE 钉位 ——
           * 钉位每帧会重新灌 STAGE.length 只回来，两边打架的话读到哪一帧全看运气。 */
          if (!FIRE) G.fireTimer = 1e9;
          G.monsters.length = 0;
          if (G.pickups) G.pickups.length = 0;
          G.floats.length = 0;
          requestAnimationFrame(tick);
          return;
        }
        var b = { atk: 3, rate: 2, crit: 4, critDmg: 2 };
        if (WRAP) {
          if (!didWrap) {
            didWrap = true;
            for (var w = 0; w < WRAP_N; w++) D.BUFF_LIST.push(mkFake(w));
          }
          for (var w2 = 0; w2 < WRAP_N; w2++) b['t' + w2] = 1;
        }
        G.buffs = b;
        G.weapon = WEAPON;
        if (!FIRE) G.fireTimer = 1e9;      // 关掉开火 → 画面更干净
        if (OPEN && !didOpen) { didOpen = true; D.toggleStats(true); }

        if (G.monsters.length !== STAGE.length) {
          G.monsters.length = 0;
          for (var i = 0; i < STAGE.length; i++) {
            var st = STAGE[i], base = D.MONSTERS[st.key];
            G.monsters.push({
              key: st.key, type: base, x3d: st.x, y3d: st.y,
              hp: 9999, maxHp: 9999, speed: base.speed, r: base.r, dmg: base.dmg,
              wob: i * 1.1, mode: 'walk', modeT: 0, lungeX: st.x,
              hitFlash: 0, dead: false
            });
          }
        }
        for (var j = 0; j < G.monsters.length; j++) {
          var m = G.monsters[j], s0 = STAGE[j];
          m.x3d = s0.x; m.y3d = s0.y; m.hp = 9999; m.dead = false;
          /* 射程内那只永远停在预警阶段 —— 保证截图里一定看得见落点预警圈 */
          if (s0.y === 17) {
            if (m.mode !== 'windup' && m.mode !== 'lunge') { m.mode = 'windup'; m.modeT = 0; }
            if (m.mode === 'windup' && m.modeT > m.type.windup * 0.72) m.modeT = m.type.windup * 0.5;
            m.lungeX = 0.55;
          }
        }
      }
      requestAnimationFrame(tick);
    });
  }
  setTimeout(tryStart, 50);
})();
</script>
`;

/* ---------- 生成临时页面 ----------
 * 必须落在项目根目录：index.html 里用的是 <script src="projector.js"> 这种相对路径，
 * 放 dev/ 下面会 ERR_FILE_NOT_FOUND，拍出来永远是加载页。 */
const src = fs.readFileSync(path.join(DIR, 'index.html'), 'utf8');
/* --game=_game-old.js：换一个 game.js 来拍。
 * 改视觉时"改前 / 改后"要能拍成同构图两张图，靠肉眼记忆对比是自欺欺人。
 * 旧版从 HEAD 取（git show HEAD:game.js > _game-old.js）—— 只读操作，
 * 不要去 stash / checkout：这个仓库的 .git 有过一次不明原因的整目录消失。 */
const gameArg = process.argv.find((a) => a.startsWith('--game='));
const GAME = gameArg ? gameArg.slice(7) : 'game.js';
if (/[^\w.\-]/.test(GAME)) throw new Error('--game 只接受文件名');
const html = GAME === 'game.js' ? src : src.replace('src="game.js"', 'src="' + GAME + '"');
const tmp = path.join(DIR, '_shot.html');
fs.writeFileSync(tmp, html.replace('</body>', inject + '</body>'), 'utf8');
const url = 'file:///' + tmp.replace(/\\/g, '/');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async function main() {
  fs.mkdirSync(OUTDIR, { recursive: true });
  const out = path.join(OUTDIR, name + '.png');
  if (fs.existsSync(out)) fs.unlinkSync(out);

  const userDir = path.join(__dirname, '_chrome-profile');
  const chrome = spawn(CHROME, [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--no-first-run',
    '--no-default-browser-check',
    '--enable-unsafe-swiftshader',
    '--force-device-scale-factor=1',
    '--window-size=480,900',
    '--remote-debugging-port=' + PORT,
    '--user-data-dir=' + userDir,
    'about:blank'
  ], { stdio: 'ignore' });

  const cleanup = () => {
    try { chrome.kill(); } catch (e) {}
    try { fs.rmSync(userDir, { recursive: true, force: true }); } catch (e) {}
    try { fs.unlinkSync(tmp); } catch (e) {}
  };

  try {
    /* 等调试端口起来 */
    let ver = null;
    for (let i = 0; i < 60 && !ver; i++) {
      await sleep(250);
      try { ver = await (await fetch('http://127.0.0.1:' + PORT + '/json/version')).json(); } catch (e) {}
    }
    if (!ver) throw new Error('Chrome 调试端口没起来');

    const list = await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json();
    const page = list.find((t) => t.type === 'page');
    if (!page) throw new Error('没找到 page target');

    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

    let id = 0;
    const pending = new Map();
    const events = [];
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
      else if (msg.method) events.push(msg.method);
    };
    const send = (method, params) => new Promise((res) => {
      const myId = ++id;
      pending.set(myId, res);
      ws.send(JSON.stringify({ id: myId, method, params: params || {} }));
    });

    /* 页面里的报错要能看见，否则 "加载页永远不动" 根本查不出原因 */
    const logs = [];
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.method === 'Runtime.consoleAPICalled') {
        logs.push('[console.' + m.params.type + '] ' +
          m.params.args.map((a) => a.value !== undefined ? a.value : a.description).join(' '));
      } else if (m.method === 'Runtime.exceptionThrown') {
        const d = m.params.exceptionDetails;
        logs.push('[throw] ' + (d.exception && d.exception.description || d.text));
      } else if (m.method === 'Log.entryAdded') {
        logs.push('[log.' + m.params.entry.level + '] ' + m.params.entry.text);
      }
    });

    await send('Log.enable');
    await send('Page.enable');
    await send('Runtime.enable');
    await send('Emulation.setDeviceMetricsOverride', {
      width: 480, height: 900, deviceScaleFactor: DPR, mobile: true
    });
    await send('Page.navigate', { url });

    /* 等 load 事件（最多 8s），再多等一会儿让游戏跑起来 */
    for (let i = 0; i < 80 && events.indexOf('Page.loadEventFired') < 0; i++) await sleep(100);
    await sleep(WAIT);

    /* 拍之前回报一下游戏是不是真的在跑 —— 否则拍到的可能又是加载页 */
    const probe = await send('Runtime.evaluate', {
      expression: 'JSON.stringify({state: (typeof RD!=="undefined"?RD.state:"NO_RD"), ' +
        't: (typeof RD!=="undefined"&&RD.G)?+RD.G.t.toFixed(1):null, ' +
        'mons: (typeof RD!=="undefined"&&RD.G)?RD.G.monsters.length:0, ' +
        'scripts: document.scripts.length, w: innerWidth, h: innerHeight})',
      returnByValue: true
    });
    console.log('probe: ' + JSON.stringify(probe.result));
    console.log('events: ' + events.join(','));
    if (logs.length) console.log('page logs:\n  ' + logs.join('\n  '));

    /* --noscenery：把装饰整体关掉，用来量"装饰到底花了多少"，或者量"纯背景有多亮"。
     * 直接改 RD.SCENE 就行 —— 场景是按世界里程即时推导的，没有缓存状态。
     *
     * ⚠ 必须排在 PROBE **之前**：探针常常就是来量"去掉装饰之后画面长什么样"的，
     *   顺序反了的话探针量到的还是带装饰的帧，而它自己毫不知情 ——
     *   这种"数字看起来很正常，只是答的不是那个问题"最难查。
     *   （原来就排在后面，是量路面 vs 地面时才发现的。） */
    if (process.argv.includes('--noscenery')) {
      await send('Runtime.evaluate', {
        expression: 'RD.SCENE.belts.forEach(function(b){b.density=0;});' +
          'RD.SCENE.lampSpacing=1e9;RD.SCENE.fireflies=0;'
      });
      await sleep(500);
    }

    if (PROBE) {
      /* awaitPromise：探针可以返回 Promise，于是能"先造一个状态、等它演完再看"。
       * 例：把玩家打死 → await 600ms 让结算页真的出现 → 再截图。
       * 少了这一条，返回 Promise 会被当成普通对象，什么都不会等。 */
      const r = await send('Runtime.evaluate', {
        expression: PROBE, returnByValue: true, awaitPromise: true
      });
      if (r.result && r.result.exceptionDetails) {
        console.log('probe(--probe) 抛错: ' + JSON.stringify(r.result.exceptionDetails));
      } else {
        console.log('--probe → ' + JSON.stringify(r.result && r.result.result ? r.result.result.value : r, null, 2));
      }
    }

    /* --pick=x,y;x,y 直接读画布像素。
     * 放大图看久了会看走眼（"这树是比背景亮还是暗？"），采样一下就没争议了。 */
    const pickArg = process.argv.find((a) => a.startsWith('--pick='));
    if (pickArg) {
      const pts = pickArg.slice(7).split(';');
      const expr = 'JSON.stringify(' + JSON.stringify(pts).replace(/"/g, "'") +
        '.map(function (p) { var a = p.split(",");' +
        'var d = document.getElementById("game").getContext("2d")' +
        '.getImageData(+a[0], +a[1], 1, 1).data;' +
        'return p + " rgb(" + d[0] + "," + d[1] + "," + d[2] + ")"; }))';
      const pk = await send('Runtime.evaluate', { expression: expr, returnByValue: true });
      console.log('pixels: ' + (pk.result && pk.result.result && pk.result.result.value));
    }

    /* 帧耗时：两侧铺了上百个装饰物，必须确认没把帧预算吃掉。
     * 先清零统计，再跑一会儿，读 renderMs（累计平均，不是滑动平均）。
     * 在页面里连着跑 120 帧，回报平均/最差单帧耗时与 DPR。 */
    if (process.argv.includes('--perf')) {
      await send('Runtime.evaluate', { expression: 'RD.perf.sum = 0; RD.perf.n = 0;' });
      await sleep(1500);
      const perf = await send('Runtime.evaluate', {
        expression: `new Promise(function (res) {
          var n = 0, t0 = performance.now(), worst = 0, prev = t0;
          function f() {
            var now = performance.now();
            if (n > 0) worst = Math.max(worst, now - prev);
            prev = now; n++;
            if (n < 120) requestAnimationFrame(f);
            else res(JSON.stringify({
              avgMs: +((now - t0) / 120).toFixed(2),
              worstMs: +worst.toFixed(2),
              fps: +(120000 / (now - t0)).toFixed(1),
              dpr: devicePixelRatio, w: innerWidth, h: innerHeight
            }));
          }
          requestAnimationFrame(f);
        })`,
        awaitPromise: true, returnByValue: true
      });
      console.log('perf: ' + (perf.result && perf.result.result && perf.result.result.value));
      const inner = await send('Runtime.evaluate', {
        expression: 'JSON.stringify({renderMs: +RD.perf.renderMs.toFixed(2), frames: RD.perf.n, ' +
          'dpr: devicePixelRatio})',
        returnByValue: true
      });
      console.log('renderMs: ' + (inner.result && inner.result.result && inner.result.result.value));
    }

    const shotArgs = { format: 'png' };
    if (CLIP && CLIP.length === 4) {
      shotArgs.clip = { x: CLIP[0], y: CLIP[1], width: CLIP[2], height: CLIP[3], scale: 2 };
    }
    const shot = await send('Page.captureScreenshot', shotArgs);
    const data = shot.result && shot.result.data;
    if (!data) throw new Error('captureScreenshot 没返回数据');
    fs.writeFileSync(out, Buffer.from(data, 'base64'));

    ws.close();
    cleanup();
    console.log('ok ' + out + ' (' + Math.round(fs.statSync(out).size / 1024) + ' KB)');
    process.exit(0);
  } catch (e) {
    console.log('FAIL ' + (e && e.message ? e.message : e));
    cleanup();
    process.exit(1);
  }
})();
