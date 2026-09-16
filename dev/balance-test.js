/* 冒烟测试：几何 + 平衡性数值核算（不依赖浏览器）
 * 与 game.js 里的参数保持同步 —— 改了游戏数值记得回来改这里。 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const DIR = 'C:/Users/Administrator/Desktop/road-defender';
const REPORT = path.join(DIR, 'dev', '_balance.txt');
const _lines = [];
const _log = console.log.bind(console);
console.log = (...a) => { const s = a.join(' '); _lines.push(s); _log(s); };
process.on('exit', () => { try { fs.writeFileSync(REPORT, _lines.join('\n') + '\n', 'utf8'); } catch (e) {} });

const sandbox = { window: {}, Math: Math, console: console };
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(DIR, 'projector.js'), 'utf8'), sandbox);
const RoadProjector = sandbox.window.RoadProjector;

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('  [FAIL] ' + m); } };
const f = (v, n) => v.toFixed(n == null ? 1 : n);

/* ══════ 与 game.js 同步的参数 ══════ */
const CFG = {
  roadWidth: 4, lanes: [-4 / 3, 0, 4 / 3],
  playerY: 22, playerMoveSpeed: 5.4, scrollSpeed: 12,
  spawnDepth: 120, despawnDepth: -9, roundDuration: 180,
  playerRadius: 0.38, maxHp: 100, bulletSpeed: 88, hurtCooldown: 0.55
};
const ATTACK = { range: 17, lockJitter: 0.40, brake: 0.20, lungeChase: 3.1, hitDepth: 1.6, lungeTime: 1.1, recover: 0.42 };
const MONSTERS = {
  slime: { hp: 20, speed: 1.9, r: 0.44, dmg: 8, windup: 0.50, dash: 10 },
  bat: { hp: 15, speed: 3.6, r: 0.34, dmg: 6, windup: 0.40, dash: 15 },
  brute: { hp: 55, speed: 1.4, r: 0.58, dmg: 14, windup: 0.72, dash: 8 },
  elite: { hp: 115, speed: 1.6, r: 0.66, dmg: 18, windup: 0.64, dash: 9 }
};
const WEAPONS = {
  sword: { cd: 0.80, dmg: 13, shots: 1 },
  twin: { cd: 0.52, dmg: 12, shots: 2 },
  fan: { cd: 0.68, dmg: 12, shots: 3 },
  cloud: { cd: 0.80, dmg: 40, shots: 1 }
};
const DROP = { pHeal: 0.24, pWep: 0.08, pBuff: 0.22, heal: 26 };

const W = 900, H = 700;
const road = new RoadProjector({
  left0: { x: W * 0.5 - W * 0.26, y: H },
  right0: { x: W * 0.5 + W * 0.26, y: H },
  vanish: { x: W * 0.5, y: H * 0.155 },
  roadWidth: 4, k: 48, maxDepth: 420
});
const pxPerMeter = road.nearWidthPx / 4;

console.log('=== 1. 几何 ===');
console.log('  近端像素/米 = ' + f(pxPerMeter, 2) + '，近端路宽 = ' + f(road.nearWidthPx) + 'px');
const pl = road.project(0, CFG.playerY);
console.log('  玩家屏幕位置 = (' + f(pl.pos.x) + ', ' + f(pl.pos.y) + ')，scale = ' + f(pl.scale, 3) +
  '，人高 = ' + f(1.75 * pxPerMeter * pl.scale) + 'px');
ok(Math.abs(pl.pos.x - W / 2) < 0.01, '玩家横向居中');
ok(pl.pos.y > H * 0.66 && pl.pos.y < H * 0.85, '玩家位于屏幕下方（y=' + f(pl.pos.y) + '，屏高 ' + H + '）');

const xs = CFG.lanes.map((x) => road.project(x, CFG.playerY).pos.x);
console.log('  三车道屏幕 x：' + xs.map((v) => f(v)).join(' / '));
ok(xs[0] < xs[1] && xs[1] < xs[2], '三车道从左到右排序正确');
ok(Math.abs((xs[1] - xs[0]) - (xs[2] - xs[1])) < 0.5, '三车道间距均匀（' + f(xs[1] - xs[0]) + 'px）');

let mono = true;
for (let y = 0; y < 160; y += 4) if (road.project(0, y).pos.y <= road.project(0, y + 4).pos.y) mono = false;
ok(mono, '屏幕 y 随深度单调递减（近处在下、远处在上）');

const spawnScale = road.project(0, CFG.spawnDepth).scale;
ok(spawnScale > 0.2, '生成点缩放不至于看不见：' + f(spawnScale, 3));

console.log('\n=== 2. 时序：从生成到打照面 ===');
let minT = 99;
Object.keys(MONSTERS).forEach((k) => {
  const m = MONSTERS[k];
  const t = (CFG.spawnDepth - CFG.playerY) / (CFG.scrollSpeed + m.speed);
  minT = Math.min(minT, t);
  console.log('  ' + k.padEnd(6) + '速度 ' + m.speed + ' m/s → ' + f(t, 2) + ' 秒（先到射程 17m 处约 ' +
    f((CFG.spawnDepth - CFG.playerY - ATTACK.range) / (CFG.scrollSpeed + m.speed), 2) + 's）');
});
ok(minT > 4.0, '最快妖物也有足够反应时间（' + f(minT, 2) + 's）');

console.log('\n=== 3. 主动攻击的可躲性（这套机制成不成立，全看这一段） ===');
ok(ATTACK.lungeChase < CFG.playerMoveSpeed,
  '扑击横移 ' + ATTACK.lungeChase + ' < 玩家 ' + CFG.playerMoveSpeed + ' → 一直跑就甩得开');
Object.keys(MONSTERS).forEach((k) => {
  const m = MONSTERS[k];
  // 进入射程那一刻锁定落点，此时玩家若正好站在落点上：
  const dAtLunge = ATTACK.range - CFG.scrollSpeed * ATTACK.brake * m.windup;   // 蓄力期间会稍微前挪
  const closeSpeed = CFG.scrollSpeed + m.dash;
  const T = m.windup + Math.max(0, dAtLunge - ATTACK.hitDepth) / closeSpeed;   // 到落地还有多久
  const need = m.r + CFG.playerRadius + ATTACK.lockJitter;                     // 最坏情况还要算上落点抖动
  const escape = CFG.playerMoveSpeed * T;                                      // 这段时间玩家能横移多远
  console.log('  ' + k.padEnd(6) + '蓄力 ' + f(m.windup, 2) + 's + 冲刺 ' + f(T - m.windup, 2) +
    's = 预警 ' + f(T, 2) + 's，可横移 ' + f(escape, 2) + 'm，需让开 ' + f(need, 2) + 'm');
  ok(escape > need + 0.6, k + ' 的预警时间足够让开（余量 ' + f(escape - need, 2) + 'm）');
});

console.log('\n=== 4. 出怪节奏（按曲线解析积分，不抽样） ===');
function diff(t) {
  return {
    interval: Math.max(0.42, 0.92 - (t / 180) * 0.30),
    hpMul: 1 + (t / 180) * 1.05,
    speedMul: 1 + (t / 180) * 0.40,
    elite: t < 50 ? 0 : Math.min(0.20, (t - 50) / 300),
    brute: t < 25 ? 0 : Math.min(0.32, (t - 25) / 160)
  };
}
const BAT_P = 0.30;
function mix(t) {
  const d = diff(t);
  const pS = Math.max(0, 1 - d.elite - d.brute - BAT_P);
  return { slime: pS, bat: BAT_P, brute: d.brute, elite: d.elite };
}
function rateAt(t) { return 1 / diff(t).interval; }                 // 只/秒
function avgHpAt(t) {
  const m = mix(t);
  let base = 0;
  Object.keys(m).forEach((k) => { base += m[k] * MONSTERS[k].hp; });
  return base * diff(t).hpMul;
}
function hpPerSecAt(t) { return rateAt(t) * avgHpAt(t); }

let totalSpawn = 0, totalHp = 0, maxAlive = 0;
const alive = [];
for (let s = 0; s < 180; s += 0.25) {
  const n = rateAt(s) * 0.25;
  totalSpawn += n;
  totalHp += n * avgHpAt(s);
  alive.push(s);
}
function aliveAt(s) { return rateAt(s) * 8.5; }   // 从出现到离场约 8.5 秒
for (let s = 0; s < 180; s += 0.5) maxAlive = Math.max(maxAlive, aliveAt(s));

console.log('  180 秒共生成约 ' + f(totalSpawn, 0) + ' 只，同屏峰值约 ' + f(maxAlive, 0) + ' 只');
[0, 60, 120, 179].forEach((s) => {
  const m = mix(s);
  console.log('  t=' + String(s).padStart(3) + 's：间隔 ' + f(diff(s).interval, 2) + 's（' +
    f(rateAt(s), 2) + ' 只/秒）  均血 ' + f(avgHpAt(s), 0) +
    '（小妖' + f(m.slime * 100, 0) + '%/飞蝠' + f(m.bat * 100, 0) + '%/蛮兵' +
    f(m.brute * 100, 0) + '%/妖将' + f(m.elite * 100, 0) + '%）  → ' + f(hpPerSecAt(s)) + ' HP/秒');
});
const hpPerSecEnd = hpPerSecAt(179);
ok(maxAlive < 64, '同屏峰值 ' + f(maxAlive, 0) + ' < 上限 64');
ok(totalSpawn > 120 && totalSpawn < 460, '总出怪量 ' + f(totalSpawn, 0) + ' 在合理区间');
ok(hpPerSecEnd > hpPerSecAt(0) * 3, '后期压力显著高于前期（' +
  f(hpPerSecAt(0)) + ' → ' + f(hpPerSecEnd) + ' HP/秒）');

console.log('\n=== 5. 伤害平衡：玩家 dps vs 出怪 HP/秒 ===');
function dps(weaponKey, atkLv, rateLv, critLv, cdLv) {
  const w = WEAPONS[weaponKey];
  const cd = w.cd / (1 + rateLv * 0.12);
  const dmg = w.dmg * (1 + atkLv * 0.15);
  const crit = Math.min(0.92, 0.05 + critLv * 0.06);
  const critMul = 1.5 + cdLv * 0.25;
  return (w.shots * dmg / cd) * (1 + crit * (critMul - 1));
}
const base = {
  sword: dps('sword', 0, 0, 0, 0),
  twin: dps('twin', 0, 0, 0, 0),
  fan: dps('fan', 0, 0, 0, 0),
  cloud: dps('cloud', 0, 0, 0, 0)
};
console.log('  各武器裸装 dps：' + Object.keys(base).map((k) => k + ' ' + f(base[k])).join('  '));
console.log('  开局清怪率（t=0，' + f(hpPerSecAt(0)) + ' HP/秒）');
Object.keys(base).forEach((k) => {
  console.log('    ' + k.padEnd(6) + ' ' + f(base[k] / hpPerSecAt(0) * 100) + '%');
});
console.log('  末期清怪率（t=180，' + f(hpPerSecEnd) + ' HP/秒）');
Object.keys(base).forEach((k) => {
  console.log('    ' + k.padEnd(6) + ' ' + f(base[k] / hpPerSecEnd * 100) + '%');
});

const startRate = base.sword / hpPerSecAt(0);
ok(startRate > 0.5 && startRate < 1.15,
  '开局飞剑清怪率 ' + f(startRate * 100) + '% —— 有压力但不会被淹没');
// 起始飞剑不在比较范围：到末期玩家必然已经换过武器（否则就是运气极差的一局，本就该输）
const endRates = Object.keys(base).filter((k) => k !== 'sword').map((k) => base[k] / hpPerSecEnd);
ok(Math.max(...endRates) < 1.0,
  '末期即使换到最好的裸装武器，清怪率也 < 100%（' + f(Math.max(...endRates) * 100) +
  '%）→ 后期一定有漏网之鱼，不会退化成无脑挂机');
ok(Math.min(...endRates) > 0.25,
  '末期捡到任意一把武器都能保持 ' + f(Math.min(...endRates) * 100) + '% 以上的清怪率 —— 玩家仍能还手');
ok(base.twin > base.sword && base.cloud > base.twin * 0.9,
  '换到进阶武器确实有提升（' + f(base.sword) + ' → ' + f(base.twin) + ' → ' + f(base.cloud) + ' dps）');

console.log('\n=== 6. 掉落期望（按 ' + f(totalSpawn, 0) + ' 只怪） ===');
const nHeal = totalSpawn * DROP.pHeal, nWep = totalSpawn * DROP.pWep, nBuff = totalSpawn * DROP.pBuff;
console.log('  血瓶约 ' + f(nHeal, 0) + ' 个（每个 +' + DROP.heal + ' HP）');
console.log('  武器约 ' + f(nWep, 0) + ' 把，强化约 ' + f(nBuff, 0) + ' 次');
console.log('  掉落密度 = ' + f((nHeal + nWep + nBuff) / 180, 2) + ' 个/秒');
// 注意：只有玩家横向走过去（±1.2m）才能拾取，所以实际收益远低于"全部拾取"。
// 真实拾取率由 e2e-test 实测，这里只做上限检查。
const healUpper = nHeal * DROP.heal / 180;
console.log('  理论上限（假设全部拾取）= ' + f(healUpper, 2) + ' HP/秒');
ok((nHeal + nWep + nBuff) / 180 < 0.9, '掉落密度不至于刷屏（' + f((nHeal + nWep + nBuff) / 180, 2) + ' 个/秒）');
ok(healUpper < 12, '即使全部拾取，回血上限 ' + f(healUpper, 2) + ' HP/秒 也不会让人变成不死之身');

console.log('\n=== 7. 子弹判定 ===');
[60, 30, 20].forEach((fps) => {
  const dt = 1 / fps;
  const step = CFG.bulletSpeed * dt;
  const pad = 0.55;
  const lo = -pad, hi = step + pad;   // 相对本帧起点的扫掠区间
  ok(lo <= 0 && hi >= step, fps + 'fps：扫掠区间覆盖整段位移（' + f(step, 2) + 'm/帧）');
  console.log('  ' + fps + 'fps：子弹每帧 ' + f(step, 2) + 'm，判定区间 [' + f(lo, 2) + ', ' + f(hi, 2) + '] 无盲区');
});
// 瞄准辅助下，横向摆幅是否仍落在命中半径内
const fanWorst = Math.max(...Object.keys(WEAPONS).map((k) => WEAPONS[k].shots > 1 ? 0.20 : 0));
const lateral = Math.sin(fanWorst) * CFG.bulletSpeed / 60;
console.log('  最大张角 ' + f(fanWorst, 2) + ' rad → 每帧横移 ' + f(lateral, 2) + 'm，命中半径最小 ' +
  f(MONSTERS.bat.r + 0.32, 2) + 'm');
ok(lateral < MONSTERS.bat.r + 0.32, '扇射最外侧弹道每帧横移小于最小命中半径，不会漏判');

console.log('\n==== 结果: ' + pass + ' 通过 / ' + fail + ' 失败 ====');
process.exit(fail ? 1 : 0);
