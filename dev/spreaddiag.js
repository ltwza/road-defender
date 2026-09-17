/* ============================================================================
 *  spreaddiag —— 齐射散布的口径之争：固定角度 vs 固定米数
 *
 *  背景：双股剑 / 三才剑阵最初用「相邻两发的固定夹角（弧度）」描述散开，
 *  结果在 17 米（妖物进入扑击射程的深度）几乎全空。改成「在目标深度处
 *  散开多少米（spreadM）」后修好。
 *
 *  这个脚本用真实的 projector.js + 与 game.js 完全一致的相机参数，
 *  把两种口径换算成「屏幕像素」，回答：为什么不用 3D 空间的角度？
 *
 *  跑法：node dev/spreaddiag.js
 * ========================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

/* 载入真实的投影器（它是 (function(global){...})(window) 形式，给个假 window） */
const win = {};
new Function('window', fs.readFileSync(path.join(ROOT, 'projector.js'), 'utf8'))(win);
const RoadProjector = win.RoadProjector;

/* ── 与 game.js 完全一致的画布 / 相机参数 ───────────────────────────── */
const W = 480, H = 900;
const halfW = W * 0.26;                 // buildRoad(): left0/right0 的横向半宽
const road = new RoadProjector({
  left0: { x: W * 0.5 - halfW, y: H },
  right0: { x: W * 0.5 + halfW, y: H },
  vanish: { x: W * 0.5, y: H * 0.155 },
  roadWidth: 4, k: 48, maxDepth: 420
});

const pxAt = (x3d, y) => road.project(x3d, y).pos.x;

/* ── 与 game.js 一致的战斗常量 ─────────────────────────────────────── */
const PLAYER_Y = 22;                    // CFG.playerY（玩家固定深度）
const ATTACK_RANGE = 17;                // ATTACK.range（妖物在此深度进入扑击）
const ROAD_HALF = 2;                    // 路半宽（米）
const TOL_MIN = 0.34 + 0.32;            // 最小命中容差：飞蝠 r=0.34 + 弹道半径 0.32
const TOL_SLIME = 0.44 + 0.32;          // 小妖的容差，注释里引用的那个数

/* 双股剑 */
const OLD_FAN = 0.12;                   // 旧：相邻两发夹角（弧度）
const NEW_SPREAD = 0.9;                 // 新：在目标深度处散开多少米
/* 三才剑阵 */
const OLD_FAN3 = 0.20;
const NEW_SPREAD3 = 0.5;

const out = [];
const R = (n, d) => (d === undefined ? String(n) : Number(n).toFixed(d));
const line = (s) => out.push(s);

line('=== 量纲口径：同一把「双股剑」，两种描述方式在屏幕上的表现 ===');
line('画布 ' + W + '×' + H + '　相机 k=48　路宽 4m　玩家深度 ' + PLAYER_Y + 'm　交火深度 ' + ATTACK_RANGE + 'm');
line('最小命中容差 ' + R(TOL_MIN, 2) + 'm（飞蝠 0.34 + 弹道 0.32）');
line('');

/* 自检：把路半宽算回像素，确认投影器接对了 */
line('自检：玩家深度处的路半宽 = ' + R(Math.abs(pxAt(ROAD_HALF, PLAYER_Y) - pxAt(0, PLAYER_Y)), 1) + ' px');
line('');

const DISTS = [5, 8, 12, 17, 25, 40, 60, 100];
line('距离'.padEnd(7) + '缩放'.padEnd(8) + '路半宽'.padEnd(9) + '容差'.padEnd(8) +
  '固定角度(0.12rad)'.padEnd(20) + '固定米数(0.9m)'.padEnd(19) + '命中?');
line('─'.repeat(92));

for (const y of DISTS) {
  const scale = road.project(0, y).scale;
  const roadHalfPx = Math.abs(pxAt(ROAD_HALF, y) - pxAt(0, y));
  const tolPx = Math.abs(pxAt(TOL_MIN, y) - pxAt(0, y));

  /* 固定角度：外侧那一发在深度 y 处的横向偏离 = y·tan(θ_half) */
  const angOffM = y * Math.tan(OLD_FAN / 2);
  const angOffPx = Math.abs(pxAt(angOffM, y) - pxAt(0, y));

  /* 固定米数：外侧那一发恒为 0.9 / 2 = 0.45m */
  const mOffM = NEW_SPREAD / 2;
  const mOffPx = Math.abs(pxAt(mOffM, y) - pxAt(0, y));

  const angHit = angOffM <= TOL_MIN;
  const mHit = mOffM <= TOL_MIN;

  line(R(y + 'm', undefined).padEnd(7) + R(scale, 3).padEnd(8) +
    R(roadHalfPx, 0).padEnd(9) + R(tolPx, 0).padEnd(8) +
    (R(angOffM, 2) + 'm / ' + R(angOffPx, 0) + 'px').padEnd(20) +
    (R(mOffM, 2) + 'm / ' + R(mOffPx, 0) + 'px').padEnd(19) +
    (angHit ? '中' : '空') + ' / ' + (mHit ? '中' : '空'));
}

line('');
line('=== 固定角度到底能不能修？解出「让 ' + ATTACK_RANGE + 'm 处刚好命中」的角度上界 ===');
const maxHalfAngle = Math.atan(TOL_MIN / ATTACK_RANGE);
line('需要 tan(θ/2) ≤ ' + R(TOL_MIN, 2) + '/' + ATTACK_RANGE + ' = ' + R(TOL_MIN / ATTACK_RANGE, 4) +
  '　→　相邻夹角 ≤ ' + R(maxHalfAngle * 2 * 180 / Math.PI, 2) + '°（' + R(maxHalfAngle * 2, 4) + ' rad）');
line('即：固定角度只有缩到现在的 ' + R(maxHalfAngle * 2 / OLD_FAN * 100, 0) + '% 才可能在交火距离上命中。');
line('');
line('但角度是「无界量」：横向偏离 = 距离 × tan(θ)，会一直涨。');
line('而命中容差是「有界量」：' + R(TOL_MIN, 2) + 'm，恒定。');
line('→ 两者必然在某个深度交叉，越过就必空。这个临界深度：');
for (const [name, fan] of [['双股剑 0.12rad', OLD_FAN], ['三才剑阵 0.20rad', OLD_FAN3]]) {
  const half = fan / 2;
  const dStar = TOL_MIN / Math.tan(half);
  line('  ' + name.padEnd(18) + ' 临界深度 ≈ ' + R(dStar, 1) + 'm' +
    '（' + (dStar < ATTACK_RANGE ? '比交火距离 ' + ATTACK_RANGE + 'm 还近 → 交火时全空' : '') + '）');
}
line('');
line('=== 换成「固定米数」之后，临界深度还有吗？ ===');
line('横向偏离恒为 ' + R(NEW_SPREAD / 2, 2) + 'm（双股剑）/ ' + R(NEW_SPREAD3 / 2, 2) + 'm（剑阵），与距离无关。');
line('两者都小于最小容差 ' + R(TOL_MIN, 2) + 'm → 任何距离恒命中，不存在临界深度。');
line('');

/* 屏幕收敛性：这一节回答「视觉上像不像并排的剑」 */
line('=== 屏幕表现：透视收敛（这决定了「看起来像不像两把并排的剑」）===');
line('双股剑，两发之间的屏幕像素间距：');
line('距离'.padEnd(8) + '固定角度 0.12rad'.padEnd(22) + '固定米数 0.9m');
line('─'.repeat(56));
const angPx = (y) => {
  const off = y * Math.tan(OLD_FAN / 2);
  return Math.abs(pxAt(off, y) - pxAt(-off, y));
};
const mPx = (y) => Math.abs(pxAt(NEW_SPREAD / 2, y) - pxAt(-NEW_SPREAD / 2, y));
for (const y of DISTS) {
  line(R(y + 'm').padEnd(8) + (R(angPx(y), 0) + ' px').padEnd(22) + R(mPx(y), 0) + ' px');
}
line('');
line('固定米数：像素间距 ∝ 1/(y+48)，随距离单调收拢 → 和路面、路肩的收敛方向一致，');
line('          看上去就是「两条平行线在透视下汇聚」。');
line('固定角度：像素间距 ∝ y/(y+48)，渐近到一个常数 ' +
  R(halfW / 2 * 48 * 2 * Math.tan(OLD_FAN / 2), 0) + ' px（极限），');
line('          即「屏幕上的间距永远不收敛」—— 和路面的收敛打架，看上去像往两边飞出去。');
line('');
line('=== 另一组极端：屏幕上 = 1 像素需要多少米？（远处并射还看不看得出来）===');
for (const y of [17, 25, 40, 60, 100]) {
  const onePx = 1 / (Math.abs(pxAt(1, y) - pxAt(0, y)));
  line(R(y + 'm').padEnd(8) + '1 px = ' + R(onePx, 3) + ' m　→　0.9m 展宽约占 ' +
    R(NEW_SPREAD / onePx, 1) + ' px');
}

fs.writeFileSync(path.join(__dirname, '_spread.txt'), out.join('\n'), 'utf8');
console.log(out.join('\n'));
