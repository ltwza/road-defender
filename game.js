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
    /* 通关奖励（金币）。为什么要有这一笔：单局收入完全由"打死多少只"决定，
     * 于是"活着"本身没有任何经济价值 —— 玩家的最优解会变成在路中间硬拼而不是躲。
     * 给一笔约等于多打死 120 只小妖（小妖掉 1 枚）的奖励，"撑满 3 分钟"才成为明确的最优策略。
     * 数量按 dev/economy.js 量出来的单局收入（会躲的玩家约 520）折算：+120 ≈ 多两成。 */
    coinBonusWin: 120,
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

  /* coin = 击杀掉落的金币。它是**跨局持久**的货币（买地图/皮肤），
   * 所以数值口径和 score 必须分开看：
   *   · score 是"这一局打得好不好"，可以随手给（顺手一刀 +10 不心疼）；
   *   · coin 是"值多少钱"，要经得起「一局能攒多少 × 价格」的对照。
   * 取分档时按「击杀难度」而不是按血量线性走 —— 蛮兵/妖将挡路更久、更可能要放掉一次输出，
   * 打掉它们就该明显更值钱，否则玩家没有动力先清硬怪（都去刷小妖了）。
   * 相对关系：小妖 1 : 飞蝠 2 : 蛮兵 4 : 妖将 9。
   * ⚠ 改这里的数之前先跑 dev/economy.js（它会用真实模拟玩家算出"一局平均收入"），
   *   价格表（MAPS/SKINS 里的 price）就是按那个数定的 —— 只动一边必然失衡。 */
  var MONSTERS = {
    slime: { key: 'slime', name: '小妖', hp: 20, speed: 1.9, r: 0.44, dmg: 8, score: 10, coin: 1, color: '#7ee081', dark: '#3d7a46', windup: 0.50, dash: 10 },
    bat: { key: 'bat', name: '飞蝠', hp: 15, speed: 3.6, r: 0.34, dmg: 6, score: 16, coin: 2, color: '#c58bff', dark: '#6b46a0', windup: 0.40, dash: 15 },
    brute: { key: 'brute', name: '蛮兵', hp: 55, speed: 1.4, r: 0.58, dmg: 14, score: 32, coin: 4, color: '#ff9366', dark: '#a3492b', windup: 0.72, dash: 8 },
    elite: { key: 'elite', name: '妖将', hp: 115, speed: 1.6, r: 0.66, dmg: 18, score: 70, coin: 9, color: '#ffd166', dark: '#a37a17', windup: 0.64, dash: 9 }
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

  /* ══════════════════ 主题 / 地图 / 皮肤 / 存档 ══════════════════
   * 这是商城系统的地基，分三层，职责刻意分开：
   *   主题（theme）—— 一张地图的**全部颜色与雾参数**。绘制代码只认主题、不认地图，
   *                    换地图 = 换一个主题对象，绘制路径一行都不用改。
   *   地图（MAPS） —— 主题覆盖 + 景物种类（belts 的 kinds）+ 价格。
   *   皮肤（SKINS）—— 人物配色与体型参数（男/女各一套），与地图正交。
   *
   * ⚠ 夜图（night）的每个色值都必须是「抽主题之前」的原字面量，一个字节都不许漂。
   *   这类重构最常见的翻车方式就是"顺手调一下"，然后用户发现熟悉的夜景变了样。
   *   dev/shot.js 的 --region 可以逐像素比对改前改后，别靠肉眼。
   *
   * ⚠ 玩法性的颜色（妖物本体、血条、预警圈、伤害闪红、词条图标）**故意不进主题**：
   *   它们必须跨地图完全一致 —— 换了张地图就得重新学"哪个圈是要命的"，
   *   那不是美术，是 bug。
   */
  var BASE_THEME = {
    /* 天空渐变（上 → 下），铺满整块画布，地面再盖住下半部分 */
    sky: ['#080d18', '#121a2a', '#1a2130', '#0c1017'],
    /* 地平线以下的地面（远 → 近） */
    ground: ['#1a2333', '#131a26', '#0e131c'],
    /* 两层远山剪影（远 → 近）+ 两条远树线（远 → 近） */
    ridge: ['#131c29', '#0c131c'],
    treeLine: ['#141d2b', '#111927'],
    /* 地平线雾带的四个色标（上 → 下），中间那两个是"贴地平线"的浓度 */
    haze: ['rgba(110,150,205,0)', 'rgba(104,144,200,0.055)',
           'rgba(150,185,232,0.125)', 'rgba(120,160,215,0)'],
    /* 路面（远 → 近）、横向条纹的 rgb 三元组、分隔虚线的整条 rgba */
    road: ['#2c313d', '#232833', '#1a1e28'],
    stripe: '160,190,240',
    /* 分隔虚线：rgb 三元组 + 近端不透明度（远处靠 exp 衰减，见 drawRoad）。
     * 和 curb 一个模式 —— alpha 必须能单独调，否则没法做"随距离淡出"。 */
    dash: '200,222,255',
    dashA: 0.24,
    /* 路沿：rgb 三元组 + 近端不透明度（远处靠 exp 衰减，见 drawCurb） */
    curb: '120,190,255',
    curbA: 0.55,
    curbGlowA: 0.16,
    /* 路肩碎石带 */
    verge: '20,26,36',
    /* 空气透视：alpha = fogMin + (1−fogMin)·exp(−depth/fogD) */
    fogMin: 0.30,
    fogD: 75,
    vig: 0.55,        // 暗角强度（白天/沙漠要弱得多，否则像被熏黑了）
    flies: 14,        // 萤火/浮尘数量
    /* 景物配色。名字按"用途"取，不按"长什么样"——
     * 同一套绘制代码要在夜/昼/沙漠三种光线下都说得通。 */
    P: {
      grass: '#122219', bush: '#0f1c16', bushTop: '#14251c',
      rock: '#0f151e', rockTop: '#171f2a',
      trunk: '#080d12', pineA: '#0c1714', pineB: '#0a1310',
      leafA: '#0b1611', leafB: '#0f1d16', edge: 'rgba(150,196,235,0.20)',
      stalkA: '#122219', stalkB: '#16291e', leafC: '#193023',
      pole: '#151d27', cloth: '#1e2c40', emblem: 'rgba(206,228,255,0.26)',
      wall: '#1d2735', roof: '#26313f', window: 'rgba(255,188,112,0.62)',
      eave: 'rgba(0,0,0,0.35)', stone: '#0a1017', tower: '#0d141d'
      /* ⚠ 这里**只放夜里会用到的键**。沙漠专属的（仙人掌/沙丘/台地/断柱/帐篷/棕榈）
       *   一律写在 desert 的 over.P 里 —— 曾经把它们写在这儿，
       *   于是沙漠图的仙人掌与棕榈叶读的是**夜图**的深绿，在黄沙上绿得刺眼。
       *   deepMerge 不会报错，只会安静地给你一个不该出现的颜色。
       *   dev/e2e-test.js 测试 L 现在会逐道具核对"用到的每个键都在本图 over.P 里"。 */
    },
    /* 石灯笼：白天地图里"不点灯"，于是只改这几个色，几何一律不动 */
    lamp: {
      pole: '#1f2835', body: '#2b3546', core: '#ffc061',
      glow: ['rgba(255,166,72,0.55)', 'rgba(255,138,48,0.16)', 'rgba(255,140,60,0)'],
      light: ['rgba(255,154,52,0.62)', 'rgba(255,124,28,0.22)', 'rgba(255,110,20,0)'],
      poolA: 0.34
    },
    /* 萤火：三个 rgb 三元组，alpha 由代码现算后拼进 rgba(...) */
    fly: { a: '255,232,160', b: '205,255,175', c: '180,255,160' },
    shadow: 0.42      // 妖物/人物脚下影子的不透明度
  };

  /* 深合并（两层足够）。地图只覆盖个别色值，
   * 用"整块替换"的话，BASE_THEME 里将来新增的字段在被覆盖的地图上会变成 undefined ——
   * 那种崩溃只在切到那张地图时出现，最难查。 */
  function deepMerge(base, over) {
    var out = {}, k;
    for (k in base) if (Object.prototype.hasOwnProperty.call(base, k)) out[k] = base[k];
    for (k in over) if (Object.prototype.hasOwnProperty.call(over, k)) {
      var b = out[k], o = over[k];
      if (b && o && typeof b === 'object' && typeof o === 'object' &&
          !Array.isArray(b) && !Array.isArray(o)) {
        var m = {}, k2;
        for (k2 in b) if (Object.prototype.hasOwnProperty.call(b, k2)) m[k2] = b[k2];
        for (k2 in o) if (Object.prototype.hasOwnProperty.call(o, k2)) m[k2] = o[k2];
        out[k] = m;
      } else out[k] = o;
    }
    return out;
  }

  /* 色值 → [r,g,b]。要认三种写法：
   *   'hex'（#abc / #aabbcc）、'r,g,b'（三元组，主题里给需要单独调 alpha 的用）、
   *   'rgb(...)' —— 最后这个不是为了好看，而是因为 **mixColor 的输出会再被 mixColor 吃掉**
   *   （路面远端先混一次地面色、再拿结果混一次路面色）。少了这一支，
   *   parseInt('rgb(24') 就是 NaN，整块路面直接不画。 */
  function rgbOf(c) {
    if (typeof c !== 'string') return null;
    var body = c;
    var m = /^rgba?\(([^)]*)\)$/.exec(c);
    if (m) body = m[1];
    if (body.charAt(0) === '#') {
      var h = body.slice(1);
      if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
      if (h.length !== 6 || /[^0-9a-fA-F]/.test(h)) return null;
      return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
    }
    var p = body.split(',');
    if (p.length < 3 || p.length > 4) return null;
    var out = [parseInt(p[0], 10), parseInt(p[1], 10), parseInt(p[2], 10)];
    if (isNaN(out[0]) || isNaN(out[1]) || isNaN(out[2])) return null;
    return out;
  }

  /* 两色混合：k=0 取 a，k=1 取 b。
   * 解析不出来的色值按 k 取整返回原串 —— 主题是数据，
   * 宁可画得难看一点，也不要 NaN 把整块画面变成黑色。 */
  function mixColor(a, b, k) {
    var A = rgbOf(a), B = rgbOf(b);
    if (!A || !B) return k < 0.5 ? a : b;
    return 'rgb(' + Math.round(A[0] + (B[0] - A[0]) * k) + ',' +
                    Math.round(A[1] + (B[1] - A[1]) * k) + ',' +
                    Math.round(A[2] + (B[2] - A[2]) * k) + ')';
  }

  /* 地面渐变的色标位置（远 → 近）。
   * 抽成常量是因为 drawRoad 要让路面远端**收敛到同一屏幕 y 处的地面色** ——
   * 两处各写一份位置，迟早会对不上，而症状是"远处路上浮着一条淡淡的带"，
   * 很难联想到是两处拼写不同步。 */
  var GROUND_STOPS = [0, 0.30, 1];

  /* 路面渐变末段的色标：[位置, 残留对比度 s]。
   *
   * s 的含义是"路面还剩多少自己的颜色"：s=1 完全是柏油本色，s=0 完全是
   * **同一屏幕 y 处**的地面色。
   *
   * 为什么是"连色相一起收敛"而不是"亮度对齐、色调照旧"：
   *   大气对路面和地面是同一个介质、同一次衰减，于是
   *       haze(road) − haze(ground) = (1 − a) · (road − ground)
   *   —— 两者的**差**按 (1−a) 缩水，色相和亮度一起缩。
   *   第一版写成"只借亮度"（scaleToLum），保住了柏油的灰调，代价是
   *   远处路面和地面在色相上永远差着几十级：白天图草地绿、柏油灰，
   *   实测 900 米处逐通道最大差 33 —— 路照样从背景里翻出来，
   *   只是从"暗塔"换成了"浅灰带"。dev/persp.js 的判据 B 就是量这个。
   *
   * s 的斜率刻意取成缓变（3.0 → 3.25 → 3.14 → 2.29 每单位），
   *   色标斜率的突变会在屏幕上留下一条横向亮暗带（马赫带），
   *   这个坑在"末段收敛"的第一版上踩过，那条带比尖塔本身还显眼。 */
  var ROAD_FADE = [[0.68, 1], [0.78, 0.70], [0.86, 0.44], [0.93, 0.22], [1, 0.06]];

  /* ── 地图（场景） ──
   * kinds = 三条景物带上各摆什么，按 SCENE.belts 的顺序一一对应。
   * 只写种类、不写坐标：位置仍由「世界里程 + 稳定哈希」推导（见 SCENE 注释），
   * 所以换地图不会让世界"重掷"，只是换了同一批槽位上长什么东西。
   *
   * price 的依据（dev/economy.js 实测，别凭感觉调）。一局到手多少分三档：
   *   最快 —— 会躲（233ms 反应）且通关：掉落 521 + 通关奖励 120 = 641/局
   *   只会躲、没通关：521/局      不擅走位：227 + 120 = 347/局
   * 定价**按最快那一档**折算，因为"连最顺的人都要打这么多局，慢的只会更久"：
   *   day ≈ 10.3 局、desert ≈ 13.7 局 —— 对上"地图 10 多局往上"；
   *   同一组价格对不擅走位的人是 19.0 / 25.4 局，属于"值得攒一阵"的那一档。
   * ⚠ dev/e2e-test.js 测试 L 会把最快基线钉成断言，改价先跑 economy.js。
   * ⚠ 口径坑：G.coins 里混着通关奖励（endGame 在置 result 之前就加了），
   *   economy.js 已经把这笔单独扣出来报，别把"到手"当成"掉落"用。 */
  var MAPS = [
    {
      key: 'night', name: '暮色长路', sub: '夜色 · 灯笼', price: 0,
      desc: '初入江湖的那条夜路。石灯笼一路点到天边。',
      kinds: null                     // null = 用 SCENE 里的默认种类
    },
    {
      key: 'day', name: '白昼长路', sub: '晴天 · 山径', price: 6600,
      desc: '同一条路，白天。远山、竹影、屋顶的瓦都看得清了。',
      kinds: [['grass', 'rock', 'bamboo', 'grass', 'banner', 'rock', 'bush'],
              ['pine', 'broadleaf', 'pine', 'rock', 'hut', 'broadleaf'],
              ['pine', 'pagoda', 'gate', 'broadleaf', 'pine']],
      over: {
        sky: ['#3f7fc4', '#6ea8dd', '#9cc6e9', '#c8dcee'],
        ground: ['#8aa260', '#6d854c', '#4b5f36'],
        ridge: ['#93aec2', '#7e9aae'],
        treeLine: ['#5b7a44', '#4a6636'],
        haze: ['rgba(255,255,255,0)', 'rgba(255,255,255,0.10)',
               'rgba(255,255,255,0.22)', 'rgba(255,255,255,0)'],
        road: ['#8f8a80', '#7b766c', '#66625a'],
        stripe: '255,255,255',
        dash: '255,255,255',
        dashA: 0.50,
        curb: '236,238,242',
        curbA: 0.42,
        curbGlowA: 0.06,
        verge: '111,106,96',
        fogMin: 0.34,
        fogD: 95,
        vig: 0.22,
        flies: 0,
        P: {
          grass: '#4e6b32', bush: '#41602c', bushTop: '#4f7034',
          rock: '#7b7a72', rockTop: '#8f8e85',
          trunk: '#4a3d30', pineA: '#39562f', pineB: '#2f4a28',
          leafA: '#3f5f2e', leafB: '#4d7137', edge: 'rgba(255,255,240,0.38)',
          stalkA: '#5b7a3a', stalkB: '#6a8c45', leafC: '#7fae55',
          pole: '#5a5048', cloth: '#b8443c', emblem: 'rgba(255,255,255,0.55)',
          wall: '#c3b6a1', roof: '#6b4b3a', window: 'rgba(52,44,38,0.55)',
          eave: 'rgba(0,0,0,0.18)', stone: '#8a8578', tower: '#a8a196'
        },
        lamp: {
          pole: '#8a8578', body: '#9b9689', core: '#cfcabc',
          glow: ['rgba(255,255,255,0)', 'rgba(255,255,255,0)', 'rgba(255,255,255,0)'],
          light: ['rgba(255,255,255,0)', 'rgba(255,255,255,0)', 'rgba(255,255,255,0)'],
          poolA: 0
        },
        shadow: 0.30
      }
    },
    {
      key: 'desert', name: '大漠孤烟', sub: '黄昏 · 沙丘', price: 8800,
      desc: '落日把沙丘压成剪影。仙人掌、断柱、商队的帐篷。',
      /* 沙漠图**不收真树**（松/阔叶/竹一概没有），第一带也不放草 ——
       * 上一次这里铺的是 grass 与 palm，画出来是一片棕榈林，草还是绿的。
       * 主体改成仙人掌：近处矮丛（cactusClump）、中景柱状（cactus），
       * 远景靠台地/断柱/方尖碑撑天际线。
       * palm（绿洲棕榈）的道具和配色都留着，想加一段绿洲就把它塞进第三带。 */
      kinds: [['dune', 'rock', 'cactusClump', 'yucca', 'banner', 'cactusClump', 'deadbush'],
              ['cactus', 'dune', 'ruin', 'cactus', 'tent', 'rock'],
              ['mesa', 'cactus', 'ruin', 'obelisk', 'mesa']],
      over: {
        sky: ['#33406f', '#8a5a80', '#d4795a', '#f0b070'],
        ground: ['#c08a52', '#a8703f', '#6b4526'],
        /* 远景剪影在沙漠里**不能真做成剪影**：日落时沙丘是被夕阳照亮的地形，
         * 而沙地本身就亮（亮度 145）。原来那两个深紫褐（88 / 60）会在
         * 地平线上压出一条暗带，紧贴着亮沙地，反差一百多级 —— 那正是
         * "远处的景观怪怪的"的来源。现在改成越靠近地平线越接近沙色，
         * 让远景平滑地融进地面：
         *   天空 80 → 远丘 109 → 近丘 129 → 起伏 138~144 → 沙地 145 */
        ridge: ['#8f6558', '#a87a55'],
        treeLine: ['#b5834c', '#bb8a52'],
        haze: ['rgba(255,190,120,0)', 'rgba(255,180,110,0.10)',
               'rgba(255,170,100,0.24)', 'rgba(255,160,90,0)'],
        road: ['#8a7358', '#75604a', '#5f4d3c'],
        stripe: '255,220,170',
        dash: '255,232,190',
        dashA: 0.34,
        curb: '255,208,150',
        curbA: 0.48,
        curbGlowA: 0.10,
        verge: '109,84,58',
        fogMin: 0.34,
        fogD: 58,
        vig: 0.40,
        flies: 9,
        P: {
          /* 这里只列**沙漠图真正画得到的**道具色值。
           * 沙丘/台地/断柱/帐篷本来就该是沙石色，跟地平线同调；
           * 植物则刻意压暗、去饱和 —— 落日是逆光，饱和的绿会像贴上去的贴纸。 */
          rock: '#8a7355', rockTop: '#9c8465',
          dune: '#c99a63', duneTop: '#e0b478',
          mesa: '#a87c4e', mesaTop: '#c99a63',
          ruin: '#b09a78', ruinTop: '#8f7c5e',
          tent: '#c2a97e', tentDark: '#8a7454',
          pole: '#5a4330', cloth: '#a8483a', emblem: 'rgba(255,235,190,0.5)',
          trunk: '#4a3524',
          cactus: '#5f8046', cactusDark: '#42583a', cactusFlower: '#ffb89e',
          cactusClump: '#57733f', cactusClumpTop: '#6b8a4c',
          yucca: '#7d8f4e', yuccaDark: '#637440',
          deadbush: '#7a6242', deadbushTop: '#9a7d52',
          palmLeaf: '#7d8a4a', palmLeaf2: '#8f9b58'
        },
        lamp: {
          pole: '#6b5238', body: '#7d6244', core: '#ffd07a',
          glow: ['rgba(255,196,110,0.50)', 'rgba(255,170,80,0.16)', 'rgba(255,160,70,0)'],
          light: ['rgba(255,182,96,0.58)', 'rgba(255,158,70,0.20)', 'rgba(255,150,60,0)'],
          poolA: 0.30
        },
        fly: { a: '255,220,150', b: '255,196,120', c: '255,180,110' },
        shadow: 0.34
      }
    }
  ];

  /* ── 皮肤 ──
   * 一套皮肤 = 一套**配色** + 一份**体型参数**，男款女款共用配色、只换体型与发型。
   * 这正是用户要的"性别切换但皮肤不变"：切的是 male/female 这两组参数，
   * 不是换一套皮肤。
   *
   * 体型参数的含义（都以"初始男款"为 1.0，所以那个组合画出来必须与改动前逐像素一致）：
   *   shK  肩宽倍率 —— 乘在现画法里的 wPx * 0.3 上
   *   hipK 下摆倍率 —— 乘在现画法里的 wPx * 0.52 上
   *   hair 发型：short / bun / long / ponytail / bald
   *   skirt 裙摆外张（0 = 直筒，越大越像裙子），只画在腰线以下
   * gear 是头饰（盔缨 / 头巾 / 斗笠 / 角盔 / 条纹头巾 / 发带），null 就是没有。
   * weapon 是手上那把家伙：剑 / 长枪 / 弯刀 / 太刀 / 战斧 / 权杖 / 弓。
   *
   * price 依据同 MAPS（同一份 dev/economy.js 基线）。按最快档 641/局折算，
   * 皮肤落在 1.4~3.7 局之间 —— 比地图便宜一大档，玩家能更早拿到第一件东西
   * （有反馈才有继续玩的动力）；对不擅走位的人是 2.6~6.9 局。 */
  var SKINS = [
    {
      key: 'wuxia', name: '青衫剑客', nation: '中原', job: '剑客', price: 0,
      desc: '一袭青衫，负剑独行。',
      body: { robe: ['#a8cfff', '#3d6cd4'], trim: '#e9f4ff', belt: '#2b4a8f', boot: '#1d2740', cape: null },
      head: { skin: '#ffe2bd', hair: '#232838' },
      gear: null,
      weapon: { kind: 'sword', color: '#d6ecff' },
      male: { shK: 1.00, hipK: 1.00, hair: 'bun', skirt: 0.06 },
      female: { shK: 0.86, hipK: 1.14, hair: 'long', skirt: 0.46 }
    },
    {
      key: 'greek', name: '斯巴达重装', nation: '希腊', job: '重装枪兵', price: 900,
      desc: '青铜胸甲，赤缨长枪。',
      body: { robe: ['#dfe8f2', '#8fa3b8'], trim: '#c8a447', belt: '#7a5f22', boot: '#4a3a24', cape: '#9c3537' },
      head: { skin: '#ecc79c', hair: '#3a2a1e' },
      gear: { kind: 'plume', color: '#c0392b' },
      weapon: { kind: 'spear', color: '#e6d6a8' },
      male: { shK: 1.16, hipK: 0.98, hair: 'short', skirt: 0.16 },
      female: { shK: 0.98, hipK: 1.16, hair: 'ponytail', skirt: 0.56 }
    },
    {
      key: 'persian', name: '波斯刺客', nation: '波斯', job: '刺客', price: 1200,
      desc: '缠头遮面，弯刀出袖。',
      body: { robe: ['#7d5a9c', '#3d2a52'], trim: '#e0b552', belt: '#8a6a20', boot: '#2b2233', cape: '#5b3f74' },
      head: { skin: '#e3bd92', hair: '#221a20' },
      gear: { kind: 'turban', color: '#d8c58a' },
      weapon: { kind: 'scimitar', color: '#f0e2b0' },
      male: { shK: 1.02, hipK: 0.98, hair: 'short', skirt: 0.20 },
      female: { shK: 0.88, hipK: 1.12, hair: 'long', skirt: 0.52 }
    },
    {
      key: 'ronin', name: '东瀛浪人', nation: '东瀛', job: '浪人', price: 1500,
      desc: '斗笠压低，太刀在腰。',
      body: { robe: ['#5c6b7a', '#2b3542'], trim: '#9fb0c0', belt: '#7a5a34', boot: '#23292f', cape: null },
      head: { skin: '#e8c49c', hair: '#1c1d22' },
      gear: { kind: 'kasa', color: '#a08a54' },
      weapon: { kind: 'katana', color: '#eaf4ff' },
      male: { shK: 1.04, hipK: 0.94, hair: 'bun', skirt: 0.14 },
      female: { shK: 0.90, hipK: 1.08, hair: 'ponytail', skirt: 0.44 }
    },
    {
      key: 'viking', name: '北境狂战', nation: '北欧', job: '狂战士', price: 1800,
      desc: '皮甲兽肩，双刃战斧。',
      body: { robe: ['#8a6b4a', '#4a3626'], trim: '#c9c2b4', belt: '#5c4326', boot: '#33251a', cape: '#6b4a3a' },
      head: { skin: '#f0cda6', hair: '#c98a3c' },
      gear: { kind: 'horn', color: '#cfd6de' },
      weapon: { kind: 'axe', color: '#b9c4cf' },
      male: { shK: 1.20, hipK: 1.04, hair: 'long', skirt: 0.18 },
      female: { shK: 1.00, hipK: 1.18, hair: 'ponytail', skirt: 0.50 }
    },
    {
      key: 'egypt', name: '尼罗河祭司', nation: '埃及', job: '祭司', price: 2100,
      desc: '亚麻白袍，金项圈与蛇杖。',
      body: { robe: ['#f2ece0', '#c9bba0'], trim: '#d8b03c', belt: '#b8932c', boot: '#8a7a58', cape: null },
      head: { skin: '#d9a970', hair: '#1a1a1a' },
      gear: { kind: 'nemes', color: '#2f5fa8' },
      weapon: { kind: 'staff', color: '#e8d07a' },
      male: { shK: 1.02, hipK: 1.00, hair: 'bald', skirt: 0.24 },
      female: { shK: 0.90, hipK: 1.12, hair: 'long', skirt: 0.54 }
    },
    {
      key: 'archer', name: '草原神射', nation: '草原', job: '弓手', price: 2400,
      desc: '皮袍窄袖，反曲弓在手。',
      body: { robe: ['#b8763c', '#6b3a1e'], trim: '#f0d9a8', belt: '#4a2a14', boot: '#33200f', cape: '#8f5a2a' },
      head: { skin: '#e0b184', hair: '#2a1c14' },
      gear: { kind: 'band', color: '#c8a447' },
      weapon: { kind: 'bow', color: '#c9a86a' },
      male: { shK: 1.08, hipK: 0.96, hair: 'short', skirt: 0.20 },
      female: { shK: 0.92, hipK: 1.10, hair: 'ponytail', skirt: 0.48 }
    }
  ];

  MAPS.forEach(function (m) { m.th = deepMerge(BASE_THEME, m.over || {}); });

  function mapOf(key) {
    for (var i = 0; i < MAPS.length; i++) if (MAPS[i].key === key) return MAPS[i];
    return MAPS[0];
  }
  function skinOf(key) {
    for (var i = 0; i < SKINS.length; i++) if (SKINS[i].key === key) return SKINS[i];
    return SKINS[0];
  }

  /* 预览用的临时主题覆盖：商城里同时要画好几张地图的缩略图，
   * 而绘制代码读的是"当前装备的那张"。用这个变量临时改指向，
   * 画完立刻还原（withTarget 里成对做，见 renderMapThumb）。 */
  var themeKey = null;
  function theme() { return mapOf(themeKey || profile.map).th; }

  /* 某张地图实际生效的景物带（只换 kinds，位置逻辑一律不动）。 */
  function beltsFor(key) {
    var m = mapOf(key);
    if (!m.kinds) return SCENE.belts;
    return SCENE.belts.map(function (b, i) {
      var ks = m.kinds[i];
      if (!ks) return b;
      var c = {};
      for (var k in b) if (Object.prototype.hasOwnProperty.call(b, k)) c[k] = b[k];
      c.kinds = ks;
      return c;
    });
  }

  /* ══════════════════ 存档（金币 / 已购 / 装备 / 性别） ══════════════════
   * 用一个键装完，避免"改了五个键、漏存其中一个"这种存档撕裂。
   * ⚠ 读进来必须**逐字段校验**：localStorage 里的东西可能是上一版写的、
   *   也可能被用户手改过。一个不存在的 skin key 会让绘制直接抛异常，
   *   症状是"打开就白屏"，而且清缓存才好 —— 校验比"相信存档"便宜太多。 */
  var PROFILE_KEY = 'rd_profile';
  var profile = {
    coins: 0,          // 当前余额
    earned: 0,         // 累计挣到的（结算页/统计用；不改价也能看出玩家玩了多久）
    runs: 0,           // 完成的局数
    ownedMaps: ['night'],
    ownedSkins: ['wuxia'],
    map: 'night',
    skin: 'wuxia',
    gender: 'male'
  };

  function hasKeyIn(list, arr) {
    for (var i = 0; i < list.length; i++) if (list[i].key === arr) return true;
    return false;
  }
  function uniq(list, table) {
    var out = [];
    (list || []).forEach(function (k) {
      if (typeof k !== 'string') return;
      if (!hasKeyIn(table, k)) return;              // 不认识的一律丢掉
      if (out.indexOf(k) < 0) out.push(k);
    });
    return out;
  }

  (function loadProfile() {
    var raw = null;
    try { raw = JSON.parse(localStorage.getItem(PROFILE_KEY) || 'null'); } catch (e) { raw = null; }
    if (!raw || typeof raw !== 'object') return;
    if (typeof raw.coins === 'number' && isFinite(raw.coins)) profile.coins = Math.max(0, Math.floor(raw.coins));
    if (typeof raw.earned === 'number' && isFinite(raw.earned)) profile.earned = Math.max(0, Math.floor(raw.earned));
    if (typeof raw.runs === 'number' && isFinite(raw.runs)) profile.runs = Math.max(0, Math.floor(raw.runs));
    profile.ownedMaps = uniq(raw.ownedMaps, MAPS);
    profile.ownedSkins = uniq(raw.ownedSkins, SKINS);
    /* 初始项永远算已拥有 —— 存档损坏/被清空也不能把玩家锁在"没有地图可用"的状态里 */
    if (profile.ownedMaps.indexOf('night') < 0) profile.ownedMaps.unshift('night');
    if (profile.ownedSkins.indexOf('wuxia') < 0) profile.ownedSkins.unshift('wuxia');
    profile.map = profile.ownedMaps.indexOf(raw.map) >= 0 ? raw.map : 'night';
    profile.skin = profile.ownedSkins.indexOf(raw.skin) >= 0 ? raw.skin : 'wuxia';
    profile.gender = (raw.gender === 'female') ? 'female' : 'male';
  })();

  function saveProfile() {
    try { localStorage.setItem(PROFILE_KEY, JSON.stringify(profile)); } catch (e) {}
  }

  function ownsMap(key) { return profile.ownedMaps.indexOf(key) >= 0; }
  function ownsSkin(key) { return profile.ownedSkins.indexOf(key) >= 0; }
  function owns(kind, key) { return kind === 'map' ? ownsMap(key) : ownsSkin(key); }

  /* 买。返回 {ok, reason}：调用方要能区分"钱不够"和"已经买过"，
   * 否则只能给一句笼统的失败提示。 */
  function buy(kind, key) {
    var d = kind === 'map' ? mapOf(key) : skinOf(key);
    if (owns(kind, key)) return { ok: false, reason: 'owned' };
    if (profile.coins < d.price) return { ok: false, reason: 'poor', need: d.price - profile.coins };
    profile.coins -= d.price;
    (kind === 'map' ? profile.ownedMaps : profile.ownedSkins).push(key);
    /* 买完直接装备 —— 买了个东西却要再点一下"使用"，是没必要的第二刀 */
    if (kind === 'map') profile.map = key; else profile.skin = key;
    saveProfile();
    return { ok: true, item: d };
  }

  function equip(kind, key) {
    if (!owns(kind, key)) return false;
    if (kind === 'map') profile.map = key; else profile.skin = key;
    saveProfile();
    return true;
  }

  function setGender(g) {
    profile.gender = (g === 'female') ? 'female' : 'male';
    saveProfile();
    return profile.gender;
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

  /* 把 --vh-full 钉成"真实可视高度"（px）。
   *
   * 为什么需要它：移动浏览器的 `100vh` 是**大视口** —— 地址栏收起时的高度，
   * 比真实可视区高（iPhone 竖屏实测差 100~140px）。#app 按它撑高，整个 HUD 底部
   * 就被锚到屏幕外面，血条和属性面板下半截被浏览器 UI 盖住；而面板自身并不溢出，
   * 所以"怎么拉都拉不动"，看着像面板坏了。电脑端没有地址栏，因此只在手机上出事。
   *
   * CSS 那边已经用 dvh 解决（见 index.html 的 :root 注释），这里再兜一层：
   * 微信旧 X5 内核不认识 dvh，而 visualViewport 覆盖面更广，且给的是实测像素。
   * 地址栏伸缩、切前后台都会改变可视区，所以每次 resize 都要重新同步。 */
  function syncViewportHeight() {
    var vv = window.visualViewport;
    var h = (vv && vv.height) || window.innerHeight;
    if (h > 0) document.documentElement.style.setProperty('--vh-full', h + 'px');
  }

  function resize() {
    syncViewportHeight();
    DPR = Math.min(window.devicePixelRatio || 1, 2);
    W = canvas.clientWidth || window.innerWidth;
    H = canvas.clientHeight || window.innerHeight;
    canvas.width = Math.round(W * DPR);
    canvas.height = Math.round(H * DPR);
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    buildRoad();
    buildVignette();
  }

  /* 暗角。强度走主题：夜景要 0.55 才压得住远处的亮块，
   * 白天/沙漠用同样的 0.55 会像被熏黑了 —— 所以它是"每张地图的参数"，
   * 不是全局常量。换地图时要重建（渐变对象是缓存下来的，不重建就还是旧强度）。 */
  function buildVignette() {
    vignette = ctx.createRadialGradient(W * 0.5, H * 0.55, H * 0.25, W * 0.5, H * 0.55, H * 0.95);
    vignette.addColorStop(0, 'rgba(0,0,0,0)');
    vignette.addColorStop(1, 'rgba(0,0,0,' + theme().vig + ')');
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
      /* coins = 本局已挣到的金币（结算时入账）；coinGain = 有过几次进账，
       * 给 HUD 的"跳一下"动画用 —— 光比大小的话，同一帧连捡两只就只跳一次。 */
      coins: 0, coinGain: 0, banked: false,
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
    /* 与目标的深度差：夹住下界，免得妖物贴脸扑过来时 atan2 在小分母上算出横飞的角。
     * 代价：夹取生效时（妖物进到 2.5 米内），下面那条「偏离恒等于 offM」的不变量失效 ——
     * 弹道瞄的是 2.5 米处的假想点，真实偏离被等比压缩成 offM × dy真 / 2.5，越贴脸越集中。
     * 方向上是好事；而且子弹一帧飞约 1.5 米，这个区间本来就谈不上散布。 */
    var dy = aimY - oy;
    if (dy < 2.5) dy = 2.5;

    var n = st.w.shots;
    var spread = st.w.spreadM || 0;
    G.shotsFired += n;
    for (var i = 0; i < n; i++) {
      /* 散布的口径是"米"，不是角度 —— 见 WEAPONS 上方关于 spreadM 的注释。
       * 瞄准点直接挪到「目标位置横向 ±offM 米」，角度由这一点现算，
       * 于是"在最外侧那一发，在目标那个深度上离目标中心多远"永远等于 offM，
       * 和远近无关：双股剑外侧偏 0.45 米，在 12 米和 60 米处都是 0.45 米。
       * （唯一例外是上面 dy 被夹取的情形，那里偏离会被等比压缩 —— 见该处注释。）
       * 注意算出来的 a 仍然是 3D 空间里的角度：变的不是「用不用角度」，
       * 而是角度从「配置里的常量」变成「按目标深度现算的派生量」。 */
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
    /* 两种浮字故意分开一点：积分往上一点（更远处，屏幕上更高），金币留在原处。
     * 两个都从同一位置起跳的话，妖物密集时数字会叠在一起看不清。 */
    G.floats.push({ x: m.x3d, y: m.y3d + 2.0, text: '+' + m.type.score, color: '#ffe08a', life: 0.95 });
    G.coins += m.type.coin;
    G.coinGain++;
    G.floats.push({ x: m.x3d, y: m.y3d, text: '+' + m.type.coin, color: '#ffd166', life: 0.95, coin: true });
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
    /* 大气层压在**所有远景元素**之上：路面、路肩、路沿、景物、灯笼都要被同一层雾衰减。
     * 排在 drawEntities 之前是有意的 —— 妖物和玩家最远 120 米（屏幕 y≥356），
     * 本来就在雾带范围之外，但顺序上明确隔开，免得将来雾带变厚时
     * "雾盖住妖物"这种玩法级事故悄悄发生。 */
    drawAir();

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
    var th = theme();
    var g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, th.sky[0]);
    g.addColorStop(0.38, th.sky[1]);
    g.addColorStop(0.60, th.sky[2]);
    g.addColorStop(1, th.sky[3]);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
  }

  function drawRoad() {
    var th = theme();
    var far = road.crossSectionAtT(0.995);
    var hy = road.vanish.y;          // 地平线 —— 地面渐变与它的色标都以这里为原点
    var scroll = currentScroll();

    // 路面主体
    ctx.beginPath();
    ctx.moveTo(road.left0.x, road.left0.y);
    ctx.lineTo(far.a.x, far.a.y);
    ctx.lineTo(far.b.x, far.b.y);
    ctx.lineTo(road.right0.x, road.right0.y);
    ctx.closePath();
    var rg = ctx.createLinearGradient(0, road.left0.y, 0, far.a.y);
    /* 末端必须收敛到**同一屏幕 y 处的地面色**，而不是一个固定的 ground[0]：
     * 地面自身的渐变还在继续往暗处走，钉死一个常量会在远端留下 2~3 级亮度差 ——
     * 那点差刚好够让眼睛顺着两条直边一路看到消失点，也就是"焦点太清晰"。
     * 按 y 反查地面渐变，两边才是同一个量。
     *
     * 渐变的**位置参数恰好等于 t**（屏幕 y 是 t 的线性函数），
     * 所以色标可以直接读成透视深度：0.42→35 米，0.68→100 米，0.95→912 米。 */
    function groundAtY(y) {
      var pg = (y - hy) / (H - hy);
      if (pg <= 0) return th.ground[0];
      if (pg >= 1) return th.ground[GROUND_STOPS.length - 1];
      for (var i = 0; i < GROUND_STOPS.length - 1; i++) {
        if (pg <= GROUND_STOPS[i + 1]) {
          var span = GROUND_STOPS[i + 1] - GROUND_STOPS[i];
          return mixColor(th.ground[i], th.ground[i + 1], span > 0 ? (pg - GROUND_STOPS[i]) / span : 0);
        }
      }
      return th.ground[GROUND_STOPS.length - 1];
    }
    var yN = road.left0.y, yF = far.a.y;
    var gy = function (p) { return yN + (yF - yN) * p; };
    /* 路面在 y 处的雾化色 = 「同一屏幕 y 处的地面色」掺上 s 份「柏油本色」。
     * 等价于"先把路和地面的差按 (1−s) 缩水，再叠到地面上" ——
     * 也就是 haze(road) = haze(ground) + (1−a)·(road − ground) 那个式子。
     * 末段的色标表见上面 ROAD_FADE 的注释。 */
    var fadeAt = function (y, s) { return mixColor(groundAtY(y), th.road[2], s); };
    rg.addColorStop(0, th.road[0]);
    rg.addColorStop(0.42, th.road[1]);
    for (var fi = 0; fi < ROAD_FADE.length; fi++) {
      rg.addColorStop(ROAD_FADE[fi][0], fadeAt(gy(ROAD_FADE[fi][0]), ROAD_FADE[fi][1]));
    }
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
      ctx.strokeStyle = 'rgba(' + th.stripe + ',' + a.toFixed(3) + ')';
      ctx.beginPath();
      ctx.moveTo(cs.a.x, cs.a.y);
      ctx.lineTo(cs.b.x, cs.b.y);
      ctx.stroke();
    }

    /* 分隔虚线（x = ±roadWidth/6）。宽度必须用**米**、跟着透视收缩 ——
     * 写死 px 的话远处那条线会一直保持同样的粗细和亮度，
     * 等于在地平线上钉了一排小白点：这是"路的焦点太清晰"的另一半来源
     * （另一半是路面的几何尖塔，见上面的渐变）。
     * 0.035 米不是现实里的车道线宽度（真实是 0.10~0.15 米），
     * 而是**从改动前的近端观感反推**的：2.2px ÷ 62.4px/m ≈ 0.035 米。
     * 用户报的是远处，就别顺手把近处也改了。 */
    var dashPeriod = 6, dashLen = 3.1;
    var off2 = scroll % dashPeriod;
    var bounds = [-CFG.roadWidth / 6, CFG.roadWidth / 6];
    for (var k = 0; k < bounds.length; k++) {
      for (var s = -off2; s < CFG.roadViewDepth; s += dashPeriod) {
        var y0 = Math.max(0.6, s), y1 = Math.min(CFG.roadViewDepth, s + dashLen);
        if (y1 - y0 < 0.5) continue;
        var dm = (y0 + y1) / 2;
        var dw = DASH.wM * pxPerMeter * (1 - road.tFromDepth(dm));
        if (dw < DASH.minW) continue;         // 细到亚像素，画了也只是糊成灰线
        var da = th.dashA * Math.exp(-dm / DASH.fogD);
        if (da < 0.006) continue;             // 已淡到看不见，省一次 stroke
        var p0 = road.project(bounds[k], y0).pos;
        var p1 = road.project(bounds[k], y1).pos;
        ctx.strokeStyle = 'rgba(' + th.dash + ',' + da.toFixed(3) + ')';
        ctx.lineWidth = dw;
        ctx.beginPath();
        ctx.moveTo(p0.x, p0.y);
        ctx.lineTo(p1.x, p1.y);
        ctx.stroke();
      }
    }

    drawCurb();
  }

  /* ══════════════════ 路沿 ══════════════════
   * 一条发光的边条，负责在暗路面上划出路界。
   *
   * ⚠️ 线宽必须是「世界量」，不能写成固定屏幕像素。
   *    第一版是 ctx.lineWidth = 3 + 8px 辉光，从近端一路 stroke 到消失点。
   *    问题在于路宽是按 (1−t) 收缩到 0 的，而线宽固定 ——
   *    「路沿宽 ÷ 路宽」这个比值于是随距离失控：
   *    22 米处 1.2%、193 米处 10.1%、414 米处 23.1%（实测数据见 dev/curbdiag.js），
   *    屏幕上就是「远处的路沿比整条路还宽」。
   *
   *    而且 alpha 恒定 0.5：远处路面已经暗到 rgb(31,32,36)，路沿照旧，
   *    明暗差反而从 62 涨到 80 个亮度级 —— 所以还「又亮」。
   *
   *    改成 wM（米）之后，「路沿宽 ÷ 路宽」恒等于 wM ÷ roadWidth = 1.2%，
   *    与深度无关，也与屏幕宽度无关（和景物、妖物一样，宽度天然跟着透视走）。
   *
   * ⚠️ 必须用「米」，连「3px」这种看着人畜无害的固定值也不行：
   *    它只是**碰巧**在 480px 宽的窗口里比例对；换成 1920px 的桌面全屏，
   *    同样的 3px 相对路宽只剩 0.3%，路沿会淡到看不见 —— 那是另一个 bug。
   *
   *    宽度掉到 minW 以下直接不画 —— 路沿在 260 米开外自然消失，
   *    而不是糊成一条亚像素灰线。
   *
   * ⚠️ 明度同理，走的是景物同一套空气透视：exp(−depth/fogD)。
   *    近端 alpha 与改动前一致（0.55 ≈ 原来的 0.5），近处观感刻意不动 ——
   *    用户报的是「远处」，就别顺手把没问题的地方也改了。
   */
  var CURB = {
    wM: 0.048,      // 路沿宽度（米）—— 4.8 厘米，现实里一条路缘石的量级
    glowK: 2.67,    // 辉光宽度 = 实边 × 该倍率（即改动前的 8px ÷ 3px）
    minW: 0.45,     // 细于此就不再绘制（亚像素只会糊成灰线）
    fogD: 110,      // 空气透视特征距离（米）
    segs: 36
  };

  /* 分隔虚线的几何，与路沿同一套做法：宽度用「米」跟着透视收缩，明度随距离指数衰减。
   * 两者分开定义（而不是共用一张表）是因为"多细算看不见"的量级不同：
   * 路沿是连续的发光细线，虚线是断续的白色短段。 */
  var DASH = {
    wM: 0.035,      // 宽度（米）—— 见 drawRoad 里解释为什么不是真实的 0.12
    minW: 0.40,     // 细于此不再绘制（亚像素只会糊成灰线）
    fogD: 110       // 空气透视特征距离（米），与路沿取同一个值
  };
  /* 颜色与不透明度走地图主题（夜/昼/沙漠的路沿不该是同一个色、同一个亮度）；
   * 宽度、分段数、衰减距离走上面这张几何表 —— 它们跟光照无关，跨地图不该变。
   * 近端不透明度：夜 0.55（与抽主题前完全一致，测试 J 钉着这个数），白天更淡。 */

  /* 路沿几何：枚举与绘制分离（和 sceneItems 一个路子）。
   * 自动化测试可以直接拿到每段的宽度/透明度来断言比值恒定，
   * 不必去解码像素、也不必去数 stroke 调用次数。
   * 返回每段：{ a0,a1,b0,b1（左右两条边的起止点）, w, roadW, alpha, depth } */
  function curbSegments() {
    var th = theme();
    var out = [];
    var tEnd = 0.995;                      // 与路面主体的远端一致，长度不会对不上
    for (var i = 0; i < CURB.segs; i++) {
      var t0 = (tEnd * i) / CURB.segs;
      var t1 = (tEnd * (i + 1)) / CURB.segs;
      var tm = (t0 + t1) / 2;
      /* 宽度 = 世界宽度 × 该深度处的横向像素密度。
       * pxPerMeter 是深度 0 处的密度，乘 (1−t) 就落到当前深度 ——
       * 和 roadWidth 走的是同一个缩放，所以两者的比值恒定。 */
      var w = CURB.wM * pxPerMeter * (1 - tm);
      if (w < CURB.minW) break;            // 太细就别画了：远处路沿本来就该看不见
      var c0 = road.crossSectionAtT(t0), c1 = road.crossSectionAtT(t1);
      var depth = road.depthFromT(tm);
      out.push({
        a0: c0.a, a1: c1.a, b0: c0.b, b1: c1.b,
        w: w, roadW: (c0.width + c1.width) / 2,
        alpha: th.curbA * Math.exp(-depth / CURB.fogD),
        depth: depth
      });
    }
    return out;
  }

  /* 辉光层的宽度与不透明度都从主层按比例推出 ——
   * 上一版辉光是写死的 8px，远端比主线（3px）还宽，
   * 等于给「远处路沿又粗又亮」又加了一层。两处写死必然走样，这里只写一处。
   * 比例在每次绘制时现算：换地图会同时改 curbA 与 curbGlowA，
   * 提前算好常量的话，切到白天就成了"用夜景的比例画白天的辉光"。 */
  function curbLayers() {
    var th = theme();
    return [
      { k: 1, ak: 1 },                                      // 实边
      { k: CURB.glowK, ak: th.curbGlowA / th.curbA }        // 辉光
    ];
  }

  function drawCurb() {
    var th = theme();
    var segs = curbSegments();
    var layers = curbLayers();
    for (var L = 0; L < layers.length; L++) {
      var k = layers[L].k, ak = layers[L].ak;
      for (var i = 0; i < segs.length; i++) {
        var s = segs[i];
        var a = s.alpha * ak;
        if (a < 0.004) continue;              // 已经淡到看不见，别再花一次 stroke
        ctx.strokeStyle = 'rgba(' + th.curb + ',' + a.toFixed(3) + ')';
        ctx.lineWidth = s.w * k;
        ctx.beginPath();
        ctx.moveTo(s.a0.x, s.a0.y); ctx.lineTo(s.a1.x, s.a1.y);
        ctx.moveTo(s.b0.x, s.b0.y); ctx.lineTo(s.b1.x, s.b1.y);
        ctx.stroke();
      }
    }
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
    var th = theme();
    var hy = road.vanish.y;          // 地平线 = 路面消失点所在高度
    var scroll = currentScroll();

    // ① 铺地：地平线以下全部填成"地"。近处压暗、远处提亮 ——
    //    反过来做（近亮远暗）会立刻失去纵深。
    var gg = ctx.createLinearGradient(0, hy, 0, H);
    for (var gi = 0; gi < GROUND_STOPS.length; gi++) {
      gg.addColorStop(GROUND_STOPS[gi], th.ground[gi]);
    }
    ctx.fillStyle = gg;
    ctx.fillRect(0, hy, W, H - hy);

    // ② 远山：两层剪影，远层淡、近层深，靠视差速度把两层分开
    drawRidge(hy - 2, 46, 0.30, th.ridge[0], scroll, 0.6);
    drawRidge(hy + 5, 26, 1.05, th.ridge[1], scroll, 2.1);

    // ②b 远树线：高频小振幅 → 锯齿状树冠剪影。
    //     专门填"地平线到中景"那条带 —— 那条带对应 200 米开外，
    //     靠 belt 铺过去要几百个物件，用一条程序化锯齿几乎不花钱。
    drawTreeLine(hy + 16, 12, 2.4, th.treeLine[0], scroll);
    drawTreeLine(hy + 24, 7, 3.4, th.treeLine[1], scroll);

    /* ③ 地平线雾带**不在这里画** —— 见 drawAir()。
     *    它曾经就长在这一段下面，于是只洗到了天、山、树线和地面：
     *    路面、路肩、景物全在它之后画，等于"这些玩意儿不受大气影响"。
     *    后果是同一片远景里，地面被雾提亮、路面还是原来的暗色，
     *    路的远端于是凸出来变成一座插在天际线上的暗色尖塔（实测比周围地面暗 17 级亮度）。
     *    空气透视必须**作用于所有远景元素**，所以它得排在它们后面。 */
  }

  /* 空气透视层：一层贴着地平线的雾，向上向下都渐隐到 0。
   *
   * 为什么必须画在路面与景物**之后**：大气是一个"覆盖在整幅远景之上"的介质，
   * 不是背景的一部分。谁在它之后画，谁就免于被大气衰减 —— 而真实世界里没有东西免得了。
   *
   * 两端都必须收边到 0：只在一端收的话屏幕上会出现一道横向硬边，非常显眼
   * （第一版只收一边，踩过）。
   *
   * ⚠ 改这里必须同步改 renderMapThumb() —— 商城的缩略图走的是同一套绘制函数，
   *   漏掉一处就会出现"预览和实机不一样"，而那种不一致最难被发现。
   */
  function drawAir() {
    if (!road) return;
    var th = theme();
    var hy = road.vanish.y;
    var top = hy - H * 0.20, bot = hy + H * 0.12;
    var hz = ctx.createLinearGradient(0, top, 0, bot);
    hz.addColorStop(0, th.haze[0]);
    hz.addColorStop(0.50, th.haze[1]);
    hz.addColorStop(0.625, th.haze[2]);   // 0.625 ≈ 地平线所在位置
    hz.addColorStop(1, th.haze[3]);
    ctx.fillStyle = hz;
    var y0 = Math.max(0, top);
    ctx.fillRect(0, y0, W, bot - y0);
  }

  /* 一条山脊剪影。用 W、W/2、W/3… 为周期的正弦叠加 → 天然以屏宽为周期，
   * 视差偏移再多也不会出现接缝。 */
  function drawRidge(baseY, amp, par, color, scroll, phase) {
    var off = scroll * par;
    var bottom = road.vanish.y + 8;
    var g = silhouetteFill(color, baseY - amp, bottom);
    ctx.fillStyle = g;
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

  /* 剪影的填充：主体是纯剪影色，**底边渐隐到地平线处的地面色**。
   *
   * 为什么必须渐隐：剪影的底边是一条水平直线。剪影色和地面色差得远时
   * （沙漠图的远树线比沙地暗一百多级亮度），那条边就成了横贯屏幕的一道硬边，
   * 看起来像"远处盖了块板子"。真实世界里的远景剪影是"从地面上长出来"的，
   * 交界处被大气抹平 —— 这就是那层大气。 */
  function silhouetteFill(color, top, bottom) {
    var g = ctx.createLinearGradient(0, top, 0, bottom);
    g.addColorStop(0, color);
    g.addColorStop(0.65, color);
    g.addColorStop(1, theme().ground[0]);
    return g;
  }

  /* 远树线：用 |sin| 叠出来的锯齿状剪影。
   * |sin| 的波峰是圆的、波谷是尖的，正好像一排树冠；
   * 频率取 W 的整数分频（×26、×47）保证以屏宽为周期，视差偏移不会出现接缝。 */
  function drawTreeLine(baseY, amp, par, color, scroll) {
    var off = scroll * par;
    ctx.fillStyle = silhouetteFill(color, baseY - amp, baseY + 4);
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
   * 没有它，路面像浮在虚空里的一个楔子；有了它，"路是修在地面上的"才成立。
   *
   * 远端必须淡出（而不是一路不透明画到 168 米）：它和路面一样受大气影响，
   * 硬生生结束的话会在屏幕上留下一条横贯的直边 —— 而且那条边恰好落在
   * 空气透视最该浓的地方，看着像"路肩上盖了块板子"。
   * 淡出到透明就行了：它下面是已经画好的地面，自然露出来。 */
  function drawVerge() {
    var dx = 0.9;
    var th = theme();
    for (var side = -1; side <= 1; side += 2) {
      var i0 = road.project(side * CFG.roadWidth / 2, 0).pos;
      var iF = road.project(side * CFG.roadWidth / 2, 168).pos;
      var oF = road.project(side * (CFG.roadWidth / 2 + dx), 168).pos;
      var o0 = road.project(side * (CFG.roadWidth / 2 + dx), 0).pos;
      var vg = ctx.createLinearGradient(0, i0.y, 0, iF.y);
      vg.addColorStop(0, 'rgba(' + th.verge + ',1)');
      vg.addColorStop(0.35, 'rgba(' + th.verge + ',0.82)');
      vg.addColorStop(0.70, 'rgba(' + th.verge + ',0.34)');
      vg.addColorStop(1, 'rgba(' + th.verge + ',0)');
      ctx.fillStyle = vg;
      ctx.beginPath();
      ctx.moveTo(i0.x, i0.y);
      ctx.lineTo(iF.x, iF.y);
      ctx.lineTo(oF.x, oF.y);
      ctx.lineTo(o0.x, o0.y);
      ctx.closePath();
      ctx.fill();
    }
  }

  /* 把"当前视野里有哪些景物"单独拆出来。
   * drawScenery 只负责画，枚举逻辑不碰 canvas —— 自动化测试于是可以直接清点
   * （数量、横向位置、雾值），不必去解码像素。
   *
   * mapKey 可选：传了就按那张地图的景物种类与雾参数枚举。
   * 商城要给三张地图各画一张缩略图，测试要校验"每张地图都不许把物件怼到路面上"，
   * 两者都需要"按地图枚举"，而不是只能枚举当前装备的那张。 */
  function sceneItems(scroll, emit, mapKey) {
    var th = mapOf(mapKey || profile.map).th;
    var belts = beltsFor(mapKey || profile.map);
    for (var row = 0; row < belts.length; row++) {
      var b = belts[row];
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
          var alpha = th.fogMin + (1 - th.fogMin) * Math.exp(-y3d / th.fogD);
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
   * 也是整幅夜景里唯一的暖色，冷blue调里必须有点暖的当锚点。
   * 白天的地图里它只是"没点灯的石头灯笼"：几何一行没改，只把
   * 灯芯/辉光/光池的色值换成了全透明（见 BASE_THEME.lamp）。 */
  function drawLanterns(scroll) {
    var th = theme();
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
          Math.max(0.24, th.fogMin + (1 - th.fogMin) * Math.exp(-y3d / (th.fogD * 2.2))), th);
      }
    }
  }

  function propLantern(bx, by, u, a, th) {
    var h = 2.15 * u, w = h * 0.30;

    /* 地面光池：叠加混合，会顺带照亮路面 —— 冷暖对比的关键。
     * u < 7 说明这盏灯在 200 米开外，光池已经小到看不见了，
     * 直接跳过：那是纯浪费的逐像素填充（DPR 2 下占了装饰开销的大头）。
     * 白天 poolA = 0，这一整段直接不执行 —— 顺手也省掉了白天最大的那笔填充。 */
    if (u >= 7 && th.lamp.poolA > 0) {
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = th.lamp.poolA * a;
      var rr = u * 1.5;
      var g = ctx.createRadialGradient(bx, by, 0, bx, by, rr);
      g.addColorStop(0, th.lamp.glow[0]);
      g.addColorStop(0.45, th.lamp.glow[1]);
      g.addColorStop(1, th.lamp.glow[2]);
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.ellipse(bx, by, rr, rr * 0.40, 0, 0, 6.283);
      ctx.fill();
      ctx.restore();
    }

    // 灯身
    ctx.globalAlpha = a;
    ctx.fillStyle = th.lamp.pole;
    ctx.fillRect(bx - u * 0.05, by - h * 0.30, u * 0.10, h * 0.30);
    ctx.fillRect(bx - u * 0.15, by - h * 0.02, u * 0.30, h * 0.05);
    ctx.fillStyle = th.lamp.body;
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
    lg.addColorStop(0, th.lamp.light[0]);
    lg.addColorStop(0.35, th.lamp.light[1]);
    lg.addColorStop(1, th.lamp.light[2]);
    ctx.fillStyle = lg;
    ctx.beginPath();
    ctx.arc(bx, ly, u * 0.52, 0, 6.283);
    ctx.fill();
    ctx.fillStyle = th.lamp.core;
    ctx.fillRect(bx - w * 0.22, ly - h * 0.085, w * 0.44, h * 0.17);
    ctx.restore();
    ctx.globalAlpha = 1;
  }

  /* 萤火：既是气氛，也是深度线索 —— 不同高度的萤火按各自深度做视差，
   * 眼睛会下意识读出"这是立体的"。
   * 数量与色值走主题：白天的地图 flies = 0（白天点萤火是穿帮），
   * 沙漠换成暖色浮尘 —— 换的只是数据，这段代码一行没变。 */
  function drawFireflies(scroll) {
    var th = theme();
    if (th.flies <= 0) return;
    var span = 120;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (var i = 0; i < th.flies; i++) {
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
      g.addColorStop(0, 'rgba(' + th.fly.a + ',' + (0.55 * a).toFixed(3) + ')');
      g.addColorStop(0.35, 'rgba(' + th.fly.b + ',' + (0.22 * a).toFixed(3) + ')');
      g.addColorStop(1, 'rgba(' + th.fly.c + ',0)');
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
   * r 是稳定伪随机序列（同一槽位每次重开都一样）。
   * 颜色一律走 theme().P —— 同一段形状在三张地图上长成三种植物/石头，
   * 靠的是换色 + 换种类（MAPS 里的 kinds），不是复制三份绘制代码。 */
  var PROPS = {
    /* 草簇：最便宜、密度最高，负责把路肩"长满" */
    grass: function (bx, by, u, r) {
      var n = 4 + Math.floor(r() * 3), h = (0.26 + r() * 0.22) * u;
      ctx.strokeStyle = theme().P.grass;
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
      var th = theme().P;
      var w = (0.55 + r() * 0.45) * u, h = w * 0.72;
      ctx.fillStyle = th.bush;
      ctx.beginPath();
      ctx.ellipse(bx, by - h * 0.48, w * 0.5, h * 0.5, 0, 0, 6.283);
      ctx.fill();
      ctx.fillStyle = th.bushTop;
      ctx.beginPath();
      ctx.ellipse(bx - w * 0.15, by - h * 0.62, w * 0.33, h * 0.34, 0, 0, 6.283);
      ctx.fill();
    },

    rock: function (bx, by, u, r) {
      var th = theme().P;
      var w = (0.55 + r() * 0.85) * u, h = w * (0.5 + r() * 0.35);
      ctx.fillStyle = th.rock;
      ctx.beginPath();
      ctx.moveTo(bx - w * 0.5, by);
      ctx.lineTo(bx - w * 0.36, by - h * 0.72);
      ctx.lineTo(bx - w * 0.02, by - h);
      ctx.lineTo(bx + w * 0.34, by - h * 0.66);
      ctx.lineTo(bx + w * 0.5, by);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = th.rockTop;                // 受光的顶面
      ctx.beginPath();
      ctx.moveTo(bx - w * 0.36, by - h * 0.72);
      ctx.lineTo(bx - w * 0.02, by - h);
      ctx.lineTo(bx + w * 0.34, by - h * 0.66);
      ctx.lineTo(bx, by - h * 0.48);
      ctx.closePath();
      ctx.fill();
    },

    bamboo: function (bx, by, u, r) {
      var th = theme().P;
      var n = 3 + Math.floor(r() * 3), H0 = (3.0 + r() * 1.8) * u;
      for (var i = 0; i < n; i++) {
        var x = bx + (i - (n - 1) / 2) * u * 0.15 + (r() - 0.5) * u * 0.06;
        var h = H0 * (0.68 + r() * 0.46);
        var lean = (r() - 0.5) * 0.5;
        var tipX = x + lean * u * 0.55;
        ctx.strokeStyle = i % 2 ? th.stalkA : th.stalkB;
        ctx.lineWidth = Math.max(1, u * 0.055);
        ctx.beginPath();
        ctx.moveTo(x, by);
        ctx.quadraticCurveTo(x + lean * u * 0.18, by - h * 0.55, tipX, by - h);
        ctx.stroke();
        ctx.strokeStyle = th.leafC;               // 竹叶
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
      var th = theme().P;
      var h = (4.2 + r() * 3.2) * u, w = h * (0.32 + r() * 0.09);
      ctx.fillStyle = th.trunk;
      ctx.fillRect(bx - h * 0.022, by - h * 0.34, h * 0.044, h * 0.34);
      var tiers = 3 + Math.floor(r() * 2);
      for (var i = 0; i < tiers; i++) {
        var t0 = 0.22 + (i / tiers) * 0.60;
        var cw = w * (1 - i / (tiers + 0.5));
        var yb = by - h * t0, yt = by - h * (t0 + 0.46);
        ctx.fillStyle = i === 0 ? th.pineA : th.pineB;
        ctx.beginPath();
        ctx.moveTo(bx, yt);
        ctx.lineTo(bx + cw * 0.5, yb);
        ctx.lineTo(bx - cw * 0.5, yb);
        ctx.closePath();
        ctx.fill();
      }
      // 顶端一道冷色受光边 —— 深色剪影里没有它就会糊成一团
      var ytp = by - h * (0.22 + 0.60 + 0.46);
      ctx.strokeStyle = th.edge;
      ctx.lineWidth = Math.max(1, u * 0.03);
      ctx.beginPath();
      ctx.moveTo(bx - w * 0.5 * (1 - (tiers - 1) / (tiers + 0.5)) * 0.5, ytp + h * 0.46);
      ctx.lineTo(bx, ytp);
      ctx.stroke();
    },

    broadleaf: function (bx, by, u, r) {
      var th = theme().P;
      var h = (3.4 + r() * 2.2) * u;
      var cw = h * (0.56 + r() * 0.18), ch = h * 0.56;
      ctx.fillStyle = th.trunk;
      ctx.fillRect(bx - h * 0.026, by - h * 0.44, h * 0.052, h * 0.44);
      var cx = bx + (r() - 0.5) * h * 0.08;
      ctx.fillStyle = th.leafA;
      treeBlob(cx, by - h * 0.68, cw * 0.50, ch * 0.50, 12, 0.13, r);
      ctx.fillStyle = th.leafB;
      treeBlob(cx - cw * 0.15, by - h * 0.79, cw * 0.31, ch * 0.30, 9, 0.20, r);
      treeBlob(cx + cw * 0.19, by - h * 0.70, cw * 0.26, ch * 0.26, 9, 0.20, r);
    },

    /* 幡旗：布面随时间轻摆，给静止的夜色加一点"风" */
    banner: function (bx, by, u, r) {
      var th = theme().P;
      var h = (2.7 + r() * 1.2) * u;
      ctx.strokeStyle = th.pole;
      ctx.lineWidth = Math.max(1, u * 0.045);
      ctx.beginPath();
      ctx.moveTo(bx, by);
      ctx.lineTo(bx, by - h);
      ctx.stroke();
      var wob = Math.sin(animT * 1.6 + bx * 0.02 + r() * 6.283) * u * 0.06;
      var w = u * 0.44, top = by - h * 0.96, bot = by - h * 0.46;
      ctx.fillStyle = th.cloth;
      ctx.beginPath();
      ctx.moveTo(bx, top);
      ctx.lineTo(bx + w, top);
      ctx.quadraticCurveTo(bx + w * 0.66 + wob, (top + bot) / 2, bx + w, bot);
      ctx.lineTo(bx, bot);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = th.emblem;
      ctx.beginPath();
      ctx.arc(bx + w * 0.44, (top + bot) / 2, u * 0.10, 0, 6.283);
      ctx.fill();
    },

    /* 茅屋／客栈：墙和屋顶都要比地面亮，否则只剩两扇暖窗浮在暗处，看不出是房子 */
    hut: function (bx, by, u, r) {
      var th = theme().P;
      var w = (2.8 + r() * 1.5) * u, h = w * 0.40, roof = w * 0.30;
      ctx.fillStyle = th.wall;
      ctx.fillRect(bx - w / 2, by - h, w, h);
      ctx.fillStyle = th.roof;
      ctx.beginPath();
      ctx.moveTo(bx - w * 0.62, by - h);
      ctx.lineTo(bx, by - h - roof);
      ctx.lineTo(bx + w * 0.62, by - h);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = th.window;
      ctx.fillRect(bx - w * 0.31, by - h * 0.70, w * 0.17, h * 0.32);
      ctx.fillRect(bx + w * 0.12, by - h * 0.70, w * 0.17, h * 0.32);
      ctx.fillStyle = th.eave;                  // 檐下阴影：给屋顶一点厚度
      ctx.fillRect(bx - w * 0.62, by - h, w * 1.24, h * 0.07);
    },

    gate: function (bx, by, u, r) {
      var th = theme().P;
      var h = (4.2 + r() * 1.8) * u, w = h * 0.74;
      ctx.fillStyle = th.stone;
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
      var th = theme().P;
      var h = (7 + r() * 6) * u, w = h * 0.34;
      ctx.fillStyle = th.tower;
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
    },

    /* ---------- 以下五种是沙漠地图专用 ----------
     * 每种都必须同时给出"最坏横向半宽"（写在 dev/e2e-test.js 的 halfWidth 表里）——
     * 漏写的话测试按 0 算，物件就能悄悄怼到路面上而不报错。 */

    /* 柱状仙人掌：主干 + 两条上举的臂 */
    cactus: function (bx, by, u, r) {
      var th = theme().P;
      var h = (2.4 + r() * 2.0) * u, w = u * 0.42;
      /* 极远处（整株只剩几个像素高）：只留一根实心短柱就收工。
       * 那时候主干本身才一两像素宽，两条臂会退化成更细的线，
       * 整条远景带看着像一片飘着的噪点 —— 少画两笔反而更像"远处的仙人掌"。 */
      if (h < 4) {
        ctx.fillStyle = th.cactus;
        ctx.fillRect(bx - 0.75, by - h, 1.5, Math.max(1, h));
        return;
      }
      ctx.fillStyle = th.cactus;
      ctx.fillRect(bx - w * 0.5, by - h, w, h);
      var armH = h * 0.42, armW = w * 0.62;
      var ay1 = by - h * 0.62, ay2 = by - h * 0.44;
      ctx.fillRect(bx - w * 0.5 - u * 0.26, ay1 - armH, armW, armH);
      ctx.fillRect(bx - w * 0.5 - u * 0.26, ay1 - armH, u * 0.26, u * 0.09);
      ctx.fillRect(bx + w * 0.5, ay2 - armH * 0.86, armW, armH * 0.86);
      ctx.fillRect(bx + w * 0.5 + u * 0.26 - u * 0.09, ay2 - armH * 0.86, u * 0.26, u * 0.09);
      ctx.fillStyle = th.cactusDark;            // 背光的一侧
      ctx.fillRect(bx - w * 0.5, by - h, w * 0.34, h);
      /* 顶上一朵花：落日下最跳的一点色，也是"这是仙人掌、不是一根柱子"的提示。
       * 用位置派生而不是 r() —— PROPS 的 r 是共享的随机序列，多调一次会让
       * 后面所有物件的随机值整体错位，固定种子的截图对照就全废了。 */
      if (Math.abs(bx * 0.013) % 1 < 0.55) {
        ctx.fillStyle = th.cactusFlower;
        ctx.beginPath();
        ctx.arc(bx, by - h - u * 0.07, u * 0.12, 0, 6.283);
        ctx.fill();
      }
    },

    /* 团扇仙人掌：贴路带的矮丛，几片扁掌叠着长。
     * 它顶替的是原来第一带里的 grass —— 沙漠里那丛"绿草"是最出戏的一处。 */
    cactusClump: function (bx, by, u, r) {
      var th = theme().P;
      var n = 3 + Math.floor(r() * 3);
      /* 宽度受"最坏横向半宽 0.86 米"约束（第一带 minX=2.72，路面半宽 2.0，
       * 探入上限 0.30）—— 长得再大就得挪出贴路带，不能再往路边挤。 */
      var w0 = (0.52 + r() * 0.22) * u;
      for (var i = 0; i < n; i++) {
        var dx = (i - (n - 1) / 2) * w0 * 0.36 + (r() - 0.5) * w0 * 0.16;
        var hh = w0 * (0.72 + r() * 0.5), ww = w0 * (0.52 + r() * 0.20);
        ctx.fillStyle = i % 2 ? th.cactusClump : th.cactusClumpTop;
        ctx.beginPath();
        ctx.ellipse(bx + dx, by - hh * 0.52, ww * 0.5, hh * 0.5, 0, 0, 6.283);
        ctx.fill();
      }
    },

    /* 丝兰：一丛剑状硬叶。沙漠里的"草"就该长这样 —— 细、尖、发灰，
     * 而不是阔叶草那一撮软绿。 */
    yucca: function (bx, by, u, r) {
      var th = theme().P;
      var n = 7 + Math.floor(r() * 4), H = (0.62 + r() * 0.52) * u;
      ctx.lineWidth = Math.max(1, u * 0.055);
      ctx.lineCap = 'round';
      for (var i = 0; i < n; i++) {
        var t = (i / (n - 1) - 0.5) * 2, hh = H * (0.62 + r() * 0.5);
        ctx.strokeStyle = i % 2 ? th.yucca : th.yuccaDark;
        ctx.beginPath();
        ctx.moveTo(bx, by);
        ctx.quadraticCurveTo(bx + t * u * 0.12, by - hh * 0.70, bx + t * u * 0.42, by - hh);
        ctx.stroke();
      }
    },

    /* 枯木丛：干裂的放射枝条，替掉沙漠里同样不该有的那丛浑圆绿灌木 */
    deadbush: function (bx, by, u, r) {
      var th = theme().P;
      var n = 6 + Math.floor(r() * 5), H = (0.45 + r() * 0.38) * u;
      ctx.lineWidth = Math.max(1, u * 0.042);
      ctx.lineCap = 'round';
      for (var i = 0; i < n; i++) {
        var t = (i / (n - 1) - 0.5) * 2, hh = H * (0.50 + r() * 0.60);
        ctx.strokeStyle = i % 2 ? th.deadbush : th.deadbushTop;
        ctx.beginPath();
        ctx.moveTo(bx, by);
        ctx.quadraticCurveTo(bx + t * u * 0.14, by - hh * 0.75, bx + t * u * 0.38, by - hh);
        ctx.stroke();
      }
    },

    /* 小沙丘（贴路带用）：只留一道弧 */
    dune: function (bx, by, u, r) {
      var th = theme().P;
      var w = (0.9 + r() * 0.5) * u, h = w * (0.16 + r() * 0.10);
      ctx.fillStyle = th.dune;
      ctx.beginPath();
      ctx.ellipse(bx, by, w * 0.5, h, 0, Math.PI, 0);
      ctx.fill();
      ctx.fillStyle = th.duneTop;               // 迎风坡的亮面
      ctx.beginPath();
      ctx.ellipse(bx + w * 0.12, by, w * 0.26, h * 0.62, 0, Math.PI, 0);
      ctx.fill();
    },

    /* 大台地（中/远景带）：平顶的岩台，沙漠天际线的骨架 */
    mesa: function (bx, by, u, r) {
      var th = theme().P;
      var w = (3.0 + r() * 1.6) * u, h = w * (0.42 + r() * 0.26);
      ctx.fillStyle = th.mesa;
      ctx.beginPath();
      ctx.moveTo(bx - w * 0.5, by);
      ctx.lineTo(bx - w * 0.34, by - h);
      ctx.lineTo(bx + w * 0.30, by - h);
      ctx.lineTo(bx + w * 0.5, by);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = th.mesaTop;               // 落日在顶面留下的亮边
      ctx.beginPath();
      ctx.moveTo(bx - w * 0.34, by - h);
      ctx.lineTo(bx + w * 0.30, by - h);
      ctx.lineTo(bx + w * 0.24, by - h * 0.88);
      ctx.lineTo(bx - w * 0.28, by - h * 0.88);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = th.ruinTop;               // 背光面
      ctx.beginPath();
      ctx.moveTo(bx + w * 0.10, by - h);
      ctx.lineTo(bx + w * 0.30, by - h);
      ctx.lineTo(bx + w * 0.5, by);
      ctx.lineTo(bx + w * 0.26, by);
      ctx.closePath();
      ctx.fill();
    },

    /* 断柱：商道废墟 */
    ruin: function (bx, by, u, r) {
      var th = theme().P;
      var w = (0.66 + r() * 0.30) * u, h = (1.5 + r() * 1.5) * u;
      ctx.fillStyle = th.ruin;
      ctx.fillRect(bx - w * 0.5, by - h, w, h);
      ctx.fillStyle = th.ruinTop;
      ctx.fillRect(bx - w * 0.5, by - h, w, h * 0.10);
      ctx.beginPath();                           // 断口：斜切一角
      ctx.moveTo(bx + w * 0.5, by - h);
      ctx.lineTo(bx + w * 0.5, by - h * 0.72);
      ctx.lineTo(bx + w * 0.16, by - h);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = th.ruinTop;                 // 脚下的碎块
      ctx.fillRect(bx - w * 0.86, by - h * 0.16, w * 0.5, h * 0.16);
    },

    /* 帐篷：商队的三角帐 */
    tent: function (bx, by, u, r) {
      var th = theme().P;
      var w = (2.2 + r() * 0.8) * u, h = w * 0.62;
      ctx.fillStyle = th.tent;
      ctx.beginPath();
      ctx.moveTo(bx - w * 0.5, by);
      ctx.lineTo(bx + w * 0.02, by - h);
      ctx.lineTo(bx + w * 0.5, by);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = th.tentDark;               // 门洞
      ctx.beginPath();
      ctx.moveTo(bx - w * 0.10, by);
      ctx.lineTo(bx + w * 0.02, by - h * 0.52);
      ctx.lineTo(bx + w * 0.16, by);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = th.pole;                 // 支杆
      ctx.lineWidth = Math.max(1, u * 0.035);
      ctx.beginPath();
      ctx.moveTo(bx + w * 0.02, by - h);
      ctx.lineTo(bx + w * 0.02, by - h * 1.16);
      ctx.stroke();
    },

    /* 棕榈：弯干 + 六片叶 */
    palm: function (bx, by, u, r) {
      var th = theme().P;
      var h = (3.6 + r() * 2.2) * u;
      var lean = (r() - 0.5) * 0.6;
      var tipX = bx + lean * h * 0.28, tipY = by - h;
      ctx.strokeStyle = th.trunk;
      ctx.lineWidth = Math.max(1.5, u * 0.16);
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(bx, by);
      ctx.quadraticCurveTo(bx + lean * h * 0.06, by - h * 0.6, tipX, tipY);
      ctx.stroke();
      var n = 6, frond = (0.85 + r() * 0.35) * u;
      for (var i = 0; i < n; i++) {
        var a = Math.PI + (i / (n - 1)) * Math.PI;          // 从左侧扫到右侧
        var ex = tipX + Math.cos(a) * frond * 1.25;
        var ey = tipY + Math.sin(a) * frond * 0.75 + frond * 0.42;
        ctx.strokeStyle = i % 2 ? th.palmLeaf : th.palmLeaf2;
        ctx.lineWidth = Math.max(1, u * 0.075);
        ctx.beginPath();
        ctx.moveTo(tipX, tipY);
        ctx.quadraticCurveTo((tipX + ex) / 2, Math.min(tipY, ey) - frond * 0.30, ex, ey);
        ctx.stroke();
      }
    },

    /* 方尖碑：远景带的地标 */
    obelisk: function (bx, by, u, r) {
      var th = theme().P;
      var h = (4.0 + r() * 2.4) * u, w = h * 0.13;
      ctx.fillStyle = th.ruin;
      ctx.beginPath();
      ctx.moveTo(bx - w * 0.5, by);
      ctx.lineTo(bx - w * 0.34, by - h);
      ctx.lineTo(bx, by - h * 1.10);
      ctx.lineTo(bx + w * 0.34, by - h);
      ctx.lineTo(bx + w * 0.5, by);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = th.ruinTop;
      ctx.beginPath();
      ctx.moveTo(bx - w * 0.12, by - h);
      ctx.lineTo(bx, by - h * 1.10);
      ctx.lineTo(bx + w * 0.34, by - h);
      ctx.lineTo(bx + w * 0.12, by);
      ctx.closePath();
      ctx.fill();
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
    ctx.fillStyle = 'rgba(0,0,0,' + theme().shadow + ')';
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

  /* ══════════════════ 人物形象（皮肤 × 性别） ══════════════════
   * drawFigure 是**唯一**画人的地方：游戏里画、商城立绘也画，用的是同一段代码。
   * 这样"商城里看到长什么样，进游戏就是什么样"是结构性成立的，不靠两张图对齐。
   *
   * 几何基准就是改动前那套画法（身高 1.75 米、身宽 = 身高 × 0.34、四点多边形、
   * 头顶在 baseY − 0.84·h），所以"初始皮肤 + 男款"画出来的轮廓与改动前一致 ——
   * 皮肤数据里的 shK / hipK 都以它为 1.0。
   *
   * 男女款差在哪（用户的要求是"换性别不换皮肤"）：只差 shK（肩）/
   * hipK（下摆）/ hair / skirt 这几个体型参数，配色一律共用。
   * 也就是说斯巴达的男款女款都是青铜甲+赤缨，只是肩宽、发型、裙摆不同。
   */

  /* 头饰。c = 颜色，b = 底色（头发/头布用）。全部按 h 等比，远处自然缩小。 */
  function drawGear(kind, cx, hy, h, color, sk) {
    if (!kind) return;
    var r = h * 0.12;                      // 头半径（与 drawFigure 里一致）
    ctx.fillStyle = color;
    if (kind === 'plume') {
      /* 盔缨：一条从耳侧扫到头顶再垂下的弧 */
      ctx.beginPath();
      ctx.moveTo(cx - r * 1.15, hy + r * 0.15);
      ctx.quadraticCurveTo(cx + r * 0.2, hy - r * 3.0, cx + r * 0.95, hy + r * 0.2);
      ctx.quadraticCurveTo(cx + r * 0.2, hy - r * 1.9, cx - r * 1.15, hy + r * 0.35);
      ctx.closePath();
      ctx.fill();
    } else if (kind === 'turban') {
      /* 缠头：包住上半头，右侧拖一条尾巾 */
      ctx.beginPath();
      ctx.ellipse(cx, hy - r * 0.30, r * 1.20, r * 0.86, 0, Math.PI, 0);
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(cx + r * 0.9, hy - r * 0.5);
      ctx.lineTo(cx + r * 1.5, hy + r * 0.9);
      ctx.lineTo(cx + r * 1.0, hy + r * 0.7);
      ctx.closePath();
      ctx.fill();
    } else if (kind === 'nemes') {
      /* 埃及条纹头巾：两侧向下张成扇形的后垂布 */
      ctx.beginPath();
      ctx.moveTo(cx - r * 1.32, hy + r * 0.9);
      ctx.lineTo(cx - r * 1.05, hy - r * 1.0);
      ctx.lineTo(cx + r * 1.05, hy - r * 1.0);
      ctx.lineTo(cx + r * 1.32, hy + r * 0.9);
      ctx.lineTo(cx + r * 0.72, hy + r * 0.9);
      ctx.lineTo(cx + r * 0.72, hy - r * 0.35);
      ctx.lineTo(cx - r * 0.72, hy - r * 0.35);
      ctx.lineTo(cx - r * 0.72, hy + r * 0.9);
      ctx.closePath();
      ctx.fill();
    } else if (kind === 'kasa') {
      /* 斗笠：一个大圆锥，压得很低 */
      ctx.beginPath();
      ctx.moveTo(cx, hy - r * 1.9);
      ctx.lineTo(cx + r * 2.05, hy + r * 0.55);
      ctx.lineTo(cx - r * 2.05, hy + r * 0.55);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = 'rgba(0,0,0,0.22)';    // 帽檐下的阴影
      ctx.fillRect(cx - r * 2.05, hy + r * 0.34, r * 4.1, r * 0.22);
    } else if (kind === 'horn') {
      /* 角盔：半个圆盔 + 两只角 */
      ctx.beginPath();
      ctx.ellipse(cx, hy, r * 1.18, r * 1.05, 0, Math.PI, 0);
      ctx.fill();
      for (var s = -1; s <= 1; s += 2) {
        ctx.beginPath();
        ctx.moveTo(cx + s * r * 0.72, hy - r * 0.72);
        ctx.quadraticCurveTo(cx + s * r * 2.5, hy - r * 1.5, cx + s * r * 2.1, hy - r * 2.1);
        ctx.quadraticCurveTo(cx + s * r * 1.7, hy - r * 1.25, cx + s * r * 0.55, hy - r * 0.5);
        ctx.closePath();
        ctx.fill();
      }
    } else if (kind === 'band') {
      /* 发带：一条窄带 + 脑后两条飘带 */
      ctx.fillRect(cx - r * 1.06, hy - r * 0.55, r * 2.12, r * 0.30);
      for (var t = 0; t < 2; t++) {
        ctx.beginPath();
        ctx.moveTo(cx - r * 1.02, hy - r * 0.42);
        ctx.quadraticCurveTo(cx - r * 2.0, hy + r * 0.3 + t * r * 0.3,
          cx - r * 1.75, hy + r * 1.15 + t * r * 0.45);
        ctx.lineTo(cx - r * 1.35, hy + r * 0.95 + t * r * 0.45);
        ctx.quadraticCurveTo(cx - r * 1.5, hy + r * 0.3 + t * r * 0.3, cx - r * 0.78, hy - r * 0.4);
        ctx.closePath();
        ctx.fill();
      }
    }
  }

  /* 发型。头顶一律在 (cx, hy)，r = 头半径。 */
  function drawHair(style, cx, hy, h, color) {
    var r = h * 0.12;
    if (style === 'bald') return;
    ctx.fillStyle = color;
    if (style === 'short') {
      ctx.beginPath();
      ctx.ellipse(cx, hy - r * 0.16, r * 1.06, r * 0.92, 0, Math.PI, 0);
      ctx.fill();
    } else if (style === 'bun') {
      /* 束发：贴头皮的一层 + 顶上一个发髻（中式/浪人都用得上） */
      ctx.beginPath();
      ctx.ellipse(cx, hy - r * 0.10, r * 1.06, r * 0.94, 0, Math.PI, 0);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(cx, hy - r * 1.28, r * 0.46, 0, 6.283);
      ctx.fill();
    } else if (style === 'long') {
      /* 长发：头顶一层 + 两侧垂到肩下 */
      ctx.beginPath();
      ctx.ellipse(cx, hy - r * 0.10, r * 1.08, r * 0.96, 0, Math.PI, 0);
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(cx - r * 1.12, hy - r * 0.35);
      ctx.quadraticCurveTo(cx - r * 1.55, hy + r * 1.7, cx - r * 1.0, hy + r * 2.5);
      ctx.lineTo(cx - r * 0.55, hy + r * 2.4);
      ctx.quadraticCurveTo(cx - r * 0.95, hy + r * 1.3, cx - r * 0.72, hy - r * 0.3);
      ctx.closePath();
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(cx + r * 1.12, hy - r * 0.35);
      ctx.quadraticCurveTo(cx + r * 1.55, hy + r * 1.7, cx + r * 1.0, hy + r * 2.5);
      ctx.lineTo(cx + r * 0.55, hy + r * 2.4);
      ctx.quadraticCurveTo(cx + r * 0.95, hy + r * 1.3, cx + r * 0.72, hy - r * 0.3);
      ctx.closePath();
      ctx.fill();
    } else if (style === 'ponytail') {
      /* 马尾：头顶一层 + 脑后一条甩出去的高马尾 */
      ctx.beginPath();
      ctx.ellipse(cx, hy - r * 0.10, r * 1.06, r * 0.94, 0, Math.PI, 0);
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(cx - r * 0.95, hy - r * 0.55);
      ctx.quadraticCurveTo(cx - r * 2.6, hy - r * 0.2, cx - r * 2.35, hy + r * 1.6);
      ctx.lineTo(cx - r * 1.75, hy + r * 1.5);
      ctx.quadraticCurveTo(cx - r * 1.95, hy + r * 0.25, cx - r * 0.6, hy - r * 0.05);
      ctx.closePath();
      ctx.fill();
    }
  }

  /* 手上的家伙。全按 h 等比，anchor 在身体右侧。 */
  function drawWeapon(w, cx, baseY, h, wPx, lean) {
    if (!w) return;
    var kind = w.kind;
    ctx.strokeStyle = w.color;
    ctx.lineCap = 'round';
    if (kind === 'sword') {
      /* 与改动前逐字一致的一剑 */
      ctx.lineWidth = Math.max(1.5, h * 0.036);
      ctx.beginPath();
      ctx.moveTo(cx + wPx * 0.68, baseY - h * 0.12);
      ctx.lineTo(cx + wPx * 0.56 + lean * 0.8, baseY - h * 0.98);
      ctx.stroke();
    } else if (kind === 'spear') {
      ctx.lineWidth = Math.max(1.2, h * 0.022);
      ctx.beginPath();
      ctx.moveTo(cx + wPx * 0.70, baseY - h * 0.02);
      ctx.lineTo(cx + wPx * 0.62 + lean * 0.7, baseY - h * 1.42);
      ctx.stroke();
      ctx.fillStyle = w.color;               // 枪头
      ctx.beginPath();
      ctx.moveTo(cx + wPx * 0.62 + lean * 0.7, baseY - h * 1.66);
      ctx.lineTo(cx + wPx * 0.86 + lean * 0.7, baseY - h * 1.36);
      ctx.lineTo(cx + wPx * 0.40 + lean * 0.7, baseY - h * 1.38);
      ctx.closePath();
      ctx.fill();
    } else if (kind === 'scimitar') {
      ctx.lineWidth = Math.max(1.4, h * 0.032);
      ctx.beginPath();
      ctx.moveTo(cx + wPx * 0.60, baseY - h * 0.10);
      ctx.quadraticCurveTo(cx + wPx * 1.5, baseY - h * 0.55, cx + wPx * 1.05 + lean * 0.7, baseY - h * 1.16);
      ctx.stroke();
    } else if (kind === 'katana') {
      ctx.lineWidth = Math.max(1.4, h * 0.030);
      ctx.beginPath();
      ctx.moveTo(cx + wPx * 0.66, baseY - h * 0.14);
      ctx.quadraticCurveTo(cx + wPx * 1.0, baseY - h * 0.6, cx + wPx * 0.80 + lean * 0.7, baseY - h * 1.08);
      ctx.stroke();
    } else if (kind === 'axe') {
      ctx.lineWidth = Math.max(1.4, h * 0.028);
      ctx.beginPath();
      ctx.moveTo(cx + wPx * 0.66, baseY - h * 0.06);
      ctx.lineTo(cx + wPx * 0.58 + lean * 0.7, baseY - h * 1.02);
      ctx.stroke();
      ctx.fillStyle = w.color;               // 斧刃
      ctx.beginPath();
      ctx.moveTo(cx + wPx * 0.58 + lean * 0.7, baseY - h * 1.10);
      ctx.lineTo(cx + wPx * 1.42 + lean * 0.7, baseY - h * 1.00);
      ctx.lineTo(cx + wPx * 0.64 + lean * 0.7, baseY - h * 0.76);
      ctx.closePath();
      ctx.fill();
    } else if (kind === 'staff') {
      ctx.lineWidth = Math.max(1.2, h * 0.024);
      ctx.beginPath();
      ctx.moveTo(cx + wPx * 0.70, baseY - h * 0.02);
      ctx.lineTo(cx + wPx * 0.60 + lean * 0.7, baseY - h * 1.24);
      ctx.stroke();
      ctx.lineWidth = Math.max(1.1, h * 0.020);   // 杖头的环
      ctx.beginPath();
      ctx.arc(cx + wPx * 0.60 + lean * 0.7, baseY - h * 1.34, h * 0.072, 0, 6.283);
      ctx.stroke();
    } else if (kind === 'bow') {
      ctx.lineWidth = Math.max(1.3, h * 0.028);
      ctx.beginPath();                        // 弓臂（背在左肩）
      ctx.moveTo(cx - wPx * 0.85, baseY - h * 0.16);
      ctx.quadraticCurveTo(cx - wPx * 2.1, baseY - h * 0.62, cx - wPx * 0.85, baseY - h * 1.08);
      ctx.stroke();
      ctx.lineWidth = Math.max(1, h * 0.014);
      ctx.beginPath();                        // 弦
      ctx.moveTo(cx - wPx * 0.85, baseY - h * 0.16);
      ctx.lineTo(cx - wPx * 0.85, baseY - h * 1.08);
      ctx.stroke();
    }
  }

  /* 画一个人。o = { lean:-1..1, trail:0..1, trailDir:±1, glow:color, shadowA:0..1 } */
  function drawFigure(cx, baseY, h, sk, gender, o) {
    var g = sk[gender === 'female' ? 'female' : 'male'];
    var wPx = h * 0.34;
    var lean = o.lean * wPx * 0.5;
    var bodyTop = baseY - h * 0.84;
    var hipW = wPx * 0.52 * g.hipK;
    var shW = wPx * 0.30 * g.shK;

    // 影子
    if (o.shadowA !== 0) {
      ctx.beginPath();
      ctx.ellipse(cx, baseY, wPx * 0.95, wPx * 0.34, 0, 0, 6.283);
      ctx.fillStyle = 'rgba(0,0,0,' + (o.shadowA === undefined ? 0.45 : o.shadowA) + ')';
      ctx.fill();
    }

    // 侧移拖影：只有真的在横向移动时才出现，让"拖动"看起来是划过去而不是闪过去
    if (o.trail > 0.3) {
      var sgn = o.trailDir;
      ctx.globalAlpha = ((o.trail - 0.3) / 0.7) * 0.45;
      ctx.strokeStyle = sk.trail || sk.body.trim;
      ctx.lineWidth = Math.max(1, h * 0.028);
      ctx.lineCap = 'round';
      for (var i = 0; i < 3; i++) {
        var ly = baseY - h * (0.2 + i * 0.26);
        var l0 = cx + sgn * wPx * (0.72 + i * 0.24);
        ctx.beginPath();
        ctx.moveTo(l0, ly);
        ctx.lineTo(l0 + sgn * h * (0.14 + 0.1 * i), ly);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }

    // 披风：画在身体之前（在身后）
    if (sk.body.cape) {
      ctx.fillStyle = sk.body.cape;
      ctx.beginPath();
      ctx.moveTo(cx - shW * 1.25, bodyTop + h * 0.14);
      ctx.lineTo(cx + shW * 1.25, bodyTop + h * 0.14);
      ctx.quadraticCurveTo(cx + wPx * (0.95 + g.skirt * 0.3), baseY - h * 0.20,
        cx + wPx * 0.70, baseY - h * 0.02);
      ctx.lineTo(cx - wPx * 0.70, baseY - h * 0.02);
      ctx.quadraticCurveTo(cx - wPx * (0.95 + g.skirt * 0.3), baseY - h * 0.20,
        cx - shW * 1.25, bodyTop + h * 0.14);
      ctx.closePath();
      ctx.fill();
    }

    // 裙摆：比身体更宽的一段下摆，只在下半身露出来
    if (g.skirt > 0.12) {
      var hemW = wPx * (0.52 + g.skirt * 0.42);
      ctx.globalAlpha = 0.92;
      ctx.fillStyle = sk.body.robe[1];
      ctx.beginPath();
      ctx.moveTo(cx - wPx * 0.42, baseY - h * 0.34);
      ctx.lineTo(cx + wPx * 0.42, baseY - h * 0.34);
      ctx.lineTo(cx + hemW, baseY - h * 0.02);
      ctx.lineTo(cx - hemW, baseY - h * 0.02);
      ctx.closePath();
      ctx.fill();
      ctx.globalAlpha = 1;
    }

    ctx.shadowBlur = o.glowBlur === undefined ? 16 : o.glowBlur;
    ctx.shadowColor = o.glow || 'rgba(130,200,255,0.6)';

    // 身体
    ctx.beginPath();
    ctx.moveTo(cx - hipW, baseY - h * 0.02);
    ctx.lineTo(cx - shW + lean, bodyTop + h * 0.17);
    ctx.lineTo(cx + shW + lean, bodyTop + h * 0.17);
    ctx.lineTo(cx + hipW, baseY - h * 0.02);
    ctx.closePath();
    var pg = ctx.createLinearGradient(0, bodyTop, 0, baseY);
    pg.addColorStop(0, sk.body.robe[0]);
    pg.addColorStop(1, sk.body.robe[1]);
    ctx.fillStyle = pg;
    ctx.fill();

    // 腰带：一条横过腰线的窄带（所有皮肤都有，颜色各异）
    if (sk.body.belt) {
      ctx.globalAlpha = 0.95;
      ctx.fillStyle = sk.body.belt;
      var bY = baseY - h * 0.40;
      ctx.beginPath();
      ctx.moveTo(cx - wPx * 0.44, bY);
      ctx.lineTo(cx + wPx * 0.44, bY);
      ctx.lineTo(cx + wPx * 0.46, bY + h * 0.07);
      ctx.lineTo(cx - wPx * 0.46, bY + h * 0.07);
      ctx.closePath();
      ctx.fill();
      ctx.globalAlpha = 1;
    }

    // 头
    ctx.beginPath();
    ctx.arc(cx + lean, bodyTop + h * 0.04, h * 0.12, 0, 6.283);
    ctx.fillStyle = sk.head.skin;
    ctx.fill();

    ctx.shadowBlur = 0;

    // 头发 → 头饰（顺序固定：先发后冠，否则发髻会盖在盔缨上）
    drawHair(g.hair, cx + lean, bodyTop + h * 0.04, h, sk.head.hair);
    if (sk.gear) drawGear(sk.gear.kind, cx + lean, bodyTop + h * 0.04, h, sk.gear.color, sk);

    // 剑/枪/斧…（原先的剑是画在 shadowBlur 归零之后的，保持一致）
    drawWeapon(sk.weapon, cx, baseY, h, wPx, lean);
  }

  function drawPlayer() {
    var p = road.project(G.x3d, CFG.playerY);
    var sc = p.scale;
    var hPx = 1.75 * pxPerMeter * sc;
    var sk = skinOf(profile.skin);
    var sp = clamp(Math.abs(G.vx) / CFG.playerMoveSpeed, 0, 1);
    ctx.save();
    drawFigure(p.pos.x, p.pos.y, hPx, sk, profile.gender, {
      /* 侧倾：上半身朝移动方向压一点，静止时归零 */
      lean: clamp(G.vx / CFG.playerMoveSpeed, -1, 1),
      trail: sp,
      trailDir: G.vx > 0 ? -1 : 1,          // 拖影留在运动的相反一侧
      glow: G.hurtCd > 0.3 ? 'rgba(255,90,110,0.95)' : 'rgba(130,200,255,0.6)',
      shadowA: 0.45
    });
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
      var ty = p.pos.y - (1 - a) * 36;
      ctx.globalAlpha = a;
      ctx.font = '500 ' + size + 'px system-ui,-apple-system,"Microsoft YaHei",sans-serif';
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(0,0,0,0.6)';
      /* 金币浮字：数字前面带一枚小金饼。
       * 不画图标的话，"金币 +2" 和 "积分 +10" 在屏幕上是两串几乎同色的黄字，
       * 玩家分不清哪个是哪个 —— 而两者一个是持久货币、一个只是当局计分，
       * 混淆的代价是有人的钱袋子莫名变多/变少。 */
      var tx = p.pos.x;
      if (f.coin) {
        var rr = Math.max(2.4, size * 0.30);
        var tw = ctx.measureText ? (ctx.measureText(f.text).width || 0) : 0;
        var ccx = p.pos.x - tw / 2 - rr * 1.35;
        var ccy = ty - size * 0.34;
        ctx.beginPath(); ctx.arc(ccx, ccy, rr, 0, 6.283);
        ctx.fillStyle = '#ffcf5a'; ctx.fill();
        ctx.lineWidth = Math.max(1, rr * 0.3);
        ctx.strokeStyle = 'rgba(122,78,6,0.9)'; ctx.stroke();
        tx = p.pos.x + rr * 0.9;              // 文字给图标让出一点位置
      }
      ctx.strokeText(f.text, tx, ty);
      ctx.fillStyle = f.color;
      ctx.fillText(f.text, tx, ty);
    }
    ctx.globalAlpha = 1;
  }

  /* ══════════════════ HUD ══════════════════ */
  var hudTick = 0, lastIcoHtml = '', lastPanelHtml = '', lastCoinGain = 0;

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

    /* 局内金币：数字 + "跳一下"。
     * 用 coinGain（进账次数）而不是金币数值来判断要不要跳 ——
     * 同一帧连捡两只妖物的话，数值只变一次，跳两下才对得上玩家的感受。
     * 重启动画必须"移除类 → 强制回流 → 加回来"，只加类的话第二次不会动。 */
    $('coinText').textContent = G.coins;
    if (G.coinGain !== lastCoinGain) {
      lastCoinGain = G.coinGain;
      var cl = $('coinLine');
      if (cl) {
        cl.classList.remove('pop');
        void cl.offsetWidth;
        cl.classList.add('pop');
      }
    }

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

  /* ══════════════════ 商城 ══════════════════
   * 三条设计上的取舍，都写在下面：
   *  1) 缩略图**复用真实渲染管线**，不另画一套简化图 ——
   *     另画一套的话，地图改了颜色、皮肤改了配色，商城里的预览还是旧的，
   *     而"预览和实际不一致"是最伤信任的一类 bug。
   *  2) 购买有二次确认：地图 4800 金币相当于十几局，误触一下就没了是不可接受的。
   *  3) 初始地图/初始皮肤照列出来，但不标价、不显示"已拥有"——
   *     它们是"默认款"，标"初始"更准；而且必须有入口，否则玩家买了新地图之后
   *     想换回夜景都找不到地方。
   */
  var shopTab = 'all';                 // all | map | skin
  var pendingBuy = null;
  /* 缩略图的**像素缓冲**尺寸：TW×TH 是设计基准（132×168，3:4 略瘦的竖版），
   * 实际缓冲乘 TDPR —— 矢量填充在 DPR 1 下会发虚，缩到卡片大小时边缘发毛
   * （和游戏本体同一个道理）。显示尺寸由 CSS 决定（铺满卡片宽度）。 */
  var TDPR = Math.min(2, (typeof window !== 'undefined' && window.devicePixelRatio) || 1);
  var TW = 132, TH = 168;

  var COIN_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"'
    + ' stroke-linecap="round"><circle cx="12" cy="12" r="8.4"/>'
    + '<circle cx="12" cy="12" r="3.4" fill="currentColor" stroke="none" opacity=".55"/></svg>';

  function updateCoinDisplays() {
    var h = $('homeCoins'), s = $('shopCoins');
    if (h) h.textContent = profile.coins;
    if (s) s.textContent = profile.coins;
  }

  /* 把"当前画布 / 投影器 / 地图主题 / 里程"临时换成缩略图那一套，跑完立刻还原。
   * 商城要在同一帧里画出好几张**别的**地图，而所有绘制函数读的都是模块级变量 ——
   * 与其给十几个绘制函数逐个加参数，不如在这里存旧值、换新值、finally 还原。
   * 全程同步执行（中间没有 await），主循环不可能插进来画一帧（JS 单线程）。 */
  function withTarget(c2, w2, h2, road2, ppm2, mapKey, fn) {
    var sCtx = ctx, sW = W, sH = H, sRoad = road, sPpm = pxPerMeter;
    var sScroll = bgScroll, sTheme = themeKey;
    ctx = c2; W = w2; H = h2; road = road2; pxPerMeter = ppm2; themeKey = mapKey;
    bgScroll = 137.5;                  // 固定里程：每次打开商城构图都一样，也避开 0 附近的空槽
    try { fn(); } finally {
      ctx = sCtx; W = sW; H = sH; road = sRoad; pxPerMeter = sPpm;
      bgScroll = sScroll; themeKey = sTheme;
    }
  }

  /* 地图缩略图：按游戏里同一套比例（近端占 52% 宽、消失点在 15.5% 高、k=48）
   * 建一个缩小的投影器，然后把 sky/backdrop/road/scenery 原样跑一遍。 */
  function renderMapThumb(cv, key) {
    var c2 = cv.getContext('2d');
    var tw = cv.width, thh = cv.height;
    if (!c2 || !tw) return;
    c2.setTransform(1, 0, 0, 1, 0, 0);
    c2.clearRect(0, 0, tw, thh);
    var pr = new RoadProjector({
      left0: { x: tw * 0.5 - tw * 0.26, y: thh },
      right0: { x: tw * 0.5 + tw * 0.26, y: thh },
      vanish: { x: tw * 0.5, y: thh * 0.155 },
      roadWidth: CFG.roadWidth, k: 48, maxDepth: 420
    });
    withTarget(c2, tw, thh, pr, pr.nearWidthPx / CFG.roadWidth, key, function () {
      drawSky(); drawBackdrop(); drawRoad(); drawScenery(); drawAir();
    });
  }

  /* 皮肤立绘：底色取**当前装备地图**的地面/雾色 —— 于是"皮肤卡"和"地图卡"
   * 看起来是一套光照里的东西；换了地图，立绘的底色也跟着换。 */
  function renderSkinThumb(cv, key) {
    var c2 = cv.getContext('2d');
    var tw = cv.width, thh = cv.height;
    if (!c2 || !tw) return;
    c2.setTransform(1, 0, 0, 1, 0, 0);
    var th = theme();
    var g = c2.createLinearGradient(0, 0, 0, thh);
    g.addColorStop(0, th.sky[2]);
    g.addColorStop(0.42, th.haze[2]);
    g.addColorStop(1, th.ground[2]);
    c2.fillStyle = g;
    c2.fillRect(0, 0, tw, thh);
    withTarget(c2, tw, thh, road, pxPerMeter, themeKey, function () {
      drawFigure(tw * 0.5, thh * 0.93, thh * 0.74, skinOf(key), profile.gender,
        { lean: 0, trail: 0, trailDir: 1, shadowA: 0.40, glowBlur: 10 });
    });
  }

  function paintThumbs() {
    var list = document.querySelectorAll('#shopGrid .thumbcv');
    Array.prototype.forEach.call(list, function (cv) {
      /* 缩略图是纯装饰，画不出来（老内核、无 canvas 环境）不该让整个商城打不开 */
      try {
        if (cv.getAttribute('data-kind') === 'map') renderMapThumb(cv, cv.getAttribute('data-key'));
        else renderSkinThumb(cv, cv.getAttribute('data-key'));
      } catch (e) {}
    });
  }

  function shopItems() {
    var out = [];
    if (shopTab === 'all' || shopTab === 'map') {
      MAPS.forEach(function (m) { out.push({ kind: 'map', d: m }); });
    }
    if (shopTab === 'all' || shopTab === 'skin') {
      SKINS.forEach(function (s) { out.push({ kind: 'skin', d: s }); });
    }
    return out;
  }

  function cardHtml(it) {
    var kind = it.kind, d = it.d;
    var owned = owns(kind, d.key);
    var using = (kind === 'map' ? profile.map : profile.skin) === d.key;
    var base = d.price === 0;
    var tag = using ? '<span class="tag using">使用中</span>'
      : base ? '<span class="tag base">初始</span>'
        : owned ? '<span class="tag own">已拥有</span>' : '';
    var foot;
    if (using) {
      foot = '<span class="cprice free">当前使用</span>';
    } else if (owned || base) {
      /* 初始款和已购款在这里是同一种操作（切过去），所以并成一档 */
      foot = '<span class="cprice free">' + (base ? '初始赠送' : '已拥有') + '</span>'
        + '<button class="cbtn" data-act="equip" data-kind="' + kind + '" data-key="' + d.key + '">使用</button>';
    } else {
      var poor = profile.coins < d.price;
      foot = '<span class="cprice' + (poor ? ' poor' : '') + '">' + COIN_SVG + d.price + '</span>'
        + '<button class="cbtn buy" data-act="buy" data-kind="' + kind
        + '" data-key="' + d.key + '">购买</button>';
    }
    var sub = kind === 'map' ? ('地图 · ' + d.sub) : (d.nation + ' · ' + d.job);
    return '<div class="card' + (using ? ' using' : '') + '">'
      /* width/height 属性 = **像素缓冲**尺寸（按 DPR 放大，否则矢量填充发虚）；
       * 显示尺寸交给 CSS（.card .thumb canvas{width:100%;height:auto}）。
       * 在这里再写一份内联 style 会和 CSS 打架：画布只占 132px、
       * 右边空出一条黑边。 */
      + '<div class="thumb"><canvas class="thumbcv" width="' + (TW * TDPR) + '" height="' + (TH * TDPR)
      + '" data-kind="' + kind
      + '" data-key="' + d.key + '"></canvas>' + tag + '</div>'
      + '<div class="cbody"><div class="cname">' + d.name + '</div>'
      + '<div class="csub">' + sub + '</div>'
      + '<div class="cdesc">' + d.desc + '</div>'
      + '<div class="cfoot">' + foot + '</div></div></div>';
  }

  function paintShop() {
    updateCoinDisplays();
    Array.prototype.forEach.call($('shopTabs').children, function (b) {
      b.classList.toggle('on', b.getAttribute('data-tab') === shopTab);
    });
    /* 性别开关只在有皮肤卡片时才有意义（地图页显示它只会让人以为地图也分男女） */
    var grow = $('genderRow');
    if (grow) grow.classList.toggle('hidden', shopTab === 'map');
    var seg = $('genderSeg');
    if (seg) Array.prototype.forEach.call(seg.children, function (b) {
      b.classList.toggle('on', b.getAttribute('data-gender') === profile.gender);
    });

    var out = '';
    shopItems().forEach(function (it) { out += cardHtml(it); });
    $('shopGrid').innerHTML = out;
    paintThumbs();

    var owned = profile.ownedMaps.length + profile.ownedSkins.length;
    var total = MAPS.length + SKINS.length;
    $('shopHint').textContent = '已解锁 ' + owned + ' / ' + total +
      ' · 金币在每局结束时入账，买到的地图与皮肤永久保留';
  }

  function openShop() {
    Sound.resume();
    shopTab = 'all';
    pendingBuy = null;
    $('buyConfirm').classList.add('hidden');
    setState('shop');
    paintShop();
  }

  function closeShop() {
    pendingBuy = null;
    $('buyConfirm').classList.add('hidden');
    setState('home');
    updateCoinDisplays();
  }

  /* 装备/购买之后要同步的东西 */
  function afterEquip(kind) {
    /* 暗角强度是按地图缓存的渐变对象，换了地图必须重建，否则还是旧强度 */
    if (kind === 'map') buildVignette();
    paintShop();
  }

  function askBuy(kind, key) {
    var d = kind === 'map' ? mapOf(key) : skinOf(key);
    pendingBuy = { kind: kind, key: key };
    var left = profile.coins - d.price;
    $('bcName').textContent = d.name;
    $('bcPrice').textContent = d.price + ' 金币';
    $('bcSub').innerHTML = '当前余额 ' + profile.coins + ' 金币<br>'
      + (left >= 0
        ? '购买后剩余 ' + left + ' 金币。买下会立即装备。'
        : '<span class="warn">还差 ' + (-left) + ' 金币 —— 再打几局就有了。</span>');
    $('bcOk').disabled = left < 0;
    $('bcOk').textContent = left < 0 ? '金币不足' : '确认购买';
    $('buyConfirm').classList.remove('hidden');
  }

  function doBuy() {
    if (!pendingBuy) return;
    var kind = pendingBuy.kind;
    var r = buy(pendingBuy.kind, pendingBuy.key);
    pendingBuy = null;
    $('buyConfirm').classList.add('hidden');
    if (r.ok) {
      Sound.init(); Sound.pickup(); vibrate(28);
      toast('已购买并装备：' + r.item.name);
    } else if (r.reason === 'poor') {
      toast('金币不足，还差 ' + r.need);
    }
    afterEquip(kind);
  }

  /* ══════════════════ 界面切换 ══════════════════ */
  function setState(s) {
    state = s;
    $('loading').classList.toggle('hidden', s !== 'loading');
    $('home').classList.toggle('hidden', s !== 'home');
    $('shop').classList.toggle('hidden', s !== 'shop');
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
    /* 从设置里的"重新开始"进来时，手上还捏着上一局没入账的金币 —— 先记上再开新局。
     * 顺序不能反：newGame() 会把 G 整个换掉，换掉之后就再也拿不到那笔钱了。 */
    bankRun();
    newGame();
    lastIcoHtml = '';                          // 新一局强制重画图标行与面板
    lastPanelHtml = '';
    lastCoinGain = 0;
    setState('playing');
    updateHud();
    toast('妖物来袭 · 坚持 3:00 即通关');
  }

  /* 把这一局挣到的金币记进存档。
   * 幂等（G.banked）：结算、再来一局、返回主页、重新开始都可能走到这里，
   * 不设标记的话"结算 → 返回主页"会把同一笔钱记两遍。
   * 中途退出也照样入账 —— 击杀是真实发生的，没有作弊空间（想多挣就得多活、
   * 多打），而"打断一局就把钱全扣掉"只会让玩家不敢随手关掉页面。 */
  function bankRun() {
    if (!G || G.banked) return 0;
    G.banked = true;
    var n = G.coins;
    profile.coins += n;
    profile.earned += n;
    profile.runs++;
    saveProfile();
    return n;
  }

  function endGame(win) {
    if (state === 'result') return;
    state = 'result';
    Sound.init();
    if (win) { Sound.win(); vibrate([40, 70, 40]); G.coins += CFG.coinBonusWin; }
    else { Sound.lose(); vibrate(220); }

    var isBest = G.score > bestScore;
    if (isBest) { bestScore = G.score; saveBest(); }

    var gained = bankRun();

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
    $('resCoinGain').textContent = '+' + gained;
    $('resCoinBal').textContent = '余额 ' + profile.coins +
      (win ? '（含通关奖励 +' + CFG.coinBonusWin + '）' : '');
    $('resBest').textContent = isBest
      ? '新纪录！历史最高积分 ' + bestScore
      : '历史最高积分 ' + bestScore;

    setState('result');
  }

  function goHome() {
    Sound.resume();
    bankRun();                       // 中途返回也把已挣到的记上（幂等，不会重复记）
    G = null;
    $('bestScore').textContent = bestScore > 0 ? '历史最高积分 ' + bestScore : '';
    setState('home');
    updateCoinDisplays();
  }

  /* ══════════════════ 事件绑定 ══════════════════ */
  function bindUI() {
    $('btnStart').addEventListener('click', startGame);
    $('btnShop').addEventListener('click', openShop);
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

    /* ── 商城 ──
     * 卡片是整段 innerHTML 重建的，所以事件一律用**委托**挂在稳定的父节点上：
     * 给每张卡单独 addEventListener 的话，每次重绘都会留下一批指向旧 DOM 的监听器。 */
    $('btnShopBack').addEventListener('click', closeShop);
    $('shopTabs').addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('[data-tab]') : null;
      if (!b) return;
      shopTab = b.getAttribute('data-tab');
      paintShop();
    });
    $('genderSeg').addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('[data-gender]') : null;
      if (!b) return;
      setGender(b.getAttribute('data-gender'));
      paintShop();
      toast(profile.gender === 'female' ? '已切换为女款' : '已切换为男款');
    });
    $('shopGrid').addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('[data-act]') : null;
      if (!b) return;
      var act = b.getAttribute('data-act');
      var kind = b.getAttribute('data-kind'), key = b.getAttribute('data-key');
      if (act === 'buy') askBuy(kind, key);
      else if (act === 'equip' && equip(kind, key)) {
        toast('已切换：' + (kind === 'map' ? mapOf(key).name : skinOf(key).name));
        afterEquip(kind);
      }
    });
    $('bcOk').addEventListener('click', doBuy);
    $('bcCancel').addEventListener('click', function () {
      pendingBuy = null;
      $('buyConfirm').classList.add('hidden');
    });

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
    /* 地址栏伸缩在 iOS 上不一定派发 window.resize，但一定会动 visualViewport。
     * 不顺带听这个的话，手指一划让地址栏收起来，HUD 就会和屏幕底错位。 */
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', resize);
    }
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
          updateCoinDisplays();
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
    MAPS: MAPS, SKINS: SKINS,
    settings: settings,
    /* 存档是**同一个对象**（不是拷贝）：测试可以直接改 profile.coins 来造场景，
     * 也可以读它来断言"买完扣了多少"。 */
    profile: profile,
    get perf() { return perf; },
    get G() { return G; },
    get state() { return state; },
    project: function (x, y) { return road.project(x, y); },
    /* 某张地图的主题（不传就是当前装备的那张）。测试用它核对
     * "夜图的色值是不是和抽主题前逐字一致"、"换地图后雾参数有没有跟着换"。 */
    theme: function (key) { return mapOf(key || profile.map).th; },
    /* 某张地图实际生效的景物带（种类已换成该地图的） */
    beltsFor: function (key) { return beltsFor(key || profile.map); },
    /* 枚举当前视野里的景物（不绘制）。给自动化测试清点用。
     * 第三个参数可以指定地图 —— 测试要逐张地图验证"物件不许压到路面"。 */
    sceneItems: function (scroll, emit, mapKey) {
      return sceneItems(scroll === undefined ? currentScroll() : scroll, emit, mapKey);
    },
    /* 路沿每段的几何与透明度（不绘制）。给测试断言"线宽随透视收缩、明度随距离衰减"用。 */
    curbSegments: function () { return curbSegments(); },
    /* 属性面板：开关 + 当前那几行数据（测试直接核对数字，不用去解 DOM） */
    toggleStats: function (force) { toggleStats(force); },
    statsRows: function () { return G ? statsRows() : []; },
    playerStats: function () { return G ? playerStats() : null; },
    /* 经济与商城：测试要能"给钱 → 进商城 → 点购买 → 核对余额与装备"整条走通，
     * 所以把真实入口（而不是另写一份测试专用逻辑）暴露出来。 */
    updateCoinDisplays: function () { updateCoinDisplays(); },
    bankRun: function () { return bankRun(); },
    saveProfile: function () { saveProfile(); },
    shop: {
      open: function () { openShop(); },
      close: function () { closeShop(); },
      /* ⚠ 这里**不能**同时提供 `tab(t)` 和 `get tab()`：
       * 对象字面量里同名键后者胜，getter 会把函数整个覆盖掉，
       * 于是 `RD.shop.tab('map')` 变成"把字符串当函数调用"，而且不报错、只是没生效。
       * 分工：tab(t) 用来切筛选，currentTab 用来读当前筛选。 */
      tab: function (t) { shopTab = t; paintShop(); },
      get currentTab() { return shopTab; },
      items: function () { return shopItems(); },
      paint: function () { paintShop(); },
      owns: function (kind, key) { return owns(kind, key); },
      buy: function (kind, key) { return buy(kind, key); },
      equip: function (kind, key) { return equip(kind, key); },
      setGender: function (g) { return setGender(g); },
      askBuy: function (kind, key) { askBuy(kind, key); },
      confirm: function () { doBuy(); },
      cardHtml: function (it) { return cardHtml(it); },
      /* 缩略图是纯 canvas 的东西，jsdom 里没有真实上下文；
       * 测试要验"预览真的走了渲染管线"就用这个入口（注入一个假 canvas）。 */
      renderThumb: function (cv, kind, key) {
        if (kind === 'map') renderMapThumb(cv, key); else renderSkinThumb(cv, key);
      }
    }
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
