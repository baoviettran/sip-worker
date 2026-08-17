// Test-only HTTPS server for the FreeSWITCH pilot packed-app Playwright gate.
//
// Builds with testMode:true, serves static files over HTTPS on port 4400,
// runs SipFakeServer WSS upgrades on port 4401 (/sip and /relay), and
// delegates /control/** to the fake server over plain HTTP.
//
// TLS: generates a one-day local CA + leaf certificate (bounded openssl
// pattern from test/browser-phone/server.mjs). Playwright's
// ignoreHTTPSErrors: true handles the self-signed cert in the browser.
//
// Never accepts credentials from environment variables.

import https from 'node:https';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync, statSync, createReadStream } from 'node:fs';
import * as fsp from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { buildPilot } from './build-pilot.mjs';
import { SipFakeServer } from '../example/fake-sip-server.mjs';
import { handleUpgrade } from '../example/websocket-server.mjs';

const HOST = '127.0.0.1';
const HTTP_PORT = Number(process.env.PILOT_HTTP_PORT ?? 4400);
const WSS_PORT = Number(process.env.PILOT_WSS_PORT ?? 4401);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

const log = (line) => console.log(`[pilot-server] ${line}`);

// ---------------------------------------------------------------------------
// TLS certificate bundle (per-run local CA + leaf)
// ---------------------------------------------------------------------------

async function makeCertBundle() {
  const certDir = join(tmpdir(), `pilot-wss-${process.pid}-${Math.random().toString(36).slice(2)}`);
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
    '-subj', '/CN=sipw-pilot-test-ca',
  ], { stdio: 'ignore' });
  execFileSync('openssl', [
    'req', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', leafKey, '-out', leafCsr, '-subj', '/CN=localhost',
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

  return { certDir, caKey, caCrt, leafKey, leafCrt };
}

// ---------------------------------------------------------------------------
// WSS server (SIP + relay)
// ---------------------------------------------------------------------------

async function startWssServer(fakeServer, bundle) {
  const wssServer = https.createServer({
    key: readFileSync(bundle.leafKey),
    cert: readFileSync(bundle.leafCrt),
  });

  wssServer.on('upgrade', (req, socket, head) => {
    const path = (req.url ?? '').split('?')[0];
    if (path === '/sip' || path === '/relay') {
      fakeServer.handleUpgrade(req, socket, head);
      return;
    }
    socket.destroy();
  });

  await new Promise((resolve, reject) => {
    wssServer.once('error', reject);
    wssServer.listen(WSS_PORT, HOST, resolve);
  });

  log(`WSS server listening on wss://${HOST}:${WSS_PORT}`);
  return {
    wssServer,
    close: () => new Promise((resolve) => wssServer.close(resolve)),
  };
}

// ---------------------------------------------------------------------------
// HTTP handler
// ---------------------------------------------------------------------------

function createHandler(fakeServer, webRoot) {
  return function handler(req, res) {
    const url = new URL(req.url ?? '/', `http://${HOST}:${HTTP_PORT}`);
    let path = url.pathname;
    if (path === '/') path = '/index.html';

    // Diagnostic endpoint: SIP socket + dialog state
    if (path === '/control/sip-status') {
      const body = JSON.stringify({
        sipConnected: !!fakeServer.sipSocket,
        relayConnected: fakeServer.relayConnected,
        dialogs: [...fakeServer.dialogs.values()].map((d) => ({
          callId: d.callId,
          direction: d.direction,
          acked: !!d.acked,
          ended: !!d.ended,
          cseq: d.cseq ?? 0,
        })),
      });
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      });
      res.end(body);
      return;
    }

    // Control endpoints -> delegate to fake server
    if (path.startsWith('/control/')) {
      fakeServer.handleControl(req, res).catch(() => {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end('{"ok":false,"error":"control handler failed"}');
      });
      return;
    }

    // Traversal guard
    const file = join(webRoot, path);
    if (!file.startsWith(webRoot)) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('forbidden');
      return;
    }

    fsp.readFile(file)
      .then((data) => {
        const dot = file.lastIndexOf('.');
        const ext = dot === -1 ? '' : file.slice(dot);
        res.writeHead(200, {
          'Content-Type': MIME[ext] ?? 'application/octet-stream',
          'Cache-Control': 'no-store',
          'Content-Length': data.length,
        });
        res.end(data);
      })
      .catch(() => {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('not found');
      });
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  log('building pilot with testMode:true...');
  const { outputDirectory: webRoot } = await buildPilot({ testMode: true });

  log('generating TLS certificate bundle...');
  const bundle = await makeCertBundle();
  log(`certificate bundle created at ${bundle.certDir}`);

  const fakeServer = new SipFakeServer({ aor: 'sip:1001@localhost' });
  const wss = await startWssServer(fakeServer, bundle);
  const httpServer = http.createServer(createHandler(fakeServer, webRoot));

  await new Promise((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(HTTP_PORT, HOST, resolve);
  });

  log(`HTTP server listening on http://${HOST}:${HTTP_PORT}/`);
  log(`SIP + relay WSS on wss://${HOST}:${WSS_PORT}`);
  log('pilot server ready');

  const shutdown = async () => {
    log('shutting down...');
    await wss.close();
    httpServer.close(() => {
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
