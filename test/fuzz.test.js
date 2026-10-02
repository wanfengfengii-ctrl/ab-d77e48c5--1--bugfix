import { test } from 'node:test';
import assert from 'node:assert/strict';
import { solveLineage } from '../src/lineage.js';

/** 可复现的小型 PRNG */
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 对任一解出的谱系做独立结构校验（与主算法无关的视角） */
function audit(lineage, frames, opts) {
  const n = frames.length;
  // 1. 末帧存活数
  assert.equal(lineage.survivors.length, opts.survivors);
  const lastIds = lineage.adopted.filter((a) => a.frame === n - 1).map((a) => a.spot.id);
  assert.deepEqual(lastIds.sort(), lineage.survivors.slice().sort());

  // 2. 起始帧只含起始斑点
  const first = lineage.adopted.filter((a) => a.frame === 0);
  assert.equal(first.length, 1);
  assert.equal(first[0].spot.id, opts.startId);

  // 3. 每个采用斑点每帧至多出现一次，且确实存在于输入
  const seenAdopted = new Set();
  for (const a of lineage.adopted) {
    const key = `${a.frame}:${a.spot.id}`;
    assert.ok(!seenAdopted.has(key), `斑点重复采用 ${key}`);
    seenAdopted.add(key);
    assert.ok(frames[a.frame].some((s) => s.id === a.spot.id), `采用了不存在的斑点 ${key}`);
  }

  // 4. 每个非起始采用斑点恰有一条入边；连线终点必须是采用斑点
  const inDeg = new Map();
  for (const l of lineage.links) {
    const to = `${l.to.frame}:${l.to.spot.id}`;
    assert.ok(seenAdopted.has(to), `连到未采用斑点 ${to}`);
    inDeg.set(to, (inDeg.get(to) ?? 0) + 1);
  }
  for (const key of seenAdopted) {
    if (!key.startsWith('0:')) assert.equal(inDeg.get(key), 1, `${key} 祖先数不为 1`);
  }

  // 5. 亲代动作合法：0 直连（保持）或 2 直连（分裂）或 1 跨帧；跨帧帧号差恰为 2
  const out = new Map();
  for (const l of lineage.links) {
    const key = `${l.from.frame}:${l.from.spot.id}`;
    if (!out.has(key)) out.set(key, []);
    out.get(key).push(l);
  }
  let skips = 0;
  for (const ls of out.values()) {
    const dir = ls.filter((l) => l.kind === 'direct');
    const skp = ls.filter((l) => l.kind === 'skip');
    assert.ok(dir.length + skp.length >= 1);
    assert.ok(dir.length + skp.length <= 2);
    assert.ok(dir.length === 0 || skp.length === 0);
    for (const l of ls) {
      const span = l.to.frame - l.from.frame;
      assert.ok(span === 1 || span === 2);
      if (span === 2) { assert.equal(l.kind, 'skip'); skips++; }
      for (const seg of l.segments) assert.ok(seg.distance <= opts.maxMove + 1e-9);
    }
  }
  assert.equal(skips, lineage.misses);
  assert.ok(lineage.misses <= opts.maxSkip);

  // 6. 支系数单调性：每帧存活细胞数只可保持或 +1（对每个亲代），
  //    用帧间出边统计新细胞数
  for (let i = 0; i < n - 1; i++) {
    const linksHere = lineage.links.filter((l) => l.from.frame === i);
    const parents = new Set(linksHere.map((l) => l.from.spot.id));
    const childTargets = new Set(linksHere.filter((l) => l.kind === 'direct')
      .map((l) => `${l.to.frame}:${l.to.spot.id}`));
    const skipTargets = linksHere.filter((l) => l.kind === 'skip').length;
    // 下一帧可见数 = 直连目标数；总存活 = 可见 + 跨帧中
    const liveNext = childTargets.size + skipTargets;
    assert.ok(liveNext >= parents.size);
    assert.ok(liveNext <= 2 * parents.size);
  }

  // 7. 亮度统计
  assert.equal(lineage.adopted.reduce((s, a) => s + a.spot.brightness, 0), lineage.totalBrightness);
}

test('随机属性测试：500 个场景的可行解全部满足谱系约束', () => {
  const rand = mulberry32(20260929);
  const ri = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));
  let feasible = 0;
  let infeasible = 0;
  for (let t = 0; t < 500; t++) {
    const n = ri(4, 7);
    const frames = [];
    for (let f = 0; f < n; f++) {
      const count = ri(2, 8);
      const spots = [];
      for (let j = 0; j < count; j++) {
        spots.push({
          id: `f${f}s${j}`,
          x: ri(-6, 6), y: ri(-6, 6),
          brightness: ri(0, 20),
        });
      }
      frames.push(spots);
    }
    const opts = {
      startId: frames[0][ri(0, frames[0].length - 1)].id,
      maxMove: ri(1, 6),
      maxSkip: ri(0, 2),
      survivors: ri(1, Math.min(3, frames[n - 1].length)),
    };
    const r = solveLineage(frames, opts);
    if (r.ok) { feasible++; audit(r.lineage, frames, opts); }
    else {
      infeasible++;
      assert.ok(r.brokenGap >= 0 && r.brokenGap < n - 1);
    }
  }
  // 两类结果都应出现（保证测试确实覆盖了两种分支）
  assert.ok(feasible > 50, `可行场景过少: ${feasible}`);
  assert.ok(infeasible > 50, `不可行场景过少: ${infeasible}`);
});

test('最优性抽查：对小规模场景穷举全部合法谱系，验证算法裁决结果', () => {
  const rand = mulberry32(42);
  const ri = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));

  // 4 帧、每帧 3 斑点、survivors=1（支系不分裂），可行谱系即一条“每帧选点或跨帧”的链
  for (let t = 0; t < 200; t++) {
    const n = 4;
    const frames = [];
    for (let f = 0; f < n; f++) {
      frames.push(Array.from({ length: 3 }, (_, j) => ({
        id: `s${f}${j}`, x: ri(-4, 4), y: ri(-4, 4), brightness: ri(0, 10),
      })));
    }
    const opts = { startId: frames[0][ri(0, 2)].id, maxMove: ri(2, 5), maxSkip: 1, survivors: 1 };

    // 穷举：每步从当前斑点直连下一帧或跨帧（survivors=1 时无分裂）
    let best = null;
    const walk = (f, idx, bright, misses, path) => {
      if (f === n - 1) {
        const score = [bright, -misses];
        if (!best || score[0] > best.score[0] ||
            (score[0] === best.score[0] && score[1] > best.score[1])) {
          best = { score, path: path.slice() };
        }
        return;
      }
      const p = frames[f][idx];
      // 直连
      for (let j = 0; j < frames[f + 1].length; j++) {
        const c = frames[f + 1][j];
        if (Math.hypot(c.x - p.x, c.y - p.y) <= opts.maxMove + 1e-9) {
          path.push(['d', f + 1, c.id]);
          walk(f + 1, j, bright + c.brightness, misses, path);
          path.pop();
        }
      }
      // 跨一帧
      if (f + 2 < n && misses < opts.maxSkip) {
        for (let j = 0; j < frames[f + 2].length; j++) {
          const g = frames[f + 2][j];
          if (Math.hypot(g.x - p.x, g.y - p.y) <= 2 * opts.maxMove + 1e-9) {
            path.push(['s', f + 2, g.id]);
            walk(f + 2, j, bright + g.brightness, misses + 1, path);
            path.pop();
          }
        }
      }
    };
    const startIdx = frames[0].findIndex((s) => s.id === opts.startId);
    walk(0, startIdx, frames[0][startIdx].brightness, 0, [['d', 0, opts.startId]]);

    const r = solveLineage(frames, opts);
    if (best) {
      assert.ok(r.ok, '穷举有解但算法报不可行');
      assert.equal(r.lineage.totalBrightness, best.score[0]);
      assert.equal(r.lineage.misses, -best.score[1]);
    } else {
      assert.equal(r.ok, false);
    }
  }
});
