// Minimal static server for app/ used by the admin e2e. Serves tests/admin/videos.fixture.json
// as /videos.json when app/videos.json has not been built yet.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(here, '..', '..', 'app');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json',
  '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.mp4': 'video/mp4', '.map': 'application/json' };

export function startServer(port = 0) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    let rel = decodeURIComponent(url.pathname);
    if (rel.endsWith('/')) rel += 'index.html';
    let file = path.join(APP, path.normalize(rel));
    if (!file.startsWith(APP)) { res.writeHead(403).end(); return; }
    if (rel === '/videos.json' && !fs.existsSync(file)) file = path.join(here, 'videos.fixture.json');
    fs.readFile(file, (err, buf) => {
      if (err) { res.writeHead(404, { 'content-type': 'text/plain' }).end('not found'); return; }
      res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
      res.end(buf);
    });
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const s = await startServer(Number(process.argv[2] || 5180));
  console.log(`serving app/ on http://127.0.0.1:${s.address().port}/admin.html`);
}
