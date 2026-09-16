/* ============================================================================
 *  RoadProjector —— 伪 3D 路面 ⇄ 画布坐标映射（JavaScript 版）
 *  由 RoadProjector.ts 移植，去掉了类型标注，接口完全一致。
 *
 *  ⚠️ 本游戏直接使用「屏幕坐标」（左上原点、y 向下）构造投影器。
 *     原因：整套映射只用到向量 lerp / 叉积 / 模长，全部是线性或旋转不变量,
 *     所以镜像（y 轴反向）情形同样成立 —— 投影结果就是屏幕坐标，无需翻转。
 *
 *  核心公式：
 *      t = y / (y + k)        A = lerp(L0, V, t)     B = lerp(R0, V, t)
 *      u = (x + W/2) / W      pos = lerp(A, B, u)    scale = 1 − t
 * ========================================================================== */
(function (global) {
  'use strict';

  var v2 = function (x, y) { return { x: x, y: y }; };
  var cross = function (a, b) { return a.x * b.y - a.y * b.x; };
  var sub = function (a, b) { return v2(a.x - b.x, a.y - b.y); };
  var lerpV = function (a, b, t) { return v2(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t); };
  var vlen = function (a) { return Math.hypot(a.x, a.y); };
  var normalize = function (a) {
    var l = vlen(a);
    return l < 1e-12 ? v2(0, 0) : v2(a.x / l, a.y / l);
  };
  var clamp = function (v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; };

  /** 两条直线求交点，平行返回 null */
  function lineIntersect(a0, a1, b0, b1) {
    var da = sub(a1, a0), db = sub(b1, b0);
    var den = cross(da, db);
    if (Math.abs(den) < 1e-9) return null;
    var t = cross(sub(b0, a0), db) / den;
    return v2(a0.x + da.x * t, a0.y + da.y * t);
  }

  /** 图片坐标（左上原点）→ 画布坐标（左下原点） */
  function fromImageCoords(p, imageHeight) {
    return v2(p.x, imageHeight - p.y);
  }

  /** 绕 pivot 旋转 deg 度（正 = 逆时针；顺时针 90° 传 −90） */
  function rotateAround(p, pivot, deg) {
    var r = (deg * Math.PI) / 180;
    var c = Math.cos(r), s = Math.sin(r);
    var dx = p.x - pivot.x, dy = p.y - pivot.y;
    return v2(pivot.x + dx * c - dy * s, pivot.y + dx * s + dy * c);
  }

  /** 由相机参数推算透视强度 k = Y0 + h·tanφ */
  function kFromCamera(cam) {
    var phi = ((cam.pitchDeg || 0) * Math.PI) / 180;
    return Math.max(cam.nearDistance + cam.height * Math.tan(phi), 1e-3);
  }

  /* ======================================================================== */

  function RoadProjector(opts) {
    this.left0 = opts.left0;
    this.right0 = opts.right0;
    this.roadWidth = opts.roadWidth != null ? opts.roadWidth : 4;
    this.minDepth = opts.minDepth != null ? opts.minDepth : 0;
    this.maxDepth = opts.maxDepth != null ? opts.maxDepth : Infinity;

    this.edge = sub(this.right0, this.left0);
    this.edgeLen = vlen(this.edge);
    if (this.edgeLen < 1e-6) throw new Error('[RoadProjector] left0 与 right0 不能重合');

    if (opts.vanish) {
      this.isParallel = false;
      this.vanish = opts.vanish;
      this.wL = sub(opts.vanish, opts.left0);
      this.dir = v2(0, 0);
      this.ppm = 0;
    } else if (opts.parallel) {
      this.isParallel = true;
      this.vanish = null;
      this.wL = null;
      this.dir = normalize(opts.parallel.dir);
      this.ppm = opts.parallel.pxPerMeter;
    } else {
      throw new Error('[RoadProjector] 必须提供 vanish（透视）或 parallel（等距）之一');
    }

    this._k = opts.camera ? kFromCamera(opts.camera) : (opts.k != null ? opts.k : 60);
    if (!(this._k > 0)) throw new Error('[RoadProjector] k 必须大于 0');
  }

  /** 给两条路沿直线，自动求消失点；平行则退化为等距模式 */
  RoadProjector.fromEdgeLines = function (cfg) {
    var v = lineIntersect(cfg.leftEdge[0], cfg.leftEdge[1], cfg.rightEdge[0], cfg.rightEdge[1]);
    if (v) {
      return new RoadProjector({
        left0: cfg.leftEdge[0], right0: cfg.rightEdge[0], vanish: v,
        roadWidth: cfg.roadWidth, k: cfg.k, camera: cfg.camera, maxDepth: cfg.maxDepth
      });
    }
    return new RoadProjector({
      left0: cfg.leftEdge[0], right0: cfg.rightEdge[0],
      parallel: { dir: sub(cfg.leftEdge[1], cfg.leftEdge[0]), pxPerMeter: cfg.pxPerMeter || 4 },
      roadWidth: cfg.roadWidth, k: cfg.k, camera: cfg.camera, maxDepth: cfg.maxDepth
    });
  };

  RoadProjector.prototype = {
    constructor: RoadProjector,

    get k() { return this._k; },
    set k(v) {
      if (!(v > 0)) throw new Error('[RoadProjector] k 必须大于 0');
      this._k = v;
    },

    /** 近端路宽的像素长度 */
    get nearWidthPx() { return this.edgeLen; },

    /** 深度 y（米）→ 深度参数 t */
    tFromDepth: function (y) {
      if (this.isParallel) return 0;
      return y / (y + this._k);
    },

    /** t → 深度 y（米） */
    depthFromT: function (t) {
      if (this.isParallel) return 0;
      var c = clamp(t, 0, 0.999999);
      return (this._k * c) / (1 - c);
    },

    /** 有效视深：t 从 0.2 → 0.9 对应的 y 区间 */
    visibleDepthRange: function () {
      if (this.isParallel) {
        var d = isFinite(this.maxDepth) ? this.maxDepth : 100;
        return { shallow: d * 0.2, deep: d * 0.9 };
      }
      return { shallow: this.depthFromT(0.2), deep: this.depthFromT(0.9) };
    },

    /** 核心：3D 路面坐标 → 画布坐标 */
    project: function (x3d, y3d) {
      var y = clamp(y3d, this.minDepth, this.maxDepth);
      var u = (x3d + this.roadWidth / 2) / this.roadWidth;
      var a, b, t;

      if (this.isParallel) {
        t = 0;
        var d = y * this.ppm;
        a = v2(this.left0.x + this.dir.x * d, this.left0.y + this.dir.y * d);
        b = v2(this.right0.x + this.dir.x * d, this.right0.y + this.dir.y * d);
      } else {
        t = this.tFromDepth(y);
        a = lerpV(this.left0, this.vanish, t);
        b = lerpV(this.right0, this.vanish, t);
      }

      return {
        pos: lerpV(a, b, u),
        scale: this.isParallel ? 1 : 1 - t,
        t: t,
        u: u,
        depth: y
      };
    },

    projectPos: function (x3d, y3d) { return this.project(x3d, y3d).pos; },

    /** 反查：画布坐标 → 路面坐标；路沿之外返回 null */
    unproject: function (p) {
      var m = sub(p, this.left0);

      if (this.isParallel) {
        var cme = cross(m, this.edge);
        var cde = cross(this.dir, this.edge);
        if (Math.abs(cde) < 1e-9) return null;
        var y = cme / (this.ppm * cde);
        var ced = cross(this.edge, this.dir);
        if (Math.abs(ced) < 1e-9) return null;
        var u = cross(m, this.dir) / ced;
        return { x: u * this.roadWidth - this.roadWidth / 2, y: y };
      }

      var w = this.wL;
      var den = cross(w, this.edge);
      if (Math.abs(den) < 1e-9) return null;

      var tt = cross(m, this.edge) / den;
      if (tt < 0 || tt >= 1 - 1e-9) return null;

      var uu = -cross(m, w) / ((1 - tt) * den);
      return {
        x: uu * this.roadWidth - this.roadWidth / 2,
        y: this.depthFromT(tt)
      };
    },

    /** 取某个 t 处的横断面 */
    crossSectionAtT: function (t) {
      var c = clamp(t, 0, 1);
      var a, b;
      if (this.isParallel) {
        a = this.left0; b = this.right0;
      } else {
        a = lerpV(this.left0, this.vanish, c);
        b = lerpV(this.right0, this.vanish, c);
      }
      return { a: a, b: b, width: vlen(sub(b, a)) };
    },

    /** 取某个深度处的横断面 */
    crossSectionAtDepth: function (y) {
      return this.crossSectionAtT(this.tFromDepth(clamp(y, this.minDepth, this.maxDepth)));
    },

    /** 沿路沿按等深采样出一串点 */
    edgePoints: function (side, count) {
      count = count || 24;
      var pts = [];
      var deep = isFinite(this.maxDepth) ? this.maxDepth : this.depthFromT(0.95);
      for (var i = 0; i < count; i++) {
        var y = (deep * i) / (count - 1);
        pts.push(this.project(side === 'left' ? -this.roadWidth / 2 : this.roadWidth / 2, y).pos);
      }
      return pts;
    },

    /** 该深度下一条横向线的像素长度 */
    widthAtDepth: function (y) { return this.crossSectionAtDepth(y).width; },

    isOnRoad: function (x3d, y3d, tolerance) {
      var half = this.roadWidth / 2 + (tolerance || 0);
      return x3d >= -half && x3d <= half && y3d >= this.minDepth && y3d <= this.maxDepth;
    },

    clampX: function (x3d) {
      var half = this.roadWidth / 2;
      return clamp(x3d, -half, half);
    },

    /** 返回整个画布绕 pivot 旋转 deg 度后的新投影器（原对象不变） */
    rotatedAround: function (pivot, deg) {
      var opts = {
        left0: rotateAround(this.left0, pivot, deg),
        right0: rotateAround(this.right0, pivot, deg),
        roadWidth: this.roadWidth,
        k: this._k,
        minDepth: this.minDepth,
        maxDepth: this.maxDepth
      };
      if (this.vanish) {
        opts.vanish = rotateAround(this.vanish, pivot, deg);
      } else {
        opts.parallel = { dir: rotateAround(this.dir, v2(0, 0), deg), pxPerMeter: this.ppm };
      }
      return new RoadProjector(opts);
    }
  };

  global.RoadProjector = RoadProjector;
  global.RPUtil = {
    v2: v2,
    lineIntersect: lineIntersect,
    fromImageCoords: fromImageCoords,
    rotateAround: rotateAround,
    kFromCamera: kFromCamera,
    clamp: clamp
  };
})(window);
