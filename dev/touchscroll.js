/* ============================================================================
 *  移动端「属性面板能不能用手指滚」诊断（Chrome CDP + 真实触摸事件）
 *
 *  为什么必须用真机式验证：jsdom 不做布局、不走真实输入管线，
 *  `touch-action` / 默认滚动行为这类东西在 jsdom 里**永远测不出来**。
 *  而鼠标滚轮走的也不是同一条链路 —— 所以"电脑能滚、手机不能滚"这种 bug
 *  只能在带触摸模拟的真实 Chrome 里复现。
 *
 *  用法：
 *    node dev/touchscroll.js              → 诊断并打印全部关键数字
 *    node dev/touchscroll.js --stuff=8    → 往 BUFF_LIST 塞 8 个词条，把面板撑到溢出。
 *                                            默认配置下面板只有 265px < 36vh，**根本没有滚动条**，
 *                                            "滚不动"是正常的 —— 必须造出溢出才有意义。
 *    node dev/touchscroll.js --simvh=844 --h=704
 *                                         → 模拟移动端的 vh 错位：CSS 的 100vh 按 844 解析，
 *                                            而真实可视区只有 704。CDP 里 vh 与可视高度是绑死的
 *                                            （改 height 两者一起变），只能这样人为解耦。
 *    node dev/touchscroll.js --dpr=3 --w=390 --h=844
 *
 *  判据（三个都要看，别只看滚动）：
 *    ① 面板是否真的溢出：scrollHeight > clientHeight
 *       不溢出的话"不能滚"根本不是 bug（没东西可滚）
 *    ② 面板底边是否超出视口：rect.bottom > innerHeight
 *       这个才是"只能看到截断部分"的另一种可能 —— 内容没溢出，是**整块被屏幕裁掉**
 *    ③ 手指滑完 scrollTop 有没有变
 *
 *  最后会尝试用两种手段各滑一次，区分"浏览器默认滚动被拦"和"环境本身不响应触摸"：
 *    次 1：只靠浏览器默认（不加任何人工处理）
 *    次 2：保留原样，用于对照
 * ========================================================================== */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const DIR = path.join(__dirname, '..');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

const arg = (k, def) => {
  const a = process.argv.find((x) => x.startsWith('--' + k + '='));
  return a ? parseInt(a.slice(k.length + 3), 10) : def;
};
const W = arg('w', 390);
const H = arg('h', 844);
const DPR = arg('dpr', 3);
const STUFF = arg('stuff', 0);      // 额外塞几个词条，把面板撑到溢出
const SIMVH = arg('simvh', 0);      // >0 时：把 #app / 面板高度按"大视口"钉住（只能复现，不能验证修复）
const SIMVIS = arg('visual', 0);    // >0 时：劫持 visualViewport.height = N，制造"大视口 vs 真实可视区"错位
const VISUALH = arg('visualh', 0);  // >0 时：试拆 layout/visual viewport（Chrome 已忽略该参数，留作探测）
const PORT = 9224;

/* 注入：跳过加载动画面直接开局，然后把面板打开。 */
const inject = `
<script>
(function () {
  var didOpen = false, didStuff = false, didSim = false, didVis = false;
  var STUFF = ${STUFF}, SIMVH = ${SIMVH}, SIMVIS = ${SIMVIS};
  function mkFake(i) {
    return {
      key: 't' + i, name: '测试' + i, color: '#8194ad', stackable: true,
      icon: '<circle cx="12" cy="12" r="6.4"/><path d="M12 5.6v3.2"/>',
      badge: function () { return '+' + (i + 1) * 7 + '%'; },
      effect: function (n) { return '测试词条 ' + n + ' 层'; },
      note: '仅供布局校验'
    };
  }
  function tryStart() {
    var home = document.getElementById('home');
    var btn = document.getElementById('btnStart');
    if (!home || !btn || home.classList.contains('hidden')) { setTimeout(tryStart, 40); return; }
    btn.click();
    tick();
  }
  function tick() {
    requestAnimationFrame(function f() {
      var D = window.RD;
      if (D && D.G) {
        /* --visual=N：劫持 visualViewport.height，制造
         * 「layout viewport（=100vh）844 / 真实可视区 704」的错位 —— 这正是手机上的情形。
         * 修复后 syncViewportHeight() 读到 704，#app 跟着变 704；
         * 修复前 #app 恒为 100vh=844，底边被裁。这是唯一能**区分修复前后**的手段。 */
        if (SIMVIS && !didVis) {
          didVis = true;
          try {
            Object.defineProperty(window.visualViewport, 'height', {
              get: function () { return SIMVIS; }, configurable: true
            });
            window.__vhHijack = 'ok';
          } catch (e) { window.__vhHijack = 'fail: ' + e.message; }
          window.dispatchEvent(new Event('resize'));    // 让 resize() 立刻重新同步
        }
        D.G.t = 74; D.G.hp = 78; D.G.score = 1280;
        var b = { atk: 3, rate: 2, crit: 4, critDmg: 2 };
        if (STUFF) {
          if (!didStuff) {
            didStuff = true;
            for (var w = 0; w < STUFF; w++) D.BUFF_LIST.push(mkFake(w));
          }
          for (var w2 = 0; w2 < STUFF; w2++) b['t' + w2] = 1;
        }
        /* 模拟移动端 vh 错位：把 "100vh" 的语义钉成"大视口"（SIMVH），
         * 而真实可视区由 deviceMetrics 的 height 决定（更小）。
         * 桌面 CDP 里这两个数总是相等，所以只能这样人为拆开。 */
        if (SIMVH && !didSim) {
          didSim = true;
          var st = document.createElement('style');
          st.textContent =
            '#app{height:' + SIMVH + 'px !important}' +
            '.stat-panel{max-height:' + Math.round(SIMVH * 0.36) + 'px !important}';
          document.head.appendChild(st);
        }
        D.G.buffs = b;
        D.G.weapon = 'twin';
        D.G.fireTimer = 1e9;
        if (!didOpen) { didOpen = true; D.toggleStats(true); }
      }
      requestAnimationFrame(f);
    });
  }
  setTimeout(tryStart, 50);
})();
</script>
`;

const src = fs.readFileSync(path.join(DIR, 'index.html'), 'utf8');
const tmp = path.join(DIR, '_touch.html');
fs.writeFileSync(tmp, src.replace('</body>', inject + '</body>'), 'utf8');
const url = 'file:///' + tmp.replace(/\\/g, '/');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async function main() {
  const userDir = path.join(__dirname, '_chrome-profile-touch');
  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
    '--no-default-browser-check', '--enable-unsafe-swiftshader',
    '--window-size=' + W + ',' + H,
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
    let ver = null;
    for (let i = 0; i < 60 && !ver; i++) {
      await sleep(250);
      try { ver = await (await fetch('http://127.0.0.1:' + PORT + '/json/version')).json(); } catch (e) {}
    }
    if (!ver) throw new Error('Chrome 调试端口没起来');

    const list = await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json();
    const page = list.find((t) => t.type === 'page');
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

    let id = 0;
    const pending = new Map();
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    };
    const send = (method, params) => new Promise((res) => {
      const myId = ++id;
      pending.set(myId, res);
      ws.send(JSON.stringify({ id: myId, method, params: params || {} }));
    });
    const evalJS = async (expr, awaitPromise) => {
      const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: !!awaitPromise });
      if (r.result && r.result.exceptionDetails) return { err: r.result.exceptionDetails.text };
      return r.result && r.result.result ? r.result.result.value : undefined;
    };

    await send('Page.enable');
    await send('Runtime.enable');
    /* 两种视口设置：
     *   · 默认：Emulation.setDeviceMetricsOverride —— layout 与 visual 绑死，
     *     所以 VH 永远等于可视高度，**测不出移动端的错位**。
     *   · --visualh=N：改用（已废弃的）Page.setDeviceMetricsOverride，它能同时给出
     *     layout viewport（决定 100vh）和 visual viewport（决定真实可视区）。
     *     两者不相等 = 精确复刻手机上的情形。新 API 没有这个能力。 */
    if (VISUALH) {
      const r = await send('Page.setDeviceMetricsOverride', {
        width: W, height: H, deviceScaleFactor: DPR, mobile: true,
        viewport: { x: 0, y: 0, width: W, height: VISUALH, scale: 1 }
      });
      console.log('Page.setDeviceMetricsOverride → ' +
        (r && r.error ? 'ERROR ' + JSON.stringify(r.error) : 'ok'));
    } else {
      await send('Emulation.setDeviceMetricsOverride', {
        width: W, height: H, deviceScaleFactor: DPR, mobile: true
      });
    }
    await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    await send('Page.navigate', { url });

    /* 等游戏进入 playing（面板由注入打开） */
    for (let i = 0; i < 100; i++) {
      await sleep(150);
      const s = await evalJS('(typeof RD!=="undefined"&&RD.G)?RD.state:""');
      if (s === 'playing') break;
    }
    await sleep(800);

    /* ── 采集布局事实 ── */
    const info = await evalJS(`(function () {
      var p = document.getElementById('statPanel');
      var strip = document.getElementById('statStrip');
      var app = document.getElementById('app');
      var cs = getComputedStyle(p);
      var r = p.getBoundingClientRect();
      var rs = strip.getBoundingClientRect();
      var ra = app.getBoundingClientRect();
      return JSON.stringify({
        vw: innerWidth, vh: innerHeight, dpr: devicePixelRatio,
        panelHidden: p.classList.contains('hidden'),
        panelScrollH: p.scrollHeight, panelClientH: p.clientHeight,
        panelScrollTop: p.scrollTop, panelOverflowY: cs.overflowY,
        panelTouchAction: cs.touchAction, stripTouchAction: getComputedStyle(strip).touchAction,
        hudTouchAction: getComputedStyle(document.getElementById('hud')).touchAction,
        bodyTouchAction: getComputedStyle(document.body).touchAction,
        panelRect: [Math.round(r.left), Math.round(r.top), Math.round(r.right), Math.round(r.bottom)],
        stripRect: [Math.round(rs.left), Math.round(rs.top), Math.round(rs.right), Math.round(rs.bottom)],
        appRect: [Math.round(ra.left), Math.round(ra.top), Math.round(ra.right), Math.round(ra.bottom)],
        appCSHeight: getComputedStyle(app).height,
        visualVH: (window.visualViewport ? Math.round(window.visualViewport.height) : null),
        vhHijack: window.__vhHijack || null,
        vhFullVar: getComputedStyle(document.documentElement).getPropertyValue('--vh-full').trim(),
        docScrollH: document.documentElement.scrollHeight,
        docClientH: document.documentElement.clientHeight,
        elAtPanelCenter: (function () {
          var e = document.elementFromPoint((r.left + r.right) / 2, (r.top + r.bottom) / 2);
          return e ? (e.id || e.className || e.tagName) : null;
        })()
      });
    })()`);
    console.log('=== 布局事实 ===');
    console.log(info);

    /* 判读：先分清是"没东西可滚"还是"被屏幕裁掉"，两者症状一模一样、修法完全不同。
     * ⚠ "真实可视高度"必须用 visualViewport.height，**不能用 innerHeight** ——
     * 两者不相等正是这个 bug 的成因；拿 innerHeight 比会得出"一切正常"的错误结论
     * （第一版就是这么写的，修复前也报 ✅，等于把判据废掉了）。 */
    const J = JSON.parse(info);
    const realH = J.visualVH || J.vh;
    const overflow = J.panelScrollH - J.panelClientH;
    console.log('--- 判读 ---');
    console.log('真实可视高度 = ' + realH + (J.visualVH ? '（visualViewport）' : '（innerHeight 兜底）') +
      '　layout 视口 vh = ' + J.vh + (realH === J.vh ? '（相等，测不出错位）' : '（错位 ' + (J.vh - realH) + 'px）'));
    console.log('面板内容 ' + J.panelScrollH + 'px / 可见 ' + J.panelClientH + 'px　' +
      (overflow > 0 ? '溢出 ' + overflow + 'px（有东西可滚）' : '不溢出（没东西可滚，"滚不动"属正常）'));
    console.log('卡片底边 ' + J.stripRect[3] + ' vs 真实可视高 ' + realH + '　' +
      (J.stripRect[3] > realH ? '❌ 底部被裁掉 ' + (J.stripRect[3] - realH) + 'px' : '✅ 完整在可视区内'));
    console.log('#app 高 ' + J.appCSHeight + ' vs 真实可视高 ' + realH + '　' +
      (parseInt(J.appCSHeight, 10) > realH
        ? '❌ 高了 ' + (parseInt(J.appCSHeight, 10) - realH) + 'px —— 移动端 vh 错位'
        : '✅ 一致'));
    console.log('visualViewport.height ' + J.visualVH + '　--vh-full = "' + J.vhFullVar + '"' +
      (J.vhHijack ? '　(hijack: ' + J.vhHijack + ')' : '') +
      (J.visualVH && parseInt(J.appCSHeight, 10) === J.visualVH
        ? '　✅ #app 跟着真实可视高度走' : '　⚠ #app 没跟上真实可视高度'));

    const rect = J.panelRect;
    const cx = Math.round((rect[0] + rect[2]) / 2);
    const cy = Math.round((rect[1] + rect[3]) / 2);

    /* ── 派发真实触摸滑动（从面板中部往上滑 240px） ── */
    async function swipeUp(label) {
      const before = await evalJS('document.getElementById("statPanel").scrollTop');
      const startY = cy;
      await send('Input.dispatchTouchEvent', {
        type: 'touchStart', touchPoints: [{ x: cx, y: startY, id: 1, radiusX: 12, radiusY: 12, force: 1 }]
      });
      for (let i = 1; i <= 12; i++) {
        await send('Input.dispatchTouchEvent', {
          type: 'touchMove',
          touchPoints: [{ x: cx, y: startY - i * 20, id: 1, radiusX: 12, radiusY: 12, force: 1 }]
        });
        await sleep(16);
      }
      await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await sleep(500);
      const after = await evalJS('document.getElementById("statPanel").scrollTop');
      console.log(label + '：scrollTop ' + before + ' → ' + after +
        (after > before ? '  ✅ 能滚' : '  ❌ 滚不动'));
      return { before: before, after: after };
    }

    console.log('=== 触摸滑动（真实 Input.dispatchTouchEvent） ===');
    console.log('触摸起点：(' + cx + ', ' + cy + ')　面板 rect=' + JSON.stringify(rect));
    await swipeUp('次 1 默认行为');
    await swipeUp('次 2 再来一次');

    /* 对照：用 JS 直接改 scrollTop，确认"容器本身是可滚的"
     * （排除"内容没溢出所以没什么可滚"这种误判）*/
    const forced = await evalJS(`(function () {
      var p = document.getElementById('statPanel');
      p.scrollTop = 999;
      var v = p.scrollTop;
      return JSON.stringify({ maxScrollTop: v, scrollH: p.scrollHeight, clientH: p.clientHeight });
    })()`);
    console.log('=== 强制滚动对照 ===');
    console.log(forced + '　（maxScrollTop>0 说明容器确实可滚，只是触摸没驱动它）');

    ws.close();
    cleanup();
    process.exit(0);
  } catch (e) {
    console.log('FAIL ' + (e && e.message ? e.message : e));
    cleanup();
    process.exit(1);
  }
})();
