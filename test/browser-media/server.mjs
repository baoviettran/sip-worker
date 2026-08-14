import http from 'node:http';
import dgram from 'node:dgram';
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
  if (pathname === '/stun-count') {
    serveText(res, String(stunBindingsServed), 'text/plain');
    return;
  }
  if (pathname === '/stun-seen') {
    serveText(res, String(stunPacketsSeen), 'text/plain');
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

// Export the built-only request handler so the Safari runner (safari-runner.mjs)
// can wrap the exact same contract in a real TLS server (Safari requires a true
// HTTPS secure context; Playwright's http://localhost trick does not apply).
export { handler, ROOT };

// Deliberately NO TLS: Playwright treats http://localhost as a secure context,
// so WebRTC, getUserMedia, and AudioContext all work over plain localhost
// HTTPS-equivalent. This keeps the gate dependency-free and CI-friendly.
if (import.meta.url === `file://${process.argv[1]}`) {
  const server = http.createServer(handler);
  const port = Number(process.env.BROWSER_MEDIA_PORT ?? 4100);
  const host = '127.0.0.1';
  server.listen(port, host, () => {
    console.log(`browser-media server listening on http://${host}:${port}`);
    startStunServer();
  });
  process.on('SIGTERM', () => server.close(() => process.exit(0)));
  process.on('SIGINT', () => server.close(() => process.exit(0)));
}

/**
 * Minimal RFC-5389 STUN binding server on a fixed loopback port.
 *
 * The STUN call scenario must REQUIRE a genuine server-reflexive (srflx)
 * candidate — the reviewer's point 2 — and this sandbox has NO outbound
 * internet (stun.l.google.com / Cloudflare STUN are all dark; proven by raw
 * STUN probes). A same-host peer also always selects its loopback host pair
 * regardless of STUN, so only the *gathered* srflx candidate proves the STUN
 * exchange. Running a real STUN binding server on localhost exercises the real
 * STUN protocol end-to-end (Binding Request -> XOR-MAPPED response = us) so the
 * browser genuinely gathers an srflx candidate, without any fake or hand-waved
 * candidate type. The library's STUN call points at `stun:127.0.0.1:4101`.
 */
const STUN_PORT = Number(process.env.BROWSER_MEDIA_STUN_PORT ?? 4101);

// How many valid RFC-5389 Binding Requests this STUN server has served. The
// STUN scenario's hardening needs an engine-agnostic proof that the browser
// genuinely performed a STUN binding exchange with OUR server (and did not
// silently collapse to a direct host-host call when the server is unreachable).
// Different engines surface a server-reflexive candidate differently — Firefox
// prunes a same-realm srflx from the final local-candidate set, so "gathered
// contains srflx" cannot be a load-bearing assertion on every engine. The
// binding-request count is identical across engines: 0 when the server was never
// reached (collapse-to-direct), N>0 when the disabled STUN genuinely served.
let stunBindingsServed = 0;
// Any UDP datagram that arrived on the STUN port from the page's browsers, served
// or not. Distinguishes "Firefox sent no STUN traffic at all" (raw 0) from
// "Firefox sent STUN our validator rejected" (raw > 0, bindings 0).
let stunPacketsSeen = 0;

function startStunServer() {
  const sock = dgram.createSocket('udp4');
  sock.on('message', (msg, rinfo) => {
    try {
      stunPacketsSeen += 1; // any datagram on the STUN port
      if (msg.length < 20) {
        console.log(`[stun] dropped short msg len=${msg.length} from ${rinfo.address}:${rinfo.port}`);
        return;
      }
      const type = msg.readUInt16BE(0);
      const magic = msg.readUInt32BE(4);
      if ((type & 0xfff0) !== 0x0000) {
        console.log(`[stun] dropped non-binding type=0x${type.toString(16)} from ${rinfo.address}:${rinfo.port}`);
        return;
      }
      if (magic !== 0x2112a442) {
        console.log(`[stun] dropped bad magic=0x${magic.toString(16)} len=${msg.length} from ${rinfo.address}:${rinfo.port}`);
        return;
      }
      const txid = msg.subarray(8, 20);
      stunBindingsServed += 1; // a valid RFC-5389 Binding Request was served
      // XOR-MAPPED-ADDRESS (0x0020) per RFC-5389. A real binding server echoes
      // the address the request appeared to come from. We map onto 127.0.0.2 —
      // a reachable loopback alias DISTINCT from the client's 127.0.0.1 host
      // candidate — with the request source port preserved, so engines derive a
      // genuine server-reflexive (srflx) candidate and keep it rather than
      // pruning it as identical to host. We must NOT map onto the host's real
      // non-loopback IP: ICE liveness checks target that address on the
      // ephemeral rinfo.port where nothing listens, so gathering stalls. The
      // *gathered* srflx candidate (captured via raw onicecandidate) proves the
      // STUN binding exchange happened; the selected pair always stays host/host
      // for two same-realm peers and is never used as the proof.
      const mappedIp = '127.0.0.2';
      const srcIpParts = mappedIp.split('.').map(Number);
      const srcInt = ((srcIpParts[0] << 24) >>> 0) + (srcIpParts[1] << 16) + (srcIpParts[2] << 8) + srcIpParts[3];
      const xaddr = srcInt ^ 0x2112a442;
      const xport = rinfo.port ^ 0x2112;
      const attr = Buffer.alloc(12);
      attr.writeUInt16BE(0x0020, 0);
      attr.writeUInt16BE(8, 2);
      attr.writeUInt8(0, 4); // reserved
      attr.writeUInt8(0x01, 5); // IPv4
      attr.writeUInt16BE(xport, 6); // XORed port
      attr.writeUInt32BE(xaddr, 8); // XORed mapped address
      // Message-type 0x0101 (Binding Success Response), 1 attr, len 12.
      const resp = Buffer.alloc(20 + 12);
      resp.writeUInt16BE(0x0101, 0);
      resp.writeUInt16BE(12, 2);
      resp.writeUInt32BE(magic, 4);
      txid.copy(resp, 8);
      attr.copy(resp, 20);
      sock.send(resp, rinfo.port, rinfo.address, () => {});
    } catch (e) { console.log(`[stun] error: ${e.message}`); /* drop malformed */ }
  });
  sock.bind(STUN_PORT, host, () => {
    console.log(`stun server listening on ${host}:${STUN_PORT}`);
  });
  sock.on('error', (e) => {
    console.error(`stun server error: ${e.message}`);
  });
}

