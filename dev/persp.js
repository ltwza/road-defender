/* ============================================================================
 *  透视剖面 —— 沿线深度量「路面相对两侧地面凸出来多少」，判断路的远端有没有"翻出来"
 *
 *  为什么需要它：用户说"路的焦点太清晰"，但"清晰"没法直接调参 ——
 *  得先把它变成一条曲线。
 *
 *  判据 B（主判据）—— 通道差必须随距离衰减到 0
 *    真实照片里，路和地面在远处被大气洗成同一个色，看不出边界。
 *    所以「路面 RGB − 同 y 的地面 RGB」的**逐通道最大差**必须随深度衰减，
 *    到 640m/900m 时应当只剩个位数。远端仍明显非 0 = 路从背景里翻出来、
 *    变成插在地平线上的一座尖塔 —— 这正是"焦点太清晰"的量化定义。
 *
 *    为什么用逐通道最大差而不是亮度差：沙漠图上路面 RGB(175,134,98)、
 *    沙地 RGB(182,128,75)，亮度只差 5 级（路还更亮一点），但色相差得很远，
 *    肉眼一眼就能看出边界。只量亮度会直接漏判 —— 这个坑是
 *    "数值说没有路、放大图说路很硬"两边对不上才揪出来的。
 *
 *  判据 A（参考）—— 路面自身的亮度随距离**不得下降**
 *    大气会把远处的东西往雾色上提，所以真实照片里路面是"越远越亮"的
 *    （近处深黑、远处浅灰，Route 66 那张就是这样）。越远越暗只有一个解释：
 *    路面没被大气影响，于是从背景里凸出来。
 *
 *  实测（改前 → 改后，判据 B 的 900m 通道差）：
 *      夜 42 → 6      昼 58 → 14      沙漠 61 → 7
 *
 *  用法：
 *    node dev/persp.js                             # 三张地图都跑
 *    node dev/persp.js night,desert                # 只跑指定地图
 *    node dev/persp.js night --game=_game-old.js   # 修复前对照（需先 git show 取旧版）
 *
 *  ⚠ 只读诊断，不进自动化测试 —— 它要在真 Chrome 里读画布像素，
 *    而 e2e 跑在 jsdom 上（canvas 是桩，读不到像素）。
 *    改路面配色、雾参数、消失点、k 值之后请手动跑一次。
 * ========================================================================== */
const path = require('path');
const { execSync } = require('child_process');
const DIR = path.join(__dirname, '..');

/* 通道差的通过线。定 20 的依据：三张图改完之后实测 6 / 14 / 7，
 * 留出 1.4 倍的余量；而改之前是 42 / 58 / 61，离这条线远得很 ——
 * 判据在修复前后都能明确分开，不是摆设。 */
const CH_MAX = 20;

const maps = (process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : 'night,day,desert').split(',');
const gameArg = process.argv.find((a) => a.startsWith('--game='));
const game = gameArg ? ' --game=' + gameArg.slice(7) : '';

let bad = 0;
for (const mp of maps) {
  /* --noscenery 是关键：把装饰整片关掉，屏幕边缘那几列才是**纯背景色**，
   * 拿它当"这个深度本该有的地面色"才站得住。 */
  const cmd = 'node dev/shot.js _persp --bare --noscenery --map=' + mp + game +
    ' --probefile=dev/persp-probe.js';
  let out = '';
  try {
    out = execSync(cmd, { cwd: DIR, encoding: 'utf8', maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    out = ((e.stdout || '') + (e.stderr || ''));
  }
  const m = out.match(/^--probe → (.*)$/m);
  if (!m) { console.log('[' + mp + '] 探针无输出：\n' + out.slice(-500)); bad++; continue; }
  let table;
  try { table = JSON.parse(m[1]); } catch (e) {
    console.log('[' + mp + '] 解析失败：' + m[1].slice(0, 200)); bad++; continue;
  }
  console.log('\n' + table);

  const rows = [];
  for (const line of table.split('\n')) {
    const r = /^\s*(\d+)m\s+(\d+)\s+([\d.]+|--)\s+([\d.]+|--)\s+([\d.]+|--)\s+(-?[\d.]+|--)\s+(\d+|--)/.exec(line);
    if (r) rows.push({ d: +r[1], roadL: parseFloat(r[3]), dC: r[7] === '--' ? null : +r[7] });
  }
  const at = (d) => rows.find((x) => x.d === d);

  /* ── 判据 B：通道差在远端必须收敛 ── */
  const f640 = at(640), f900 = at(900), n230 = at(230), n110 = at(110);
  if (f640 && f900 && f640.dC !== null && f900.dC !== null) {
    const worst = Math.max(f640.dC, f900.dC);
    const ok = worst <= CH_MAX;
    if (!ok) bad++;
    /* "从哪一深度开始看不出边界"：通道差第一次掉到 10 以下的那个深度。
     * 这个数字比"通过/不通过"更能说明画面变成了什么样。 */
    const fade = rows.filter((x) => x.dC !== null);
    let first = null;
    for (let i = fade.length - 1; i >= 0; i--) {
      if (fade[i].dC < 10) { first = fade[i].d; } else { break; }
    }
    console.log('  远端通道差 640m ' + f640.dC + ' / 900m ' + f900.dC +
      '（上限 ' + CH_MAX + '）  →  ' + (ok ? 'OK（路面融进地面，看不出边界）'
        : '⚠ 路从背景里翻出来了：远端仍比地面显眼 ' + worst + ' 级'));
    if (first !== null) console.log('  通道差 <10 的最近深度：' + first + 'm —— 再远就只剩大气，看不出路了');
    if (n110 && n230 && n110.dC !== null && n230.dC !== null) {
      console.log('  对照：110m 通道差 ' + n110.dC + '，230m ' + n230.dC +
        '（这两个深度必须**看得出**路，否则是把整条路都洗没了）');
      if (n110.dC < 15) { bad++; console.log('  ⚠ 110m 就低于 15：洗过头了，近景的路也不见了'); }
    }
  } else {
    console.log('  ⚠ 拿不到 640m / 900m 的样本'); bad++;
  }

  /* ── 判据 A：路面自身亮度随距离不得下降 ── */
  const r230 = at(230), r900 = at(900);
  if (r230 && r900 && r230.roadL !== null && r900.roadL !== null) {
    const drop = r230.roadL - r900.roadL;
    const ok = drop <= 3;
    if (!ok) bad++;
    console.log('  路面亮度 230m→900m：' + r230.roadL.toFixed(1) + ' → ' + r900.roadL.toFixed(1) +
      '（' + (drop >= 0 ? '降' : '升') + Math.abs(drop).toFixed(1) + '）  →  ' +
      (ok ? 'OK（远端被大气提亮）' : '⚠ 远端变暗：路面没被大气影响'));
  }
}
process.exit(bad ? 1 : 0);
