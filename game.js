/* ============================================================================
 *  御剑封路 · Road Defender
 *  固定视角伪 3D 三列守路小游戏 —— 基于 RoadProjector
 *
 *  视角原理：玩家永远站在深度 y=22 米处（屏幕下方固定位置），
 *           世界（道路纹理 / 妖物 / 掉落物）以 scrollSpeed 向后流动，
 *           于是「人不动、路在退」，得到第三人称追尾的固定视角。
 * ========================================================================== */
(function () {
  'use strict';

  /* ══════════════════ 小工具 ══════════════════ */
  var $ = function (id) { return document.getElementById(id); };
  var rand = function (a, b) { return a + Math.random() * (b - a); };
  var randInt = function (a, b) { return Math.floor(a + Math.random() * (b - a + 1)); };
  var clamp = function (v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; };
  var lerp = function (a, b, t) { return a + (b - a) * t; };
  var pick = function (arr) { return arr[Math.floor(Math.random() * arr.length)]; };
  var fmtTime = function (s) {
    s = Math.max(0, Math.ceil(s));
    return Math.floor(s / 60) + ':' + (s % 60 < 10 ? '0' : '') + (s % 60);
  };

  /* ══════════════════ 配置 ══════════════════ */
  var CFG = {
    roadWidth: 4,
    lanes: [-4 / 3, 0, 4 / 3],   // 三条小路中心（米）
    playerY: 22,                 // 玩家固定深度（米）—— 视角固定的关键
    playerMoveSpeed: 5.4,        // 横向移动速度（米/秒）
    scrollSpeed: 12,             // 前进速度 → 世界后移速度
    spawnDepth: 120,             // 妖物生成深度
    despawnDepth: -9,            // 越过玩家多远后回收
    roadViewDepth: 175,          // 路面条纹绘制范围
    roundDuration: 180,          // 存活即可通关的秒数
    /* 判定半径刻意贴近人物画出来的身宽（约 0.6 米）：
     * 定得太大就会出现"看着没撞上却掉血"的憋屈感 */
    playerRadius: 0.38,
    maxHp: 100,
    bulletSpeed: 88,
    bulletLife: 3.4,
    pickupRadius: 0.9,
    hurtCooldown: 0.55,          // 受击无敌帧，防止一帧内被多只怪瞬秒
    /* 拖动的灵敏度：1.0 = 手指横移多少像素、人物就横移多少像素（人物的屏幕位移和手指完全一致）。
     * 想更"灵"就调大（比如 1.3，手指挪 100px 人物挪 130px），想更"稳"就调小。 */
    dragSensitivity: 1.0
  };

  /* shots 发数；spreadM 为"齐射在目标所在深度处散开多少米"；pierce 为可多穿几个目标。
   * desc 是给属性面板用的一句话特性说明 —— 刻意只写"手感"，不写数字，
   * 数字全部由面板从 cd/dmg/shots/spreadM/pierce 现算，避免两处写死对不上。
   *
   * ⚠ spreadM 的单位必须是"米"，不要换回"相邻两发的夹角（弧度）"。
   * 这两把武器最初用的是固定夹角 0.12 / 0.20 弧度，是硬伤：
   * 妖物在 17 米（ATTACK.range）才进入交火，而 0.20 弧度在 17 米处横向偏
   * 17·tan(0.20) = 3.45 米 —— 妖物判定半径只有 0.76 米（半径 0.44 + 弹道 0.32），
   * 路半宽也才 2 米。于是两侧的剑一出手就飞到路外：双股剑 17 米外两发全空、
   * 三才剑阵三发只中一发，真实命中率 62% / 47%，比初始飞剑还弱。
   * 夹角给的是"随距离越散越开的绝对角度"，米给的是"和距离无关的宽度" ——
   * 后者才是玩家对"并射 / 齐射"的心理模型。动这两个数之前先看 e2e 测试 H。
   *
   * ⚠ 多发武器的单发伤害（9 / 8）低于初始飞剑（13），同样是刻意的，别顺手调回 12。
   * 齐射能全中之后，实际 dps = dmg × shots ÷ cd：9 / 8 对应 34.6 / 35.3，
   * 而 12 会到 46 / 53 —— 高过「小妖血量 20 ÷ 预警 0.5 秒 = 40」这条线，
   * 妖物在扑到之前就被打死，站着不动反而无敌（这正是起始飞剑注释里的那条教训）。
   * 实测把 dmg 留成 12 时，dev/stand180.js 的站桩通关率从 8% 飙到 42%（12 局里 5 局通关）；
   * 回到 9 / 8 后是 1/12，与修复前一致。改这两个数之前先跑 stand180
   * 和 dev/balance-test.js 第 5 节（那里有一条以"发呆阈值"为准的反向护栏）。 */
  var WEAPONS = {
    /* 起始飞剑：低射速、高单发。
     * 两点都是踩坑踩出来的：
     *  · 单发伤害不能太小 —— 伤害本来就会被路径上的其它妖物分掉，
     *    单发 6 点时会变成"开 300 枪、命中率 92%、只打死 6 只"（单杀耗伤 250）；
     *  · dps 也不能太高 —— 高于（小妖血量 ÷ 预警时长）的话，
     *    妖物还没扑到就被打死，站着不动反而无敌。 */
    sword: { key: 'sword', name: '飞剑', desc: '单发直线，稳而沉', cd: 0.80, dmg: 13, shots: 1, spreadM: 0, pierce: 0, color: '#8fd8ff' },
    twin: { key: 'twin', name: '双股剑', desc: '双道并射，出手最快', cd: 0.52, dmg: 9, shots: 2, spreadM: 0.9, pierce: 0, color: '#9dffd7' },
    fan: { key: 'fan', name: '三才剑阵', desc: '三发齐出，火力最密', cd: 0.68, dmg: 8, shots: 3, spreadM: 0.5, pierce: 0, color: '#ffd98f' },
    cloud: { key: 'cloud', name: '穿云剑', desc: '单发最重，一贯三', cd: 0.80, dmg: 40, shots: 1, spreadM: 0, pierce: 3, color: '#ffa8dd' }
  };
  var WEAPON_KEYS = ['sword', 'twin', 'fan', 'cloud'];

  var MONSTERS = {
    slime: { key: 'slime', name: '小妖', hp: 20, speed: 1.9, r: 0.44, dmg: 8, score: 10, color: '#7ee081', dark: '#3d7a46', windup: 0.50, dash: 10 },
    bat: { key: 'bat', name: '飞蝠', hp: 15, speed: 3.6, r: 0.34, dmg: 6, score: 16, color: '#c58bff', dark: '#6b46a0', windup: 0.40, dash: 15 },
    brute: { key: 'brute', name: '蛮兵', hp: 55, speed: 1.4, r: 0.58, dmg: 14, score: 32, color: '#ff9366', dark: '#a3492b', windup: 0.72, dash: 8 },
    elite: { key: 'elite', name: '妖将', hp: 115, speed: 1.6, r: 0.66, dmg: 18, score: 70, color: '#ffd166', dark: '#a37a17', windup: 0.64, dash: 9 }
  };

  /* 妖物的主动攻击节奏：进入射程 → 立刻锁定落点并蓄力（地面亮预警圈）→ 扑击 → 命中或扑空
   * 关键点：落点是在"蓄力开始时"锁定的，不是蓄力结束时。
   * 这样预警圈从出现到砸下有一整个 windup + 冲刺的时间，玩家看得见、躲得开；
   * 蓄力结束时才锁定的话，玩家只能靠事后逃跑，体感很差。 */
  var ATTACK = {
    range: 17,          // 距玩家多少米进入攻击准备
    lockJitter: 0.40,   // 锁定落点时的横向误差（米）：站着不动必被打中，横向挪开就躲开
    brake: 0.20,        // 蓄力期间保留多少世界滚动（越低越像"刹车"）
    lungeChase: 3.1,    // 扑击时的横向追击速度（米/秒，低于玩家 5.4 → 横移就能甩开）
    hitDepth: 1.6,      // 冲到距玩家这个深度内开始判定命中
    lungeTime: 1.1,     // 扑击最长持续（秒）
    recover: 0.42       // 扑空后的收招时间
    /* 为什么不做"同时只允许 N 只攻击"的限流：
     * 试过，结果是大量妖物因为排不上队，直接从玩家身上走过去了 ——
     * 反而出现"站着不动 3 分钟不掉血"的怪现象。
     * 真正的公平性来自另外三点：落点在蓄力开始时就被钉死（不会追着玩家打）、
     * 横移追击 3.2 < 玩家 5.4（一直走就甩得开）、命中半径只有 0.9 米出头。
     * 所以难度请通过出怪节奏、血量、伤害来调，不要加限流。 */
  };

  /* ══════════════════ 路旁景物（场景装饰） ══════════════════
   * 道路只占屏幕中间一个窄楔形，两侧本来是大片纯色虚空 —— 这就是"空旷"的来源。
   * 三类东西填它：
   *   1. 铺地 + 远山剪影 + 地平线雾带（drawn once，把"天与地"分开，见 drawBackdrop）
   *   2. 三层路旁植被/建筑（本配置，跟着 scroll 一起往后退）
   *   3. 灯笼的暖光池 + 萤火（见 drawLanterns / drawFireflies）
   *
   * 三层横向带来由：伪 3D 下"能看见多宽"取决于深度 ——
   * 近处（屏幕底部）路占满宽度，两侧只露出 ±2.6~4.5 米；
   * 远处路收窄，两侧能露出 ±10 米以上。所以想让画面从下到上都有东西，
   * 就必须同时铺"贴路的小东西"和"远一点的大东西"，光靠一种摆法必然留白。
   *
   * 位置全部由「世界里程」推导，不存状态：
   *   某物件的世界里程 D 固定，当前深度 y3d = D − scroll。
   *   于是 D = k·spacing 的整数槽位 + 稳定哈希（hashSeq）就能得到
   *   一个"每次重开都一模一样、不随帧率漂移、不需要回收数组"的世界。
   */
  var SCENE = {
    /* 每条带有自己的 maxDepth：带越远、单个物件越小，就该一路铺到更远的地方，
     * 否则屏幕中上部（约 y=150~320，对应深度 150 米开外）会留出一大片空白 ——
     * 那里正是"空旷感"最重的地方。maxDepth 同时也是性能闸门。 */
    belts: [
      /* minX 不是随便取的：它是"这一带最宽的物件也不能压到路面"倒推出来的。
       * 贴路带最宽的是山石（±0.70 米），2.72 − 0.70 = 2.02 > 路半宽 2.0 —— 刚好不越界。
       * 竹叶会略微探到路沿上方约 0.15 米，这是刻意留的（看起来自然），
       * 有 dev/e2e-test.js 测试 E 盯着这个余量，改 minX 或放大任何物件都会被它拦下。 */
      // 贴路带：小东西，负责屏幕下半部分的"路边感"
      { spacing: 7.5, minX: 2.72, spread: 1.8, density: 0.88, maxDepth: 260,
        kinds: ['grass', 'rock', 'bamboo', 'grass', 'banner', 'rock', 'bush'] },
      // 中景带：树，负责主体轮廓（阔叶树冠最宽可达 ±2.7 米）
      { spacing: 12.5, minX: 4.9, spread: 3.4, density: 0.62, maxDepth: 450,
        kinds: ['pine', 'broadleaf', 'pine', 'rock', 'hut', 'broadleaf'] },
      // 远景带：偶尔一栋楼阁／牌坊，负责"那后面还有东西"
      { spacing: 22, minX: 8.5, spread: 8.0, density: 0.55, maxDepth: 520,
        kinds: ['pine', 'pagoda', 'gate', 'broadleaf', 'pine'] }
    ],
    lampSpacing: 30,     // 石灯笼间隔（米）——刻意做成规律的韵律，强化道路延伸感
    fireflies: 14,       // 萤火数量
    /* 雾（空气透视）：alpha = fogMin + (1−fogMin)·exp(−depth/fogD)。
     * 用指数而不是线性，是因为线性雾让中景（50~120 米）掉得太快，
     * 整片林子会糊成一团；指数衰减能保住中景的轮廓。
     * fogMin = "再远也不低于这个不透明度"：远山远林必须留一点痕迹，
     * 否则地平线附近又会空掉。 */
    fogMin: 0.30,
    fogD: 75
  };

  /* 确定性哈希：给每个"槽位 + 左右 + 层"生成稳定的伪随机序列。
   * 用它而不是 Math.random 的原因见上面 SCENE 的注释 —— 景物必须钉在世界里。 */
  function hashSeq(seed) {
    var s = (seed | 0) >>> 0;
    return function () {
      s = (Math.imul(s ^ (s >>> 15), 2246822519) + 374761393) >>> 0;
      return ((s ^ (s >>> 13)) >>> 0) / 4294967296;
    };
  }
  var hashOf = function (k, row, side) {
    return Math.imul(k, 374761393) + Math.imul(row + 1, 668265263) + (side > 0 ? 1442695041 : 1013904223);
  };

  /* 强化词条。显示相关的三样东西全部挂在数据上，UI 只负责读：
   *   · icon   —— SVG 片段（24×24，描边色用 currentColor，容器给 color）
   *   · badge  —— 给定层数 → 图标右上角那个小角标（"+45%" / "+0.50"）
   *   · effect —— 给定层数 → 属性面板里那句"现在是多少"
   * 加一个新词条不需要动任何绘制或面板代码。
   *
   * stackable 决定这一格怎么表现：
   *   true  —— 可叠加：占一个固定槽位，角标写累计数值（层数由数值本身体现），
   *            未获得时该槽位变灰但不消失，位置固定，玩家能记住在哪看。
   *   false —— 不可叠加：捡到就替换，同样占一个固定槽位、角标不写层数。
   *            武器就是这一类（槽位排在最前）。
   *
   * 为什么角标写"累计数值"而不是"层数"：玩家真正想知道的是"我现在暴击多少"，
   * +50% 一眼就懂，"+3" 还得自己去乘。层数放在属性面板里（"攻击力 +2"）。 */
  var BUFF_LIST = [
    { key: 'atk', name: '攻击力', color: '#ff9b6b', stackable: true,
      icon: '<path d="M4.6 19.4 16 8"/><path d="M13.8 5.8h4.4v4.4"/><path d="M7.4 12.6l4 4"/>',
      badge: function (n) { return '+' + Math.round(n * 15) + '%'; },
      effect: function (n) { return '伤害 ×' + (1 + n * 0.15).toFixed(2); },
      note: '每层武器伤害 +15%' },
    { key: 'rate', name: '攻速', color: '#8fd8ff', stackable: true,
      icon: '<path d="M13.6 2.4 5.4 13.6h5.3l-.8 8 8.7-11.6h-5.3l.3-7.6Z"/>',
      badge: function (n) { return '+' + Math.round(n * 12) + '%'; },
      effect: function (n) { return '攻速 ×' + (1 + n * 0.12).toFixed(2); },
      note: '每层攻击频率 +12%' },
    { key: 'crit', name: '暴击率', color: '#ffd166', stackable: true,
      icon: '<circle cx="12" cy="12" r="6.9"/><path d="M12 1.7v4.3M12 18v4.3M1.7 12H6M18 12h4.3"/>'
        + '<circle cx="12" cy="12" r="1.7" fill="currentColor" stroke="none"/>',
      badge: function (n) { return '+' + Math.round(n * 6) + '%'; },
      effect: function (n) { return '暴击率 ' + Math.min(92, Math.round((0.05 + n * 0.06) * 100)) + '%'; },
      note: '基础 5%，每层 +6%，上限 92%' },
    { key: 'critDmg', name: '暴击伤害', color: '#ff8ad0', stackable: true,
      icon: '<path d="M12 2.4 14.3 9.7 21.6 12 14.3 14.3 12 21.6 9.7 14.3 2.4 12 9.7 9.7Z"'
        + ' fill="currentColor" stroke="none"/>',
      badge: function (n) { return '+' + (n * 0.25).toFixed(2); },
      effect: function (n) { return '暴击倍率 ' + (1.5 + n * 0.25).toFixed(2) + '×'; },
      note: '基础 1.50×，每层 +0.25' }
  ];
  var BUFF_MAP = {};
  BUFF_LIST.forEach(function (b) { BUFF_MAP[b.key] = b; });

  /* ══════════════════ 设置持久化 ══════════════════ */
  var settings = { volume: 0.6, vibrate: true };
  var bestScore = 0;
  try {
    var sv = JSON.parse(localStorage.getItem('rd_settings') || '{}');
    if (typeof sv.volume === 'number') settings.volume = clamp(sv.volume, 0, 1);
    if (typeof sv.vibrate === 'boolean') settings.vibrate = sv.vibrate;
    bestScore = parseInt(localStorage.getItem('rd_best') || '0', 10) || 0;
  } catch (e) { /* 隐私模式下忽略 */ }

  function saveSettings() {
    try { localStorage.setItem('rd_settings', JSON.stringify(settings)); } catch (e) {}
  }
  function saveBest() {
    try { localStorage.setItem('rd_best', String(bestScore)); } catch (e) {}
  }

  function vibrate(ms) {
    if (!settings.vibrate) return;
    if (navigator.vibrate) { try { navigator.vibrate(ms); } catch (e) {} }
  }

  /* ══════════════════ 音效（Web Audio 合成，无外部资源） ══════════════════ */
  var Sound = {
    ctx: null, master: null,
    init: function () {
      if (this.ctx) return;
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      try {
        this.ctx = new AC();
        this.master = this.ctx.createGain();
        this.master.gain.value = settings.volume;
        this.master.connect(this.ctx.destination);
      } catch (e) { this.ctx = null; }
    },
    resume: function () {
      if (this.ctx && this.ctx.state === 'suspended') { try { this.ctx.resume(); } catch (e) {} }
    },
    setVolume: function (v) { if (this.master) this.master.gain.value = v; },
    tone: function (freq, dur, type, vol, slideTo) {
      if (!this.ctx) return;
      var t0 = this.ctx.currentTime;
      var o = this.ctx.createOscillator();
      var g = this.ctx.createGain();
      o.type = type || 'square';
      o.frequency.setValueAtTime(freq, t0);
      if (slideTo) o.frequency.exponentialRampToValueAtTime(Math.max(40, slideTo), t0 + dur);
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(Math.max(0.0002, vol || 0.12), t0 + 0.008);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      o.connect(g); g.connect(this.master);
      o.start(t0); o.stop(t0 + dur + 0.03);
    },
    noise: function (dur, vol, freq) {
      if (!this.ctx) return;
      var sr = this.ctx.sampleRate;
      var len = Math.floor(sr * dur);
      var buf = this.ctx.createBuffer(1, len, sr);
      var d = buf.getChannelData(0);
      for (var i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
      var src = this.ctx.createBufferSource();
      src.buffer = buf;
      var bp = this.ctx.createBiquadFilter();
      bp.type = 'lowpass'; bp.frequency.value = freq || 900;
      var g = this.ctx.createGain(); g.gain.value = vol || 0.2;
      src.connect(bp); bp.connect(g); g.connect(this.master);
      src.start();
    },
    shoot: function () { this.tone(900, 0.07, 'square', 0.055, 420); },
    hit: function () { this.tone(260, 0.05, 'sawtooth', 0.05, 130); },
    kill: function () { this.tone(520, 0.15, 'triangle', 0.1, 190); },
    warn: function () { this.tone(320, 0.14, 'sawtooth', 0.075, 660); },
    lunge: function () { this.tone(180, 0.18, 'sawtooth', 0.085, 90); },
    hurt: function () { this.noise(0.22, 0.22, 700); this.tone(110, 0.24, 'sawtooth', 0.12, 55); },
    pickup: function () {
      var self = this;
      this.tone(680, 0.08, 'sine', 0.1);
      setTimeout(function () { self.tone(1020, 0.11, 'sine', 0.1); }, 65);
    },
    win: function () {
      var self = this;
      [523, 659, 784, 1047].forEach(function (f, i) {
        setTimeout(function () { self.tone(f, 0.34, 'triangle', 0.14); }, i * 135);
      });
    },
    lose: function () {
      var self = this;
      [392, 330, 262, 196].forEach(function (f, i) {
        setTimeout(function () { self.tone(f, 0.38, 'sawtooth', 0.12); }, i * 170);
      });
    }
  };

  /* ══════════════════ 画布 & 投影器 ══════════════════ */
  var canvas = $('game');
  var ctx = canvas.getContext('2d');
  var W = 0, H = 0, DPR = 1;
  var road = null, pxPerMeter = 1, vignette = null;

  function resize() {
    DPR = Math.min(window.devicePixelRatio || 1, 2);
    W = canvas.clientWidth || window.innerWidth;
    H = canvas.clientHeight || window.innerHeight;
    canvas.width = Math.round(W * DPR);
    canvas.height = Math.round(H * DPR);
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    buildRoad();
    vignette = ctx.createRadialGradient(W * 0.5, H * 0.55, H * 0.25, W * 0.5, H * 0.55, H * 0.95);
    vignette.addColorStop(0, 'rgba(0,0,0,0)');
    vignette.addColorStop(1, 'rgba(0,0,0,0.55)');
  }

  function buildRoad() {
    var halfW = W * 0.26;
    road = new RoadProjector({
      left0: { x: W * 0.5 - halfW, y: H },
      right0: { x: W * 0.5 + halfW, y: H },
      vanish: { x: W * 0.5, y: H * 0.155 },
      roadWidth: CFG.roadWidth,
      k: 48,
      maxDepth: 420
    });
    pxPerMeter = road.nearWidthPx / CFG.roadWidth;
  }

  /* ══════════════════ 游戏状态 ══════════════════ */
  var state = 'loading';
  var G = null;
  var bgScroll = 0;
  var animT = 0;          // 全局动画时间：只给"原地摆动"的东西用（幡旗 / 萤火）
  var settingsFrom = 'home';

  function newGame() {
    G = {
      t: 0, score: 0, kills: 0,
      hp: CFG.maxHp, maxHp: CFG.maxHp,
      x3d: 0, vx: 0,
      scroll: 0,
      weapon: 'sword',
      fireTimer: 0.3,
      buffs: { atk: 0, rate: 0, crit: 0, critDmg: 0 },
      spawnTimer: 1.0,
      monsters: [], bullets: [], drops: [], parts: [], floats: [], rings: [],
      shake: 0, flash: 0, hurtCd: 0, warnCd: 0,
      dropsSpawned: 0, dropsPicked: 0, hits: 0,   // 运行统计（调试/调平衡用）
      shotsFired: 0, bulletHits: 0, dmgDealt: 0, aimLock: null,
      keyLeft: false, keyRight: false,
      drag: false, dragLastX: 0, dragPxPerM: 80, dragMove: 0,
      statsOpen: false                        // 属性面板是否展开（每局重置）
    };
  }

  function currentScroll() {
    return (state === 'playing' && G) ? G.scroll : bgScroll;
  }

  /* ══════════════════ 属性 / 难度 ══════════════════ */
  function playerStats() {
    var w = WEAPONS[G.weapon];
    var cd = w.cd / (1 + G.buffs.rate * 0.12);
    var dmg = w.dmg * (1 + G.buffs.atk * 0.15);
    var crit = Math.min(0.92, 0.05 + G.buffs.crit * 0.06);
    var critMul = 1.5 + G.buffs.critDmg * 0.25;
    return {
      w: w, shots: w.shots, cd: cd, dmg: dmg, crit: crit, critMul: critMul,
      /* 期望 dps：把暴击也算进去（每发都按概率加权）。
       * 属性面板直接显示它，这样"换武器/堆词条到底强了多少"有唯一的口径。 */
      dps: (dmg * w.shots * (1 + crit * (critMul - 1))) / cd
    };
  }

  function difficulty() {
    var t = G.t;
    return {
      /* 三条曲线的相对关系决定了整个手感：出怪血量/秒 略高于玩家 dps，
       * 超出的部分就是"会扑到你身上的妖物"。改难度优先动 interval 和 hpMul。 */
      interval: Math.max(0.42, 0.92 - (t / 180) * 0.30),
      hpMul: 1 + (t / 180) * 1.05,
      speedMul: 1 + (t / 180) * 0.40,
      elite: t < 50 ? 0 : Math.min(0.20, (t - 50) / 300),
      brute: t < 25 ? 0 : Math.min(0.32, (t - 25) / 160)
    };
  }

  /* ══════════════════ 输入 ══════════════════
   * 移动方式：按住左右拖动，增量式、1:1 跟随 ——
   * 手指/鼠标横向移动多少像素，人物就在路上横向移动多少（人物的屏幕位移和手指完全一致）。
   *
   * 为什么不做"点哪里就走到哪里"（原来是这么写的）：
   *  · 位置映射要先算出一个目标点，再让 updatePlayer 每帧插值过去，凭空多出 ~60ms 滞后，
   *    手感是"被拖着走"而不是"跟着手走"；
   *  · 路只有 4.1 米宽、屏幕上才 330px 出头，手指轻轻一点就横移大半条路，想微调半米根本做不到；
   *  · 松手前人物还在朝旧目标滑，妖物扑过来时想立刻刹住是不行的。
   * 增量拖动没有这些毛病：松手即停、想挪多少挪多少、也不用管手指停在屏幕哪个角落。 */

  /* 玩家所在深度处，1 米等于多少像素（拖动要用它把屏幕位移换算成路上位移） */
  function inputPxPerMeter() {
    var halfPx = road.widthAtDepth(CFG.playerY) / 2;
    if (halfPx < 1) return 80;                       // 尺寸还没算出来时用个兜底值
    return halfPx / (CFG.roadWidth / 2);
  }

  /* ── 事件源适配：Pointer Events 优先，退回 Touch Events ──
   * 为什么必须做这件事（而不是"现代浏览器都支持"）：
   *   Pointer Events 从 Chrome 55 / iOS Safari 13 才有。安卓微信内置浏览器的旧 X5 内核
   *   是 Chromium 53，那个环境里 pointerdown / pointermove 一个都不派发 —— 而 canvas 上
   *   已经声明了 touch-action:none，于是症状是"画面正常渲染、人物纹丝不动、属性面板也点不开"，
   *   看起来就像游戏坏了。把链接丢到微信群里，出事的是别人手机，自己手机测不出来。
   * 做法：不复制任何移动逻辑，只把事件源抽象成 on(el, kind, fn)。
   *   有 PointerEvent → 只挂 pointer*；
   *   没有         → 额外挂一套 touch*，并用 norm() 把 Touch 包成 {clientX, clientY} 的形状。
   * 两条路共用同一套 dragStart/dragMove/dragEnd 账本，所以行为完全一致，也不会双触发。 */
  var HAS_POINTER = typeof window.PointerEvent === 'function';
  var EVT_NAME = {
    down: ['pointerdown', 'touchstart'],
    move: ['pointermove', 'touchmove'],
    up: ['pointerup', 'touchend'],
    cancel: ['pointercancel', 'touchcancel']
  };

  /* 把 touch 事件里的第一根手指伪装成指针事件的样子；本来就是指针事件时原样返回 */
  function norm(e) {
    if (!e || !e.touches || !e.touches.length) return e;   // 注意 touchend 的 touches 是空的
    var t = e.touches[0];
    return { clientX: t.clientX, clientY: t.clientY, pointerId: t.identifier, target: e.target };
  }

  function on(el, kind, fn) {
    var names = EVT_NAME[kind];
    el.addEventListener(names[0], function (e) { fn(norm(e)); });
    if (!HAS_POINTER) {
      /* down/move 要 preventDefault（拦掉页面滚动与双击缩放），所以必须 passive:false，
       * 否则浏览器会忽略 preventDefault，手指一划页面就跟着滚。 */
      var opt = (kind === 'down' || kind === 'move') ? { passive: false } : false;
      el.addEventListener(names[1], function (e) { fn(norm(e)); }, opt);
    }
  }

  function dragStart(e) {
    if (state !== 'playing' || !G) return;
    G.drag = true;
    G.dragLastX = e.clientX;
    G.dragPxPerM = inputPxPerMeter();
    /* 捕获指针：鼠标拖出画布（比如拖到按钮上）也不会断。
     * 触摸路径没有这个 API（不是 Pointer Events），但 touch 事件本来就只派发给起始元素，
     * 滑出画布照样收得到，所以不需要补偿。 */
    if (canvas.setPointerCapture && e.pointerId !== undefined) {
      try { canvas.setPointerCapture(e.pointerId); } catch (err) {}
    }
  }

  function dragMove(e) {
    if (!G || !G.drag) return;
    var dx = e.clientX - G.dragLastX;                // 本帧手指横移的像素
    G.dragLastX = e.clientX;
    if (!dx) return;
    var old = G.x3d;
    G.x3d = clamp(old + (dx / G.dragPxPerM) * CFG.dragSensitivity, -2.05, 2.05);
    /* 记下"这一帧真的挪了多少"（按钳制后的量算），给 updatePlayer 算侧移速度用。
     * 拖动必须在这一刻就落到 x3d 上（零延迟），但侧倾/拖影需要按帧来看，
     * 所以这里只是记账，不在这里做视觉。 */
    G.dragMove += G.x3d - old;
  }

  function dragEnd() {
    if (G) G.drag = false;
  }

  function bindInput() {
    window.addEventListener('keydown', function (e) {
      var k = e.key;
      if (k === 'a' || k === 'A' || k === 'ArrowLeft') { if (G) G.keyLeft = true; }
      if (k === 'd' || k === 'D' || k === 'ArrowRight') { if (G) G.keyRight = true; }
      /* Esc 的优先级：先收属性面板，再开关设置。
       * 少了第一档的话，面板开着时按 Esc 会去走 closeSettings，
       * 而它会把 state 恢复成 playing —— 结果是"面板还盖着人物，游戏却在跑"。 */
      if (k === 'Escape') {
        if (G && G.statsOpen) toggleStats(false);
        else if (state === 'playing') openSettings('game');
        else if (state === 'paused') closeSettings();
      }
      if (k === ' ' || k === 'ArrowLeft' || k === 'ArrowRight') e.preventDefault();
    });
    window.addEventListener('keyup', function (e) {
      var k = e.key;
      if (k === 'a' || k === 'A' || k === 'ArrowLeft') { if (G) G.keyLeft = false; }
      if (k === 'd' || k === 'D' || k === 'ArrowRight') { if (G) G.keyRight = false; }
    });
    on(canvas, 'down', dragStart);
    on(canvas, 'move', dragMove);
    /* 抬手 / 取消挂 window：手指滑出画布再松开也要收得到，否则 G.drag 一直为 true，
     * 下一次触摸会从旧位置算位移，人物直接跳过去。 */
    on(window, 'up', dragEnd);
    on(window, 'cancel', dragEnd);
    window.addEventListener('blur', function () {
      /* 切后台 / 切到微信聊天再回来：把按键和拖动状态清干净。
       * 不清的话，切走时按着的方向键会一直"按着"，回来人物自己跑。 */
      if (G) { G.keyLeft = G.keyRight = false; G.drag = false; }
    });
    /* 音频解锁与恢复 —— 两个都会在手机上咬人：
     *   · iOS / 微信要求 AudioContext 必须在"用户手势里"创建或 resume，否则全程静音；
     *     开始按钮那一次虽然算手势，但下一条更隐蔽：
     *   · 切到微信聊天再切回来，AudioContext 会被挂起且不会自己恢复，
     *     表现是"聊了两句回来，这一局就再也没声音了"。
     * 所以任何一次触摸/点击都顺手催一下 resume（已经是 running 时它是空操作），
     * 回前台也催一次。两行成本，换掉一类"偶发没声音"的疑难杂症。 */
    on(window, 'down', function () { Sound.resume(); });
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) Sound.resume();
    });
    /* 老内核上 touch-action 未必拦得住页面级的滚动和双击缩放，再兜一层。
     * 只在没有 PointerEvent 时挂 —— 现代浏览器靠 touch-action:none 就够了，
     * 多余的 preventDefault 会顺手废掉页面里本来该有的滚动。
     * 例外：属性面板内部要能往上滚，落点在面板里就放过。 */
    if (!HAS_POINTER) {
      ['touchstart', 'touchmove'].forEach(function (n) {
        document.addEventListener(n, function (e) {
          var t = e.target;
          if (t && t.closest && t.closest('#statPanel')) return;
          if (e.cancelable) e.preventDefault();
        }, { passive: false });
      });
    }
    bindStatsStrip();
  }

  /* ── 底部信息条：既是属性面板的开关，又躺在拇指最常用的位置上 ──
   * 这两件事会打架：它必须能点（开关面板），但不能因此把"拖动"吃掉 ——
   * 否则玩家的拇指会正好压在它上面，人拖不动。
   * 所以按下时只记账，不立刻决定：
   *   · 横向挪过 7px → 判定为拖动，把手指"交棒"给游戏（从按下点算起，前 7px 不丢），
   *     并 setPointerCapture，手指滑出信息条也不会断；
   *   · 一直没挪动   → 判定为点击，切换属性面板。
   * 面板展开后，落在面板里的按下直接放过（让位给滚动），不参与开关和拖动。 */
  var stripTap = null;
  function bindStatsStrip() {
    var strip = $('statStrip');
    if (!strip) return;
    var panel = $('statPanel');

    on(strip, 'down', function (e) {
      if (!G) { stripTap = null; return; }
      /* 两种可交互情形：
       *   · playing —— 点=开关面板，拖=移动人物；
       *   · paused 且面板开着 —— 只认"点=收起"（此时人物本来就动不了，交棒没意义）。
       * 少了第二种，面板一展开就再也点不掉了。 */
      var dragOK = (state === 'playing');
      if (!dragOK && !(state === 'paused' && G.statsOpen)) { stripTap = null; return; }
      if (panel && !panel.classList.contains('hidden') && panel.contains(e.target)) {
        stripTap = null;                       // 面板内部：交给原生滚动
        return;
      }
      stripTap = { x: e.clientX, y: e.clientY, moved: false, dragOK: dragOK };
    });

    on(strip, 'move', function (e) {
      if (!stripTap) return;
      if (!stripTap.moved) {
        if (Math.abs(e.clientX - stripTap.x) < 7) return;
        stripTap.moved = true;
        if (!stripTap.dragOK) return;          // 暂停中：把这个手势作废（不交棒、也不当点击）
        G.drag = true;
        G.dragLastX = stripTap.x;              // 从按下点算，7px 死区不丢位移
        G.dragPxPerM = inputPxPerMeter();
        if (strip.setPointerCapture && e.pointerId !== undefined) {
          try { strip.setPointerCapture(e.pointerId); } catch (err) {}
        }
      }
      if (stripTap.dragOK) dragMove(e);
    });

    function stripUp() {
      if (!stripTap) return;
      var wasTap = !stripTap.moved;
      stripTap = null;
      if (wasTap) toggleStats();
      if (G) G.drag = false;
    }
    /* 抬手挂在 window 上而不是信息条上：事件会冒泡，
     * 所以"在卡片上松手"和"手指滑出卡片才松手"都能收到。
     * 只挂一边的话，第二种情况会丢事件，点击就没了。 */
    on(window, 'up', stripUp);
    on(window, 'cancel', stripUp);

    /* "收起"是在面板里动态生成的，所以用事件代理挂在稳定的 #statPanel 上 */
    if (panel) panel.addEventListener('click', function (e) {
      if (e.target && e.target.id === 'statsClose') toggleStats(false);
    });
  }

  /* ══════════════════ 玩法更新 ══════════════════ */
  function updatePlaying(dt) {
    G.t += dt;
    G.scroll += CFG.scrollSpeed * dt;
    if (G.shake > 0) G.shake = Math.max(0, G.shake - dt * 42);
    if (G.flash > 0) G.flash = Math.max(0, G.flash - dt * 2.6);
    if (G.hurtCd > 0) G.hurtCd -= dt;
    if (G.warnCd > 0) G.warnCd -= dt;

    updatePlayer(dt);
    updateFire(dt);
    updateSpawn(dt);
    updateMonsters(dt);
    updateBullets(dt);
    updateDrops(dt);
    updateFx(dt);

    if (G.hp <= 0) { endGame(false); return; }
    if (G.t >= CFG.roundDuration) { endGame(true); }
  }

  function updatePlayer(dt) {
    /* 拖动是事件驱动的（dragMove 里已经直接落到 x3d 上了），这里只管键盘的"按住持续移动"。
     * 两条路径最后都汇到同一个 x3d、同一套边界钳制，不用分叉。 */
    var dir = (G.keyRight ? 1 : 0) - (G.keyLeft ? 1 : 0);
    var keyDx = dir ? dir * CFG.playerMoveSpeed * dt : 0;
    /* dragMove 是 dragMove() 期间累计的实际位移（已被钳制过），这里只用来算侧移速度 */
    var moved = keyDx + G.dragMove;
    G.dragMove = 0;
    G.x3d = clamp(G.x3d + keyDx, -2.05, 2.05);
    /* 侧移速度（米/秒，带一点平滑）：只用于视觉表现 —— 人物侧倾 + 侧移拖影。
     * 有了它，"拖动"这种一帧到位的手感才会看起来是划过去，而不是闪过去。 */
    if (dt > 0.0001) G.vx = lerp(G.vx, moved / dt, Math.min(1, dt * 14));
  }

  /* 软锁定：挑一个"最值得打"的前方妖物当作瞄准方向。
   * 没有锁定的话，子弹只能沿着玩家所在的那一列飞，
   * 而闪避又要求玩家离开那一列 —— 两个需求会互相打架。 */
  function aimTarget() {
    // 锁定目标要"粘"住：每发都重新挑最近的话，伤害会平摊到所有妖物身上，
    // 结果就是开了 300 枪、命中率 92%，却一只都打不死（实测踩过这个坑）。
    var lock = G.aimLock;
    if (lock && !lock.dead) {
      var ldy = lock.y3d - CFG.playerY;
      if (ldy > 0.6 && ldy < 95) return lock;
    }
    var best = null, bestScore = Infinity;
    for (var i = 0; i < G.monsters.length; i++) {
      var m = G.monsters[i];
      if (m.dead) continue;
      var dy = m.y3d - CFG.playerY;
      if (dy < 0.6 || dy > 95) continue;          // 只瞄前方，不回头打身后的
      var score = dy + Math.abs(m.x3d - G.x3d) * 1.7;   // 优先近的、正前方的
      if (score < bestScore) { bestScore = score; best = m; }
    }
    G.aimLock = best;
    return best;
  }

  function updateFire(dt) {
    var st = playerStats();
    G.fireTimer -= dt;
    if (G.fireTimer > 0) return;
    G.fireTimer = st.cd;

    var oy = CFG.playerY + 1.4;
    var tgt = aimTarget();
    var aimX = tgt ? tgt.x3d : G.x3d;
    var aimY = tgt ? tgt.y3d : oy + 60;
    /* 与目标的深度差：夹住下界，免得妖物贴脸扑过来时 atan2 在小分母上算出横飞的角 */
    var dy = aimY - oy;
    if (dy < 2.5) dy = 2.5;

    var n = st.w.shots;
    var spread = st.w.spreadM || 0;
    G.shotsFired += n;
    for (var i = 0; i < n; i++) {
      /* 散布的口径是"米"，不是角度 —— 见 WEAPONS 上方关于 spreadM 的注释。
       * 瞄准点直接挪到「目标位置横向 ±offM 米」，角度由这一点现算，
       * 于是"在最外侧那一发，在目标那个深度上离目标中心多远"永远等于 offM，
       * 和远近无关：0.55 米的散布在 12 米和 60 米处都是 0.55 米。 */
      var offM = n === 1 ? 0 : (i - (n - 1) / 2) * spread;
      var a = Math.atan2(dy, aimX + offM - G.x3d);
      var crit = Math.random() < st.crit;
      G.bullets.push({
        x3d: G.x3d,
        y3d: oy,
        prevY: oy,
        vx: Math.cos(a) * CFG.bulletSpeed,
        vy: Math.sin(a) * CFG.bulletSpeed,
        dmg: st.dmg * (crit ? st.critMul : 1),
        crit: crit,
        pierce: st.w.pierce,
        life: CFG.bulletLife,
        color: st.w.color,
        hitSet: []
      });
    }
    Sound.shoot();
  }

  function updateSpawn(dt) {
    G.spawnTimer -= dt;
    if (G.spawnTimer > 0) return;
    var d = difficulty();
    G.spawnTimer = d.interval * rand(0.82, 1.18);
    spawnMonster(d);
  }

  function spawnMonster(d) {
    if (G.monsters.length >= 64) return;   // 同屏上限保护
    var r = Math.random();
    var key = 'slime';
    if (r < d.elite) key = 'elite';
    else if (r < d.elite + d.brute) key = 'brute';
    else if (r < d.elite + d.brute + 0.30) key = 'bat';

    var base = MONSTERS[key];
    var hp = Math.round(base.hp * d.hpMul);
    G.monsters.push({
      key: key, type: base,
      x3d: pick(CFG.lanes) + rand(-0.16, 0.16),
      y3d: CFG.spawnDepth + rand(-8, 18),
      hp: hp, maxHp: hp,
      speed: base.speed * d.speedMul,
      r: base.r, dmg: base.dmg,
      wob: rand(0, 6.283),
      mode: 'walk', modeT: 0, lungeX: 0,
      hitFlash: 0, dead: false
    });
  }

  function updateMonsters(dt) {
    for (var i = G.monsters.length - 1; i >= 0; i--) {
      var m = G.monsters[i];
      if (m.dead) { G.monsters.splice(i, 1); continue; }
      if (m.hitFlash > 0) m.hitFlash = Math.max(0, m.hitFlash - dt);
      m.wob += dt * 6;

      if (m.mode === 'walk') {
        // 普通前进：只在本列直行，不做横向漂移
        m.y3d -= (CFG.scrollSpeed + m.speed) * dt;
        if (m.y3d - CFG.playerY <= ATTACK.range && m.y3d > CFG.playerY) {
          m.mode = 'windup';
          m.modeT = 0;
          // 进入射程的瞬间就锁定落点（带一点误差），随后地面亮起预警圈
          m.lungeX = clamp(G.x3d + rand(-ATTACK.lockJitter, ATTACK.lockJitter), -2.35, 2.35);
          if (G.warnCd <= 0) { Sound.warn(); G.warnCd = 0.26; }
        }
      } else if (m.mode === 'windup') {
        // 蓄力：刹住脚步、身体后仰蓄势，落点上亮起预警圈
        m.modeT += dt;
        m.y3d -= CFG.scrollSpeed * ATTACK.brake * dt;
        if (m.modeT >= m.type.windup) {
          m.mode = 'lunge';
          m.modeT = 0;
          Sound.lunge();
        }
      } else if (m.mode === 'lunge') {
        // 扑击：朝锁定点猛冲，冲进判定深度后按横向对齐情况结算命中
        m.modeT += dt;
        m.y3d -= (CFG.scrollSpeed + m.type.dash) * dt;
        var mv = ATTACK.lungeChase * dt;
        m.x3d += clamp(m.lungeX - m.x3d, -mv, mv);

        var d = m.y3d - CFG.playerY;
        if (d < ATTACK.hitDepth && d > -1.3 &&
            Math.abs(m.x3d - G.x3d) < m.r + CFG.playerRadius) {
          hitPlayer(m);
        }
        if (m.modeT >= ATTACK.lungeTime || m.y3d < CFG.playerY - 4) {
          m.mode = 'recover';
          m.modeT = 0;
          // 扑空：扬起一小圈尘土
          G.rings.push({ x: m.x3d, y: m.y3d + 1, life: 0.34, max: 0.34, color: 'rgba(190,210,240,0.75)', w: 0.55 });
        }
      } else {
        // 收招（扑空后）：慢慢恢复，然后继续向近端退场
        m.modeT += dt;
        m.y3d -= CFG.scrollSpeed * dt;
        if (m.modeT >= ATTACK.recover) { m.mode = 'walk'; m.modeT = 0; }
      }

      if (m.y3d < CFG.despawnDepth) G.monsters.splice(i, 1);
    }
  }

  function hitPlayer(m) {
    m.dead = true;
    if (G.hurtCd > 0) return;
    G.hits++;
    G.hp -= m.dmg;
    G.hurtCd = CFG.hurtCooldown;
    G.shake = 15;
    G.flash = 0.9;
    Sound.hurt();
    vibrate(70);
    G.floats.push({ x: G.x3d, y: CFG.playerY + 2.5, text: '-' + m.dmg, color: '#ff6b81', life: 1.1 });
    G.rings.push({ x: G.x3d, y: CFG.playerY + 0.4, life: 0.42, max: 0.42, color: '#ff6b81', w: 1 });
  }

  function updateBullets(dt) {
    for (var i = G.bullets.length - 1; i >= 0; i--) {
      var b = G.bullets[i];
      b.prevY = b.y3d;
      b.y3d += b.vy * dt;
      b.x3d += b.vx * dt;
      b.life -= dt;
      if (b.life <= 0 || b.y3d > CFG.spawnDepth + 60) { G.bullets.splice(i, 1); continue; }

      // 扫掠判定：按本帧扫过的 y 区间命中，避免子弹高速穿过怪物
      var lo = Math.min(b.prevY, b.y3d) - 0.55;
      var hi = Math.max(b.prevY, b.y3d) + 0.55;

      for (var j = 0; j < G.monsters.length; j++) {
        var m = G.monsters[j];
        if (m.dead || m.y3d < CFG.playerY - 1) continue;
        if (b.hitSet.indexOf(m) >= 0) continue;
        if (Math.abs(m.x3d - b.x3d) < m.r + 0.32 && m.y3d >= lo && m.y3d <= hi) {
          damageMonster(m, b.dmg, b.crit);
          b.hitSet.push(m);
          if (b.pierce > 0) b.pierce--;
          else { G.bullets.splice(i, 1); }
          break;
        }
      }
    }
  }

  function damageMonster(m, dmg, crit) {
    if (m.dead) return;
    G.bulletHits++;
    G.dmgDealt += dmg;
    m.hp -= dmg;
    m.hitFlash = 0.13;
    burstAt(m.x3d, m.y3d, crit ? 7 : 4, crit ? '#ffe08a' : '#ffffff');
    if (m.hp <= 0) killMonster(m);
    else Sound.hit();
  }

  function killMonster(m) {
    if (m.dead) return;
    m.dead = true;
    G.kills++;
    G.score += m.type.score;
    G.floats.push({ x: m.x3d, y: m.y3d, text: '+' + m.type.score, color: '#ffe08a', life: 0.95 });
    burstAt(m.x3d, m.y3d, 16, m.type.color);
    Sound.kill();
    vibrate(14);
    maybeDrop(m);
  }

  function maybeDrop(m) {
    var elite = m.key === 'elite';
    var pHeal = elite ? 0.46 : 0.24;
    var pWep = elite ? 0.26 : 0.08;
    var pBuff = elite ? 0.62 : 0.22;
    var r = Math.random();
    if (r < pHeal) makeDrop(m, 'heal');
    else if (r < pHeal + pWep) makeDrop(m, 'weapon');
    else if (r < pHeal + pWep + pBuff) makeDrop(m, 'buff');
  }

  function makeDrop(m, kind) {
    G.dropsSpawned++;
    var d = { kind: kind, x3d: m.x3d, y3d: m.y3d, bob: rand(0, 6.283) };
    if (kind === 'heal') d.amount = 26;
    if (kind === 'weapon') {
      var pool = WEAPON_KEYS.filter(function (k) { return k !== G.weapon; });
      d.weaponKey = pick(pool);
    }
    if (kind === 'buff') d.buffKey = pick(['atk', 'rate', 'crit', 'critDmg']);
    G.drops.push(d);
  }

  function updateDrops(dt) {
    for (var i = G.drops.length - 1; i >= 0; i--) {
      var d = G.drops[i];
      d.y3d -= CFG.scrollSpeed * dt;
      d.bob += dt * 3;
      if (d.y3d < CFG.playerY - 1.6) { G.drops.splice(i, 1); continue; }
      if (Math.abs(d.y3d - CFG.playerY) < 1.2 &&
          Math.abs(d.x3d - G.x3d) < CFG.pickupRadius + 0.3) {
        collect(d);
        G.drops.splice(i, 1);
      }
    }
  }

  function collect(d) {
    G.dropsPicked++;
    Sound.pickup();
    vibrate(18);
    burstAt(d.x3d, d.y3d, 12, '#ffffff');
    if (d.kind === 'heal') {
      G.hp = Math.min(G.maxHp, G.hp + d.amount);
      G.floats.push({ x: d.x3d, y: d.y3d, text: '+' + d.amount + ' HP', color: '#7dff9b', life: 1.05 });
      burstAt(d.x3d, d.y3d, 12, '#ff6b81');
      toast('拾取血瓶  +' + d.amount + ' HP');
    } else if (d.kind === 'weapon') {
      G.weapon = d.weaponKey;
      G.floats.push({ x: d.x3d, y: d.y3d, text: WEAPONS[d.weaponKey].name, color: '#8fd8ff', life: 1.2 });
      burstAt(d.x3d, d.y3d, 16, '#8fd8ff');
      toast('换上新武器：' + WEAPONS[d.weaponKey].name);
    } else {
      G.buffs[d.buffKey]++;
      var b = BUFF_MAP[d.buffKey];
      G.floats.push({ x: d.x3d, y: d.y3d, text: b.name + ' +1', color: b.color, life: 1.2 });
      burstAt(d.x3d, d.y3d, 14, b.color);
      toast('获得强化：' + b.name);
    }
  }

  function burstAt(x3d, y3d, n, color) {
    var p = road.project(x3d, y3d);
    var sc = clamp(p.scale + 0.28, 0.4, 1.3);
    for (var i = 0; i < n; i++) {
      var a = rand(0, 6.283), sp = rand(28, 185) * sc;
      G.parts.push({
        x: p.pos.x, y: p.pos.y,
        vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 46,
        life: rand(0.28, 0.62), max: 0.62,
        size: rand(1.5, 3.6) * sc, color: color
      });
    }
  }

  function updateFx(dt) {
    for (var i = G.parts.length - 1; i >= 0; i--) {
      var p = G.parts[i];
      p.x += p.vx * dt; p.y += p.vy * dt;
      p.vy += 330 * dt;
      p.vx *= 0.98;
      p.life -= dt;
      if (p.life <= 0) G.parts.splice(i, 1);
    }
    for (i = G.floats.length - 1; i >= 0; i--) {
      G.floats[i].life -= dt;
      if (G.floats[i].life <= 0) G.floats.splice(i, 1);
    }
    for (i = G.rings.length - 1; i >= 0; i--) {
      G.rings[i].life -= dt;
      if (G.rings[i].life <= 0) G.rings.splice(i, 1);
    }
  }

  /* ══════════════════ 渲染 ══════════════════ */
  /* 渲染耗时（累计平均，毫秒）。加场景装饰后单帧要多画上百个物件，
   * 必须有个能直接读到的数，否则"看起来不卡"这种话没有依据。
   * 一帧 16.7ms 是 60fps 的预算，renderMs 长期超过 6ms 就该警惕。
   * 用累计平均而不是滑动平均：滑动平均在低帧率下根本没收敛，
   * 读出来的数会忽高忽低（DPR1 比 DPR2 还高这种鬼结果）。
   * 调试时把 sum/n 清零即可重新开始统计。 */
  var perf = { renderMs: 0, sum: 0, n: 0 };
  function render() {
    var t0 = window.performance && performance.now ? performance.now() : Date.now();
    ctx.save();
    if (G && state === 'playing' && G.shake > 0.4) {
      ctx.translate(rand(-G.shake, G.shake) * 0.45, rand(-G.shake, G.shake) * 0.45);
    }

    drawSky();
    drawBackdrop();
    if (road) drawRoad();
    drawScenery();

    if (G && (state === 'playing' || state === 'paused' || state === 'result')) {
      drawEntities();
    }

    ctx.restore();

    if (vignette) { ctx.fillStyle = vignette; ctx.fillRect(0, 0, W, H); }

    if (G && G.flash > 0 && (state === 'playing' || state === 'paused')) {
      ctx.fillStyle = 'rgba(255,58,80,' + (G.flash * 0.28) + ')';
      ctx.fillRect(0, 0, W, H);
    }

    var t1 = window.performance && performance.now ? performance.now() : Date.now();
    perf.sum += t1 - t0;
    perf.n++;
    perf.renderMs = perf.sum / perf.n;
  }

  function drawSky() {
    var g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, '#080d18');
    g.addColorStop(0.38, '#121a2a');
    g.addColorStop(0.60, '#1a2130');
    g.addColorStop(1, '#0c1017');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
  }

  function drawRoad() {
    var far = road.crossSectionAtT(0.995);
    var scroll = currentScroll();

    // 路面主体
    ctx.beginPath();
    ctx.moveTo(road.left0.x, road.left0.y);
    ctx.lineTo(far.a.x, far.a.y);
    ctx.lineTo(far.b.x, far.b.y);
    ctx.lineTo(road.right0.x, road.right0.y);
    ctx.closePath();
    var rg = ctx.createLinearGradient(0, road.left0.y, 0, far.a.y);
    rg.addColorStop(0, '#2c313d');
    rg.addColorStop(0.42, '#232833');
    rg.addColorStop(1, '#1a1e28');
    ctx.fillStyle = rg;
    ctx.fill();

    // 横向流动条纹（前进感）
    var spacing = 5.5;
    var off = scroll % spacing;
    ctx.lineWidth = 2;
    for (var y = spacing - off; y < CFG.roadViewDepth; y += spacing) {
      var cs = road.crossSectionAtDepth(y);
      var a = 0.085 * (1 - road.tFromDepth(y));
      if (a < 0.004) continue;
      ctx.strokeStyle = 'rgba(160,190,240,' + a.toFixed(3) + ')';
      ctx.beginPath();
      ctx.moveTo(cs.a.x, cs.a.y);
      ctx.lineTo(cs.b.x, cs.b.y);
      ctx.stroke();
    }

    // 三条小路的分隔虚线（x = ±roadWidth/6）
    var dashPeriod = 6, dashLen = 3.1;
    var off2 = scroll % dashPeriod;
    ctx.strokeStyle = 'rgba(200,222,255,0.24)';
    ctx.lineWidth = 2.2;
    var bounds = [-CFG.roadWidth / 6, CFG.roadWidth / 6];
    for (var k = 0; k < bounds.length; k++) {
      for (var s = -off2; s < CFG.roadViewDepth; s += dashPeriod) {
        var y0 = Math.max(0.6, s), y1 = Math.min(CFG.roadViewDepth, s + dashLen);
        if (y1 - y0 < 0.5) continue;
        var p0 = road.project(bounds[k], y0).pos;
        var p1 = road.project(bounds[k], y1).pos;
        ctx.beginPath();
        ctx.moveTo(p0.x, p0.y);
        ctx.lineTo(p1.x, p1.y);
        ctx.stroke();
      }
    }

    // 路沿
    ctx.strokeStyle = 'rgba(120,190,255,0.5)';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(road.left0.x, road.left0.y);
    ctx.lineTo(far.a.x, far.a.y);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(road.right0.x, road.right0.y);
    ctx.lineTo(far.b.x, far.b.y);
    ctx.stroke();

    ctx.strokeStyle = 'rgba(120,190,255,0.16)';
    ctx.lineWidth = 8;
    ctx.beginPath();
    ctx.moveTo(road.left0.x, road.left0.y);
    ctx.lineTo(far.a.x, far.a.y);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(road.right0.x, road.right0.y);
    ctx.lineTo(far.b.x, far.b.y);
    ctx.stroke();
  }

  /* ══════════════════ 场景装饰 ══════════════════
   * ⚠️ 绘制顺序上的一个刻意决定：所有景物都画在 drawEntities 之前。
   *    严格按深度排序的话，近处的树应该挡住远处的妖物；但那样就必然出现
   *    "树挡住妖物 / 挡住地面预警圈"的画面 —— 对这个游戏是不可接受的。
   *    景物全在路外（|x3d| ≥ 2.55，树冠也不会压到路面），所以让它整体退到
   *    妖物之下，几乎看不出排序错误，却换来"妖物永远清晰可见"的硬保证。
   */

  /* 天地底子：铺地 + 远山剪影 + 地平线雾带。画在路面之下，永远只是背景。 */
  function drawBackdrop() {
    if (!road) return;
    var hy = road.vanish.y;          // 地平线 = 路面消失点所在高度
    var scroll = currentScroll();

    // ① 铺地：地平线以下全部填成"地"。近处压暗、远处提亮 ——
    //    反过来做（近亮远暗）会立刻失去纵深。
    var gg = ctx.createLinearGradient(0, hy, 0, H);
    gg.addColorStop(0, '#1a2333');
    gg.addColorStop(0.30, '#131a26');
    gg.addColorStop(1, '#0e131c');
    ctx.fillStyle = gg;
    ctx.fillRect(0, hy, W, H - hy);

    // ② 远山：两层剪影，远层淡、近层深，靠视差速度把两层分开
    drawRidge(hy - 2, 46, 0.30, '#131c29', scroll, 0.6);
    drawRidge(hy + 5, 26, 1.05, '#0c131c', scroll, 2.1);

    // ②b 远树线：高频小振幅 → 锯齿状树冠剪影。
    //     专门填"地平线到中景"那条带 —— 那条带对应 200 米开外，
    //     靠 belt 铺过去要几百个物件，用一条程序化锯齿几乎不花钱。
    drawTreeLine(hy + 16, 12, 2.4, '#141d2b', scroll);
    drawTreeLine(hy + 24, 7, 3.4, '#111927', scroll);

    // ③ 地平线雾带：把天与地接起来，同时给远景一层空气。
    //    必须向上向下都渐隐到 0 —— 只在一端收边的话，屏幕上会出现一道横向硬边，
    //    非常显眼（第一版就踩了这个坑）。
    var top = hy - H * 0.20, bot = hy + H * 0.12;
    var hz = ctx.createLinearGradient(0, top, 0, bot);
    hz.addColorStop(0, 'rgba(110,150,205,0)');
    hz.addColorStop(0.50, 'rgba(104,144,200,0.055)');
    hz.addColorStop(0.625, 'rgba(150,185,232,0.125)');   // 0.625 ≈ 地平线所在位置
    hz.addColorStop(1, 'rgba(120,160,215,0)');
    ctx.fillStyle = hz;
    ctx.fillRect(0, Math.max(0, top), W, bot - Math.max(0, top));
  }

  /* 一条山脊剪影。用 W、W/2、W/3… 为周期的正弦叠加 → 天然以屏宽为周期，
   * 视差偏移再多也不会出现接缝。 */
  function drawRidge(baseY, amp, par, color, scroll, phase) {
    var off = scroll * par;
    var bottom = road.vanish.y + 8;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(-2, bottom);
    for (var x = -2; x <= W + 2; x += 6) {
      var a = ((x + off) / W) * Math.PI * 2 + phase;
      var s = Math.sin(a) * 0.5 + Math.sin(a * 3 + phase * 1.7) * 0.30 +
              Math.sin(a * 5 + phase * 2.3) * 0.15;
      ctx.lineTo(x, baseY - amp * (0.5 + 0.5 * s));
    }
    ctx.lineTo(W + 2, bottom);
    ctx.closePath();
    ctx.fill();
  }

  /* 远树线：用 |sin| 叠出来的锯齿状剪影。
   * |sin| 的波峰是圆的、波谷是尖的，正好像一排树冠；
   * 频率取 W 的整数分频（×26、×47）保证以屏宽为周期，视差偏移不会出现接缝。 */
  function drawTreeLine(baseY, amp, par, color, scroll) {
    var off = scroll * par;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(-2, baseY + 4);
    for (var x = -2; x <= W + 2; x += 3) {
      var a = ((x + off) / W) * Math.PI * 2;
      var s = Math.abs(Math.sin(a * 26)) * 0.6 + Math.abs(Math.sin(a * 47 + 1.1)) * 0.4;
      ctx.lineTo(x, baseY - amp * (0.30 + 0.70 * s));
    }
    ctx.lineTo(W + 2, baseY + 4);
    ctx.closePath();
    ctx.fill();
  }

  /* 路肩：贴着路沿的一条碎石带。作用很大 ——
   * 没有它，路面像浮在虚空里的一个楔子；有了它，"路是修在地面上的"才成立。 */
  function drawVerge() {
    var dx = 0.9;
    for (var side = -1; side <= 1; side += 2) {
      var i0 = road.project(side * CFG.roadWidth / 2, 0).pos;
      var iF = road.project(side * CFG.roadWidth / 2, 168).pos;
      var oF = road.project(side * (CFG.roadWidth / 2 + dx), 168).pos;
      var o0 = road.project(side * (CFG.roadWidth / 2 + dx), 0).pos;
      ctx.beginPath();
      ctx.moveTo(i0.x, i0.y);
      ctx.lineTo(iF.x, iF.y);
      ctx.lineTo(oF.x, oF.y);
      ctx.lineTo(o0.x, o0.y);
      ctx.closePath();
      ctx.fillStyle = '#141a24';
      ctx.fill();
    }
  }

  /* 把"当前视野里有哪些景物"单独拆出来。
   * drawScenery 只负责画，枚举逻辑不碰 canvas —— 自动化测试于是可以直接清点
   * （数量、横向位置、雾值），不必去解码像素。 */
  function sceneItems(scroll, emit) {
    for (var row = 0; row < SCENE.belts.length; row++) {
      var b = SCENE.belts[row];
      var lo = Math.ceil((scroll + 1.2) / b.spacing);
      var hi = Math.floor((scroll + b.maxDepth) / b.spacing);
      if (hi < lo) continue;
      if (hi - lo > 200) hi = lo + 200;                 // 兜底保护
      for (var k = lo; k <= hi; k++) {
        for (var side = -1; side <= 1; side += 2) {
          var r = hashSeq(hashOf(k, row, side));
          if (r() > b.density) continue;                // 留空槽：自然些，也更省
          var y3d = k * b.spacing - scroll;             // 世界里程 → 当前深度
          var x3d = side * (b.minX + r() * b.spread);
          var q = road.project(x3d, y3d);
          if (q.scale < 0.03) continue;
          var alpha = SCENE.fogMin + (1 - SCENE.fogMin) * Math.exp(-y3d / SCENE.fogD);
          var kind = b.kinds[Math.floor(r() * b.kinds.length)];
          if (emit(kind, x3d, y3d, q, alpha, r, row, k, side) === false) return;
        }
      }
    }
  }

  function drawScenery() {
    if (!road) return;
    var scroll = currentScroll();
    drawVerge();
    sceneItems(scroll, function (kind, x3d, y3d, q, alpha, r) {
      if (q.pos.x < -140 || q.pos.x > W + 140) return;  // 屏幕外的不画
      var fn = PROPS[kind];
      if (!fn) return;
      ctx.globalAlpha = alpha;
      fn(q.pos.x, q.pos.y, pxPerMeter * q.scale, r);
      ctx.globalAlpha = 1;
    });
    drawLanterns(scroll);
    drawFireflies(scroll);
  }

  /* 石灯笼：等距、左右交替 —— 规律的韵律会极大强化"路在无限延伸"的感觉，
   * 也是整幅夜景里唯一的暖色，冷blue调里必须有点暖的当锚点。 */
  function drawLanterns(scroll) {
    var sp = SCENE.lampSpacing;
    var lo = Math.ceil((scroll + 1.5) / sp), hi = Math.floor((scroll + 300) / sp);
    for (var k = lo; k <= hi; k++) {
      for (var side = -1; side <= 1; side += 2) {
        var r = hashSeq(hashOf(k, 9, side));
        var y3d = k * sp - scroll;
        var q = road.project(side * (2.62 + r() * 0.45), y3d);
        if (q.scale < 0.04) continue;
        if (q.pos.x < -140 || q.pos.x > W + 140) continue;
        /* 灯光比景物"穿雾"：衰减更慢，远处的灯要还看得见 */
        propLantern(q.pos.x, q.pos.y, pxPerMeter * q.scale,
          Math.max(0.24, SCENE.fogMin + (1 - SCENE.fogMin) * Math.exp(-y3d / (SCENE.fogD * 2.2))));
      }
    }
  }

  function propLantern(bx, by, u, a) {
    var h = 2.15 * u, w = h * 0.30;

    /* 地面光池：叠加混合，会顺带照亮路面 —— 冷暖对比的关键。
     * u < 7 说明这盏灯在 200 米开外，光池已经小到看不见了，
     * 直接跳过：那是纯浪费的逐像素填充（DPR 2 下占了装饰开销的大头）。 */
    if (u >= 7) {
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = 0.34 * a;
      var rr = u * 1.5;
      var g = ctx.createRadialGradient(bx, by, 0, bx, by, rr);
      g.addColorStop(0, 'rgba(255,166,72,0.55)');
      g.addColorStop(0.45, 'rgba(255,138,48,0.16)');
      g.addColorStop(1, 'rgba(255,140,60,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.ellipse(bx, by, rr, rr * 0.40, 0, 0, 6.283);
      ctx.fill();
      ctx.restore();
    }

    // 灯身
    ctx.globalAlpha = a;
    ctx.fillStyle = '#1f2835';
    ctx.fillRect(bx - u * 0.05, by - h * 0.30, u * 0.10, h * 0.30);
    ctx.fillRect(bx - u * 0.15, by - h * 0.02, u * 0.30, h * 0.05);
    ctx.fillStyle = '#2b3546';
    ctx.beginPath();
    ctx.moveTo(bx - w * 0.5, by - h * 0.68);
    ctx.lineTo(bx + w * 0.5, by - h * 0.68);
    ctx.lineTo(bx + w * 0.36, by - h * 0.42);
    ctx.lineTo(bx - w * 0.36, by - h * 0.42);
    ctx.closePath();
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(bx - w * 0.66, by - h * 0.68);
    ctx.lineTo(bx, by - h * 0.86);
    ctx.lineTo(bx + w * 0.66, by - h * 0.68);
    ctx.closePath();
    ctx.fill();
    ctx.globalAlpha = 1;

    // 灯芯与外发光。这里刻意用饱和的橙而不是发白的暖白 ——
    // 叠加混合（lighter）下，"暖白"会和深蓝背景加成一片灰，看着像雾不像灯。
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = a;
    var ly = by - h * 0.55;
    var lg = ctx.createRadialGradient(bx, ly, 0, bx, ly, u * 0.52);
    lg.addColorStop(0, 'rgba(255,154,52,0.62)');
    lg.addColorStop(0.35, 'rgba(255,124,28,0.22)');
    lg.addColorStop(1, 'rgba(255,110,20,0)');
    ctx.fillStyle = lg;
    ctx.beginPath();
    ctx.arc(bx, ly, u * 0.52, 0, 6.283);
    ctx.fill();
    ctx.fillStyle = '#ffc061';
    ctx.fillRect(bx - w * 0.22, ly - h * 0.085, w * 0.44, h * 0.17);
    ctx.restore();
    ctx.globalAlpha = 1;
  }

  /* 萤火：既是气氛，也是深度线索 —— 不同高度的萤火按各自深度做视差，
   * 眼睛会下意识读出"这是立体的"。 */
  function drawFireflies(scroll) {
    var span = 120;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (var i = 0; i < SCENE.fireflies; i++) {
      var r = hashSeq(hashOf(i, 21, 1));
      var D = r() * span;
      var y3d = ((D - scroll) % span + span) % span;
      if (y3d < 2.5) continue;
      var x3d = (r() < 0.5 ? -1 : 1) * (2.4 + r() * 3.6);
      var q = road.project(x3d, y3d);
      var u = pxPerMeter * q.scale;
      if (q.pos.x < -60 || q.pos.x > W + 60) continue;
      var ph = r() * 6.283;
      var fx = q.pos.x + Math.cos(animT * 0.7 + ph * 1.3) * u * 0.6;
      var fy = q.pos.y - u * 0.95 + Math.sin(animT * 0.9 + ph) * u * 0.5;
      var blink = 0.3 + 0.7 * Math.pow(0.5 + 0.5 * Math.sin(animT * 2.1 + ph), 2);
      var a = blink * clamp(1 - y3d / 135, 0, 1);
      if (a < 0.02) continue;
      var rad = Math.max(1.8, u * 0.30);
      var g = ctx.createRadialGradient(fx, fy, 0, fx, fy, rad);
      g.addColorStop(0, 'rgba(255,232,160,' + (0.55 * a).toFixed(3) + ')');
      g.addColorStop(0.35, 'rgba(205,255,175,' + (0.22 * a).toFixed(3) + ')');
      g.addColorStop(1, 'rgba(180,255,160,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(fx, fy, rad, 0, 6.283);
      ctx.fill();
    }
    ctx.restore();
  }

  /* 树冠轮廓：在椭圆上叠一圈起伏。
   * 直接画椭圆的话，一棵"阔叶树"就是一个纯圆球，一眼假；加起伏才有树叶的碎边。 */
  function treeBlob(cx, cy, rx, ry, n, bump, r) {
    ctx.beginPath();
    for (var i = 0; i <= n; i++) {
      var a = (i / n) * 6.283;
      var k = 1 + Math.sin(i * 2.7) * bump + (r() - 0.5) * bump * 0.7;
      var px = cx + Math.cos(a) * rx * k;
      var py = cy + Math.sin(a) * ry * k;
      if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    }
    ctx.closePath();
    ctx.fill();
  }

  /* ---------- 各类景物 ----------
   * 约定：bx/by = 落地点（画布坐标），u = 该深度下 1 米等于多少像素。
   * 所有尺寸都乘 u，所以同一物件在近处大、远处小，自动跟透视一致。
   * r 是稳定伪随机序列（同一槽位每次重开都一样）。 */
  var PROPS = {
    /* 草簇：最便宜、密度最高，负责把路肩"长满" */
    grass: function (bx, by, u, r) {
      var n = 4 + Math.floor(r() * 3), h = (0.26 + r() * 0.22) * u;
      ctx.strokeStyle = '#122219';
      ctx.lineWidth = Math.max(1, u * 0.05);
      ctx.lineCap = 'round';
      ctx.beginPath();
      for (var i = 0; i < n; i++) {
        var t = (i / (n - 1) - 0.5) * 2, hh = h * (0.55 + r() * 0.65);
        ctx.moveTo(bx + t * u * 0.10, by);
        ctx.quadraticCurveTo(bx + t * u * 0.17, by - hh * 0.6, bx + t * u * 0.32, by - hh);
      }
      ctx.stroke();
    },

    bush: function (bx, by, u, r) {
      var w = (0.55 + r() * 0.45) * u, h = w * 0.72;
      ctx.fillStyle = '#0f1c16';
      ctx.beginPath();
      ctx.ellipse(bx, by - h * 0.48, w * 0.5, h * 0.5, 0, 0, 6.283);
      ctx.fill();
      ctx.fillStyle = '#14251c';
      ctx.beginPath();
      ctx.ellipse(bx - w * 0.15, by - h * 0.62, w * 0.33, h * 0.34, 0, 0, 6.283);
      ctx.fill();
    },

    rock: function (bx, by, u, r) {
      var w = (0.55 + r() * 0.85) * u, h = w * (0.5 + r() * 0.35);
      ctx.fillStyle = '#0f151e';
      ctx.beginPath();
      ctx.moveTo(bx - w * 0.5, by);
      ctx.lineTo(bx - w * 0.36, by - h * 0.72);
      ctx.lineTo(bx - w * 0.02, by - h);
      ctx.lineTo(bx + w * 0.34, by - h * 0.66);
      ctx.lineTo(bx + w * 0.5, by);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = '#171f2a';                 // 受光的顶面
      ctx.beginPath();
      ctx.moveTo(bx - w * 0.36, by - h * 0.72);
      ctx.lineTo(bx - w * 0.02, by - h);
      ctx.lineTo(bx + w * 0.34, by - h * 0.66);
      ctx.lineTo(bx, by - h * 0.48);
      ctx.closePath();
      ctx.fill();
    },

    bamboo: function (bx, by, u, r) {
      var n = 3 + Math.floor(r() * 3), H0 = (3.0 + r() * 1.8) * u;
      for (var i = 0; i < n; i++) {
        var x = bx + (i - (n - 1) / 2) * u * 0.15 + (r() - 0.5) * u * 0.06;
        var h = H0 * (0.68 + r() * 0.46);
        var lean = (r() - 0.5) * 0.5;
        var tipX = x + lean * u * 0.55;
        ctx.strokeStyle = i % 2 ? '#122219' : '#16291e';
        ctx.lineWidth = Math.max(1, u * 0.055);
        ctx.beginPath();
        ctx.moveTo(x, by);
        ctx.quadraticCurveTo(x + lean * u * 0.18, by - h * 0.55, tipX, by - h);
        ctx.stroke();
        ctx.strokeStyle = '#193023';              // 竹叶
        ctx.lineWidth = Math.max(1, u * 0.035);
        for (var j = 0; j < 3; j++) {
          var ly = by - h * (0.66 + j * 0.12), sgn = j % 2 ? 1 : -1;
          ctx.beginPath();
          ctx.moveTo(tipX - lean * u * 0.1, ly);
          ctx.quadraticCurveTo(x + sgn * u * 0.30, ly - u * 0.14, x + sgn * u * 0.52, ly - u * 0.02);
          ctx.stroke();
        }
      }
    },

    pine: function (bx, by, u, r) {
      var h = (4.2 + r() * 3.2) * u, w = h * (0.32 + r() * 0.09);
      ctx.fillStyle = '#080d12';
      ctx.fillRect(bx - h * 0.022, by - h * 0.34, h * 0.044, h * 0.34);
      var tiers = 3 + Math.floor(r() * 2);
      for (var i = 0; i < tiers; i++) {
        var t0 = 0.22 + (i / tiers) * 0.60;
        var cw = w * (1 - i / (tiers + 0.5));
        var yb = by - h * t0, yt = by - h * (t0 + 0.46);
        ctx.fillStyle = i === 0 ? '#0c1714' : '#0a1310';
        ctx.beginPath();
        ctx.moveTo(bx, yt);
        ctx.lineTo(bx + cw * 0.5, yb);
        ctx.lineTo(bx - cw * 0.5, yb);
        ctx.closePath();
        ctx.fill();
      }
      // 顶端一道冷色受光边 —— 深色剪影里没有它就会糊成一团
      var ytp = by - h * (0.22 + 0.60 + 0.46);
      ctx.strokeStyle = 'rgba(150,196,235,0.20)';
      ctx.lineWidth = Math.max(1, u * 0.03);
      ctx.beginPath();
      ctx.moveTo(bx - w * 0.5 * (1 - (tiers - 1) / (tiers + 0.5)) * 0.5, ytp + h * 0.46);
      ctx.lineTo(bx, ytp);
      ctx.stroke();
    },

    broadleaf: function (bx, by, u, r) {
      var h = (3.4 + r() * 2.2) * u;
      var cw = h * (0.56 + r() * 0.18), ch = h * 0.56;
      ctx.fillStyle = '#080d12';
      ctx.fillRect(bx - h * 0.026, by - h * 0.44, h * 0.052, h * 0.44);
      var cx = bx + (r() - 0.5) * h * 0.08;
      ctx.fillStyle = '#0b1611';
      treeBlob(cx, by - h * 0.68, cw * 0.50, ch * 0.50, 12, 0.13, r);
      ctx.fillStyle = '#0f1d16';
      treeBlob(cx - cw * 0.15, by - h * 0.79, cw * 0.31, ch * 0.30, 9, 0.20, r);
      treeBlob(cx + cw * 0.19, by - h * 0.70, cw * 0.26, ch * 0.26, 9, 0.20, r);
    },

    /* 幡旗：布面随时间轻摆，给静止的夜色加一点"风" */
    banner: function (bx, by, u, r) {
      var h = (2.7 + r() * 1.2) * u;
      ctx.strokeStyle = '#151d27';
      ctx.lineWidth = Math.max(1, u * 0.045);
      ctx.beginPath();
      ctx.moveTo(bx, by);
      ctx.lineTo(bx, by - h);
      ctx.stroke();
      var wob = Math.sin(animT * 1.6 + bx * 0.02 + r() * 6.283) * u * 0.06;
      var w = u * 0.44, top = by - h * 0.96, bot = by - h * 0.46;
      ctx.fillStyle = '#1e2c40';
      ctx.beginPath();
      ctx.moveTo(bx, top);
      ctx.lineTo(bx + w, top);
      ctx.quadraticCurveTo(bx + w * 0.66 + wob, (top + bot) / 2, bx + w, bot);
      ctx.lineTo(bx, bot);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = 'rgba(206,228,255,0.26)';
      ctx.beginPath();
      ctx.arc(bx + w * 0.44, (top + bot) / 2, u * 0.10, 0, 6.283);
      ctx.fill();
    },

    /* 茅屋／客栈：墙和屋顶都要比地面亮，否则只剩两扇暖窗浮在暗处，看不出是房子 */
    hut: function (bx, by, u, r) {
      var w = (2.8 + r() * 1.5) * u, h = w * 0.40, roof = w * 0.30;
      ctx.fillStyle = '#1d2735';
      ctx.fillRect(bx - w / 2, by - h, w, h);
      ctx.fillStyle = '#26313f';
      ctx.beginPath();
      ctx.moveTo(bx - w * 0.62, by - h);
      ctx.lineTo(bx, by - h - roof);
      ctx.lineTo(bx + w * 0.62, by - h);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = 'rgba(255,188,112,0.62)';
      ctx.fillRect(bx - w * 0.31, by - h * 0.70, w * 0.17, h * 0.32);
      ctx.fillRect(bx + w * 0.12, by - h * 0.70, w * 0.17, h * 0.32);
      ctx.fillStyle = 'rgba(0,0,0,0.35)';      // 檐下阴影：给屋顶一点厚度
      ctx.fillRect(bx - w * 0.62, by - h, w * 1.24, h * 0.07);
    },

    gate: function (bx, by, u, r) {
      var h = (4.2 + r() * 1.8) * u, w = h * 0.74;
      ctx.fillStyle = '#0a1017';
      ctx.fillRect(bx - w / 2, by - h, w * 0.09, h);
      ctx.fillRect(bx + w / 2 - w * 0.09, by - h, w * 0.09, h);
      ctx.fillRect(bx - w * 0.72, by - h, w * 1.44, h * 0.10);
      ctx.fillRect(bx - w * 0.72, by - h * 0.32, w * 1.44, h * 0.055);
      ctx.beginPath();
      ctx.moveTo(bx - w * 0.92, by - h);
      ctx.lineTo(bx, by - h * 1.17);
      ctx.lineTo(bx + w * 0.92, by - h);
      ctx.closePath();
      ctx.fill();
    },

    pagoda: function (bx, by, u, r) {
      var h = (7 + r() * 6) * u, w = h * 0.34;
      ctx.fillStyle = '#0d141d';
      for (var i = 0; i < 4; i++) {
        var tw = w * (1 - (i / 4) * 0.40);
        var ty = by - h * (i / 4) * 0.78;
        var bh = h * 0.30;
        ctx.fillRect(bx - tw * 0.30, ty - bh, tw * 0.60, bh);
        ctx.beginPath();
        ctx.moveTo(bx - tw * 0.52, ty - bh);
        ctx.lineTo(bx, ty - bh * 1.46);
        ctx.lineTo(bx + tw * 0.52, ty - bh);
        ctx.closePath();
        ctx.fill();
      }
      ctx.fillRect(bx - u * 0.06, by - h * 1.04, u * 0.12, h * 0.16);
    }
  };

  function drawEntities() {
    var list = [], i;
    for (i = 0; i < G.monsters.length; i++) list.push({ k: 0, o: G.monsters[i], y: G.monsters[i].y3d });
    for (i = 0; i < G.drops.length; i++) list.push({ k: 1, o: G.drops[i], y: G.drops[i].y3d });
    for (i = 0; i < G.bullets.length; i++) list.push({ k: 2, o: G.bullets[i], y: G.bullets[i].y3d });
    list.sort(function (a, b) { return b.y - a.y; });

    drawRings();
    drawTelegraphs();

    for (i = 0; i < list.length; i++) {
      if (list[i].k === 0) drawMonster(list[i].o);
      else if (list[i].k === 1) drawDrop(list[i].o);
      else drawBullet(list[i].o);
    }

    drawPlayer();
    drawParticles();
    drawFloats();
  }

  function drawRings() {
    for (var i = 0; i < G.rings.length; i++) {
      var r = G.rings[i];
      var p = road.project(r.x, r.y);
      var prog = 1 - r.life / r.max;
      var rad = (0.35 + prog * 1.9) * pxPerMeter * p.scale;
      if (rad < 1) continue;
      ctx.globalAlpha = clamp((1 - prog) * 0.85, 0, 1);
      ctx.strokeStyle = r.color;
      ctx.lineWidth = Math.max(1, 3 * (r.w || 1) * p.scale + 0.8);
      ctx.beginPath();
      ctx.ellipse(p.pos.x, p.pos.y, rad, rad * 0.42, 0, 0, 6.283);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  /* 攻击预警：把"它要扑到哪儿"直接画在玩家脚下的地面上。
   * 这是整套主动攻击能被玩家读懂、进而躲开的依托 —— 没有它，扑击就是随机挨打。 */
  function drawTelegraphs() {
    for (var i = 0; i < G.monsters.length; i++) {
      var m = G.monsters[i];
      if (m.mode !== 'windup' && m.mode !== 'lunge') continue;
      if (m.y3d - CFG.playerY > ATTACK.range + 6) continue;

      var g = road.project(m.lungeX, CFG.playerY + 0.3);
      if (g.scale <= 0.01) continue;
      var rx = (m.r + CFG.playerRadius) * pxPerMeter * g.scale;
      var windup = m.mode === 'windup';
      var wp = windup ? clamp(m.modeT / m.type.windup, 0, 1) : 1;
      var pulse = 0.5 + 0.5 * Math.sin(m.wob * 5);

      ctx.save();
      // 落点外圈：越接近扑出越亮越实
      ctx.globalAlpha = windup ? 0.30 + 0.45 * wp : 0.85;
      ctx.strokeStyle = windup ? '#ff5d6e' : '#ffd166';
      ctx.lineWidth = Math.max(1.5, 3.4 * g.scale + 0.7);
      ctx.beginPath();
      ctx.ellipse(g.pos.x, g.pos.y, rx * (windup ? 1.45 - 0.42 * wp : 1), rx * 0.42, 0, 0, 6.283);
      ctx.stroke();

      // 内部充能扇面：随蓄力进度填满，填满即扑出
      ctx.globalAlpha = windup ? 0.10 + 0.30 * wp * pulse : 0.42;
      ctx.fillStyle = windup ? '#ff3b55' : '#ffb347';
      ctx.beginPath();
      ctx.ellipse(g.pos.x, g.pos.y, rx * 1.05, rx * 0.32, 0, 0, 6.283);
      ctx.fill();

      // 从妖物指向落点的虚线，表明"是这个家伙要扑过来"
      if (windup) {
        var mp = road.project(m.x3d, m.y3d);
        ctx.globalAlpha = 0.16 + 0.34 * wp;
        ctx.strokeStyle = '#ff8f9e';
        ctx.lineWidth = Math.max(1, 2.2 * g.scale + 0.5);
        ctx.setLineDash([Math.max(3, 9 * g.scale), Math.max(4, 8 * g.scale)]);
        ctx.beginPath();
        ctx.moveTo(mp.pos.x, mp.pos.y);
        ctx.lineTo(g.pos.x, g.pos.y);
        ctx.stroke();
        ctx.setLineDash([]);
      }
      ctx.restore();
    }
  }

  function drawMonster(m) {
    var p = road.project(m.x3d, m.y3d);
    var sc = p.scale;
    var alpha = clamp((CFG.spawnDepth + 18 - m.y3d) / 16, 0, 1);
    if (alpha <= 0.02 || sc <= 0.004) return;

    var windup = m.mode === 'windup';
    var lunge = m.mode === 'lunge';
    var wp = windup ? clamp(m.modeT / m.type.windup, 0, 1) : 0;

    // 蓄力时向下压扁、扑击时拉长 —— 配合落点预警圈一起读
    var rPx = m.r * pxPerMeter * sc * (windup ? 1 + wp * 0.22 : 1);
    var bodyH = rPx * 2.05 * (lunge ? 1.22 : windup ? 1 - wp * 0.26 : 1);
    var cx = p.pos.x, baseY = p.pos.y;
    var topY = baseY - bodyH;

    ctx.save();
    ctx.globalAlpha = alpha;

    // 影子
    ctx.beginPath();
    ctx.ellipse(cx, baseY, rPx * 1.15, rPx * 0.36, 0, 0, 6.283);
    ctx.fillStyle = 'rgba(0,0,0,0.42)';
    ctx.fill();

    // 蓄力：脚下的收缩圈（表示"憋住了"，落点预警另有专门的 drawTelegraphs）
    if (windup) {
      ctx.beginPath();
      ctx.ellipse(cx, baseY, rPx * (1.35 - wp * 0.45), rPx * 0.42, 0, 0, 6.283);
      ctx.globalAlpha = alpha * (0.16 + 0.30 * wp);
      ctx.strokeStyle = '#ff5d6e';
      ctx.lineWidth = Math.max(1.4, rPx * 0.14);
      ctx.stroke();
      ctx.globalAlpha = alpha;
    }

    // 扑击残影（拖尾）
    if (lunge) {
      for (var k = 1; k <= 2; k++) {
        var gp = road.project(m.x3d, m.y3d - k * 2.3);
        ctx.globalAlpha = alpha * (0.20 / k);
        ctx.fillStyle = m.type.color;
        ctx.beginPath();
        ctx.ellipse(gp.pos.x, gp.pos.y - bodyH * (0.5 - k * 0.04),
          rPx * (1 - k * 0.14), bodyH * (0.5 - k * 0.05), 0, 0, 6.283);
        ctx.fill();
      }
      ctx.globalAlpha = alpha;
    }

    var col = m.type.color, dark = m.type.dark;
    if (windup) {
      ctx.shadowBlur = 10 + 20 * wp;
      ctx.shadowColor = 'rgba(255,70,90,' + (0.45 + 0.5 * wp).toFixed(2) + ')';
    }

    if (m.key === 'bat') {
      var flap = Math.sin(m.wob) * rPx * 0.38;
      ctx.fillStyle = col;
      ctx.beginPath();
      ctx.moveTo(cx, topY + bodyH * 0.42);
      ctx.lineTo(cx - rPx * 1.85, topY + bodyH * 0.02 - flap);
      ctx.lineTo(cx - rPx * 0.45, topY + bodyH * 0.76);
      ctx.closePath(); ctx.fill();
      ctx.beginPath();
      ctx.moveTo(cx, topY + bodyH * 0.42);
      ctx.lineTo(cx + rPx * 1.85, topY + bodyH * 0.02 - flap);
      ctx.lineTo(cx + rPx * 0.45, topY + bodyH * 0.76);
      ctx.closePath(); ctx.fill();
      ctx.beginPath();
      ctx.arc(cx, topY + bodyH * 0.42, rPx * 0.64, 0, 6.283);
      ctx.fillStyle = dark; ctx.fill();
    } else {
      var wob = Math.sin(m.wob) * rPx * 0.06;
      ctx.beginPath();
      ctx.ellipse(cx, baseY - bodyH * 0.5 + wob, rPx, bodyH * 0.52, 0, 0, 6.283);
      ctx.fillStyle = col; ctx.fill();
      ctx.lineWidth = Math.max(1, rPx * 0.13);
      ctx.strokeStyle = dark; ctx.stroke();
      if (m.key === 'elite') {
        // 妖将的角
        ctx.fillStyle = dark;
        ctx.beginPath();
        ctx.moveTo(cx - rPx * 0.62, topY + bodyH * 0.16);
        ctx.lineTo(cx - rPx * 0.95, topY - bodyH * 0.16);
        ctx.lineTo(cx - rPx * 0.3, topY + bodyH * 0.04);
        ctx.closePath(); ctx.fill();
        ctx.beginPath();
        ctx.moveTo(cx + rPx * 0.62, topY + bodyH * 0.16);
        ctx.lineTo(cx + rPx * 0.95, topY - bodyH * 0.16);
        ctx.lineTo(cx + rPx * 0.3, topY + bodyH * 0.04);
        ctx.closePath(); ctx.fill();
      } else {
        ctx.beginPath();
        ctx.ellipse(cx - rPx * 0.32, baseY - bodyH * 0.7, rPx * 0.26, rPx * 0.17, -0.5, 0, 6.283);
        ctx.fillStyle = 'rgba(255,255,255,0.3)';
        ctx.fill();
      }
    }

    ctx.shadowBlur = 0;

    // 眼睛
    if (rPx > 3.4) {
      var eyeY = m.key === 'bat' ? topY + bodyH * 0.42 : baseY - bodyH * 0.6;
      var eyeDx = rPx * 0.33, eyeR = Math.max(1.1, rPx * 0.13);
      ctx.fillStyle = '#12161f';
      ctx.beginPath(); ctx.arc(cx - eyeDx, eyeY, eyeR, 0, 6.283); ctx.fill();
      ctx.beginPath(); ctx.arc(cx + eyeDx, eyeY, eyeR, 0, 6.283); ctx.fill();
    }

    // 命中闪白
    if (m.hitFlash > 0) {
      ctx.globalAlpha = alpha * (m.hitFlash / 0.13) * 0.8;
      ctx.beginPath();
      ctx.ellipse(cx, baseY - bodyH * 0.5, rPx * 1.02, bodyH * 0.53, 0, 0, 6.283);
      ctx.fillStyle = '#fff'; ctx.fill();
      ctx.globalAlpha = alpha;
    }

    // 血条
    if (rPx > 2.6) {
      var barW = Math.max(15, rPx * 2.5);
      var barH = Math.max(3, rPx * 0.22);
      var barY = topY - barH - Math.max(3, rPx * 0.32);
      var ratio = clamp(m.hp / m.maxHp, 0, 1);
      ctx.fillStyle = 'rgba(0,0,0,0.65)';
      ctx.fillRect(cx - barW / 2 - 1.5, barY - 1.5, barW + 3, barH + 3);
      ctx.fillStyle = 'rgba(255,255,255,0.18)';
      ctx.fillRect(cx - barW / 2, barY, barW, barH);
      ctx.fillStyle = m.key === 'elite' ? '#ffd166'
        : (ratio > 0.5 ? '#5ddc7a' : ratio > 0.22 ? '#ffcc55' : '#ff5d6e');
      ctx.fillRect(cx - barW / 2, barY, barW * ratio, barH);
    }

    ctx.restore();
  }

  function drawBullet(b) {
    var p = road.project(b.x3d, b.y3d);
    var sc = p.scale;
    if (sc <= 0.01) return;
    var len = 30 * sc * (b.crit ? 1.35 : 1);
    var wd = 3.6 * sc;
    ctx.save();
    ctx.globalAlpha = clamp(sc * 3.2, 0.35, 1);
    ctx.translate(p.pos.x, p.pos.y);
    ctx.fillStyle = b.color;
    ctx.beginPath();
    ctx.moveTo(0, -len * 0.62);
    ctx.lineTo(wd, 0);
    ctx.lineTo(0, len * 0.38);
    ctx.lineTo(-wd, 0);
    ctx.closePath();
    ctx.fill();
    if (b.crit) {
      ctx.globalAlpha = 0.55;
      ctx.fillStyle = '#fff5cc';
      ctx.beginPath();
      ctx.arc(0, 0, wd * 1.5, 0, 6.283);
      ctx.fill();
    }
    ctx.restore();
  }

  function drawDrop(d) {
    var p = road.project(d.x3d, d.y3d);
    var sc = p.scale;
    var r = 14 * sc;
    if (r < 1.4) return;
    var col = d.kind === 'heal' ? '#ff6b81'
      : d.kind === 'weapon' ? '#8fd8ff' : BUFF_MAP[d.buffKey].color;
    var bob = Math.sin(d.bob * 1.6) * r * 0.2;
    var cy = p.pos.y - r * 1.6 + bob;

    ctx.save();
    ctx.globalAlpha = clamp(sc * 3, 0.3, 1);
    ctx.strokeStyle = col;
    ctx.globalAlpha *= 0.4;
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(p.pos.x, cy, r * 1.18, 0, 6.283); ctx.stroke();
    ctx.globalAlpha = clamp(sc * 3, 0.3, 1);

    ctx.fillStyle = col;
    ctx.beginPath();
    if (d.kind === 'heal') {
      var t = r * 0.32;
      ctx.rect(p.pos.x - t, cy - r * 0.72, t * 2, r * 1.44);
      ctx.rect(p.pos.x - r * 0.72, cy - t, r * 1.44, t * 2);
    } else if (d.kind === 'weapon') {
      ctx.moveTo(p.pos.x, cy - r);
      ctx.lineTo(p.pos.x + r * 0.52, cy);
      ctx.lineTo(p.pos.x, cy + r);
      ctx.lineTo(p.pos.x - r * 0.52, cy);
      ctx.closePath();
    } else {
      ctx.arc(p.pos.x, cy, r * 0.74, 0, 6.283);
    }
    ctx.fill();
    ctx.restore();
  }

  function drawPlayer() {
    var p = road.project(G.x3d, CFG.playerY);
    var sc = p.scale;
    var hPx = 1.75 * pxPerMeter * sc;
    var cx = p.pos.x, baseY = p.pos.y;
    var wPx = hPx * 0.34;

    ctx.save();

    // 影子
    ctx.beginPath();
    ctx.ellipse(cx, baseY, wPx * 0.95, wPx * 0.34, 0, 0, 6.283);
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    ctx.fill();

    // 侧移拖影：只有真的在横向移动时才出现，让"拖动"看起来是划过去而不是闪过去
    var sp = clamp(Math.abs(G.vx) / CFG.playerMoveSpeed, 0, 1);
    if (sp > 0.3) {
      var sgn = G.vx > 0 ? -1 : 1;                 // 拖影留在运动的相反一侧
      ctx.globalAlpha = ((sp - 0.3) / 0.7) * 0.45;
      ctx.strokeStyle = '#9ecbff';
      ctx.lineWidth = Math.max(1, hPx * 0.028);
      ctx.lineCap = 'round';
      for (var i = 0; i < 3; i++) {
        var ly = baseY - hPx * (0.2 + i * 0.26);
        var l0 = cx + sgn * wPx * (0.72 + i * 0.24);
        ctx.beginPath();
        ctx.moveTo(l0, ly);
        ctx.lineTo(l0 + sgn * hPx * (0.14 + 0.1 * i), ly);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }

    // 侧倾：上半身朝移动方向压一点，静止时归零
    var lean = clamp(G.vx / CFG.playerMoveSpeed, -1, 1) * wPx * 0.5;

    var bodyTop = baseY - hPx * 0.84;
    ctx.shadowBlur = 16;
    ctx.shadowColor = G.hurtCd > 0.3 ? 'rgba(255,90,110,0.95)' : 'rgba(130,200,255,0.6)';

    // 身体
    ctx.beginPath();
    ctx.moveTo(cx - wPx * 0.52, baseY - hPx * 0.02);
    ctx.lineTo(cx - wPx * 0.3 + lean, bodyTop + hPx * 0.17);
    ctx.lineTo(cx + wPx * 0.3 + lean, bodyTop + hPx * 0.17);
    ctx.lineTo(cx + wPx * 0.52, baseY - hPx * 0.02);
    ctx.closePath();
    var pg = ctx.createLinearGradient(0, bodyTop, 0, baseY);
    pg.addColorStop(0, '#a8cfff');
    pg.addColorStop(1, '#3d6cd4');
    ctx.fillStyle = pg;
    ctx.fill();

    // 头
    ctx.beginPath();
    ctx.arc(cx + lean, bodyTop + hPx * 0.04, hPx * 0.12, 0, 6.283);
    ctx.fillStyle = '#ffe2bd';
    ctx.fill();

    ctx.shadowBlur = 0;

    // 剑
    ctx.strokeStyle = '#d6ecff';
    ctx.lineWidth = Math.max(1.5, hPx * 0.036);
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(cx + wPx * 0.68, baseY - hPx * 0.12);
    ctx.lineTo(cx + wPx * 0.56 + lean * 0.8, baseY - hPx * 0.98);
    ctx.stroke();

    ctx.restore();
  }

  function drawParticles() {
    for (var i = 0; i < G.parts.length; i++) {
      var p = G.parts[i];
      var a = clamp(p.life / p.max, 0, 1);
      ctx.globalAlpha = a;
      ctx.fillStyle = p.color;
      ctx.fillRect(p.x - p.size / 2, p.y - p.size / 2, p.size, p.size);
    }
    ctx.globalAlpha = 1;
  }

  function drawFloats() {
    ctx.textAlign = 'center';
    for (var i = 0; i < G.floats.length; i++) {
      var f = G.floats[i];
      var p = road.project(f.x, f.y);
      var a = clamp(Math.min(1, f.life * 3), 0, 1);
      var size = Math.round(15 * clamp(p.scale + 0.4, 0.65, 1.35));
      ctx.globalAlpha = a;
      ctx.font = '500 ' + size + 'px system-ui,-apple-system,"Microsoft YaHei",sans-serif';
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(0,0,0,0.6)';
      ctx.strokeText(f.text, p.pos.x, p.pos.y - (1 - a) * 36);
      ctx.fillStyle = f.color;
      ctx.fillText(f.text, p.pos.x, p.pos.y - (1 - a) * 36);
    }
    ctx.globalAlpha = 1;
  }

  /* ══════════════════ HUD ══════════════════ */
  var hudTick = 0, lastIcoHtml = '', lastPanelHtml = '';

  var SVG_OPEN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"'
    + ' stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">';
  var ICO_WEAPON = '<path d="M4.6 19.4 16 8"/><path d="M13.8 5.8h4.4v4.4"/><path d="M7.4 12.6l4 4"/>';

  /* 图标行：武器（不可叠加，固定第一格）+ 每个词条一格。
   * 槽位顺序固定、未获得也不消失（只变灰）—— 位置稳定，玩家才能形成肌肉记忆，
   * 一眼扫到"暴击多少"。角标写的是累计数值，不是层数。 */
  function icoRowHtml() {
    var out = '';
    var w = WEAPONS[G.weapon];
    out += '<span class="buff-ico" style="color:' + w.color + ';border-color:' + w.color + '88"'
      + ' title="' + w.name + ' · ' + w.desc + '">' + SVG_OPEN + ICO_WEAPON + '</svg></span>';
    BUFF_LIST.forEach(function (b) {
      var n = G.buffs[b.key], on = n > 0;
      out += '<span class="buff-ico' + (on ? '' : ' off') + '"'
        + ' style="color:' + b.color + (on ? ';border-color:' + b.color + '88' : '') + '"'
        + ' title="' + b.name + '：' + (on ? b.effect(n) + '（' + b.note + '）' : '未获得 · ' + b.note) + '">'
        + SVG_OPEN + b.icon + '</svg>'
        + (on ? '<i class="lv">' + b.badge(n) + '</i>' : '')
        + '</span>';
    });
    return out;
  }

  /* 属性面板的数据行。全部现算 —— 面板显示的数和真正开火用的数来自同一个
   * playerStats()，不存在"说明和实现不一致"的可能。 */
  function statsRows() {
    var st = playerStats(), w = st.w, b = G.buffs;
    var r = [];
    r.push({ h: '武器 · ' + w.name });
    r.push({ k: '单发伤害', v: st.dmg.toFixed(1) });
    r.push({ k: '攻击间隔', v: st.cd.toFixed(2) + ' 秒' });
    r.push({ k: '期望每秒伤害', v: st.dps.toFixed(1) });
    r.push({ k: '弹道', v: st.shots + ' 发' + (w.spreadM > 0
      ? ' · 展宽 ' + ((st.shots - 1) * w.spreadM).toFixed(1) + ' 米' : ' · 直线') });
    r.push({ k: '穿透', v: w.pierce > 0 ? '可穿 ' + w.pierce + ' 个目标' : '无' });
    r.push({ full: '特性：' + w.desc });
    r.push({ sep: true });

    r.push({ h: '人物' });
    r.push({ k: '生命', v: Math.max(0, Math.ceil(G.hp)) + ' / ' + G.maxHp });
    r.push({ k: '暴击率', v: (st.crit * 100).toFixed(0) + '%' + (st.crit >= 0.92 ? '（上限）' : '') });
    r.push({ k: '暴击倍率', v: st.critMul.toFixed(2) + '×' });
    r.push({ k: '击杀 / 积分', v: G.kills + ' / ' + G.score });
    r.push({ sep: true });

    var got = BUFF_LIST.filter(function (x) { return b[x.key] > 0; });
    r.push({ h: '强化词条（' + got.length + ' / ' + BUFF_LIST.length + '）' });
    if (!got.length) {
      r.push({ full: '本局还没拾到强化 —— 击杀妖物会掉落。' });
    } else {
      got.forEach(function (x) {
        r.push({ k: x.name + ' +' + b[x.key] + ' 层', v: x.effect(b[x.key]), color: x.color });
      });
    }
    return r;
  }

  function panelHtml() {
    var out = '<div class="sp-head"><span>属性详情</span>'
      + '<span class="sp-x" id="statsClose">收起 ▴</span></div><div class="sp-grid">';
    statsRows().forEach(function (x) {
      if (x.sep) { out += '<div class="sp-sep"></div>'; return; }
      if (x.h) { out += '<div class="sp-h">' + x.h + '</div>'; return; }
      if (x.full !== undefined) { out += '<div class="sp-note">' + x.full + '</div>'; return; }
      out += '<div class="sp-r">' + x.k + '<b'
        + (x.color ? ' style="color:' + x.color + '"' : '') + '>' + x.v + '</b></div>';
    });
    return out + '</div>';
  }

  /* 展开/收起属性面板。
   * 展开时把时间冻住（state → paused）：面板长在屏幕底部，而人物就站在那一带，
   * 不冻的话根本没法边看边躲。
   * 这不会退化成"紧急刹车"：暂停期间人物不能移动，落点在蓄力开始时就已经钉死了，
   * 解冻后该挨的扑击一样躲不掉，计时也一起停住 —— 拿不到任何便宜。 */
  function toggleStats(force) {
    if (!G) return;
    var open = (force === undefined) ? !G.statsOpen : !!force;
    G.statsOpen = open;
    lastPanelHtml = '';                        // 下次必定重建
    if (open) {
      if (state === 'playing') state = 'paused';
    } else if (state === 'paused' && !modalVisible()) {
      state = 'playing';
    }
    syncStats();
    if (open) updateHud();
  }

  /* 设置弹层开着时不要抢着把游戏恢复起来（打开设置的流程里也会调 toggleStats） */
  function modalVisible() {
    var m = $('settings');
    return !!(m && !m.classList.contains('hidden'));
  }

  /* 只负责"显不显示"和那个小箭头，不碰内容 */
  function syncStats() {
    var panel = $('statPanel'), arrow = $('statsArrow');
    if (!panel) return;
    var open = !!(G && G.statsOpen);
    panel.classList.toggle('hidden', !open);
    if (arrow) arrow.textContent = open ? '属性 ▴' : '属性 ▾';
  }

  function updateHud() {
    if (!G) return;
    var hpRatio = clamp(G.hp / G.maxHp, 0, 1);
    $('hpFill').style.width = (hpRatio * 100).toFixed(1) + '%';
    $('hpText').textContent = Math.max(0, Math.ceil(G.hp)) + ' / ' + G.maxHp;
    $('scoreText').textContent = G.score;
    var left = Math.max(0, CFG.roundDuration - G.t);
    $('timeText').textContent = fmtTime(left);
    $('timeFill').style.width = ((1 - left / CFG.roundDuration) * 100).toFixed(1) + '%';
    $('weaponName').textContent = WEAPONS[G.weapon].name;

    var ico = icoRowHtml();
    if (ico !== lastIcoHtml) { $('icoRow').innerHTML = ico; lastIcoHtml = ico; }

    if (G.statsOpen) {
      var p = panelHtml();
      if (p !== lastPanelHtml) { $('statPanel').innerHTML = p; lastPanelHtml = p; }
    }
  }

  var toastTimer = null;
  function toast(msg) {
    var el = $('toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.remove('show'); }, 1500);
  }

  /* ══════════════════ 界面切换 ══════════════════ */
  function setState(s) {
    state = s;
    $('loading').classList.toggle('hidden', s !== 'loading');
    $('home').classList.toggle('hidden', s !== 'home');
    $('result').classList.toggle('hidden', s !== 'result');
    $('hud').classList.toggle('hidden', !(s === 'playing' || s === 'paused'));
    /* HUD 一进一出的同时把属性面板也归位：新一局不该继承上一局展开的状态，
     * 而且 updateHud 只在 playing 时跑，不主动同步的话面板会"留着不动"。 */
    if (s !== 'playing' && G) G.statsOpen = false;
    syncStats();
    if (s !== 'paused') $('settings').classList.add('hidden');
  }

  function openSettings(from) {
    settingsFrom = from;
    $('settings').classList.remove('hidden');
    Array.prototype.forEach.call(document.querySelectorAll('.ingame-only'), function (b) {
      b.classList.toggle('hidden', from !== 'game');
    });
    Array.prototype.forEach.call(document.querySelectorAll('.home-only'), function (b) {
      b.classList.toggle('hidden', from === 'game');
    });
    if (from === 'game' && G) {
      /* 先关属性面板再置 paused。顺序不能反：面板自己会把 state 从 paused 恢复回来，
       * 反过来的话它会覆盖掉这里刚设的暂停，游戏就会在设置弹层背后继续跑。 */
      toggleStats(false);
      state = 'paused';
      G.drag = false; G.dragMove = 0;
    }
    syncSettingsUI();
  }

  function closeSettings() {
    $('settings').classList.add('hidden');
    if (settingsFrom === 'game' && state === 'paused') state = 'playing';
  }

  function syncSettingsUI() {
    var v = Math.round(settings.volume * 100);
    $('volRange').value = v;
    $('volVal').textContent = v + '%';
    $('vibToggle').classList.toggle('on', settings.vibrate);
  }

  function startGame() {
    Sound.init();
    Sound.resume();
    newGame();
    lastIcoHtml = '';                          // 新一局强制重画图标行与面板
    lastPanelHtml = '';
    setState('playing');
    updateHud();
    toast('妖物来袭 · 坚持 3:00 即通关');
  }

  function endGame(win) {
    if (state === 'result') return;
    state = 'result';
    Sound.init();
    if (win) { Sound.win(); vibrate([40, 70, 40]); }
    else { Sound.lose(); vibrate(220); }

    var isBest = G.score > bestScore;
    if (isBest) { bestScore = G.score; saveBest(); }

    var title = $('resTitle');
    title.textContent = win ? '通关' : '失败';
    title.style.color = win ? '#7dffb0' : '#ff8a9a';
    title.style.textShadow = win
      ? '0 0 26px rgba(90,255,150,.45)'
      : '0 0 26px rgba(255,90,120,.45)';
    $('resSub').textContent = win ? '妖物退散，长路已清' : '血尽而亡，妖物未退';
    $('resScore').textContent = G.score;
    $('resKills').textContent = G.kills;
    $('resTime').textContent = fmtTime(Math.min(G.t, CFG.roundDuration));
    $('resBest').textContent = isBest
      ? '新纪录！历史最高积分 ' + bestScore
      : '历史最高积分 ' + bestScore;

    setState('result');
  }

  function goHome() {
    Sound.resume();
    G = null;
    $('bestScore').textContent = bestScore > 0 ? '历史最高积分 ' + bestScore : '';
    setState('home');
  }

  /* ══════════════════ 事件绑定 ══════════════════ */
  function bindUI() {
    $('btnStart').addEventListener('click', startGame);
    $('btnHomeSettings').addEventListener('click', function () { openSettings('home'); });
    $('btnSettingsInGame').addEventListener('click', function () { openSettings('game'); });
    $('btnResume').addEventListener('click', closeSettings);
    $('btnCloseSetHome').addEventListener('click', closeSettings);
    $('btnRestart').addEventListener('click', function () {
      $('settings').classList.add('hidden');
      startGame();
    });
    $('btnBackHome').addEventListener('click', function () {
      $('settings').classList.add('hidden');
      goHome();
    });
    $('btnAgain').addEventListener('click', startGame);
    $('btnResHome').addEventListener('click', goHome);

    $('volRange').addEventListener('input', function (e) {
      settings.volume = (+e.target.value) / 100;
      $('volVal').textContent = e.target.value + '%';
      Sound.init();
      Sound.setVolume(settings.volume);
      saveSettings();
    });
    $('vibToggle').addEventListener('click', function () {
      settings.vibrate = !settings.vibrate;
      $('vibToggle').classList.toggle('on', settings.vibrate);
      saveSettings();
      if (settings.vibrate) vibrate(35);
    });
  }

  /* ══════════════════ 主循环 ══════════════════ */
  var lastTs = 0;
  function loop(ts) {
    var dt = lastTs ? Math.min(0.05, (ts - lastTs) / 1000) : 0;
    lastTs = ts;
    animT += dt;

    if (state === 'playing') {
      updatePlaying(dt);
      if (++hudTick % 4 === 0) updateHud();
    } else if (state === 'home') {
      bgScroll += CFG.scrollSpeed * 0.42 * dt;
    } else if (G && (state === 'paused' || state === 'result')) {
      if (G.shake > 0) G.shake = Math.max(0, G.shake - dt * 42);
      if (G.flash > 0) G.flash = Math.max(0, G.flash - dt * 2.6);
    }

    render();
    requestAnimationFrame(loop);
  }

  /* ══════════════════ 启动 ══════════════════ */
  function boot() {
    resize();
    window.addEventListener('resize', resize);
    bindInput();
    bindUI();

    var steps = ['正在铺设道路…', '正在召唤妖物…', '正在磨砺剑锋…'];
    var i = 0;
    $('loaderFill').style.width = '8%';
    var timer = setInterval(function () {
      i++;
      $('loaderFill').style.width = Math.min(100, i * 30) + '%';
      if (i <= steps.length) $('loaderText').textContent = steps[i - 1];
      if (i >= 4) {
        clearInterval(timer);
        $('loaderFill').style.width = '100%';
        setTimeout(function () {
          $('bestScore').textContent = bestScore > 0 ? '历史最高积分 ' + bestScore : '';
          setState('home');
        }, 300);
      }
    }, 260);

    requestAnimationFrame(loop);
  }

  /* ══════════════════ 调试 / 二次开发钩子 ══════════════════
   * 只读引用，便于自动化验证与调参（改这些对象的字段会直接影响游戏）。
   * 例：RD.G.monsters 看当前妖物，RD.CFG.playerY 看玩家所处深度。 */
  window.RD = {
    CFG: CFG, ATTACK: ATTACK, WEAPONS: WEAPONS, MONSTERS: MONSTERS, BUFF_MAP: BUFF_MAP,
    BUFF_LIST: BUFF_LIST,
    SCENE: SCENE, PROPS: PROPS,
    settings: settings,
    get perf() { return perf; },
    get G() { return G; },
    get state() { return state; },
    project: function (x, y) { return road.project(x, y); },
    /* 枚举当前视野里的景物（不绘制）。给自动化测试清点用。 */
    sceneItems: function (scroll, emit) { return sceneItems(scroll === undefined ? currentScroll() : scroll, emit); },
    /* 属性面板：开关 + 当前那几行数据（测试直接核对数字，不用去解 DOM） */
    toggleStats: function (force) { toggleStats(force); },
    statsRows: function () { return G ? statsRows() : []; },
    playerStats: function () { return G ? playerStats() : null; }
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
