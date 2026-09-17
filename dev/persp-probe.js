/* 透视剖面探针：沿深度量「路面相对两侧地面凸出来多少」。
 *
 * 为什么需要它：用户说"路的焦点太清晰"，但"清晰"没法直接调参 ——
 * 得先把它变成一条曲线。真实照片里这条差值是快速衰减到 0 的
 * （路在远处被大气洗成和周围地面同一个色，看不出边界）；
 * 曲线在远端仍明显非 0，就说明"路从背景里凸出来了"。
 *
 * 三个采样上的坑（都踩过）：
 *   ① 不能走 RD.project —— 它把深度钳到 maxDepth(420)，
 *      而这里要量的恰恰是"420 米以外路面还在不在"。
 *   ② 单点采样会被景物撞花：中景带从路外 2.7 米就开始摆东西，
 *      "路外 3 米"那一点经常正好落在一棵树或一丛草上。
 *      所以每一侧都采一排点取**中位数**。
 *   ③ **只看亮度会漏判。** 沙漠图上路面 RGB(175,134,98)、沙地 RGB(182,128,75)：
 *      亮度只差 5 级（路还略微更亮），可色相明显不同 —— 路是"被晒灰的石头"、
 *      地是"橙沙"，肉眼一眼就能分出边界。所以主判据用**逐通道最大差**，
 *      亮度差只当参考列。这个坑是靠"数值说没路、放大图说路很硬"对不上才揪出来的。
 *
 * 「地面」参照取屏幕左右两端 x = 4% / 96% W。理由：
 *   · 地面是**竖直渐变**（同一 y 上颜色与 x 无关），所以边缘采到的就是"这个深度本该有的地面色"；
 *   · 屏幕边缘离路最远，景物最稀。
 *   配合 dev/persp.js 传来的 --noscenery（装饰全关），这几列就是纯粹的背景色。
 *
 * 由 dev/persp.js 调用，不直接跑。
 */
(function () {
  var c = document.getElementById("game");
  var cx = c.getContext("2d");
  var W = c.width, H = c.height;
  var halfW = W * 0.26, yv = H * 0.155, K = 48;
  function tOf(d) { return d / (d + K); }
  function scrY(d) { return H + (yv - H) * tOf(d); }
  function scrX(x3d, d) { return W * 0.5 + halfW * (1 - tOf(d)) * (x3d / 2); }
  function lum(p) { return 0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2]; }
  function px(x, y) {
    var d = cx.getImageData(Math.round(x), Math.round(y), 1, 1).data;
    return [d[0], d[1], d[2]];
  }
  /* 沿一条竖线取一排点再取中位数：单点会被一根草、一只萤火撞花 */
  function medianRows(x, y0, y1, n) {
    var vals = [];
    for (var i = 0; i < n; i++) {
      var y = y0 + (y1 - y0) * (n === 1 ? 0.5 : i / (n - 1));
      if (y < 0 || y >= H) continue;
      vals.push(px(x, y));
    }
    if (!vals.length) return null;
    vals.sort(function (a, b) { return lum(a) - lum(b); });
    return vals[vals.length >> 1];
  }
  function medianAt(xs, d) {
    var y = Math.round(scrY(d));
    if (y < 0 || y >= H) return null;
    var vals = [];
    for (var i = 0; i < xs.length; i++) {
      var x = Math.round(scrX(xs[i], d));
      if (x < 0 || x >= W) continue;
      vals.push(px(x, y));
    }
    if (!vals.length) return null;
    vals.sort(function (a, b) { return lum(a) - lum(b); });
    return vals[vals.length >> 1];
  }
  /* 同一屏幕 y 上的"地面"：左右边缘各取一小块的中位数。
   * 路面近端会铺满屏幕，所以要避开中间 —— 4% / 96% 处永远在路外。 */
  function groundAt(y) {
    var l = medianRows(W * 0.04, y - 3, y + 3, 4);
    var r = medianRows(W * 0.96, y - 3, y + 3, 4);
    if (!l) return r;
    if (!r) return l;
    return [(l[0] + r[0]) / 2, (l[1] + r[1]) / 2, (l[2] + r[2]) / 2];
  }
  function maxCh(a, b) {
    return Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2]));
  }
  function pad(s, n) { s = String(s); while (s.length < n) s = " " + s; return s; }
  function rgb(p) { return p ? Math.round(p[0]) + "," + Math.round(p[1]) + "," + Math.round(p[2]) : "  --  "; }

  var IN = [-1.0, -0.5, 0, 0.5, 1.0];                       // 路面内（路半宽 2 米）
  var OUT = [3.0, 4.0, 5.0, 6.5, 8.0, 10.0, 12.0];          // 路外地面（避开 2~2.9 的路肩带）
  var depths = [8, 14, 22, 34, 50, 75, 110, 160, 230, 320, 450, 640, 900, 1400, 2200];
  var lines = [
    "地图 " + (window.RD && RD.profile ? RD.profile.map : "?") + "   W=" + W + " H=" + H +
      "   地面参照 = 屏幕左右 4%/96% 处（装饰已关）",
    " 深度   屏幕y  路面亮  路外亮  地面亮  亮度差  通道差   路面RGB        地面RGB"
  ];
  for (var i = 0; i < depths.length; i++) {
    var d = depths[i], y = Math.round(scrY(d));
    if (y < 0 || y >= H) { lines.push(pad(d + "m", 7) + "   （屏幕外）"); continue; }
    var road = medianAt(IN, d), o = medianAt(OUT, d), g = groundAt(y);
    var dL = (road && g) ? (lum(road) - lum(g)) : null;
    var dC = (road && g) ? maxCh(road, g) : null;
    lines.push(pad(d + "m", 7) + pad(y, 7) +
      pad(road ? lum(road).toFixed(1) : "--", 8) +
      pad(o ? lum(o).toFixed(1) : "--", 8) +
      pad(g ? lum(g).toFixed(1) : "--", 8) +
      pad(dL === null ? "--" : dL.toFixed(1), 8) +
      pad(dC === null ? "--" : Math.round(dC), 7) +
      "   " + pad(rgb(road), 14) + " " + rgb(g));
  }
  return lines.join("\n");
})()
