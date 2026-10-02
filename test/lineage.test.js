import { test } from 'node:test';
import assert from 'node:assert/strict';
import { solveLineage, validateInput, MIN_FRAMES } from '../src/lineage.js';

const S = (id, x, y, brightness = 10) => ({ id, x, y, brightness });

/** 由解出的谱系派生每个斑点的入度（非起始斑点须恰为 1） */
function indegrees(lineage) {
  const deg = new Map();
  for (const link of lineage.links) {
    const to = `${link.to.frame}:${link.to.spot.id}`;
    deg.set(to, (deg.get(to) ?? 0) + 1);
  }
  return deg;
}

function adoptedIds(lineage, f) {
  return lineage.adopted.filter((a) => a.frame === f).map((a) => a.spot.id);
}

/** 校验谱系结构性约束，返回问题数组 */
function checkStructure(lineage, input, opts) {
  const problems = [];
  const n = input.length;
  const deg = indegrees(lineage);

  for (const a of lineage.adopted) {
    const key = `${a.frame}:${a.spot.id}`;
    if (a.frame === 0) {
      if (a.spot.id !== opts.startId) problems.push(`第 1 帧采用了非起始斑点 ${a.spot.id}`);
    } else if ((deg.get(key) ?? 0) !== 1) {
      problems.push(`非起始斑点 ${key} 的祖先数为 ${deg.get(key) ?? 0}（应为 1）`);
    }
  }
  // 同一斑点不得归入两支：出向连接目标不可重复（入度已覆盖）；分裂恰为 2、保持恰为 1
  const outByParent = new Map();
  for (const link of lineage.links) {
    const key = `${link.from.frame}:${link.from.spot.id}`;
    if (!outByParent.has(key)) outByParent.set(key, []);
    outByParent.get(key).push(link);
  }
  for (const [key, ls] of outByParent) {
    const directs = ls.filter((l) => l.kind === 'direct');
    const skips = ls.filter((l) => l.kind === 'skip');
    if (directs.length + skips.length > 2) problems.push(`${key} 后代超过 2`);
    if (directs.length === 1 && skips.length !== 0) problems.push(`${key} 既保持又漏检`);
    if (directs.length === 2 && skips.length !== 0) problems.push(`${key} 既分裂又漏检`);
    if (directs.length === 2 && directs[0].to.spot.id === directs[1].to.spot.id &&
        directs[0].to.frame === directs[1].to.frame) {
      problems.push(`${key} 分裂到同一斑点`);
    }
    if (skips.length > 1) problems.push(`${key} 跨帧后代超过 1`);
  }
  // 位移约束
  for (const link of lineage.links) {
    for (const seg of link.segments) {
      if (seg.distance > opts.maxMove + 1e-9) {
        problems.push(`连线 ${JSON.stringify(seg.from)} -> ${JSON.stringify(seg.to)} 段位移 ${seg.distance} 超限`);
      }
    }
  }
  // 末帧存活数
  if (lineage.survivors.length !== opts.survivors) problems.push('末帧存活数不符');
  // 总亮度
  const total = lineage.adopted.reduce((sum, a) => sum + a.spot.brightness, 0);
  if (total !== lineage.totalBrightness) problems.push('总亮度统计错误');
  // 漏检数
  const skipCount = lineage.links.filter((l) => l.kind === 'skip').length;
  if (skipCount !== lineage.misses) problems.push('漏检数统计错误');
  if (lineage.misses > opts.maxSkip) problems.push('漏检数超限');
  return problems;
}

test('基本场景：保持为一个后代，所有帧连通', () => {
  const frames = [
    [S('a', 0, 0, 10), S('z', 9, 9, 5)],
    [S('b', 1, 0, 10), S('z', 9, 9, 5)],
    [S('c', 2, 0, 10), S('z', 9, 9, 5)],
    [S('d', 3, 0, 10), S('z', 9, 9, 5)],
  ];
  const opts = { startId: 'a', maxMove: 3, maxSkip: 0, survivors: 1 };
  const r = solveLineage(frames, opts);
  assert.equal(r.ok, true);
  assert.deepEqual(r.lineage.survivors, ['d']);
  assert.equal(r.lineage.misses, 0);
  assert.deepEqual(checkStructure(r.lineage, frames, opts), []);
});

test('分裂场景：1 -> 2，末帧恰存活两个细胞', () => {
  const frames = [
    [S('a', 0, 0, 10), S('q', 5, 5, 1)],
    [S('b1', 1, 1, 10), S('b2', 1, -1, 10), S('q', 5, 5, 1)],
    [S('c1', 2, 1, 10), S('c2', 2, -1, 10), S('q', 5, 5, 1)],
    [S('d1', 3, 1, 10), S('d2', 3, -1, 10), S('q', 5, 5, 1)],
  ];
  const opts = { startId: 'a', maxMove: 3, maxSkip: 0, survivors: 2 };
  const r = solveLineage(frames, opts);
  assert.equal(r.ok, true);
  assert.deepEqual(r.lineage.survivors.sort(), ['d1', 'd2']);
  assert.deepEqual(checkStructure(r.lineage, frames, opts), []);
  // 第 2 帧必须同时采用 b1、b2（一次分裂，而非逐帧挑选最亮的杂质 q）
  assert.deepEqual(adoptedIds(r.lineage, 1).sort(), ['b1', 'b2']);
});

test('不可逐帧贪心：亮杂质无法到达末帧，谱系必须避开它', () => {
  const frames = [
    [S('a', 0, 0, 10), S('imp1', 3, 3, 99)],
    [S('b', 1, 0, 10), S('imp2', 3, 3, 99)],
    [S('c', 2, 0, 10), S('imp3', 9, 9, 99)],
    [S('d', 3, 0, 10), S('imp4', 9, 9, 99)],
  ];
  const opts = { startId: 'a', maxMove: 2, maxSkip: 0, survivors: 1 };
  const r = solveLineage(frames, opts);
  assert.equal(r.ok, true);
  assert.deepEqual(r.lineage.survivors, ['d']);
  for (let f = 0; f < 4; f++) assert.deepEqual(adoptedIds(r.lineage, f), [f === 0 ? 'a' : 'bcd'[f - 1]]);
});

test('漏检跨帧：中间帧唯一路径缺失时用 skip 连接', () => {
  const frames = [
    [S('a', 0, 0, 10), S('z', 8, 8, 1)],
    [S('z1', 8, 8, 1), S('z2', 8, 9, 1)], // a 附近无斑点
    [S('c', 2, 0, 10), S('z', 8, 8, 1)],
    [S('d', 3, 0, 10), S('z', 8, 8, 1)],
  ];
  const opts = { startId: 'a', maxMove: 2, maxSkip: 1, survivors: 1 };
  const r = solveLineage(frames, opts);
  assert.equal(r.ok, true);
  assert.equal(r.lineage.misses, 1);
  assert.deepEqual(r.lineage.survivors, ['d']);
  const skip = r.lineage.links.find((l) => l.kind === 'skip');
  assert.ok(skip);
  assert.equal(skip.from.frame, 0);
  assert.equal(skip.from.spot.id, 'a');
  assert.equal(skip.to.frame, 2);
  assert.equal(skip.to.spot.id, 'c');
  assert.deepEqual(checkStructure(r.lineage, frames, opts), []);
});

test('禁止漏检时同样场景不可行，指出最早断开的帧间', () => {
  const frames = [
    [S('a', 0, 0, 10), S('z', 8, 8, 1)],
    [S('z1', 8, 8, 1), S('z2', 8, 9, 1)],
    [S('c', 2, 0, 10), S('z', 8, 8, 1)],
    [S('d', 3, 0, 10), S('z', 8, 8, 1)],
  ];
  const opts = { startId: 'a', maxMove: 2, maxSkip: 0, survivors: 1 };
  const r = solveLineage(frames, opts);
  assert.equal(r.ok, false);
  assert.equal(r.brokenGap, 0); // 第 1 帧与第 2 帧之间最先断开
});

test('裁决：总亮度优先于漏检数（更亮路径多一次漏检仍胜出）', () => {
  // 直连走廊暗：a -> b(亮1) -> c(亮1) -> d(亮1)
  // 漏检走廊亮：a 跳过第 2 帧 -> c′(亮100) -> d′(亮100)
  const frames = [
    [S('a', 0, 0, 10), S('z', 9, 9, 1)],
    [S('b', 1, 0, 1), S('z', 9, 9, 1)],
    [S('c', 2, 0, 1), S('cp', 2, 3, 100)],
    [S('d', 3, 0, 1), S('dp', 3, 3, 100)],
  ];
  const opts = { startId: 'a', maxMove: 3, maxSkip: 1, survivors: 1 };
  const r = solveLineage(frames, opts);
  assert.equal(r.ok, true);
  assert.equal(r.lineage.misses, 1);
  assert.equal(r.lineage.totalBrightness, 210);
  assert.deepEqual(r.lineage.survivors, ['dp']);
  const skip = r.lineage.links.find((l) => l.kind === 'skip');
  assert.ok(skip);
  assert.equal(skip.from.spot.id, 'a');
  assert.equal(skip.to.spot.id, 'cp');
  assert.deepEqual(checkStructure(r.lineage, frames, opts), []);
});

test('裁决：总亮度相同则漏检数更少者胜', () => {
  // 中间帧斑点亮度为 0：跳过它与直连经过它总亮度相同，直连漏检数更少
  const frames = [
    [S('a', 0, 0, 10), S('x', 6, 6, 1)],
    [S('b', 1, 0, 0), S('x', 6, 6, 1)],
    [S('c', 2, 0, 10), S('x', 6, 6, 1)],
    [S('d', 3, 0, 10), S('x', 6, 6, 1)],
  ];
  const opts = { startId: 'a', maxMove: 3, maxSkip: 2, survivors: 1 };
  const r = solveLineage(frames, opts);
  assert.equal(r.ok, true);
  assert.equal(r.lineage.misses, 0);
  assert.equal(r.lineage.totalBrightness, 30);
});

test('存活数无法满足：末帧只有一条可达支但要求存活 2', () => {
  const frames = [
    [S('a', 0, 0, 10), S('z', 9, 9, 1)],
    [S('b', 1, 0, 10), S('z', 9, 9, 1)],
    [S('c', 2, 0, 10), S('z', 9, 9, 1)],
    [S('d', 3, 0, 10), S('z', 9, 9, 1)],
  ];
  const opts = { startId: 'a', maxMove: 2, maxSkip: 0, survivors: 2 };
  const r = solveLineage(frames, opts);
  assert.equal(r.ok, false);
  assert.equal(r.brokenGap, 0); // 第 1 个帧间就无法产生两个可存活后代
});

test('分裂后两条支各自保持，非起始斑点入度恰为 1', () => {
  const frames = [
    [S('a', 0, 0, 10), S('q', 5, 5, 1)],
    [S('b1', 1, 1, 10), S('b2', 1, -1, 10), S('q', 5, 5, 1)],
    [S('c1', 2, 1, 10), S('c2', 2, -1, 10), S('q', 5, 5, 1)],
    [S('e1', 3, 1, 10), S('e2', 3, -1, 10), S('q', 5, 5, 1)],
  ];
  const opts = { startId: 'a', maxMove: 3, maxSkip: 1, survivors: 2 };
  const r = solveLineage(frames, opts);
  assert.equal(r.ok, true);
  const deg = indegrees(r.lineage);
  for (const a of r.lineage.adopted) {
    if (a.frame > 0) assert.equal(deg.get(`${a.frame}:${a.spot.id}`), 1);
  }
  assert.deepEqual(checkStructure(r.lineage, frames, opts), []);
});

test('分裂与漏检混合烟测：7 帧、8 斑点、先分裂后一支漏检', () => {
  // 起点 (0,0) 在第 1 个帧间分裂为上支 u(i,1) 与下支 v(i,-1)；
  // 下支在第 4 帧（索引 3）漏检，跨帧连接 v2 -> v4
  const f = (i) => {
    const spots = [];
    if (i === 0) spots.push(S('u0', 0, 0, 10));
    else spots.push(S(`u${i}`, i, 1, 10));
    if (i !== 0 && i !== 3) spots.push(S(`v${i}`, i, -1, 10));
    while (spots.length < 8) spots.push(S(`w${i}_${spots.length}`, 9 + spots.length, 9 + spots.length, 1));
    return spots;
  };
  const frames = Array.from({ length: 7 }, (_, i) => f(i));
  const opts = { startId: 'u0', maxMove: 2, maxSkip: 2, survivors: 2 };
  const r = solveLineage(frames, opts);
  assert.equal(r.ok, true);
  assert.deepEqual(r.lineage.survivors.sort(), ['u6', 'v6']);
  assert.equal(r.lineage.misses, 1);
  assert.deepEqual(checkStructure(r.lineage, frames, opts), []);
});

test('同一斑点不得归入两支：近距离候选共享时只能选一条', () => {
  // 第 2 帧只有 b 一个可达点，两个亲代不可能都接到 b
  const frames = [
    [S('a', 0, 0, 10), S('p', 0, 1, 10)],
    [S('x1', 0, 0, 10), S('x2', 0, 1, 10)],
    [S('b', 0, 0, 10), S('q', 8, 8, 1)],
    [S('d', 0, 0, 10), S('q', 8, 8, 1)],
  ];
  // 从 a 分裂到 x1/x2，第 3 帧 x2 无处可去 → 存活 2 不可行
  const opts = { startId: 'a', maxMove: 2, maxSkip: 0, survivors: 2 };
  const r = solveLineage(frames, opts);
  assert.equal(r.ok, false);
  assert.equal(typeof r.brokenGap, 'number');
});

test('跨帧位移：总距离 2*maxMove 且两段均不超限可通过', () => {
  const frames = [
    [S('a', 0, 0, 10), S('z', 9, 9, 1)],
    [S('z1', 9, 9, 1), S('z2', 9, 8, 1)],
    [S('c', 2, 0, 10), S('z', 9, 9, 1)],
    [S('d', 3, 0, 10), S('z', 9, 9, 1)],
  ];
  const opts = { startId: 'a', maxMove: Math.SQRT2, maxSkip: 1, survivors: 1 };
  const r = solveLineage(frames, opts);
  assert.equal(r.ok, true);
  assert.equal(r.lineage.misses, 1);
});

test('校验：帧数、斑点数、坐标、亮度、参数', () => {
  const good = [
    [S('a', 0, 0), S('b', 1, 1)],
    [S('c', 1, 0), S('d', 2, 1)],
    [S('e', 2, 0), S('f', 3, 1)],
    [S('g', 3, 0), S('h', 4, 1)],
  ];
  assert.deepEqual(validateInput(good, { startId: 'a', maxMove: 3, maxSkip: 0, survivors: 1 }), []);
  const tooFew = good.slice(0, MIN_FRAMES - 1);
  assert.ok(validateInput(tooFew, { startId: 'a', maxMove: 3, maxSkip: 0, survivors: 1 }).length > 0);
  const badCoord = good.map((fr, i) => i === 0 ? [{ id: 'a', x: 0.5, y: 0, brightness: 1 }, S('b', 1, 1)] : fr);
  assert.ok(validateInput(badCoord, { startId: 'a', maxMove: 3, maxSkip: 0, survivors: 1 }).join().includes('整数'));
  assert.ok(validateInput(good, { startId: 'zzz', maxMove: 3, maxSkip: 0, survivors: 1 }).join().includes('起始斑点'));
  assert.ok(validateInput(good, { startId: 'a', maxMove: 3, maxSkip: 0, survivors: 9 }).join().includes('存活'));
});

test('稳定裁决：对称数据按输入顺序给出确定结果', () => {
  const mk = () => [
    [S('a', 0, 0, 10), S('z', 9, 9, 1)],
    [S('b', 1, 0, 10), S('z', 9, 9, 1)],
    [S('c', 2, 0, 10), S('z', 9, 9, 1)],
    [S('d', 3, 0, 10), S('z', 9, 9, 1)],
  ];
  const r1 = solveLineage(mk(), { startId: 'a', maxMove: 3, maxSkip: 0, survivors: 1 });
  const r2 = solveLineage(mk(), { startId: 'a', maxMove: 3, maxSkip: 0, survivors: 1 });
  assert.deepEqual(r1.lineage.adopted, r2.lineage.adopted);
  assert.deepEqual(r1.lineage.links.map((l) => [l.from.spot.id, l.to.spot.id]),
                   r2.lineage.links.map((l) => [l.from.spot.id, l.to.spot.id]));
});
