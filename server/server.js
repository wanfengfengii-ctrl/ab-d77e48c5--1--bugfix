/**
 * 极简静态文件服务器：仅托管本应用（public/ 与 src/），无第三方依赖。
 * 健康检查：GET /healthz -> 200 ok。
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '0.0.0.0';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

// 仅允许公开目录，杜绝路径穿越
const ALLOWED_PREFIXES = ['/public/', '/src/', '/dist/'];

async function serve(req, res) {
  try {
    if (req.url === '/healthz' || req.url === '/health') {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('ok');
      return;
    }
    let urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    if (urlPath === '/') urlPath = '/public/index.html';
    const safe = normalize(urlPath);
    if (!ALLOWED_PREFIXES.some((p) => safe.startsWith(p))) {
      res.writeHead(403); res.end('forbidden'); return;
    }
    const filePath = join(ROOT, safe);
    const data = await readFile(filePath);
    res.writeHead(200, { 'content-type': MIME[extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  } catch (err) {
    if (err.code === 'ENOENT') { res.writeHead(404); res.end('not found'); }
    else { res.writeHead(500); res.end('server error'); }
  }
}

const server = createServer(serve);
server.listen(PORT, HOST, () => {
  console.log(`藻类谱系复原应用已启动: http://${HOST}:${PORT}`);
});

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => server.close(() => process.exit(0)));
}
