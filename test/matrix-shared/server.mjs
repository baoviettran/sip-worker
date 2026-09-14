// Test-only HTTPS server shared by every PBX matrix page harness.
//
// Serves the committed index.html (this script's own directory — one page
// shell serves every PBX) plus the called tree's BUILT/PACKED dist/matrix.js,
// over HTTPS on 127.0.0.1 with a per-run local CA + leaf certificate (the
// test/freeswitch-pilot/server.mjs openssl pattern; Playwright's
// ignoreHTTPSErrors covers both the page server and the PBX WSS).
//
// CONTENT IS BUILT/PACKED ONLY. A request for the built bundle FAILS
// (HTTP 503) when dist/matrix.js is absent — the browser-media server
// contract. The server NEVER falls back to source .ts files, so it cannot
// silently serve stale or unbuilt code.
//
// This server is PBX-agnostic: the per-run WSS port travels to the page
// through the ?wss= query parameter that helpers.ts appends (the container is
// owned by the Playwright globalSetup, not this process).

import https from 'node:https';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync, statSync, createReadStream } from 'node:fs';
import * as fsp from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const HOST = '127.0.0.1';
const PORT = Number(process.env.MATRIX_HTTP_PORT ?? 4500);
// The tree being served is the Playwright webServer's `cwd`; the page shell is
// this script's own directory (the shared one), so no tree carries a copy.
const treeDir = process.cwd();
const sharedDir = fileURLToPath(new URL('.', import.meta.url));
const PAGE = join(sharedDir, 'index.html');
const BUNDLE = join(treeDir, 'dist', 'matrix.js');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};
const log = (line) => console.log(`[matrix-server] ${line}`);

// ---------------------------------------------------------------------------
// TLS certificate bundle (per-run local CA + leaf; bounded openssl pattern)
// ---------------------------------------------------------------------------

async function makeCertBundle() {
  const certDir = join(tmpdir(), `matrix-page-${process.pid}-${Math.random().toString(36).slice(2)}`);
  await fsp.mkdir(certDir, { recursive: true });
  const caKey = join(certDir, 'ca.key');
  const caCrt = join(certDir, 'ca.crt');
  const leafKey = join(certDir, 'leaf.key');
  const leafCrt = join(certDir, 'leaf.crt');
  const leafCsr = join(certDir, 'leaf.csr');
  const leafExt = join(certDir, 'leaf.ext');

  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', caKey, '-out', caCrt, '-days', '1',
    '-subj', '/CN=sipw-matrix-test-ca',
  ], { stdio: 'ignore' });
  execFileSync('openssl', [
    'req', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', leafKey, '-out', leafCsr, '-subj', '/CN=127.0.0.1',
  ], { stdio: 'ignore' });
  await fsp.writeFile(
    leafExt,
    'subjectAltName=IP:127.0.0.1,DNS:localhost\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n',
  );
  execFileSync('openssl', [
    'x509', '-req', '-in', leafCsr,
    '-CA', caCrt, '-CAkey', caKey, '-CAcreateserial',
    '-out', leafCrt, '-days', '1', '-extfile', leafExt,
  ], { stdio: 'ignore' });

  return { certDir, leafKey, leafCrt };
}

// ---------------------------------------------------------------------------
// Static handler: index.html + dist/matrix.js, nothing else
// ---------------------------------------------------------------------------

function serveOr503(res, path, label, hint) {
  try {
    statSync(path);
  } catch {
    res.writeHead(503, { 'content-type': 'text/plain' });
    res.end(`BUILT ARTIFACT MISSING: ${label} at ${path}. ${hint}`);
    return;
  }
  const dot = path.lastIndexOf('.');
  res.writeHead(200, {
    'content-type': MIME[dot === -1 ? '' : path.slice(dot)] ?? 'application/octet-stream',
    'cache-control': 'no-store',
  });
  createReadStream(path).pipe(res);
}

function createHandler() {
  return function handler(req, res) {
    let pathname = '/';
    try {
      pathname = decodeURIComponent(new URL(req.url ?? '/', `https://${HOST}:${PORT}`).pathname);
    } catch {
      res.writeHead(400).end('bad request');
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { 'content-type': 'text/plain' });
      res.end('method not allowed');
      return;
    }
    if (pathname === '/' || pathname === '/index.html') {
      // Committed alongside this script, not built — its absence is a broken
      // harness, never a stale build.
      serveOr503(res, PAGE, 'index.html', 'The shared page shell lives in test/matrix-shared/.');
      return;
    }
    if (pathname === '/dist/matrix.js') {
      serveOr503(
        res,
        BUNDLE,
        'matrix.js',
        `The tree being served is ${treeDir}; build it with 'node ../matrix-shared/build-matrix.mjs' from there.`,
      );
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  };
}

// ---------------------------------------------------------------------------
// Main (Playwright webServer entry)
// ---------------------------------------------------------------------------

async function main() {
  const bundle = await makeCertBundle();
  const server = https.createServer(
    { key: readFileSync(bundle.leafKey), cert: readFileSync(bundle.leafCrt) },
    createHandler(),
  );
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(PORT, HOST, resolve);
  });
  log(`HTTPS page server listening on https://${HOST}:${PORT}/ (bundle: ${BUNDLE})`);
  log('matrix server ready');

  const shutdown = () => {
    server.close(() => {
      fsp.rm(bundle.certDir, { recursive: true, force: true }).catch(() => {});
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
