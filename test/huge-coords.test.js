/**
 * 超大整数坐标（超出双精度可精确表示范围）的回归测试：
 * 坐标相差 1 的超大值不得被错误复原为连续谱系；
 * 同时覆盖普通整数坐标的既有行为、漏检跨帧连接，以及
 * 最大位移的小数 / 科学计数法 / 临界边界场景。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { solveLineage, validateInput } from '../src/lineage.js';
import { installDom } from './helpers/dom.js';

const S = (id, x, y, brightness = 10) => ({ id, x, y, brightness });

// 2^53（恰可精确表示）与 2^53+1（超出双精度精确范围，常被错误舍入为 2^53）
const H0 = '9007199254740992';
const H1 = '9007199254740993';

const hugeFrames = () => [
  [S('p0', H0, 0), S('j0', 0, 0, 1)],
  [S('p1', H1, 0), S('j1', 0, 0, 1)],
  [S('p2', H1, 0), S('j2', 0, 0, 1)],
  [S('p3', H1, 0), S('j3', 0, 0, 1)],
];

// ---------------- 求解器：超大整数坐标精确处理 ----------------

test('超大坐标相差 1、最大位移 0：不可行，最早断开第 1 帧与第 2 帧之间', () => {
  const r = solveLineage(hugeFrames(), { startId: 'p0', maxMove: 0, maxSkip: 0, survivors: 1 });
  assert.equal(r.ok, false);
  assert.equal(r.brokenGap, 0);
});

test('超大坐标：最大位移 1（临界边界，距离恰为 1）可行，采用斑点坐标精确', () => {
  const r = solveLineage(hugeFrames(), { startId: 'p0', maxMove: 1, maxSkip: 0, survivors: 1 });
  assert.equal(r.ok, true);
  assert.deepEqual(r.lineage.survivors, ['p3']);
  assert.equal(r.lineage.totalBrightness, 40);
  assert.equal(r.lineage.misses, 0);
  // 采用斑点的坐标保持精确（未被舍入为 9007199254740992）
  const p3 = r.lineage.adopted.find((a) => a.spot.id === 'p3');
  assert.equal(p3.spot.x, H1);
  // 逐段位移：首段恰为 1（=最大位移），其余为 0
  const dists = r.lineage.links.map((l) => l.segments[0].distance);
  assert.deepEqual(dists, [1, 0, 0]);
  for (const d of dists) assert.ok(d <= 1);
});

test('超大坐标：最大位移 0.5（小数，距离 1 超限）不可行', () => {
  const r = solveLineage(hugeFrames(), { startId: 'p0', maxMove: 0.5, maxSkip: 0, survivors: 1 });
  assert.equal(r.ok, false);
  assert.equal(r.brokenGap, 0);
});

test('超大坐标：number 与字符串坐标混合时同样精确', () => {
  const frames = hugeFrames().map((spots, f) => spots.map((s, i) =>
    (f === 0 && i === 0 ? { ...s, x: 9007199254740992 } : s)));
  const r0 = solveLineage(frames, { startId: 'p0', maxMove: 0, maxSkip: 0, survivors: 1 });
  assert.equal(r0.ok, false);
  assert.equal(r0.brokenGap, 0);
  const r1 = solveLineage(frames, { startId: 'p0', maxMove: 1, maxSkip: 0, survivors: 1 });
  assert.equal(r1.ok, true);
  assert.deepEqual(r1.lineage.survivors, ['p3']);
});

test('超大坐标 + 允许漏检：跨帧连接总位移恰为 2×最大位移（临界边界）可行', () => {
  const frames = [
    [S('p0', H0, 0), S('j0', 0, 0, 1)],
    [S('j1a', 0, 0, 1), S('j1b', 0, 1, 1)], // p0 附近无斑点，只能跨帧漏检
    [S('p2', H1, 0), S('j2', 0, 0, 1)],
    [S('p3', H1, 0), S('j3', 0, 0, 1)],
  ];
  // 跨帧总距离 1 = 2 × 0.5 → 两段各 0.5，恰不超最大位移
  const r = solveLineage(frames, { startId: 'p0', maxMove: 0.5, maxSkip: 1, survivors: 1 });
  assert.equal(r.ok, true);
  assert.equal(r.lineage.misses, 1);
  assert.deepEqual(r.lineage.survivors, ['p3']);
  const skip = r.lineage.links.find((l) => l.kind === 'skip');
  assert.ok(skip);
  assert.equal(skip.from.spot.id, 'p0');
  assert.equal(skip.to.spot.id, 'p2');
  assert.equal(skip.segments.length, 2);
  for (const seg of skip.segments) assert.ok(seg.distance <= 0.5 + 1e-9);

  // 0.4：跨帧总距离 1 > 2 × 0.4 → 不可行
  const r2 = solveLineage(frames, { startId: 'p0', maxMove: 0.4, maxSkip: 1, survivors: 1 });
  assert.equal(r2.ok, false);
});

test('超大坐标：距离恰为 2^53+1 时，maxMove 2^53 不可行、2^53+2 可行（精确边界）', () => {
  const frames = [
    [S('a', 0, 0), S('z', 0, H1, 1)],
    [S('b', H1, 0), S('z', 0, H1, 1)], // a→b 距离恰为 9007199254740993（2^53+1）
    [S('c', H1, 0), S('z', 0, H1, 1)],
    [S('d', H1, 0), S('z', 0, H1, 1)],
  ];
  // 距离 2^53+1 超过最大位移 2^53 → 不可行（相差 1 的超大坐标不得连接）
  const below = solveLineage(frames, { startId: 'a', maxMove: 9007199254740992, maxSkip: 0, survivors: 1 });
  assert.equal(below.ok, false);
  assert.equal(below.brokenGap, 0);
  // 最大位移 2^53+2（恰可表示）→ 可行
  const above = solveLineage(frames, { startId: 'a', maxMove: 9007199254740994, maxSkip: 0, survivors: 1 });
  assert.equal(above.ok, true);
  assert.deepEqual(above.lineage.survivors, ['d']);
  assert.equal(above.lineage.totalBrightness, 40);
});

test('普通整数坐标：小数、科学计数法与临界边界的最大位移', () => {
  const frames = [
    [S('a', 0, 0), S('z', 9, 9, 1)],
    [S('b', 3, 4), S('z', 9, 9, 1)], // 与 a 距离恰为 5（3-4-5）
    [S('c', 4, 4), S('z', 9, 9, 1)],
    [S('d', 5, 4), S('z', 9, 9, 1)],
  ];
  // 临界边界：距离 5 恰等于最大位移 5 → 可行
  const ok = solveLineage(frames, { startId: 'a', maxMove: 5, maxSkip: 0, survivors: 1 });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.lineage.survivors, ['d']);
  // 差 1 ulp 即不可行（精确比较，不为 0.000000000000001 的近似所容）
  const below = solveLineage(frames, { startId: 'a', maxMove: 4.999999999999999, maxSkip: 0, survivors: 1 });
  assert.equal(below.ok, false);
  // 科学计数法（1e1 = 10）→ 可行
  const sci = solveLineage(frames, { startId: 'a', maxMove: 1e1, maxSkip: 0, survivors: 1 });
  assert.equal(sci.ok, true);
  // 小数位移 4.9（距离 5 超限）→ 不可行
  const dec = solveLineage(frames, { startId: 'a', maxMove: 4.9, maxSkip: 0, survivors: 1 });
  assert.equal(dec.ok, false);
});

test('校验：超大整数坐标不被拒绝（契约允许整数坐标，不规定安全整数上限）', () => {
  assert.deepEqual(
    validateInput(hugeFrames(), { startId: 'p0', maxMove: 0, maxSkip: 0, survivors: 1 }), []);
  // 非整数坐标仍被拒绝
  const bad = hugeFrames().map((spots, f) => f === 0
    ? [{ ...spots[0], x: 0.5 }, spots[1]]
    : spots);
  assert.ok(validateInput(bad, { startId: 'p0', maxMove: 0, maxSkip: 0, survivors: 1 })
    .join().includes('整数'));
});

// ---------------- 页面：草稿恢复 → 复原 全流程 ----------------

// 草稿 JSON 中以原始十进制字面量承载超大坐标（模拟研究员保存的草稿）
const SEED = `{"frames":[
  [{"id":"p0","x":9007199254740992,"y":0,"brightness":10},{"id":"j0","x":0,"y":0,"brightness":1}],
  [{"id":"p1","x":9007199254740993,"y":0,"brightness":10},{"id":"j1","x":0,"y":0,"brightness":1}],
  [{"id":"p2","x":9007199254740993,"y":0,"brightness":10},{"id":"j2","x":0,"y":0,"brightness":1}],
  [{"id":"p3","x":9007199254740993,"y":0,"brightness":10},{"id":"j3","x":0,"y":0,"brightness":1}]
],"params":{"startId":"p0","maxMove":0,"maxSkip":0,"survivors":1}}`;

const dom = installDom();
dom.localStorage.setItem('algae-lineage-draft-v1', SEED);
await import('../public/app.js');

const byId = dom.byId;
const frameBlocks = () => byId('frames-editor')._walk()
  .filter((e) => e.classList.contains('frame-block'));
const xInputs = () => byId('frames-editor')._walk()
  .filter((e) => e.tagName === 'input' && e.dataset.field === 'x');
const adoptedText = () => byId('adopted-tables')._walk()
  .map((e) => e.textContent).filter(Boolean).join(' ');
const setMaxMove = (v) => {
  const el = byId('max-move');
  el.value = v;
  el.dispatch('input');
};

test('草稿恢复超大坐标：不可行、最早断开第 1 与第 2 帧之间、p3 未被采用、草稿保留', () => {
  // 草稿恢复后坐标精确（未被舍入为 9007199254740992）
  assert.equal(String(xInputs()[0].value), '9007199254740992');
  assert.equal(String(xInputs()[2].value), '9007199254740993');

  byId('btn-solve').dispatch('click');

  assert.equal(byId('broke-view').hidden, false);
  assert.match(byId('broke-view').innerHTML, /第 1 帧与第 2 帧之间/);
  // 不得把 p3 显示为已采用斑点
  assert.equal(byId('adopted-tables').children.length, 0);
  assert.ok(!adoptedText().includes('p3'));
  assert.equal(byId('summary').hidden, true);
  // 失败后草稿保留，供研究员修改限制或数据
  assert.equal(frameBlocks().length, 4);
  assert.equal(String(xInputs()[2].value), '9007199254740993');
});

test('修改限制后重新复原：边界 1 可行（p3 采用、总亮度 40）、0.5 不可行、1e0 可行', () => {
  setMaxMove('1');
  byId('btn-solve').dispatch('click');
  assert.equal(byId('broke-view').hidden, true);
  assert.equal(byId('summary').hidden, false);
  assert.match(byId('summary').innerHTML, /总亮度/);
  assert.match(byId('summary').innerHTML, /40/);
  assert.match(byId('summary').innerHTML, /p3/);
  // 采用斑点含 p3，且坐标精确显示（未被舍入）
  assert.ok(adoptedText().includes('p3'));
  assert.ok(adoptedText().includes('(9007199254740993, 0)'));
  // 逐段位移全部不超限
  const segHtml = dom.el('#segments-table tbody').children
    .map((r) => r.innerHTML).join('');
  assert.match(segHtml, /✓/);
  assert.ok(!segHtml.includes('✗'));

  // 0.5：距离 1 超过最大位移 → 不可行，最早断开第 1 帧间
  setMaxMove('0.5');
  byId('btn-solve').dispatch('click');
  assert.equal(byId('broke-view').hidden, false);
  assert.match(byId('broke-view').innerHTML, /第 1 帧与第 2 帧之间/);

  // 1e0（科学计数法）= 1 → 可行
  setMaxMove('1e0');
  byId('btn-solve').dispatch('click');
  assert.equal(byId('broke-view').hidden, true);
  assert.equal(byId('summary').hidden, false);
  assert.match(byId('summary').innerHTML, /40/);
});

test('录入超大整数坐标：精确保留、正确判定，草稿 localStorage 往返不丢精度', async () => {
  byId('btn-demo').dispatch('click'); // 重置为示例草稿并复原
  assert.equal(byId('result-view').hidden, false);

  const editor = byId('frames-editor');
  const xInput = editor._walk()
    .find((e) => e.tagName === 'input' && e.dataset.field === 'x');
  xInput.value = '9007199254740993';
  editor.dispatch('input', { target: xInput });
  byId('btn-solve').dispatch('click');
  // 起始斑点在 (9007199254740993, 0)，最大位移 2 → 第 1 帧间断开
  assert.equal(byId('broke-view').hidden, false);
  assert.match(byId('broke-view').innerHTML, /第 1 帧与第 2 帧之间/);

  // 草稿 localStorage 中的坐标保持精确（未被舍入为 9007199254740992）
  await new Promise((r) => setTimeout(r, 200)); // saveDraft 防抖 150ms
  const saved = dom.localStorage.getItem('algae-lineage-draft-v1');
  assert.ok(saved.includes('"x":"9007199254740993"'), saved);

  // 超大坐标并非被拒绝：位移上限足够大时精确参与计算并复原成功
  setMaxMove('9007199254740994'); // 恰可表示的 2^53+2 → 可行
  byId('btn-solve').dispatch('click');
  assert.equal(byId('broke-view').hidden, true);
  assert.match(byId('summary').innerHTML, /2 个/);
});

test('普通整数坐标：小数、科学计数法与临界边界的最大位移（页面流程）', () => {
  byId('btn-demo').dispatch('click'); // 示例链路含 √2≈1.414 直连与距离 1 的漏检半段
  setMaxMove('1.4'); // √2 > 1.4 → 不可行
  byId('btn-solve').dispatch('click');
  assert.equal(byId('broke-view').hidden, false);
  assert.match(byId('broke-view').innerHTML, /第 1 帧与第 2 帧之间/);

  setMaxMove('1.5'); // √2 ≤ 1.5 → 可行
  byId('btn-solve').dispatch('click');
  assert.equal(byId('broke-view').hidden, true);
  assert.match(byId('summary').innerHTML, /2 个/);

  setMaxMove('1.5e0'); // 科学计数法 → 可行
  byId('btn-solve').dispatch('click');
  assert.equal(byId('broke-view').hidden, true);

  setMaxMove('1.4142135623730951'); // 临界边界（√2 的最近双精度值）→ 可行
  byId('btn-solve').dispatch('click');
  assert.equal(byId('broke-view').hidden, true);
  assert.match(byId('summary').innerHTML, /2 个/);
});
