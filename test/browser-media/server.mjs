import http from 'node:http';
import { statSync, createReadStream } from 'node:fs';
import { extname, join } from 'node:path';
import { promises as fsp } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';

/**
 * Static (plain-HTTP; Playwright treats http://localhost as a secure context,
 * so WebRTC/getUserMedia/AudioContext all work over this HTTPS-equivalent)
 * server for the v0.5 real-browser WebRTC audio gate.
 *
 * CONTENT IS BUILT/PACKED ONLY. It mirrors the package `dist/` layout under
 * `/assets/` so the built files' RELATIVE chunk imports resolve natively in the
 * browser — no bundle rewriting, no source:/
 *   - /assets/browser/...            -> packages/browser/dist/... (index.js,
 *                                       media/index.js, chunk-*.js, …)
 *   - /assets/core/...               -> packages/core/dist/...   (index.js,
 *                                       chunk-*.js, …)
 *   - /assets/core/index.js         (also the importmap target for the bare
 *                                       `@sip-worker/core` specifier that the
 *                                       built browser chunks import)
 *   - /synthetic-peer.js            -> test/browser-media/synthetic-peer.ts
 *                                      (plain-JS syntax, JSDoc types only)
 *
 * A request for the built browser/ core bundle FAILS (HTTP 503) when the
 * artifact is absent; the harness `index.html` surfaces a fatal error. The
 * server NEVER falls back to source `.ts` files, so it cannot silently serve
 * stale or unbuilt code and violate the *built/packed* contract.
 */
const ROOT = fileURLToPath(new URL('../..', import.meta.url)); // repo root
const TEST_DIR = fileURLToPath(new URL('.', import.meta.url));

const BROWSER_INDEX = join(ROOT, 'packages/browser/dist/index.js');
const CORE_INDEX = join(ROOT, 'packages/core/dist/index.js');

const MIME = {
  '.js': 'text/javascript',
  '.html': 'text/html',
  '.map': 'application/json',
};

// Serve a single built artifact; 503 if absent (never serve stale).
function serveBuiltFile(res, path, label) {
  try {
    statSync(path);
  } catch {
    res.writeHead(503, { 'content-type': 'text/plain' });
    res.end(`BUILT ARTIFACT MISSING: ${label} at ${path}. Run 'npm run build' first.`);
    return;
  }
  res.writeHead(200, {
    'content-type': MIME[extname(path)] ?? 'application/octet-stream',
    'cache-control': 'no-store',
  });
  createReadStream(path).pipe(res);
}

function serveText(res, text, contentType = 'text/javascript') {
  res.writeHead(200, { 'content-type': contentType, 'cache-control': 'no-store' });
  res.end(text);
}

async function handler(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const pathname = decodeURIComponent(url.pathname);

  if (pathname === '/' || pathname === '/index.html') {
    if (!ensureBuilt(BROWSER_INDEX, res, 'packages/browser/dist/index.js')) return;
    const html = join(TEST_DIR, 'index.html');
    serveText(res, await fsp.readFile(html, 'utf8'), 'text/html');
    return;
  }
  if (pathname === '/synthetic-peer.js') {
    const file = join(TEST_DIR, 'synthetic-peer.ts');
    serveText(res, await fsp.readFile(file, 'utf8'));
    return;
  }
  if (pathname.startsWith('/assets/browser/')) {
    const rel = pathname.replace('/assets/browser/', '');
    const file = join(ROOT, 'packages/browser/dist', rel);
    serveBuiltFile(res, file, `packages/browser/dist/${rel}`);
    return;
  }
  if (pathname.startsWith('/assets/core/')) {
    const rel = pathname.replace('/assets/core/', '');
    const file = join(ROOT, 'packages/core/dist', rel);
    serveBuiltFile(res, file, `packages/core/dist/${rel}`);
    return;
  }
  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('not found');
}

// Fail loudly when a built artifact is absent instead of serving stale/source.
function ensureBuilt(indexPath, res, label) {
  try {
    statSync(indexPath);
  } catch {
    res.writeHead(503, { 'content-type': 'text/plain' });
    res.end(`BUILT ARTIFACT MISSING: ${label} at ${indexPath}. Run 'npm run build' first.`);
    return false;
  }
  return true;
}

// Deliberately NO TLS: Playwright treats http://localhost as a secure context,
// so WebRTC, getUserMedia, and AudioContext all work over plain localhost
// HTTPS-equivalent. This keeps the gate dependency-free and CI-friendly.
const server = http.createServer(handler);
const port = Number(process.env.BROWSER_MEDIA_PORT ?? 4100);
const host = '127.0.0.1';
server.listen(port, host, () => {
  console.log(`browser-media server listening on http://${host}:${port}`);
});

process.on('SIGTERM', () => server.close(() => process.exit(0)));
process.on('SIGINT', () => server.close(() => process.exit(0)));
