/**
 * 构建步骤（无第三方依赖）：
 *  1. 对全部 JS 源码做语法检查（node --check）；
 *  2. 校验 index.html 引用的静态资源均存在；
 *  3. 生成 dist/build.json 供健康检查/部署留痕。
 */
import { spawnSync } from 'node:child_process';
import { readdir, readFile, writeFile, access, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;

async function walk(dir, out = []) {
  for (const ent of await readdir(join(ROOT, dir), { withFileTypes: true })) {
    const rel = join(dir, ent.name);
    if (ent.isDirectory()) await walk(rel, out);
    else if (ent.name.endsWith('.js') || ent.name.endsWith('.mjs')) out.push(rel);
  }
  return out;
}

const files = [
  ...await walk('src'),
  ...await walk('server'),
  ...await walk('public'),
  ...await walk('scripts'),
];

let failed = 0;
for (const f of files) {
  const r = spawnSync(process.execPath, ['--check', join(ROOT, f)], { encoding: 'utf8' });
  if (r.status !== 0) {
    console.error(`语法检查失败: ${f}\n${r.stderr}`);
    failed++;
  }
}

const html = await readFile(join(ROOT, 'public/index.html'), 'utf8');
const refs = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1]);
for (const ref of refs) {
  if (ref.startsWith('http') || ref.startsWith('#')) continue;
  const path = ref.startsWith('/src/') ? join(ROOT, ref.slice(1)) : join(ROOT, 'public', ref.replace(/^\//, ''));
  try {
    await access(path);
  } catch {
    console.error(`index.html 引用缺失: ${ref}`);
    failed++;
  }
}

if (failed) {
  console.error(`构建失败：${failed} 个问题`);
  process.exit(1);
}

await mkdir(join(ROOT, 'dist'), { recursive: true });
await writeFile(
  join(ROOT, 'dist/build.json'),
  JSON.stringify({ builtAt: new Date().toISOString(), files: files.length }, null, 2),
);

console.log(`构建通过：语法检查 ${files.length} 个文件，资源引用 ${refs.length} 个`);
