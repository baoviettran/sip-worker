// Localhost dev server for the FreeSWITCH pilot app.
//
// Runs the production build, then serves only the dist/ output at
// http://127.0.0.1:4400 with cache-control: no-store, traversal rejection,
// and 503 for missing entry assets.

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPilot } from './build-pilot.mjs';

const HOST = '127.0.0.1';
const PORT = 4400;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

const log = (line) => console.log(`[serve-pilot] ${line}`);

async function main() {
  log('building production artifacts...');
  const { outputDirectory } = await buildPilot({ testMode: false });

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://${HOST}:${PORT}`);
    let path = url.pathname;
    if (path === '/') path = '/index.html';

    const file = join(outputDirectory, path);
    // Traversal guard: resolved path must stay inside outputDirectory.
    if (!file.startsWith(outputDirectory)) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('forbidden');
      return;
    }

    readFile(file)
      .then((data) => {
        res.writeHead(200, {
          'Content-Type': MIME[extname(file)] ?? 'application/octet-stream',
          'Content-Length': data.length,
          'Cache-Control': 'no-store',
        });
        res.end(data);
      })
      .catch(() => {
        // Entry assets return 503; other paths return 404.
        if (path === '/index.html' || path === '/main.js') {
          res.writeHead(503, { 'Content-Type': 'text/plain' });
          res.end('packed artifact not built');
          return;
        }
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('not found');
      });
  });

  const shutdown = () => {
    log('shutting down');
    server.close(() => process.exit(0));
    // Force exit after 2 seconds if graceful shutdown stalls.
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(PORT, HOST, resolve);
  });

  log(`serving on http://${HOST}:${PORT}/`);
  log('For HTTPS/WSS, proxy this port with a reverse proxy (e.g. nginx, Caddy) or use a tunnelling tool.');
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
