import { test } from 'node:test';
import assert from 'node:assert/strict';
import { solveLineage, validateInput, isIntCoord } from '../src/lineage.js';

const S = (id, x, y, brightness = 10) => ({ id, x, y, brightness });
const P53 = '9007199254740992';   // 2^53（double 可精确表示）
const P53_1 = '9007199254740993'; // 2^53 + 1（double 不可表示，Number 解析会丢成 2^53）
const P53_2 = '9007199254740994'; // 2^53 + 2
const P53_3 = '9007199254740995'; // 2^53 + 3

/** 任务回归场景：4 帧，唯一候选延续斑点横坐标 2^53 → 2^53+1，精确相差 1 */
const bigFrames = () => [
  [S('p0', P53, '0'), S('q0', 0, 0, 1)],
  [S('p1', P53_1, '0'), S('q1', 0, 0, 1)],
  [S('p2', P53_1, '0'), S('q2', 0, 0, 1)],
  [S('p3', P53_1, '0'), S('q3', 0, 0, 1)],
];

test('超大整数坐标不被校验拒绝（契约允许，不设安全整数上限）', () => {
  const opts = { startId: 'p0', maxMove: 0, maxSkip: 0, survivors: 1 };
  assert.deepEqual(validateInput(bigFrames(), opts), []);
  assert.ok(isIntCoord(P53_1));
  assert.ok(isIntCoord(9007199254740992)); // 可精确表示的 number 照常接受
  assert.ok(isIntCoord(9007199254740993n)); // bigint 同样接受
  assert.ok(!isIntCoord('1.5'));
  assert.ok(!isIntCoord(''));
  assert.ok(!isIntCoord(0.5));
});

test('回归：相差 1 的超大坐标（2^53 → 2^53+1）在最大位移 0 下不得连接', () => {
  const r = solveLineage(bigFrames(), { startId: 'p0', maxMove: 0, maxSkip: 0, survivors: 1 });
  assert.equal(r.ok, false);
  assert.equal(r.brokenGap, 0); // 最早断开：第 1 帧与第 2 帧之间
});

test('同一数据最大位移改为 1 即可行：采用 p 链、末帧 p3、总亮度 40', () => {
  const r = solveLineage(bigFrames(), { startId: 'p0', maxMove: 1, maxSkip: 0, survivors: 1 });
  assert.equal(r.ok, true);
  assert.deepEqual(r.lineage.survivors, ['p3']);
  assert.equal(r.lineage.totalBrightness, 40);
  assert.equal(r.lineage.misses, 0);
  for (const link of r.lineage.links) {
    for (const seg of link.segments) assert.ok(seg.distance <= 1);
  }
  // 结果回显保留精确的十进制坐标文本
  const p1 = r.lineage.adopted.find((a) => a.spot.id === 'p1');
  assert.equal(p1.spot.x, P53_1);
});

test('number 与字符串坐标混合录入：2^53 以 number 给出时结论一致', () => {
  const frames = bigFrames();
  frames[0][0] = S('p0', 9007199254740992, 0); // 2^53 可精确表示为 number
  const r = solveLineage(frames, { startId: 'p0', maxMove: 0, maxSkip: 0, survivors: 1 });
  assert.equal(r.ok, false);
  assert.equal(r.brokenGap, 0);
});

test('坐标完全相同（距离 0）的超大坐标在最大位移 0 下可行', () => {
  const frames = [
    [S('p0', P53, P53), S('q0', 0, 0, 1)],
    [S('p1', P53, P53), S('q1', 0, 0, 1)],
    [S('p2', P53, P53), S('q2', 0, 0, 1)],
    [S('p3', P53, P53), S('q3', 0, 0, 1)],
  ];
  const r = solveLineage(frames, { startId: 'p0', maxMove: 0, maxSkip: 0, survivors: 1 });
  assert.equal(r.ok, true);
  assert.equal(r.lineage.totalBrightness, 40);
  assert.deepEqual(r.lineage.survivors, ['p3']);
});

test('普通整数坐标：字符串录入与数值录入的谱系选择完全一致', () => {
  const mk = (c) => [
    [S('a', c(0), c(0), 10), S('q', c(5), c(5), 1)],
    [S('b1', c(1), c(1), 10), S('b2', c(1), c(-1), 10), S('q', c(5), c(5), 1)],
    [S('c1', c(2), c(1), 10), S('c2', c(2), c(-1), 10), S('q', c(5), c(5), 1)],
    [S('d1', c(3), c(1), 10), S('d2', c(3), c(-1), 10), S('q', c(5), c(5), 1)],
  ];
  const opts = { startId: 'a', maxMove: 3, maxSkip: 0, survivors: 2 };
  const rn = solveLineage(mk((v) => v), opts);
  const rs = solveLineage(mk((v) => String(v)), opts);
  assert.equal(rn.ok, true);
  assert.equal(rs.ok, true);
  assert.deepEqual(rs.lineage.adopted.map((a) => [a.frame, a.spot.id]),
                   rn.lineage.adopted.map((a) => [a.frame, a.spot.id]));
  assert.deepEqual(rs.lineage.links.map((l) => [l.kind, l.from.spot.id, l.to.spot.id]),
                   rn.lineage.links.map((l) => [l.kind, l.from.spot.id, l.to.spot.id]));
  assert.equal(rs.lineage.totalBrightness, rn.lineage.totalBrightness);
  assert.equal(rs.lineage.misses, rn.lineage.misses);
});

test('小数最大位移：0.5 断开距离 1；1.5 接通距离 1、断开距离 2', () => {
  const mk = (step) => [
    [S('a', 0, 0), S('z', 50, 50, 1)],
    [S('b', step, 0), S('z', 50, 50, 1)],
    [S('c', 2 * step, 0), S('z', 50, 50, 1)],
    [S('d', 3 * step, 0), S('z', 50, 50, 1)],
  ];
  const r1 = solveLineage(mk(1), { startId: 'a', maxMove: 0.5, maxSkip: 0, survivors: 1 });
  assert.equal(r1.ok, false);
  assert.equal(r1.brokenGap, 0);
  const r2 = solveLineage(mk(1), { startId: 'a', maxMove: 1.5, maxSkip: 0, survivors: 1 });
  assert.equal(r2.ok, true);
  assert.deepEqual(r2.lineage.survivors, ['d']);
  const r3 = solveLineage(mk(2), { startId: 'a', maxMove: 1.5, maxSkip: 0, survivors: 1 });
  assert.equal(r3.ok, false);
  assert.equal(r3.brokenGap, 0);
});

test('科学计数法最大位移：1e1 即 10，距离 10 接通、距离 11 断开', () => {
  const mk = (step) => [
    [S('a', 0, 0), S('z', 99, 99, 1)],
    [S('b', step, 0), S('z', 99, 99, 1)],
    [S('c', 2 * step, 0), S('z', 99, 99, 1)],
    [S('d', 3 * step, 0), S('z', 99, 99, 1)],
  ];
  const ok = solveLineage(mk(10), { startId: 'a', maxMove: 1e1, maxSkip: 0, survivors: 1 });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.lineage.survivors, ['d']);
  const no = solveLineage(mk(11), { startId: 'a', maxMove: 1e1, maxSkip: 0, survivors: 1 });
  assert.equal(no.ok, false);
  assert.equal(no.brokenGap, 0);
});

test('临界边界：距离恰等于最大位移可连接，小 1 ulp 即断开', () => {
  const mk = () => [
    [S('a', 0, 0), S('z', 50, 50, 1)],
    [S('b', 2, 0), S('z', 50, 50, 1)],
    [S('c', 4, 0), S('z', 50, 50, 1)],
    [S('d', 6, 0), S('z', 50, 50, 1)],
  ];
  const eq = solveLineage(mk(), { startId: 'a', maxMove: 2, maxSkip: 0, survivors: 1 });
  assert.equal(eq.ok, true);
  // 2 之下最大的 double：距离 2 已超限
  const below = solveLineage(mk(), { startId: 'a', maxMove: 1.9999999999999998, maxSkip: 0, survivors: 1 });
  assert.equal(below.ok, false);
  assert.equal(below.brokenGap, 0);
});

test('临界边界（对角线）：3-4-5 距离恰为 5 可连接，最大位移小一点即断开', () => {
  const mk = () => [
    [S('a', 0, 0), S('z', 50, 50, 1)],
    [S('b', 3, 4), S('z', 50, 50, 1)],
    [S('c', 6, 8), S('z', 50, 50, 1)],
    [S('d', 9, 12), S('z', 50, 50, 1)],
  ];
  const ok = solveLineage(mk(), { startId: 'a', maxMove: 5, maxSkip: 0, survivors: 1 });
  assert.equal(ok.ok, true);
  const no = solveLineage(mk(), { startId: 'a', maxMove: 4.999999999999999, maxSkip: 0, survivors: 1 });
  assert.equal(no.ok, false);
  assert.equal(no.brokenGap, 0);
});

test('临界边界（超大坐标）：距离恰为 2^53 可连接，超出 2 即断开', () => {
  // 干扰斑点放在 (0, 2^53+3)：距 a 与 b 都超过 2^53，不构成可用延续
  const mk = (dx) => [
    [S('a', 0, 0), S('z', 0, P53_3, 1)],
    [S('b', dx, 0), S('z', 0, P53_3, 1)],
    [S('c', dx, 0), S('z', 0, P53_3, 1)],
    [S('d', dx, 0), S('z', 0, P53_3, 1)],
  ];
  const opts = { startId: 'a', maxMove: 9007199254740992, maxSkip: 0, survivors: 1 };
  const ok = solveLineage(mk(P53), opts);
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.lineage.survivors, ['d']);
  const no = solveLineage(mk(P53_2), opts);
  assert.equal(no.ok, false);
  assert.equal(no.brokenGap, 0);
});

test('超大坐标下的跨帧漏检：两段位移恰为最大位移可通过', () => {
  // p0(2^53) 跳过第 2 帧落到 p2(2^53+2)：总距离 2，每段 1 ≤ 最大位移 1
  const frames = [
    [S('p0', P53, '0'), S('q0', 0, 0, 1)],
    [S('z1', 0, 0, 1), S('z2', 0, 5, 1)], // p0 附近无斑点
    [S('p2', P53_2, '0'), S('q2', 0, 0, 1)],
    [S('p3', P53_2, '0'), S('q3', 0, 0, 1)],
  ];
  const r = solveLineage(frames, { startId: 'p0', maxMove: 1, maxSkip: 1, survivors: 1 });
  assert.equal(r.ok, true);
  assert.equal(r.lineage.misses, 1);
  assert.equal(r.lineage.totalBrightness, 30);
  assert.deepEqual(r.lineage.survivors, ['p3']);
  const skip = r.lineage.links.find((l) => l.kind === 'skip');
  assert.ok(skip);
  assert.equal(skip.from.spot.id, 'p0');
  assert.equal(skip.to.spot.id, 'p2');
  for (const seg of skip.segments) assert.ok(seg.distance <= 1);
  // 禁漏检时同一数据不可行，最早断在第 1 帧与第 2 帧之间
  const no = solveLineage(frames, { startId: 'p0', maxMove: 1, maxSkip: 0, survivors: 1 });
  assert.equal(no.ok, false);
  assert.equal(no.brokenGap, 0);
});

test('跨帧漏检的临界边界：总距离超出 2×最大位移即断开', () => {
  // p0(2^53) → p2(2^53+3)：总距离 3 > 2×1，漏检也不允许
  const frames = [
    [S('p0', P53, '0'), S('q0', 0, 0, 1)],
    [S('z1', 0, 0, 1), S('z2', 0, 5, 1)],
    [S('p2', P53_3, '0'), S('q2', 0, 0, 1)],
    [S('p3', P53_3, '0'), S('q3', 0, 0, 1)],
  ];
  const r = solveLineage(frames, { startId: 'p0', maxMove: 1, maxSkip: 1, survivors: 1 });
  assert.equal(r.ok, false);
  assert.equal(r.brokenGap, 0);
});
