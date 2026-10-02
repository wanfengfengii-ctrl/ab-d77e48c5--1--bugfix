import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installDom } from './helpers/dom.js';

// 先装 DOM 桩并种入含超大十进制坐标（文本形式）的草稿，再导入前端模块：
// 模拟研究员的草稿经 localStorage 恢复后发起复原的完整流程
const dom = installDom();

const P53 = '9007199254740992';   // 2^53
const P53_1 = '9007199254740993'; // 2^53 + 1（Number 无法精确表示）

dom.localStorage.setItem('algae-lineage-draft-v1', JSON.stringify({
  frames: [
    [{ id: 'p0', x: P53, y: '0', brightness: 10 }, { id: 'q0', x: 0, y: 0, brightness: 1 }],
    [{ id: 'p1', x: P53_1, y: '0', brightness: 10 }, { id: 'q1', x: 0, y: 0, brightness: 1 }],
    [{ id: 'p2', x: P53_1, y: '0', brightness: 10 }, { id: 'q2', x: 0, y: 0, brightness: 1 }],
    [{ id: 'p3', x: P53_1, y: '0', brightness: 10 }, { id: 'q3', x: 0, y: 0, brightness: 1 }],
  ],
  params: { startId: 'p0', maxMove: 0, maxSkip: 0, survivors: 1 },
}));

await import('../public/app.js');

const byId = dom.byId;

function frameBlocks() {
  return byId('frames-editor')._walk().filter((e) => e.classList.contains('frame-block'));
}
function xInputs() {
  return byId('frames-editor')._walk()
    .filter((e) => e.tagName === 'input' && e.dataset.field === 'x');
}
function adoptedRows() {
  return byId('adopted-tables')._walk().filter((e) => e.classList.contains('af-spot'));
}

test('草稿恢复：超大十进制坐标按原文显示，不被四舍五入', () => {
  assert.equal(frameBlocks().length, 4);
  const xs = xInputs().map((e) => String(e.value));
  assert.equal(xs.filter((v) => v === P53).length, 1); // 仅首帧起始斑点
  assert.equal(xs.filter((v) => v === P53_1).length, 3); // 第 2–4 帧候选斑点精确保留
});

test('复原：精确相差 1 超过最大位移 0 → 不可行，最早断在第 1 帧与第 2 帧之间', () => {
  byId('btn-solve').dispatch('click');

  assert.equal(byId('broke-view').hidden, false);
  assert.match(byId('broke-view').innerHTML, /第 1 帧与第 2 帧之间/);
  assert.match(byId('broke-view').innerHTML, /草稿已保留/);
  // p3 不得显示为已采用斑点：摘要隐藏、采用表与谱系图清空
  assert.equal(byId('summary').hidden, true);
  assert.equal(byId('adopted-tables').children.length, 0);
  assert.equal(byId('lineage-svg').children.length, 0);
  assert.equal(byId('input-errors').hidden, true); // 不是校验错误，坐标本身合法
});

test('失败后草稿保留：坐标原文仍在，落盘内容不丢精度', async () => {
  assert.equal(frameBlocks().length, 4);
  assert.equal(xInputs().filter((e) => String(e.value) === P53_1).length, 3);
  assert.ok(dom.localStorage.getItem('algae-lineage-draft-v1').includes(P53_1));
  // 等过草稿防抖落盘，坐标文本仍应精确保留
  await new Promise((r) => setTimeout(r, 250));
  assert.ok(dom.localStorage.getItem('algae-lineage-draft-v1').includes(P53_1));
});

test('研究员把最大位移改为 1 后重新复原：采用 p3、总亮度 40、坐标精确回显', () => {
  const maxMove = byId('max-move');
  maxMove.value = '1';
  maxMove.dispatch('input');
  byId('btn-solve').dispatch('click');

  assert.equal(byId('broke-view').hidden, true);
  assert.equal(byId('summary').hidden, false);
  assert.match(byId('summary').innerHTML, /总亮度/);
  assert.match(byId('summary').innerHTML, /40/);
  const ids = adoptedRows().map((e) => e.children[0].textContent);
  assert.ok(ids.some((t) => t.includes('p3')));
  const wheres = adoptedRows().map((e) => e.children[1].textContent);
  assert.ok(wheres.some((t) => t.includes(P53_1))); // 采用斑点坐标按精确文本显示
});

test('最大位移支持科学计数法与小数：1e0 接通、0.5 断开', () => {
  const maxMove = byId('max-move');
  maxMove.value = '1e0'; // 科学计数法 = 1，距离 1 可连接
  maxMove.dispatch('input');
  byId('btn-solve').dispatch('click');
  assert.equal(byId('broke-view').hidden, true);
  assert.equal(byId('summary').hidden, false);

  maxMove.value = '0.5'; // 小数：距离 1 超限，仍在第 1 帧间断开
  maxMove.dispatch('input');
  byId('btn-solve').dispatch('click');
  assert.equal(byId('broke-view').hidden, false);
  assert.match(byId('broke-view').innerHTML, /第 1 帧与第 2 帧之间/);
  // 草稿仍未被清空
  assert.equal(frameBlocks().length, 4);
});
