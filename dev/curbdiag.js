/* ============================================================================
 *  路沿诊断 —— 量化"远处的路沿到底有多粗、有多亮"
 *
 *  为什么需要它：路沿是 canvas 上的描边，看不见它有几像素、比路面亮多少，
 *  只靠肉眼看截图，改完只能争论"好像是好点了"。这个脚本把两件事变成数字：
 *
 *    ① 宽度：逐行扫描，找出"蓝度异常"的像素段（路沿/虚线都会命中），
 *       再和该行路面边界的真实屏幕位置对照，认出哪一段是路沿、宽几像素。
 *       关键指标是 curbW / roadW —— 路沿占路面宽度的比例。
 *       它必须随距离**单调下降**，恒定或上升就是 bug。
 *
 *    ② 亮度：路沿像素的亮度 − 紧邻内侧路面的亮度 = 明暗差。
 *       现实里这个差随距离被大气消光吃掉，越远越小。
 *
 *  实现要点：
 *    √ 用 CDP 驱动真 Chrome（jsdom 的 canvas 是桩，读不到像素）。
 *    √ 深度 ↔ 屏幕 y 的换算走 RD.project 二分反查，不复制 game.js 里的
 *      k / vanish.y / halfW 这几个常数 —— 复制一份就有了漂移风险，
 *      哪天改了相机参数，诊断脚本会拿着过期公式给出"一切正常"。
 *    √ 蓝度 = b − (r+g)/2。路面是中性灰蓝（≈0），路沿是蓝白（≫0），
 *      所以一个阈值就能把候选段挑出来，不必知道路沿的颜色常量。
 *
 *  用法：
 *    node dev/curbdiag.js before     → 存 dev/_curb-before.json
 *    node dev/curbdiag.js after      → 存 dev/_curb-after.json 并打印对照表
 * ========================================================================== */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const DIR = path.join(__dirname, '..');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9225;
const TAG = process.argv[2] || 'run';
const OUT = path.join(DIR, 'dev', '_curb-' + TAG + '.json');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* 场景钉死：关掉开火、清空妖物，画面上只剩路面本身。
 * 妖物和子弹会盖住路面、还会带来额外的蓝色像素（飞剑就是蓝的），
 * 不清干净，扫描出来的"蓝度异常段"根本对不上路沿。 */
const inject = `
<script>
(function () {
  var s = 20260917 >>> 0;
  Math.random = function () { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  function tryStart() {
    var home = document.getElementById('home'), btn = document.getElementById('btnStart');
    if (!home || !btn || home.classList.contains('hidden')) { setTimeout(tryStart, 40); return; }
    btn.click();
  }
  setTimeout(tryStart, 50);
  requestAnimationFrame(function tick() {
    var D = window.RD;
    if (D && D.G) {
      D.G.fireTimer = 1e9;              // 关掉开火：飞剑是蓝的，会污染扫描
      if (D.G.monsters.length) D.G.monsters.length = 0;
      if (D.G.bullets.length) D.G.bullets.length = 0;
      if (D.G.parts.length) D.G.parts.length = 0;
      D.G.shake = 0;
      D.G.hp = 100;
    }
    requestAnimationFrame(tick);
  });
})();
</script>
`;

const src = fs.readFileSync(path.join(DIR, 'index.html'), 'utf8');
const tmp = path.join(DIR, '_curbdiag.html');
fs.writeFileSync(tmp, src.replace('</body>', inject + '</body>'), 'utf8');
const url = 'file:///' + tmp.replace(/\\/g, '/');

/* 页面内执行的扫描。
 * 注意两个坐标系的坑：
 *   · canvas.width 是设备像素（= CSS px × DPR），getImageData 用它；
 *   · 而 RD.project 返回的是 CSS px（ctx 上有 setTransform(DPR,...)）。
 * 所以像素下标要乘 DPRX，边界位置要除以 DPRX 再比。 */
const SCAN = `(function () {
  var c = document.getElementById('game');
  var ctx = c.getContext('2d');
  var DPRX = c.width / (c.clientWidth || window.innerWidth);
  var cw = c.width, ch = c.height;
  var img = ctx.getImageData(0, 0, cw, ch).data;
  var W = cw / DPRX, H = ch / DPRX;

  function at(x, y) {
    var ix = Math.round(x * DPRX), iy = Math.round(y * DPRX);
    if (ix < 0 || iy < 0 || ix >= cw || iy >= ch) return null;
    var o = (iy * cw + ix) * 4;
    return [img[o], img[o + 1], img[o + 2]];
  }
  function blue(p) { return p ? p[2] - (p[0] + p[1]) / 2 : 0; }
  function lum(p) { return 0.299 * p[0] + 0.587 * p[1] + 0.114 * p[2]; }

  /* 屏幕 y → 深度（米）：二分反查真实投影器，不复制相机常数 */
  function depthAtScreenY(yt) {
    var lo = 0, hi = 4000;
    for (var i = 0; i < 70; i++) {
      var mid = (lo + hi) / 2;
      var sy = window.RD.project(-2, mid).pos.y;
      if (sy > yt) lo = mid; else hi = mid;
    }
    return (lo + hi) / 2;
  }

  var rows = [];
  for (var y = Math.round(H - 4); y > H * 0.20; y -= 6) rows.push(y);

  var out = { W: W, H: H, dpr: DPRX, rows: [] };

  /* 解析几何：直接读 RD.curbSegments() 的权威数值。
   * 为什么两套都要：像素扫描受"淡到看不见"影响，alpha 一低就报"未找到"，
   * 于是它只能证明"远处确实看不见了"，证明不了"比值恒定"。
   * 比值是否失控恰恰是这次的病根，必须用解析值来看。 */
  if (window.RD.curbSegments) {
    out.segs = window.RD.curbSegments().map(function (s) {
      return {
        depth: +s.depth.toFixed(1), w: +s.w.toFixed(3),
        roadW: +s.roadW.toFixed(2),
        ratio: +(s.w / s.roadW).toFixed(5), alpha: +s.alpha.toFixed(4)
      };
    });
  }
  for (var r = 0; r < rows.length; r++) {
    var y = rows[r];
    var segs = [], cur = null;
    for (var x = 0; x < W; x++) {
      var p = at(x, y);
      var hit = p && blue(p) > 30;
      if (hit) {
        if (!cur) cur = { x0: x, x1: x, peak: -1e9, rgb: p };
        cur.x1 = x;
        if (blue(p) > cur.peak) { cur.peak = blue(p); cur.rgb = p; }
      } else if (cur) { segs.push(cur); cur = null; }
    }
    if (cur) segs.push(cur);

    var y3d = depthAtScreenY(y + 0.5);
    var L = window.RD.project(-2, y3d).pos;
    var R = window.RD.project(2, y3d).pos;

    /* 路沿只可能在路面边界附近。窗口取 ±(该行路面宽的 12% + 10px)，
     * 这样不会把中央的车道分隔虚线误认成路沿。 */
    var roadW = R.x - L.x;
    var win = roadW * 0.12 + 10;
    var pick = null, other = [];
    for (var i2 = 0; i2 < segs.length; i2++) {
      var sg = segs[i2], cx = (sg.x0 + sg.x1) / 2;
      var dl = Math.abs(cx - L.x), dr = Math.abs(cx - R.x);
      if (Math.min(dl, dr) <= win) { if (!pick || sg.x1 - sg.x0 > pick.x1 - pick.x0) pick = sg; }
      else other.push({ x0: sg.x0, x1: sg.x1 });
    }

    var rec = {
      y: y, depth: +y3d.toFixed(2),
      roadL: +L.x.toFixed(1), roadR: +R.x.toFixed(1), roadW: +roadW.toFixed(1)
    };
    if (pick) {
      /* 内侧路面亮度：从路沿内侧 6px 处取，避开路沿自身的抗锯齿边 */
      var innerX = L.x + 6, pIn = at(innerX, y);
      rec.curb = {
        x0: pick.x0, x1: pick.x1, w: pick.x1 - pick.x0 + 1,
        cx: +((pick.x0 + pick.x1) / 2).toFixed(1),
        rgb: pick.rgb, lum: +lum(pick.rgb).toFixed(1),
        ratioOfRoad: +((pick.x1 - pick.x0 + 1) / roadW).toFixed(4)
      };
      if (pIn) {
        rec.innerLum = +lum(pIn).toFixed(1);
        rec.lumGap = +(lum(pick.rgb) - lum(pIn)).toFixed(1);
      }
    }
    rec.otherSegs = other;
    out.rows.push(rec);
  }
  return JSON.stringify(out);
})()`;

(async function main() {
  if (fs.existsSync(OUT)) fs.unlinkSync(OUT);
  const userDir = path.join(__dirname, '_chrome-profile-curb');
  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars',
    '--no-first-run', '--no-default-browser-check',
    '--enable-unsafe-swiftshader', '--force-device-scale-factor=1',
    '--window-size=480,900', '--remote-debugging-port=' + PORT,
    '--user-data-dir=' + userDir, 'about:blank'
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
    const events = [];
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
      else if (m.method) events.push(m.method);
    };
    const send = (method, params) => new Promise((res) => {
      const myId = ++id; pending.set(myId, res);
      ws.send(JSON.stringify({ id: myId, method, params: params || {} }));
    });

    await send('Page.enable');
    await send('Runtime.enable');
    await send('Emulation.setDeviceMetricsOverride', { width: 480, height: 900, deviceScaleFactor: 1, mobile: true });
    await send('Page.navigate', { url });

    for (let i = 0; i < 80 && events.indexOf('Page.loadEventFired') < 0; i++) await sleep(100);
    await sleep(4200);

    const probe = await send('Runtime.evaluate', {
      expression: 'JSON.stringify({state: RD.state, w: innerWidth, h: innerHeight})',
      returnByValue: true
    });
    console.log('probe: ' + (probe.result && probe.result.result && probe.result.result.value));

    const res = await send('Runtime.evaluate', { expression: SCAN, returnByValue: true });
    const val = res.result && res.result.result && res.result.result.value;
    if (!val) {
      console.log('FAIL 扫描没返回数据');
      console.log(JSON.stringify(res.result && res.result.result));
      cleanup(); process.exit(1);
    }
    const data = JSON.parse(val);
    fs.writeFileSync(OUT, JSON.stringify(data, null, 1), 'utf8');

    console.log('\nW=' + data.W + ' H=' + data.H + ' dpr=' + data.dpr + '  → ' + OUT);
    console.log('深度(m)   屏幕y   路宽px   路沿px  路沿/路宽   路沿亮度  内侧亮度  明暗差');
    for (const r of data.rows) {
      if (!r.curb) { console.log(pad(r.depth, 8) + pad(r.y, 8) + pad(r.roadW, 9) + '   —（未找到）'); continue; }
      console.log(
        pad(r.depth, 8) + pad(r.y, 8) + pad(r.roadW, 9) + pad(r.curb.w, 9) +
        pad(r.curb.ratioOfRoad, 11) + pad(r.curb.lum, 10) + pad(r.innerLum, 10) + pad(r.lumGap, 8)
      );
    }

    if (data.segs && data.segs.length) {
      const ratios = data.segs.map((s) => s.ratio);
      const rMin = Math.min.apply(null, ratios), rMax = Math.max.apply(null, ratios);
      console.log('\n解析几何：' + data.segs.length + ' 段（RD.curbSegments）');
      console.log('深度(m)  线宽px   路宽px   线宽/路宽   alpha');
      for (const s of data.segs) {
        console.log(pad(s.depth, 8) + pad(s.w, 9) + pad(s.roadW, 9) + pad(s.ratio, 11) + pad(s.alpha, 8));
      }
      console.log('\n比值极差: ' + rMin.toFixed(5) + ' ~ ' + rMax.toFixed(5) +
        '   最远端 ' + pad(data.segs[data.segs.length - 1].depth, 8) +
        ' 米处 alpha=' + data.segs[data.segs.length - 1].alpha);
    } else {
      console.log('\n（这一版还没有 RD.curbSegments —— 基线只能看实测像素）');
    }
    ws.close(); cleanup(); process.exit(0);
  } catch (e) {
    console.log('FAIL ' + (e && e.message ? e.message : e));
    cleanup(); process.exit(1);
  }
})();

function pad(v, n) {
  const s = v === undefined || v === null ? '—' : String(v);
  return (s + ' '.repeat(Math.max(0, n - s.length))).slice(0, Math.max(n, s.length));
}
