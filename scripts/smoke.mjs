/**
 * 一次性烟测（verify 服务入口）：
 *  1. 启动网页服务器并等待 /healthz 通过；
 *  2. 校验首页与算法模块可经 HTTP 取到；
 *  3. 在与页面相同的算法模块上跑“分裂 + 漏检”端到端谱系场景；
 *  4. 以退出码报告：全部通过 0，否则 1。
 */
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { solveLineage } from '../src/lineage.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = process.env.PORT || 8099;
const HOST = '127.0.0.1';

let failures = 0;
const check = (name, cond, detail = '') => {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? `：${detail}` : ''}`); }
};

// ---------- 谱系场景：含一次分裂与一次跨帧漏检 ----------
function runLineageScenarios() {
  console.log('[谱系] 分裂 + 漏检端到端场景');
  const S = (id, x, y, brightness = 10) => ({ id, x, y, brightness });

  // 起点 (0,0)；第 1 帧间分裂为上支 u(i,1)、下支 v(i,-1)；下支在第 4 帧漏检
  const frame = (i) => {
    const spots = [];
    if (i === 0) spots.push(S('u0', 0, 0, 10));
    else spots.push(S(`u${i}`, i, 1, 10));
    if (i !== 0 && i !== 3) spots.push(S(`v${i}`, i, -1, 10));
    while (spots.length < 8) {
      spots.push(S(`w${i}_${spots.length}`, 9 + spots.length, 9 + spots.length, 1));
    }
    return spots;
  };
  const frames = Array.from({ length: 7 }, (_, i) => frame(i));
  const opts = { startId: 'u0', maxMove: 2, maxSkip: 2, survivors: 2 };
  const r = solveLineage(frames, opts);

  check('求解成功', r.ok, JSON.stringify(r));
  if (!r.ok) return;

  check('末帧存活恰为 u6、v6',
    r.lineage.survivors.length === 2 &&
    r.lineage.survivors.includes('u6') && r.lineage.survivors.includes('v6'),
    `实际 ${r.lineage.survivors.join(',')}`);

  const skips = r.lineage.links.filter((l) => l.kind === 'skip');
  check('含恰 1 段跨帧漏检', skips.length === 1, `实际 ${skips.length}`);
  check('漏检连接为 v2 → v4',
    skips.length === 1 && skips[0].from.frame === 2 && skips[0].from.spot.id === 'v2' &&
    skips[0].to.frame === 4 && skips[0].to.spot.id === 'v4');
  check('漏检虚段每段位移 ≤ 最大位移',
    skips.every((l) => l.segments.every((s) => s.distance <= opts.maxMove + 1e-9)));

  const splitParents = new Set();
  for (const l of r.lineage.links) {
    const key = `${l.from.frame}:${l.from.spot.id}`;
    if (l.kind === 'direct') splitParents.has(key) ? splitParents.delete(key) : splitParents.add(key);
  }
  check('存在分裂（一个亲代两条直连）',
    r.lineage.links.some((l) => l.from.frame === 0 && l.from.spot.id === 'u0') &&
    r.lineage.links.filter((l) => l.from.frame === 0).length === 2);

  // 每个非起始采用斑点恰有一个祖先
  const adoptedKeys = new Set(r.lineage.adopted.map((a) => `${a.frame}:${a.spot.id}`));
  const indeg = new Map();
  for (const l of r.lineage.links) {
    const key = `${l.to.frame}:${l.to.spot.id}`;
    indeg.set(key, (indeg.get(key) ?? 0) + 1);
  }
  let badAncestor = 0;
  for (const key of adoptedKeys) {
    const [f] = key.split(':');
    if (f !== '0' && indeg.get(key) !== 1) badAncestor++;
  }
  check('所有非起始采用斑点恰有 1 个祖先', badAncestor === 0);

  // 不可行场景：禁漏检时同一数据必须指出最早断开帧间
  const r2 = solveLineage(frames, { ...opts, maxSkip: 0 });
  check('禁漏检时判定不可行并指出最早断开帧间',
    !r2.ok && Number.isInteger(r2.brokenGap), JSON.stringify(r2));

  // 亮杂质不应被贪心接入：单支存活场景
  const greedy = [
    [S('a', 0, 0, 10), S('junk', 3, 3, 99)],
    [S('b', 1, 0, 10), S('junk', 3, 3, 99)],
    [S('c', 2, 0, 10), S('junk2', 9, 9, 99)],
    [S('d', 3, 0, 10), S('junk2', 9, 9, 99)],
  ];
  const r3 = solveLineage(greedy, { startId: 'a', maxMove: 2, maxSkip: 0, survivors: 1 });
  check('亮杂质不被逐帧贪心接入',
    r3.ok && r3.lineage.survivors.join() === 'd' &&
    !r3.lineage.adopted.some((a) => a.spot.id.startsWith('junk')));
}

// ---------- HTTP 层：健康检查与静态资源 ----------
async function waitForHealth() {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://${HOST}:${PORT}/healthz`);
      if (res.ok && (await res.text()) === 'ok') return true;
    } catch { /* 服务器尚未起来 */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

async function fetchText(path) {
  const res = await fetch(`http://${HOST}:${PORT}${path}`);
  return { ok: res.ok, status: res.status, body: await res.text() };
}

async function main() {
  runLineageScenarios();

  console.log('[HTTP] 启动服务器并等待健康检查');
  const server = spawn(process.execPath, [resolve(ROOT, 'server/server.js')], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), HOST },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', (d) => process.stdout.write(`[server] ${d}`));
  server.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));

  // 若编排环境提供了已运行的 web 服务（compose 中 verify 依赖 web 健康），先探活它
  const webUrl = process.env.WEB_URL;
  if (webUrl) {
    console.log(`[HTTP] 探活编排中的 web 服务 ${webUrl}`);
    try {
      const res = await fetch(`${webUrl}/healthz`);
      const text = await res.text();
      check('编排 web 服务 /healthz 返回 200 ok', res.ok && text === 'ok', `status=${res.status}`);
      const homeRes = await fetch(`${webUrl}/`);
      const homeBody = await homeRes.text();
      check('编排 web 服务首页可访问', homeRes.ok && homeBody.includes('<!doctype html'));
    } catch (err) {
      check('编排 web 服务 /healthz 返回 200 ok', false, err.message);
    }
  }

  let serverOk = false;
  try {
    serverOk = await waitForHealth();
    check('GET /healthz 返回 200 ok', serverOk);

    if (serverOk) {
      const home = await fetchText('/');
      check('首页可访问且为 HTML', home.ok && home.body.includes('<!doctype html'),
        `status=${home.status}`);
      const mod = await fetchText('/src/lineage.js');
      check('算法模块可访问且含 solveLineage',
        mod.ok && mod.body.includes('export function solveLineage'), `status=${mod.status}`);
      const missing = await fetchText('/public/does-not-exist');
      check('不存在资源返回 404', missing.status === 404, `status=${missing.status}`);
    }
  } finally {
    server.kill('SIGTERM');
    await once(server, 'exit').catch(() => {});
  }

  if (failures) {
    console.error(`\n烟测失败：${failures} 项未通过`);
    process.exit(1);
  }
  console.log('\n烟测全部通过');
}

main().catch((err) => {
  console.error('烟测异常:', err);
  process.exit(1);
});
