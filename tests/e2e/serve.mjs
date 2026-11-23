// Tiny static server with HTTP Range support (needed for <video> seeking).
// Serves the repo root so the app is at /app/ and fixtures at /tests/fixtures/.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.mp4': 'video/mp4', '.jpg': 'image/jpeg', '.png': 'image/png',
  '.svg': 'image/svg+xml', '.map': 'application/json', '.ico': 'image/x-icon', '.webp': 'image/webp',
};

export function startServer(port = Number(process.env.PORT) || 5173, host = '127.0.0.1') {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    let file = path.normalize(path.join(ROOT, decodeURIComponent(url.pathname)));
    if (!file.startsWith(ROOT)) { res.writeHead(403).end(); return; }
    if (url.pathname === '/') { res.writeHead(302, { Location: '/app/' }).end(); return; }
    fs.stat(file, (err, st) => {
      if (!err && st.isDirectory()) { file = path.join(file, 'index.html'); st = fs.existsSync(file) && fs.statSync(file); }
      if (err || !st) { res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found'); return; }
      const type = TYPES[path.extname(file)] || 'application/octet-stream';
      const headers = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-cache' };
      // The demo must run under the strict CSP of the claude.ai artifact iframe.
      if (url.pathname.startsWith('/demo/')) {
        headers['Content-Security-Policy'] = "default-src 'self'; script-src 'self'; style-src 'self' https://fonts.googleapis.com; "
          + "font-src 'self' https://fonts.gstatic.com; img-src 'self'; media-src 'self'; connect-src 'self'; frame-ancestors *";
      }
      const range = req.headers.range && /bytes=(\d*)-(\d*)/.exec(req.headers.range);
      if (range) {
        const start = range[1] ? Number(range[1]) : st.size - Number(range[2]);
        const end = range[1] && range[2] ? Math.min(Number(range[2]), st.size - 1) : st.size - 1;
        if (start >= st.size || start > end) { res.writeHead(416, { 'Content-Range': `bytes */${st.size}` }).end(); return; }
        res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Content-Length': end - start + 1 });
        if (req.method === 'HEAD') { res.end(); return; }
        fs.createReadStream(file, { start, end }).pipe(res);
        return;
      }
      res.writeHead(200, { ...headers, 'Content-Length': st.size });
      if (req.method === 'HEAD') { res.end(); return; }
      fs.createReadStream(file).pipe(res);
    });
  });
  return new Promise((resolve) => server.listen(port, host, () => resolve(server)));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const s = await startServer();
  const { port } = s.address();
  console.log(`Swipe Room: http://127.0.0.1:${port}/app/?manifest=/tests/fixtures/videos.json`);
}
