/**
 * 前端：帧/斑点录入、参数控制、调用谱系算法、可视化母女连线与漏检段。
 * 任一录入改动都会立即作废已显示的旧谱系，必须重新点击「复原谱系」。
 */
import { solveLineage, validateInput, isIntCoord, MIN_FRAMES, MAX_FRAMES,
  MIN_SPOTS_PER_FRAME, MAX_SPOTS_PER_FRAME } from '../src/lineage.js';

const $ = (sel) => document.querySelector(sel);

const els = {
  frameCount: $('#frame-count'),
  startId: $('#start-id'),
  maxMove: $('#max-move'),
  maxSkip: $('#max-skip'),
  survivors: $('#survivors'),
  editor: $('#frames-editor'),
  solve: $('#btn-solve'),
  demo: $('#btn-demo'),
  clear: $('#btn-clear'),
  dirtyHint: $('#dirty-hint'),
  errors: $('#input-errors'),
  empty: $('#empty-view'),
  result: $('#result-view'),
  broke: $('#broke-view'),
  summary: $('#summary'),
  svg: $('#lineage-svg'),
  adopted: $('#adopted-tables'),
  segBody: document.querySelector('#segments-table tbody'),
};

const STORAGE_KEY = 'algae-lineage-draft-v1';
const fmt = (v) => (Math.round(v * 100) / 100).toString();

// ---------------- 草稿状态 ----------------

function blankSpot(f, n) {
  return { id: `F${f + 1}-${n}`, x: 0, y: 0, brightness: 10 };
}
function blankFrame(f, count = MIN_SPOTS_PER_FRAME) {
  return Array.from({ length: count }, (_, i) => blankSpot(f, i + 1));
}

const demoDraft = () => ({
  frames: [
    [{ id: 'a', x: 0, y: 0, brightness: 10 }, { id: 'j1', x: 8, y: 8, brightness: 2 }],
    [{ id: 'b1', x: 1, y: 1, brightness: 10 }, { id: 'b2', x: 1, y: -1, brightness: 10 },
     { id: 'j2', x: 8, y: 8, brightness: 2 }],
    [{ id: 'c1', x: 2, y: 1, brightness: 10 }, { id: 'j3a', x: 8, y: 8, brightness: 2 },
     { id: 'j3b', x: 8, y: 9, brightness: 3 }], // 下支在此帧漏检
    [{ id: 'd1', x: 3, y: 1, brightness: 10 }, { id: 'd2', x: 3, y: -1, brightness: 10 },
     { id: 'j4', x: 8, y: 8, brightness: 2 }],
    [{ id: 'e1', x: 4, y: 1, brightness: 10 }, { id: 'e2', x: 4, y: -1, brightness: 10 },
     { id: 'j5', x: 8, y: 8, brightness: 2 }],
  ],
  params: { startId: 'a', maxMove: 2, maxSkip: 1, survivors: 2 },
});

function defaultDraft() {
  return {
    frames: Array.from({ length: MIN_FRAMES }, (_, f) => blankFrame(f)),
    params: { startId: 'F1-1', maxMove: 5, maxSkip: 1, survivors: 1 },
  };
}

let draft = loadDraft() || defaultDraft();

function loadDraft() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const d = JSON.parse(raw);
    if (!Array.isArray(d.frames) || d.frames.length < MIN_FRAMES) return null;
    return d;
  } catch { return null; }
}
let saveTimer = null;
function saveDraft() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(draft)); } catch { /* 忽略 */ }
  }, 150);
}

// ---------------- 录入区渲染 ----------------

function renderFrameCountSelect() {
  els.frameCount.innerHTML = '';
  for (let n = MIN_FRAMES; n <= MAX_FRAMES; n++) {
    const opt = document.createElement('option');
    opt.value = String(n);
    opt.textContent = `${n} 帧`;
    opt.selected = n === draft.frames.length;
    els.frameCount.appendChild(opt);
  }
}

function renderStartSelect() {
  const prev = draft.params.startId;
  els.startId.innerHTML = '';
  draft.frames[0].forEach((s) => {
    const opt = document.createElement('option');
    opt.value = s.id;
    opt.textContent = s.id || '(空编号)';
    els.startId.appendChild(opt);
  });
  if (draft.frames[0].some((s) => s.id === prev)) els.startId.value = prev;
  else { draft.params.startId = els.startId.value || ''; }
}

function renderParams() {
  els.maxMove.value = draft.params.maxMove;
  els.maxSkip.value = draft.params.maxSkip;
  els.survivors.value = draft.params.survivors;
  // 漏检帧数上限随帧数变化
  els.maxSkip.max = String(draft.frames.length - 2);
}

function renderFrames() {
  els.editor.innerHTML = '';
  draft.frames.forEach((spots, f) => {
    const block = document.createElement('div');
    block.className = 'frame-block';
    block.dataset.frame = String(f);

    const title = document.createElement('div');
    title.className = 'frame-title';
    title.innerHTML = `<span class="fno">帧 ${f + 1}</span>
      <span class="fmeta">${spots.length} 个斑点（允许 ${MIN_SPOTS_PER_FRAME}–${MAX_SPOTS_PER_FRAME}）</span>`;
    const spacer = document.createElement('span');
    spacer.style.flex = '1';
    title.appendChild(spacer);
    const addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.className = 'btn btn-mini';
    addBtn.textContent = '+ 斑点';
    addBtn.disabled = spots.length >= MAX_SPOTS_PER_FRAME;
    addBtn.addEventListener('click', () => {
      draft.frames[f].push(blankSpot(f, draft.frames[f].length + 1));
      rebuildEditor();
      markDirty();
    });
    title.appendChild(addBtn);
    block.appendChild(title);

    const head = document.createElement('div');
    head.className = 'spot-row head';
    head.innerHTML = '<span></span><span>编号</span><span>x（整数）</span><span>y（整数）</span><span>亮度（非负整数）</span><span></span>';
    block.appendChild(head);

    spots.forEach((spot, i) => {
      const row = document.createElement('div');
      row.className = 'spot-row';
      row.dataset.idx = String(i);
      const mk = (key, value, step = '1') => {
        const inp = document.createElement('input');
        inp.type = key === 'id' ? 'text' : 'number';
        if (key !== 'id') inp.step = step;
        inp.value = value;
        inp.dataset.field = key;
        return inp;
      };
      const idx = document.createElement('span');
      idx.className = 'idx';
      idx.textContent = `${i + 1}.`;
      row.appendChild(idx);
      row.appendChild(mk('id', spot.id));
      row.appendChild(mk('x', spot.x));
      row.appendChild(mk('y', spot.y));
      row.appendChild(mk('brightness', spot.brightness));
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'btn btn-mini';
      del.textContent = '删';
      del.disabled = spots.length <= MIN_SPOTS_PER_FRAME;
      del.addEventListener('click', () => {
        draft.frames[f].splice(i, 1);
        rebuildEditor();
        markDirty();
      });
      row.appendChild(del);
      block.appendChild(row);
    });

    els.editor.appendChild(block);
  });
}

function rebuildEditor() {
  renderFrameCountSelect();
  renderFrames();
  renderStartSelect();
  renderParams();
  saveDraft();
}

// ---------------- 结果作废（草稿优先） ----------------

function markDirty() {
  els.dirtyHint.hidden = false;
  els.empty.hidden = true;
  els.result.hidden = true;
  els.broke.hidden = true;
  els.errors.hidden = true;
  saveDraft();
}

// ---------------- 输入解析与求解 ----------------

function parseDraft() {
  const problems = [];
  const frames = draft.frames.map((spots, f) => spots.map((s, i) => {
    const id = String(s.id ?? '').trim();
    if (!id) problems.push(`第 ${f + 1} 帧第 ${i + 1} 个斑点缺少编号`);
    // 坐标保留原始十进制文本：超出 2^53 的整数若经 Number 中转会被四舍五入，
    // 必须原样交给算法精确解析（草稿中可能是字符串或 number）
    const x = typeof s.x === 'string' ? s.x.trim() : s.x;
    const y = typeof s.y === 'string' ? s.y.trim() : s.y;
    const b = Number(s.brightness);
    const label = id || `#${i + 1}`;
    if (!isIntCoord(x)) problems.push(`第 ${f + 1} 帧斑点 ${label} 的 x 必须是整数`);
    if (!isIntCoord(y)) problems.push(`第 ${f + 1} 帧斑点 ${label} 的 y 必须是整数`);
    if (s.brightness === '' || s.brightness === null || !Number.isInteger(b) || b < 0) {
      problems.push(`第 ${f + 1} 帧斑点 ${label} 的亮度必须是非负整数`);
    }
    return { id, x, y, brightness: b };
  }));

  // 重复编号即时标红
  draft.frames.forEach((spots, f) => {
    const ids = new Set();
    let dup = false;
    for (const s of spots) { if (ids.has(String(s.id ?? '').trim())) dup = true; ids.add(String(s.id ?? '').trim()); }
    const block = els.editor.querySelector(`.frame-block[data-frame="${f}"]`);
    if (block) block.classList.toggle('invalid', dup);
  });

  const opts = {
    startId: String(draft.params.startId ?? '').trim(),
    maxMove: Number(draft.params.maxMove),
    maxSkip: Number(draft.params.maxSkip),
    survivors: Number(draft.params.survivors),
  };
  if (draft.params.maxMove === '' || !(opts.maxMove >= 0)) {
    problems.push('相邻帧最大位移必须是非负数');
  }
  problems.push(...validateInput(frames, opts));
  return { problems, frames, opts };
}

function onSolve() {
  els.errors.hidden = true;
  const { problems, frames, opts } = parseDraft();
  if (problems.length) {
    els.errors.textContent = Array.from(new Set(problems)).join('\n');
    els.errors.hidden = false;
    return;
  }
  const result = solveLineage(frames, opts);
  els.dirtyHint.hidden = true;
  els.empty.hidden = true;
  els.result.hidden = false;

  if (!result.ok && result.errors) {
    els.errors.textContent = result.errors.join('\n');
    els.errors.hidden = false;
    els.result.hidden = true;
    els.empty.hidden = false;
    return;
  }
  if (!result.ok) {
    renderBroke(result.brokenGap, opts);
    return;
  }
  renderLineage(result.lineage, frames, opts);
}

function renderBroke(gap, opts) {
  els.broke.hidden = false;
  els.summary.hidden = true;
  els.svg.innerHTML = '';
  els.adopted.innerHTML = '';
  els.segBody.innerHTML = '';
  els.broke.innerHTML =
    `无法在满足「终帧存活 <b>${opts.survivors}</b> 个细胞」与祖先约束的情况下复原谱系：` +
    `最早断开的是<b>第 ${gap + 1} 帧与第 ${gap + 2} 帧之间</b>。<br>` +
    `草稿已保留——可尝试增大相邻帧最大位移 / 允许漏检帧数、减小终帧存活数，或检查该帧间的斑点位置。`;
}

// ---------------- 结果可视化 ----------------

function renderLineage(lineage, frames, opts) {
  els.broke.hidden = true;
  els.summary.hidden = false;
  els.summary.innerHTML =
    `<span><span class="k">采用斑点总亮度</span><span class="v">${lineage.totalBrightness}</span></span>` +
    `<span><span class="k">漏检次数</span><span class="v">${lineage.misses}</span></span>` +
    `<span><span class="k">末帧存活</span><span class="v">${lineage.survivors.length} 个（${lineage.survivors.join('、')}）</span></span>` +
    `<span><span class="k">帧间最大允许位移</span><span class="v">${opts.maxMove}</span></span>`;

  drawSvg(lineage, frames);
  drawAdopted(lineage);
  drawSegments(lineage, opts);
}

function drawSvg(lineage, frames) {
  const VW = 900;
  const VH = 340;
  const padL = 56;
  const padR = 28;
  const top = 34;
  const bottom = 30;
  const n = frames.length;
  const svg = els.svg;
  svg.setAttribute('viewBox', `0 0 ${VW} ${VH}`);
  svg.innerHTML = '';
  const NS = 'http://www.w3.org/2000/svg';
  const node = (tag, attrs = {}, text) => {
    const e = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
    if (text != null) e.textContent = text;
    return e;
  };

  const allY = frames.flat().map((s) => s.y);
  const yMin = Math.min(...allY);
  const yMax = Math.max(...allY);
  const xAt = (f) => padL + (f / (n - 1)) * (VW - padL - padR);
  const yAt = (y) => (yMin === yMax)
    ? (top + VH - bottom) / 2
    : top + ((yMax - y) / (yMax - yMin)) * (VH - top - bottom);

  // 每帧内部对 y 坐标相同/过近的斑点做错位排布（仍贴近其真实 y）
  const posByFrame = frames.map((spots) => {
    const sorted = spots.map((s, idx) => ({ s, idx, y: yAt(s.y) }))
      .sort((a, b) => a.y - b.y || a.s.x - b.s.x || a.idx - b.idx);
    const gap = 17;
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i].y - sorted[i - 1].y < gap) sorted[i].y = sorted[i - 1].y + gap;
    }
    const topClash = sorted.length ? sorted[0].y : 0;
    if (topClash < top) {
      const shift = top - topClash;
      sorted.forEach((p) => { p.y += shift; });
    }
    return new Map(sorted.map((p) => [p.idx, { x: 0, y: p.y, spot: p.s }]));
  });
  posByFrame.forEach((m, f) => m.forEach((p) => { p.x = xAt(f); }));

  // 帧分隔线与帧号
  for (let f = 0; f < n; f++) {
    svg.appendChild(node('line', {
      x1: xAt(f), y1: 12, x2: xAt(f), y2: VH - 8,
      stroke: '#eef2f1', 'stroke-width': f === 0 || f === n - 1 ? 0 : 1,
    }));
    const t = node('text', { x: xAt(f), y: 18, 'text-anchor': 'middle', fill: '#64746f', 'font-size': 12 },
      `帧 ${f + 1}`);
    svg.appendChild(t);
  }

  const adoptedKey = new Set(lineage.adopted.map((a) => `${a.frame}:${a.spot.id}`));
  const spotPos = (frame, id) => {
    const idx = frames[frame].findIndex((s) => s.id === id);
    return posByFrame[frame].get(idx);
  };

  // 连线（先漏检后直连，使直连压在上层也无所谓，二者颜色不同）
  for (const link of lineage.links) {
    const p = spotPos(link.from.frame, link.from.spot.id);
    const c = spotPos(link.to.frame, link.to.spot.id);
    if (link.kind === 'direct') {
      svg.appendChild(node('line', {
        x1: p.x, y1: p.y, x2: c.x, y2: c.y,
        stroke: '#2f6fb0', 'stroke-width': 2,
      }, null));
    } else {
      // 虚点位置：按帧序号比例插值（显示位置与数据坐标解耦，虚点位于两帧正中）
      const mx = (p.x + c.x) / 2;
      const my = (p.y + c.y) / 2;
      svg.appendChild(node('line', {
        x1: p.x, y1: p.y, x2: mx, y2: my,
        stroke: '#c65d2c', 'stroke-width': 2, 'stroke-dasharray': '6 4',
      }));
      svg.appendChild(node('line', {
        x1: mx, y1: my, x2: c.x, y2: c.y,
        stroke: '#c65d2c', 'stroke-width': 2, 'stroke-dasharray': '6 4',
      }));
      const v = node('circle', { cx: mx, cy: my, r: 4.5, fill: '#fff', stroke: '#c65d2c', 'stroke-width': 2 });
      v.appendChild(node('title', {}, `漏检虚点（帧 ${link.from.frame + 1} 与 ${link.to.frame + 1} 之间）`));
      svg.appendChild(v);
    }
  }

  // 斑点（未采用 → 采用 → 起点）
  frames.forEach((spots, f) => {
    spots.forEach((s, idx) => {
      const p = posByFrame[f].get(idx);
      const key = `${f}:${s.id}`;
      const isAdopted = adoptedKey.has(key);
      const isStart = f === 0 && s.id === draft.params.startId;
      const r = isStart ? 7.5 : isAdopted ? 6.5 : 4;
      const fill = isStart ? '#7a3fb0' : isAdopted ? '#0f7b63' : '#fff';
      const stroke = isAdopted || isStart ? fill : '#b8c4c1';
      const c = node('circle', { cx: p.x, cy: p.y, r, fill, stroke, 'stroke-width': isAdopted || isStart ? 2 : 1.5 });
      c.appendChild(node('title', {},
        `帧 ${f + 1} · ${s.id}（${s.x}, ${s.y}）亮度 ${s.brightness}${isAdopted ? ' · 采用' : ' · 未采用'}`));
      svg.appendChild(c);
      if (isAdopted || isStart) {
        const label = node('text', {
          x: p.x + 9, y: p.y + 4, fill: isStart ? '#5a2d86' : '#0b5c4b',
          'font-size': 11, 'font-weight': 600,
        }, s.id);
        svg.appendChild(label);
      }
    });
  });
}

function drawAdopted(lineage) {
  els.adopted.innerHTML = '';
  for (let f = 0; f < lineage.frames; f++) {
    const spots = lineage.adopted.filter((a) => a.frame === f);
    const box = document.createElement('div');
    box.className = 'adopted-frame';
    const head = document.createElement('div');
    head.className = 'af-head';
    head.textContent = `帧 ${f + 1}（${spots.length}）`;
    box.appendChild(head);
    spots.forEach((a, i) => {
      const row = document.createElement('div');
      row.className = 'af-spot' + (i % 2 ? ' alt' : '');
      const who = document.createElement('span');
      who.textContent = `${f === 0 ? '● ' : ''}${a.spot.id}`;
      const where = document.createElement('span');
      where.textContent = `(${a.spot.x}, ${a.spot.y}) · ${a.spot.brightness}`;
      row.appendChild(who);
      row.appendChild(where);
      box.appendChild(row);
    });
    els.adopted.appendChild(box);
  }
}

function drawSegments(lineage, opts) {
  els.segBody.innerHTML = '';
  const fr = (f) => `帧 ${f + 1}`;
  const pt = (p) => `(${p.x}, ${p.y})`;
  for (const link of lineage.links) {
    const mom = `${fr(link.from.frame)}·${link.from.spot.id}`;
    if (link.kind === 'direct') {
      const seg = link.segments[0];
      els.segBody.appendChild(row(
        '<span class="tag tag-direct">母女直连</span>',
        mom,
        `${fr(link.from.frame)} ${pt(seg.from)}`,
        `${fr(link.to.frame)}·${link.to.spot.id} ${pt(seg.to)}`,
        seg.distance, opts.maxMove,
      ));
    } else {
      const [s1, s2] = link.segments;
      els.segBody.appendChild(row(
        '<span class="tag tag-skip">漏检段 1/2</span>',
        mom,
        `${fr(link.from.frame)}·${link.from.spot.id} ${pt(s1.from)}`,
        `帧间虚点 (${fmt(s1.to.x)}, ${fmt(s1.to.y)})`,
        s1.distance, opts.maxMove,
      ));
      els.segBody.appendChild(row(
        '<span class="tag tag-skip">漏检段 2/2</span>',
        mom,
        `帧间虚点 (${fmt(s2.from.x)}, ${fmt(s2.from.y)})`,
        `${fr(link.to.frame)}·${link.to.spot.id} ${pt(s2.to)}`,
        s2.distance, opts.maxMove,
      ));
    }
  }
}
function row(type, mom, from, to, dist, maxMove) {
  const tr = document.createElement('tr');
  const ok = dist <= maxMove + 1e-9;
  tr.innerHTML = `<td>${type}</td><td>${mom}</td><td>${from}</td><td>${to}</td>
    <td class="num">${fmt(dist)}${ok ? ' ✓' : ' ✗'}</td>`;
  return tr;
}

// ---------------- 事件绑定 ----------------

els.frameCount.addEventListener('change', () => {
  const target = Number(els.frameCount.value);
  while (draft.frames.length < target) draft.frames.push(blankFrame(draft.frames.length));
  draft.frames.length = target;
  // 帧数减少后漏检预算可能越界，随之裁剪
  const cap = target - 2;
  if (Number(draft.params.maxSkip) > cap) draft.params.maxSkip = cap;
  rebuildEditor();
  markDirty();
});

els.startId.addEventListener('change', () => {
  draft.params.startId = els.startId.value;
  markDirty();
});

for (const [key, el] of [['maxMove', els.maxMove], ['maxSkip', els.maxSkip], ['survivors', els.survivors]]) {
  el.addEventListener('input', () => { draft.params[key] = el.value; markDirty(); });
}

// 事件委托：斑点字段编辑（不重渲染，避免输入焦点丢失）
els.editor.addEventListener('input', (ev) => {
  const input = ev.target.closest('input[data-field]');
  if (!input) return;
  const block = input.closest('.frame-block');
  const rowEl = input.closest('.spot-row');
  const f = Number(block.dataset.frame);
  const i = Number(rowEl.dataset.idx);
  const field = input.dataset.field;
  // 坐标保留输入原文（十进制整数字符串）：超大整数坐标不经 Number，
  // 草稿存取与求解全程不丢精度；亮度仍按数值保存
  const v = field === 'id' || field === 'x' || field === 'y'
    ? input.value
    : (input.value === '' ? '' : Number(input.value));
  draft.frames[f][i][field] = v;
  if (field === 'id' && f === 0) renderStartSelect();
  markDirty();
});

els.solve.addEventListener('click', onSolve);
els.demo.addEventListener('click', () => {
  draft = demoDraft();
  rebuildEditor();
  markDirty();
  onSolve();
});
els.clear.addEventListener('click', () => {
  markDirty();
  els.empty.hidden = false;
});

// 初始化：显式设定初始视图状态（不依赖 HTML 属性是否被解析）
els.dirtyHint.hidden = true;
els.errors.hidden = true;
els.broke.hidden = true;
els.result.hidden = true;
els.empty.hidden = false;
rebuildEditor();
