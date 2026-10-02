/**
 * 藻类细胞分裂谱系复原 —— 核心算法（无 DOM 依赖，可在浏览器与 Node 中运行）
 *
 * 模型：
 *  - 一个细胞在相邻帧之间要么保持为 1 个后代（直连），
 *    要么分裂为恰 2 个后代（两个直连）；
 *  - 也可跨一帧连接（中间帧漏检）：第 i 帧斑点与第 i+2 帧的唯一斑点相连，
 *    两段直线位移均不超过相邻帧最大位移（等价于总距离 ≤ 2×最大位移），
 *    漏检数 +1；
 *  - 非起始斑点恰有一个祖先，同一斑点不能被两支共用（落点互斥）；
 *  - 支系不会死亡，只可保持或 +1 分裂；所有存活支必须在末帧可见，
 *    末帧存活细胞数恰为 survivors。
 *
 * 求解：按帧动态规划。帧 i 的状态 =（本帧可见斑点掩码 vm, 已发起且将在第 i+1
 * 帧自动落点的漏检细胞所占用的第 i+1 帧斑点掩码 pm）。
 * 帧间转移枚举每个可见亲代的动作（保持/分裂/漏检），按动作码升序 DFS，
 * 同一递归状态只保留字典序最小前缀，输出按 (直连掩码, 漏检掩码) 天然去重。
 * 裁决优先级：采用斑点总亮度最高 → 漏检数最少 → 动作序列输入字典序最靠前（稳定）。
 *
 * 坐标精度：整数坐标接受 number / 十进制整数字符串 / bigint，一律以 BigInt
 * 参与运算；位移判定用精确平方距离与 maxMove²（double 精确分解为二进有理数）
 * 比较——超出 2^53 的坐标（如 9007199254740993）也不会被压缩成相邻偶数。
 */

export const MIN_FRAMES = 4;
export const MAX_FRAMES = 7;
export const MIN_SPOTS_PER_FRAME = 2;
export const MAX_SPOTS_PER_FRAME = 8;

const isInt = (v) => Number.isInteger(v);
const INT_RE = /^[+-]?\d+$/;

/**
 * 整数坐标精确解析：接受整数 number、十进制整数字符串或 bigint，
 * 统一转为 BigInt——超出 2^53 的整数在 double 中会被四舍五入
 * （9007199254740993 会变成 9007199254740992），绝不能经 Number 中转。
 * 非法输入返回 null。
 */
function toBigInt(v) {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number') return Number.isInteger(v) ? BigInt(v) : null;
  if (typeof v === 'string') {
    const t = v.trim();
    return INT_RE.test(t) ? BigInt(t) : null;
  }
  return null;
}

/** 坐标是否为合法整数（整数 number / 十进制整数字符串 / bigint），不设量级上限 */
export const isIntCoord = (v) => toBigInt(v) !== null;

/** 精确平方距离（BigInt）：要求斑点带有 BigInt 坐标 bx/by */
const d2exact = (a, b) => {
  const dx = a.bx - b.bx;
  const dy = a.by - b.by;
  return dx * dx + dy * dy;
};

/**
 * 把非负有限 double 精确分解为 m × 2^e（double 都是二进有理数），
 * 使 maxMove² 能与 BigInt 平方距离做无精度损失的比较。
 */
function decomposeDouble(x) {
  if (x === 0) return { m: 0n, e: 0 };
  const buf = new DataView(new ArrayBuffer(8));
  buf.setFloat64(0, x);
  const bits = buf.getBigUint64(0);
  const expBits = Number((bits >> 52n) & 0x7ffn);
  const frac = bits & 0xfffffffffffffn;
  if (expBits === 0) return { m: frac, e: -1074 }; // 次正规数
  return { m: frac | (1n << 52n), e: expBits - 1075 };
}
const bit = (j) => 1 << j;

function popcount(m) {
  let c = 0;
  while (m) { c += m & 1; m >>>= 1; }
  return c;
}
function maskIndices(m) {
  const out = [];
  for (let j = 0; m; j++, m >>>= 1) if (m & 1) out.push(j);
  return out;
}

// 动作编码（单整数，顺序即字典序）：
//   保持 [0,63]：= 子斑点索引
//   分裂 [64,127]：= 64 + u*8 + v（u<v 为两个子斑点索引）
//   漏检 [128,191]：= 128 + 跨帧目标斑点索引
const A_STAY = 0;
const A_SPLIT = 64;
const A_SKIP = 128;
const decodeAction = (a) => {
  if (a < A_SPLIT) return { kind: 0, c: a };
  if (a < A_SKIP) { const q = a - A_SPLIT; return { kind: 1, u: (q / 8) | 0, v: q % 8 }; }
  return { kind: 2, g: a - A_SKIP };
};

/** 等长数值数组的字典序比较：a < b */
function lexLess(a, b) {
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return a[i] < b[i];
  }
  return false;
}

/**
 * 校验录入数据。
 * @returns {string[]} 错误信息数组，空数组表示通过
 */
export function validateInput(frames, opts) {
  const errors = [];
  if (!Array.isArray(frames) || frames.length < MIN_FRAMES || frames.length > MAX_FRAMES) {
    errors.push(`帧数必须在 ${MIN_FRAMES} 至 ${MAX_FRAMES} 之间`);
    return errors;
  }
  frames.forEach((spots, f) => {
    if (!Array.isArray(spots) || spots.length < MIN_SPOTS_PER_FRAME ||
        spots.length > MAX_SPOTS_PER_FRAME) {
      errors.push(`第 ${f + 1} 帧斑点数必须在 ${MIN_SPOTS_PER_FRAME} 至 ${MAX_SPOTS_PER_FRAME} 之间`);
      return;
    }
    const ids = new Set();
    spots.forEach((s, i) => {
      const label = s?.id ?? `#${i + 1}`;
      if (!s || typeof s.id !== 'string' || !s.id) {
        errors.push(`第 ${f + 1} 帧第 ${i + 1} 个斑点缺少编号`);
      } else if (ids.has(s.id)) {
        errors.push(`第 ${f + 1} 帧斑点编号重复：${s.id}`);
      } else {
        ids.add(s.id);
      }
      if (!s || !isIntCoord(s.x) || !isIntCoord(s.y)) {
        errors.push(`第 ${f + 1} 帧斑点 ${label} 的坐标必须是整数`);
      }
      if (!s || !isInt(s.brightness) || s.brightness < 0) {
        errors.push(`第 ${f + 1} 帧斑点 ${label} 的亮度必须是非负整数`);
      }
    });
  });
  if (errors.length) return errors;

  const { startId, maxMove, maxSkip, survivors } = opts;
  if (!frames[0].some((s) => s.id === startId)) errors.push('起始斑点必须是第 1 帧中的某个斑点');
  if (typeof maxMove !== 'number' || !(maxMove >= 0)) errors.push('相邻帧最大位移必须是非负数');
  if (!isInt(maxSkip) || maxSkip < 0 || maxSkip > frames.length - 2) {
    errors.push(`允许漏检帧数必须是 0 至 ${frames.length - 2} 之间的整数`);
  }
  if (!isInt(survivors) || survivors < 1) {
    errors.push('终帧存活细胞数必须是正整数');
  } else if (survivors > frames[frames.length - 1].length) {
    errors.push(`终帧只有 ${frames[frames.length - 1].length} 个斑点，无法存活 ${survivors} 个细胞`);
  }
  return errors;
}

function mkLink(parent, child, kind) {
  const segments = [];
  // 距离与中点仅用于展示，由精确 BigInt 坐标换算（是否超限已在求解时精确判定）
  if (kind === 'direct') {
    segments.push({
      from: { frame: parent.f, x: parent.x, y: parent.y },
      to: { frame: child.f, x: child.x, y: child.y },
      distance: Math.sqrt(Number(d2exact(parent, child))),
      virtual: false,
    });
  } else {
    // 跨一帧：中间帧按线性插值给出漏检虚点，逐段位移为总距离的一半
    const half = Math.sqrt(Number(d2exact(parent, child))) / 2;
    const midFrame = (parent.f + child.f) / 2;
    const midX = Number(parent.bx + child.bx) / 2;
    const midY = Number(parent.by + child.by) / 2;
    segments.push(
      { from: { frame: parent.f, x: parent.x, y: parent.y },
        to: { frame: midFrame, x: midX, y: midY }, distance: half, virtual: true },
      { from: { frame: midFrame, x: midX, y: midY },
        to: { frame: child.f, x: child.x, y: child.y }, distance: half, virtual: true },
    );
  }
  return {
    kind, // 'direct' 母女直连 | 'skip' 跨一帧漏检
    from: { frame: parent.f, spot: { id: parent.id, x: parent.x, y: parent.y, brightness: parent.brightness } },
    to: { frame: child.f, spot: { id: child.id, x: child.x, y: child.y, brightness: child.brightness } },
    segments,
  };
}

/**
 * 复原谱系。
 * @returns {{ok:true, lineage:object}
 *          |{ok:false, errors:string[]}
 *          |{ok:false, brokenGap:number}}
 *   brokenGap=i 表示最早无法接续的帧间为第 i+1 帧与第 i+2 帧之间（0 基）。
 */
export function solveLineage(rawFrames, opts) {
  const errors = validateInput(rawFrames, opts);
  if (errors.length) return { ok: false, errors };

  const { startId, maxMove, maxSkip, survivors } = opts;
  // 坐标统一转为 BigInt（bx/by）参与精确运算；原始 x/y 原样保留用于结果回显
  const F = rawFrames.map((spots, f) => spots.map((s, idx) => ({
    ...s, f, idx, bx: toBigInt(s.x), by: toBigInt(s.y),
  })));
  const n = F.length;

  // maxMove² 的精确值 = m2 × 2^e2（double 精确分解）；null 表示 maxMove 为 +∞，不限制位移
  const moveSq = Number.isFinite(maxMove)
    ? (() => { const { m, e } = decomposeDouble(maxMove); return { m2: m * m, e2: 2 * e }; })()
    : null;
  /**
   * 精确判定平方距离 d2（BigInt）是否 ≤ (scale × maxMove)²：
   * scale2 为 scale 的平方——直连 1；跨一帧漏检 4（两段位移各不超过 maxMove）。
   */
  const withinMove = (d2, scale2) => {
    if (!moveSq) return true;
    const rhs = moveSq.m2 * BigInt(scale2);
    return moveSq.e2 >= 0
      ? d2 <= (rhs << BigInt(moveSq.e2))
      : (d2 << BigInt(-moveSq.e2)) <= rhs;
  };

  const expandCache = Array.from({ length: n }, () => new Map());

  // 层键包含 (可见掩码 vm, 悬空漏检掩码 pm, 累计漏检数 miss)：
  // miss 影响后续漏检预算，漏检多的路径不能遮蔽漏检少但仍可跨帧的路径
  const stateKey = (vm, pm, miss = 0) => (vm * 512 + pm) * 8 + miss;

  const start = F[0].find((s) => s.id === startId);

  // 每帧最亮的 L 个斑点亮度之和（可采纳乐观上界用）
  const topSums = F.map((spots) => {
    const sorted = spots.map((s) => s.brightness).sort((a, b) => b - a);
    const sums = [0];
    for (let j = 0; j < sorted.length; j++) sums[j + 1] = sums[j] + sorted[j];
    return sums;
  });

  /**
   * 枚举帧 i 某状态经帧间 i→i+1 的全部可行动作组合。
   * 返回 [{dm, sm, actions}]：dm 直连落点掩码，sm 新发起漏检目标掩码。
   * allowSkip=false 时只枚举保持/分裂（阶段 A 快速下界）。
   */
  function expand(i, node, allowSkip) {
    // 展开可行性还受累计漏检预算与是否允许漏检影响，一并入缓存键
    const cacheKey = (stateKey(node.vm, node.pm, node.miss) * 8 + (n - i - 1)) * 2
      + (allowSkip ? 1 : 0);
    const cached = expandCache[i].get(cacheKey);
    if (cached) return cached;

    const vis = node.vis;
    const k = vis.length;
    const next = F[i + 1];
    const after = allowSkip && i + 2 < n ? F[i + 2] : null;
    const reserved = node.pm;
    const growth = 2 ** (n - i - 2); // 本次帧间之后每细胞还能翻倍的倍数

    const stayCand = vis.map((p) => next.filter((c) => withinMove(d2exact(p, c), 1)).map((c) => c.idx));
    const skipCand = after
      ? vis.map((p) => after.filter((g) => withinMove(d2exact(p, g), 4)).map((g) => g.idx))
      : null;

    const outcomes = [];
    const seenStates = new Set(); // 已展开的 (pi, usedD, usedS)：首达即字典序最小前缀
    const actions = new Array(k);

    const rec = (pi, usedD, usedS) => {
      const seen = popcount(usedD);
      const skipping = popcount(usedS);
      const stateId = (pi * 512 + usedD) * 512 + usedS;
      if (seenStates.has(stateId)) return;
      seenStates.add(stateId);

      if (pi === k) {
        const liveNext = seen + skipping;
        if (liveNext > survivors) return;
        if (liveNext * growth < survivors) return;
        if (node.miss + skipping > maxSkip) return;
        outcomes.push({ dm: usedD, sm: usedS, actions: actions.slice() });
        return;
      }

      const left = k - pi; // 尚未处理亲代（含当前），每个至少 1 个后代
      if (seen + skipping + left > survivors) return;              // 最小存活数已超
      if ((seen + skipping + 2 * left) * growth < survivors) return; // 之后全分裂也不够
      if (node.miss + skipping > maxSkip) return;

      const stays = stayCand[pi];
      // 保持：恰一个直连后代（动作码 0..63 最先尝试）
      for (const c of stays) {
        const b = bit(c);
        if (usedD & b) continue;
        actions[pi] = A_STAY + c;
        rec(pi + 1, usedD | b, usedS);
      }
      // 分裂：恰两个直连后代（动作码 64..127）
      for (let u = 0; u < stays.length; u++) {
        const b1 = bit(stays[u]);
        if (usedD & b1) continue;
        for (let v = u + 1; v < stays.length; v++) {
          const b2 = bit(stays[v]);
          if (usedD & b2) continue;
          actions[pi] = A_SPLIT + stays[u] * 8 + stays[v];
          rec(pi + 1, usedD | b1 | b2, usedS);
        }
      }
      // 漏检：跨一帧落到 i+2 的唯一斑点（动作码 128+）
      if (skipCand) {
        for (const g of skipCand[pi]) {
          const b = bit(g);
          if (usedS & b) continue;
          actions[pi] = A_SKIP + g;
          rec(pi + 1, usedD, usedS | b);
        }
      }
    };

    rec(0, reserved, 0);
    expandCache[i].set(cacheKey, outcomes);
    return outcomes;
  }

  function better(a, b) {
    if (a.bright !== b.bright) return a.bright > b.bright;
    if (a.miss !== b.miss) return a.miss < b.miss;
    return lexLess(a.sig, b.sig);
  }

  /**
   * 节点最终总亮度的乐观上界：node.bright 已含本帧及以前亮度，
   * 忽略可达性，未来每帧取当时存活上限内最亮的若干斑点；
   * 存活数每个帧间至多翻倍，且不超过 survivors。
   */
  function upperBound(node) {
    let add = 0;
    let cap = popcount(node.vm) * 2 + popcount(node.pm); // 下一帧的存活上限
    for (let f = node.frame + 1; f < n; f++) {
      add += topSums[f][Math.min(cap, survivors, F[f].length)];
      cap = Math.min(cap, survivors) * 2;
    }
    return node.bright + add;
  }

  /**
   * 前向 DP。
   * @param allowSkip 是否允许跨一帧漏检连接
   * @param incumbent 现任最优（阶段 B 分支限界用，null 表示完整求解）
   */
  function runDP(allowSkip, incumbent) {
    const ls = Array.from({ length: n }, () => new Map());
    ls[0].set(stateKey(bit(start.idx), 0), {
      frame: 0,
      vm: bit(start.idx), pm: 0, vis: [start],
      bright: start.brightness, miss: 0,
      sig: [], actions: [], prev: null,
    });
    for (let i = 0; i < n - 1; i++) {
      for (const node of ls[i].values()) {
        for (const o of expand(i, node, allowSkip)) {
          const nextSpots = F[i + 1];
          let brightDelta = 0;
          for (const j of maskIndices(o.dm)) brightDelta += nextSpots[j].brightness;
          const cand = {
            frame: i + 1,
            vm: o.dm,
            pm: o.sm,
            vis: maskIndices(o.dm).map((j) => nextSpots[j]),
            bright: node.bright + brightDelta,
            miss: node.miss + popcount(o.sm),
            sig: node.sig.concat(o.actions),
            actions: o.actions,
            prev: stateKey(node.vm, node.pm, node.miss),
          };
          if (incumbent) {
            const ub = upperBound(cand);
            // 亮度上界严格更低 → 必败；亮度持平且漏检严格更多 → 必败。
            // 漏检持平时保留（可能凭输入顺序字典序更优，且现任路径自身须保留）。
            if (ub < incumbent.bright) continue;
            if (ub === incumbent.bright && cand.miss > incumbent.miss) continue;
          }
          const key = stateKey(o.dm, o.sm, cand.miss);
          const existing = ls[i + 1].get(key);
          if (!existing || better(cand, existing)) ls[i + 1].set(key, cand);
        }
      }
    }
    let best = null;
    for (const node of ls[n - 1].values()) {
      if (node.pm !== 0 || node.vis.length !== survivors) continue;
      if (!best || better(node, best)) best = node;
    }
    return { layers: ls, best };
  }

  // 阶段 A：禁止漏检，快速得到现任最优（若存在，其漏检数为 0）
  const phaseA = maxSkip === 0 ? null : runDP(false, null);
  const incumbentA = phaseA?.best ?? null;
  // 阶段 B：完整动作空间；有现任解时用可采纳上界剪枝，无现任解时完整求解保证可行判定。
  // maxSkip=0 时漏检动作在叶端必被预算剪枝，直接关闭该分支枚举。
  const phaseB = runDP(maxSkip > 0, incumbentA);
  const layers = phaseB.layers;

  // 后向可行集合：终态须满足存活数且无悬空漏检。
  // 注：阶段 A 可行时阶段 B 带剪枝，只用于挑最优；不可行时阶段 B 未剪枝，可行集完整。
  const good = Array.from({ length: n }, () => new Set());
  for (const [key, node] of layers[n - 1]) {
    if (node.pm === 0 && node.vis.length === survivors) good[n - 1].add(key);
  }
  for (let i = n - 2; i >= 0; i--) {
    for (const [key, node] of layers[i]) {
      for (const o of expand(i, node, maxSkip > 0)) {
        const nextMiss = node.miss + popcount(o.sm);
        if (good[i + 1].has(stateKey(o.dm, o.sm, nextMiss))) { good[i].add(key); break; }
      }
    }
  }

  if (!incumbentA) {
    // 阶段 B 为完整求解：没有可行终态时，报告最早断开的帧间
    if (good[n - 1].size === 0) {
      for (let i = 0; i < n - 1; i++) {
        let alive = false;
        for (const key of layers[i].keys()) if (good[i].has(key)) { alive = true; break; }
        if (!alive) return { ok: false, brokenGap: i };
      }
      return { ok: false, brokenGap: n - 2 };
    }
  }

  // 可行终态中裁决最优
  let bestNode = null;
  for (const key of good[n - 1]) {
    const node = layers[n - 1].get(key);
    if (!bestNode || better(node, bestNode)) bestNode = node;
  }

  // 回溯：采用斑点 + 帧间连线（由动作码解码生成）
  const adoptedByFrame = F.map(() => []);
  const gapLinks = [];
  let cur = bestNode;
  while (cur) {
    for (const s of cur.vis) adoptedByFrame[s.f].push(s);
    if (cur.prev != null) {
      const pf = cur.frame - 1;
      const parentNode = layers[pf].get(cur.prev);
      const links = [];
      cur.actions.forEach((code, pi) => {
        const parent = parentNode.vis[pi];
        const a = decodeAction(code);
        if (a.kind === 0) links.push(mkLink(parent, F[pf + 1][a.c], 'direct'));
        else if (a.kind === 1) {
          links.push(mkLink(parent, F[pf + 1][a.u], 'direct'));
          links.push(mkLink(parent, F[pf + 1][a.v], 'direct'));
        } else links.push(mkLink(parent, F[pf + 2][a.g], 'skip'));
      });
      gapLinks.push(links);
    }
    cur = cur.prev == null ? null : layers[cur.frame - 1].get(cur.prev);
  }
  gapLinks.reverse();
  const links = gapLinks.flat();

  const adopted = [];
  adoptedByFrame.forEach((spots, f) => {
    spots.sort((a, b) => a.idx - b.idx).forEach((s) => {
      adopted.push({ frame: f, spot: { id: s.id, x: s.x, y: s.y, brightness: s.brightness } });
    });
  });

  return {
    ok: true,
    lineage: {
      frames: n,
      adopted,
      links,
      totalBrightness: bestNode.bright,
      misses: bestNode.miss,
      survivors: adoptedByFrame[n - 1].map((s) => s.id),
    },
  };
}
