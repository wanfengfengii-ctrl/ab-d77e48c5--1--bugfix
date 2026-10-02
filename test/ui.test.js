import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installDom } from './helpers/dom.js';

// 必须先装 DOM 桩再 import 前端模块
const dom = installDom();

await import('../public/app.js');

const byId = dom.byId;

function frameBlocks() {
  return byId('frames-editor')._walk().filter((e) => e.classList.contains('frame-block'));
}

test('启动：渲染默认 4 帧草稿、起始斑点下拉与参数', () => {
  assert.equal(frameBlocks().length, 4);
  // 起始斑点下拉含默认帧的 2 个斑点
  const startOpts = byId('start-id').children;
  assert.equal(startOpts.length, 2);
  assert.equal(byId('dirty-hint').hidden, true);
  assert.equal(byId('result-view').hidden, true);
});

test('载入示例 → 复原：显示摘要、采用斑点、分裂母女连线与逐段位移', () => {
  byId('btn-demo').dispatch('click');

  assert.equal(byId('result-view').hidden, false);
  assert.equal(byId('broke-view').hidden, true);
  const summary = byId('summary').innerHTML;
  assert.match(summary, /总亮度/);
  assert.match(summary, /末帧存活/);
  assert.match(summary, /2 个/);

  // 采用斑点表按 5 帧渲染
  const adoptedBoxes = byId('adopted-tables')._walk()
    .filter((e) => e.classList.contains('af-head'));
  assert.equal(adoptedBoxes.length, 5);

  // SVG 中存在虚线漏检段（stroke-dasharray）与直连
  const svgEls = byId('lineage-svg')._walk();
  const dashed = svgEls.filter((e) => e.tagName === 'line' && e.attrs['stroke-dasharray']);
  assert.ok(dashed.length >= 2, '漏检跨帧应有 2 段虚线');
  const direct = svgEls.filter((e) => e.tagName === 'line' && !e.attrs['stroke-dasharray']);
  assert.ok(direct.length >= 4, '应有多条母女直连');
  const circles = svgEls.filter((e) => e.tagName === 'circle');
  assert.ok(circles.length > 0);

  // 逐段位移表非空，且含“母女直连”和“漏检段”标签
  const segRows = dom.el('#segments-table tbody').children;
  assert.ok(segRows.length > 0);
  const html = segRows.map((r) => r.innerHTML).join('');
  assert.match(html, /母女直连/);
  assert.match(html, /漏检段/);
  assert.match(html, /✓/);
});

test('修改参数后旧谱系立即作废，必须重新复原', () => {
  const maxMove = byId('max-move');
  maxMove.value = '9';
  maxMove.dispatch('input');
  assert.equal(byId('dirty-hint').hidden, false);
  assert.equal(byId('result-view').hidden, true);
});

test('修改任一帧斑点后旧谱系作废且草稿保留', () => {
  // 先复原一次
  byId('btn-demo').dispatch('click');
  assert.equal(byId('result-view').hidden, false);

  // 找到第 1 帧的 x 输入框，经事件委托派发 input
  const editor = byId('frames-editor');
  const xInput = editor._walk()
    .find((e) => e.tagName === 'input' && e.dataset.field === 'x');
  assert.ok(xInput);
  xInput.value = '42';
  editor.dispatch('input', { target: xInput });

  assert.equal(byId('dirty-hint').hidden, false);
  assert.equal(byId('result-view').hidden, true);
  // 草稿仍在（编辑器没被清空）
  assert.equal(frameBlocks().length, 5);
});

test('不可行（位移与祖先约束冲突）：保留草稿并指出最早断开帧间', () => {
  byId('btn-demo').dispatch('click');
  // 示例点间距为 √2≈1.41；最大位移给 0 时任何直连/漏检都不成立 → 第 1 帧间断开
  const maxMove = byId('max-move');
  maxMove.value = '0';
  maxMove.dispatch('input');
  byId('btn-solve').dispatch('click');

  assert.equal(byId('broke-view').hidden, false);
  const msg = byId('broke-view').innerHTML;
  assert.match(msg, /终帧存活/);
  assert.match(msg, /第 1 帧与第 2 帧之间/);
  // 草稿保留
  assert.equal(frameBlocks().length, 5);
});

test('非法录入（小数坐标）显示校验错误，不出谱系', () => {
  const editor = byId('frames-editor');
  const yInput = editor._walk()
    .find((e) => e.tagName === 'input' && e.dataset.field === 'x');
  yInput.value = '1.5';
  editor.dispatch('input', { target: yInput });
  byId('btn-solve').dispatch('click');
  assert.equal(byId('input-errors').hidden, false);
  assert.match(byId('input-errors').textContent, /整数/);
});
