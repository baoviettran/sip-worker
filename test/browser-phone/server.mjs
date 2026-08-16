import http from 'node:http';
import https from 'node:https';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { readFileSync, statSync, createReadStream } from 'node:fs';
import { promises as fsp } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  SipFakeServer,
  parseNameAddr,
  hasTag,
  buildRequest,
} from '../example/fake-sip-server.mjs';

/**
 * Browser-phone harness server (Task 16).
 *
 * Serves the browser-phone harness page + built browser/core bundles over plain
 * HTTP on PHONE_HTTP_PORT (4300) with the SAME built/packed-only contract as
 * test/browser-media/server.mjs (503 when a dist artifact is missing, never
 * source). A separate TLS (WSS) server on SIP_WSS_PORT (4200) carries BOTH the
 * SIP signaling socket (`/sip`, subprotocol 'sip') and the in-page media relay
 * (`/relay`), because the relay must be wss:// from the shipping-Safari HTTPS
 * harness (a ws:// relay would be mixed content) and the SIP link is a real
 * `wss://` per-run TLS service.
 *
 * The TLS service uses a per-run local CA + leaf certificate (openssl, never
 * committed). Linux browser jobs trust it through isolated Playwright profiles
 * (`ignoreHTTPSErrors`); the macOS Safari job imports the ephemeral CA into a
 * temporary login keychain.
 *
 * The fake SIP server (extended `SipFakeServer`) records, WITHOUT logging SDP
 * bodies:
 *   - every REGISTER's Call-ID + CSeq (`/control/registrations`)
 *   - every OPTIONS answered, and how many were in-dialog (`/control/options-count`,
 *     `/control/in-dialog-options-count`)
 *   - every re-INVITE's Call-ID, CSeq, SDP audio direction, and whether it
 *     changed the ICE ufrag (`/control/ice-restarts`, `/control/hold-offers`)
 *
 * Control plane (HTTP on 4300), beyond the example's base endpoints:
 *   POST /control/refuse-wss            -> reject the NEXT /sip upgrades
 *   POST /control/restore-wss           -> accept /sip upgrades again (idempotent)
 *   POST /control/delay-sip-connect-ms  -> delay the NEXT /sip upgrade (deterministic
 *                                          offline/online recovery)
 *   GET  /control/registrations | options-count | in-dialog-options-count |
 *        ice-restarts | hold-offers
 */

const ROOT = fileURLToPath(new URL('../..', import.meta.url)); // repo root
const TEST_DIR = fileURLToPath(new URL('.', import.meta.url));
const BROWSER_MEDIA_DIR = fileURLToPath(new URL('../browser-media/', import.meta.url));

const PHONE_HTTP_PORT = Number(process.env.PHONE_HTTP_PORT ?? 4300);
// Port 4200 is ALSO the port the example config's own webServer serves (the SIP
// link and the example UI share wss://127.0.0.1:4200/sip). The two are never
// concurrent: the Playwright webServer array launches either the example config
// OR these test servers, and the Safari runner starts this WSS on the same 4200
// only after the example's webServer has exited.
const SIP_WSS_PORT = Number(process.env.SIP_WSS_PORT ?? 4200);
const HOST = '127.0.0.1';

const MIME = {
  '.js': 'text/javascript',
  '.html': 'text/html',
  '.map': 'application/json',
};

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

// ---------------------------------------------------------------------------
// Fake SIP server extension: recordings + controllable WSS
// ---------------------------------------------------------------------------

function sdpDirection(sdp) {
  if (!sdp) return 'unknown';
  const audio = sdp.split(/^m=audio\b/m)[1] ?? sdp;
  const m = audio.match(/^a=(sendonly|sendrecv|recvonly|inactive)\b/m);
  return m ? m[1] : 'unknown';
}

function parseIceUfrag(sdp) {
  if (!sdp) return null;
  const m = sdp.match(/^a=ice-ufrag:(\S+)$/m);
  return m ? m[1] : null;
}

export class PhoneSipServer extends SipFakeServer {
  constructor(options = {}) {
    super(options);
    this.registers = [];
    this.optionsCount = 0;
    this.inDialogOptionsCount = 0;
    this.reInvites = [];
    this.sipRefusing = false;
    this.refuseRegister = false;
    this.delaySipConnectMs = 0;
  }

  reset() {
    super.reset();
    this.registers = [];
    this.optionsCount = 0;
    this.inDialogOptionsCount = 0;
    this.reInvites = [];
    this.sipRefusing = false;
    this.refuseRegister = false;
    this.delaySipConnectMs = 0;
  }

  /** Consume and clear the one-shot /sip upgrade delay. */
  takeSipConnectDelay() {
    const ms = this.delaySipConnectMs;
    this.delaySipConnectMs = 0;
    return ms;
  }

  async handleControl(req, res) {
    const url = new URL(req.url ?? '', `http://${HOST}:${PHONE_HTTP_PORT}`);
    const path = url.pathname;
    const method = req.method ?? 'GET';
    const send = (status, obj) => {
      const body = JSON.stringify(obj);
      res.writeHead(status, {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      });
      res.end(body);
    };

    if (method === 'POST' && path === '/control/restore-wss') {
      this.sipRefusing = false;
      send(200, { ok: true });
      return;
    }
    if (method === 'POST' && path === '/control/refuse-wss') {
      this.sipRefusing = true;
      send(200, { ok: true });
      return;
    }
    if (method === 'POST' && path === '/control/refuse-register') {
      // Refuse the NEXT REGISTER (one-shot) so registration recovery fails while
      // the reconnect itself succeeds — the deterministic exhausted path that
      // fails BOTH connection and registration.
      this.refuseRegister = true;
      send(200, { ok: true });
      return;
    }
    if (method === 'POST' && path === '/control/delay-sip-connect-ms') {
      const data = await this._readJson(req);
      this.delaySipConnectMs = Number(data?.ms ?? 0);
      send(200, { ok: true });
      return;
    }
    if (method === 'GET' && path === '/control/registrations') {
      send(200, { records: this.registers });
      return;
    }
    if (method === 'GET' && path === '/control/options-count') {
      send(200, { count: this.optionsCount });
      return;
    }
    if (method === 'GET' && path === '/control/in-dialog-options-count') {
      send(200, { count: this.inDialogOptionsCount });
      return;
    }
    if (method === 'GET' && path === '/control/ice-restarts') {
      send(200, { records: this.reInvites });
      return;
    }
    if (method === 'GET' && path === '/control/hold-offers') {
      send(200, { directions: this.reInvites.map((r) => r.direction) });
      return;
    }
    if (method === 'POST' && path === '/control/peer-reinvite') {
      // Drive a PEER-initiated re-INVITE on the established call: the in-page
      // synthetic peer renegotiates its audio transceiver (same track/PC), the
      // server forwards that offer in an in-dialog INVITE to the library, and on
      // the library's 200 OK relays the answer back and ACKs. The library must
      // answer from its EXISTING transceiver — no re-acquisition.
      const data = await this._readJson(req);
      try {
        const result = await this._peerReinvite(data?.direction ?? 'sendrecv');
        if (!result.ok) {
          send(500, result);
          return;
        }
        send(200, { ok: true });
      } catch (err) {
        send(500, { ok: false, error: String((err && err.message) || err) });
      }
      return;
    }
    if (method === 'GET' && path === '/control/status') {
      const dialogs = [...this.dialogs.values()].map((d) => ({
        callId: d.callId,
        direction: d.direction,
        acked: !!d.acked,
        cseq: d.cseq ?? 0,
      }));
      send(200, { relayConnected: this.relayConnected, sipConnected: !!this.sipSocket, dialogs });
      return;
    }

    return super.handleControl(req, res);
  }

  _onRegister(socket, msg) {
    const cseqNum = Number((msg.header('cseq') ?? '1 REGISTER').split(' ')[0]) || 1;
    this.registers.push({ callId: msg.header('call-id'), cseq: cseqNum });
    if (this.refuseRegister) {
      this.refuseRegister = false;
      this._respond(socket, msg, 500, 'Server Internal Error');
      return;
    }
    super._onRegister(socket, msg);
  }

  _onOptions(socket, msg) {
    this.optionsCount += 1;
    if (hasTag(msg.header('to'))) this.inDialogOptionsCount += 1;
    super._onOptions(socket, msg);
  }

  async _onInvite(socket, msg) {
    const callId = msg.header('call-id');
    const existing = this.dialogs.get(callId);
    if (existing && existing.acked) {
      // re-INVITE inside an established dialog: record direction + ICE-restart
      // proof WITHOUT logging the SDP body.
      const iceUfrag = parseIceUfrag(msg.body);
      this.reInvites.push({
        callId,
        cseq: Number((msg.header('cseq') ?? '1 INVITE').split(' ')[0]) || 1,
        direction: sdpDirection(msg.body),
        iceUfrag,
        iceRestart: existing.initialIceUfrag !== undefined && iceUfrag !== null && iceUfrag !== existing.initialIceUfrag,
      });
    }
    return super._onInvite(socket, msg);
  }

  async _completeOutgoingInvite(socket, msg) {
    const callId = msg.header('call-id');
    // A FRESH outgoing call gets a fresh relay peer, so 10-cycle harnesses (and
    // repeated calls in one page) never reuse a torn-down peer's PC.
    await this._prepareRelay();
    await super._completeOutgoingInvite(socket, msg);
    const dialog = this.dialogs.get(callId);
    if (dialog) dialog.initialIceUfrag = parseIceUfrag(msg.body);
  }

  async _incomingCall() {
    if (!this.relay) throw new Error('relay not connected');
    await this._prepareRelay();
    await super._incomingCall();
  }

  _onBye(socket, msg) {
    const existed = this.dialogs.has(msg.header('call-id'));
    super._onBye(socket, msg);
    if (existed) this._endRelayCall();
  }

  _onResponse(msg) {
    const callId = msg.header('call-id');
    const dialog = this.dialogs.get(callId);
    if (!dialog) return;
    const cseqMethod = (msg.header('cseq') ?? '').split(' ')[1];

    if (dialog.direction === 'incoming') {
      if (msg.statusCode === 200 && cseqMethod === 'INVITE') {
        const to = parseNameAddr(msg.header('to'));
        dialog.phoneTag = to.tag;
        dialog.acked = true;
        if (msg.body) {
          this._askRelay({ type: 'remote-answer', sdp: msg.body }).catch(() => {});
        }
        this.sipSocket?.sendText(this._ackRequest(dialog));
      } else if (msg.statusCode >= 300 && cseqMethod === 'INVITE') {
        this.sipSocket?.sendText(this._ackRequest(dialog));
        this.dialogs.delete(callId);
        this._endRelayCall();
      } else if (msg.statusCode === 200 && cseqMethod === 'BYE') {
        this.dialogs.delete(callId);
        this._endRelayCall();
      }
      return;
    }

    if (msg.statusCode === 200 && cseqMethod === 'INVITE') {
      // The library answered a PEER-initiated re-INVITE on the outgoing dialog
      // (the initial outgoing INVITE is answered by THIS server, never the
      // library). Record it WITHOUT logging the SDP body, relay the answer to
      // the peer, then ACK so the library commits the negotiation.
      const iceUfrag = parseIceUfrag(msg.body);
      this.reInvites.push({
        callId,
        cseq: Number((msg.header('cseq') ?? '1 INVITE').split(' ')[0]) || 1,
        direction: sdpDirection(msg.body),
        iceUfrag,
        iceRestart: dialog.initialIceUfrag !== undefined && iceUfrag !== null && iceUfrag !== dialog.initialIceUfrag,
      });
      if (msg.body) {
        this._askRelay({ type: 'remote-answer', sdp: msg.body }).catch(() => {});
      }
      this.sipSocket?.sendText(this._ackRequest(dialog));
      return;
    }

    if (msg.statusCode === 200 && cseqMethod === 'BYE') {
      dialog.ended = true;
      this.dialogs.delete(callId);
      this._endRelayCall();
    }
  }

  /**
   * Drive a peer-initiated re-INVITE: ask the in-page peer to renegotiate its
   * audio transceiver (same track/PC, fresh complete offer), forward that offer
   * in an in-dialog INVITE to the library, and advance the dialog CSeq so the
   * eventual ACK carries the re-INVITE's sequence number.
   */
  async _peerReinvite(direction = 'sendrecv') {
    if (!this.relay) return { ok: false, error: 'relay not connected' };
    if (!this.sipSocket) return { ok: false, error: 'phone not connected' };
    const dialog = [...this.dialogs.values()].find(
      (d) => d.direction === 'outgoing' && d.acked && !d.ended,
    );
    if (!dialog) return { ok: false, error: 'no established outgoing dialog' };
    const offered = await this._askRelay({ type: 'renegotiate', direction });
    if (offered.type !== 'offer' || !offered.sdp) {
      return { ok: false, error: 'relay did not produce a renegotiated offer' };
    }
    const cseqNum = (dialog.cseq ?? 1) + 1;
    this.sipSocket.sendText(buildRequest({
      method: 'INVITE',
      uri: dialog.phoneUri,
      branch: this._branch(),
      from: dialog.remoteUri,
      fromTag: dialog.remoteTag,
      to: dialog.phoneUri,
      toTag: dialog.phoneTag,
      callId: dialog.callId,
      cseqNum,
      cseqMethod: 'INVITE',
      contact: dialog.remoteUri,
      contentType: 'application/sdp',
      body: offered.sdp,
    }));
    dialog.cseq = cseqNum;
    return { ok: true };
  }

  async _prepareRelay() {
    if (!this.relay) return;
    const res = await this._askRelay({ type: 'prepare-call' });
    if (res.type !== 'ready') throw new Error('relay did not confirm prepare-call');
  }

  _endRelayCall() {
    if (!this.relay) return;
    try {
      this.relay.sendText(JSON.stringify({ type: 'end-call' }));
    } catch {}
  }
}

// ---------------------------------------------------------------------------
// TLS cert bundle (per-run local CA + leaf)
// ---------------------------------------------------------------------------

export async function makeCertBundle(baseDir = tmpdir()) {
  const certDir = join(baseDir, `sipw-phone-${process.pid}-${Math.random().toString(36).slice(2)}`);
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
    '-subj', '/CN=sipw-test-ca',
    // A chain-capable CA must assert the CA basic constraint; without it
    // Safari/WebKit's evaluator can reject the leaf even when the CA is in a
    // trust store (the real-Safari gate boots nothing on a cert-interstitial).
    '-addext', 'basicConstraints=critical,CA:TRUE',
    '-addext', 'keyUsage=keyCertSign,cRLSign',
    '-addext', 'subjectKeyIdentifier=hash',
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

/**
 * Start the TLS server carrying `/sip` (signaling) and `/relay` (in-page media
 * relay). Applies the one-shot connect delay and refuse flag so recovery tests
 * can deterministically hold a reconnect attempt open (offline lands while the
 * phone is `recovering`) or exhaust it.
 */
export async function startSipWss(fakeServer, { bundle, port = SIP_WSS_PORT, host = HOST } = {}) {
  const certs = bundle ?? (await makeCertBundle());
  const wssServer = https.createServer({
    key: readFileSync(certs.leafKey),
    cert: readFileSync(certs.leafCrt),
  });

  wssServer.on('upgrade', (req, socket, head) => {
    const path = (req.url ?? '').split('?')[0];
    if (path === '/relay') {
      fakeServer.handleUpgrade(req, socket, head);
      return;
    }
    if (path !== '/sip') {
      socket.destroy();
      return;
    }
    if (fakeServer.sipRefusing) {
      // Refuse the upgrade outright: the browser's WebSocket fires error/close
      // (1006) and the phone's reconnect attempt fails.
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    const delay = fakeServer.takeSipConnectDelay();
    if (delay > 0) {
      setTimeout(() => fakeServer.handleUpgrade(req, socket, head), delay);
    } else {
      fakeServer.handleUpgrade(req, socket, head);
    }
  });

  await new Promise((resolve, reject) => {
    wssServer.once('error', reject);
    wssServer.listen(port, host, resolve);
  });

  return {
    wssServer,
    bundle: certs,
    close: () => new Promise((resolve) => wssServer.close(resolve)),
  };
}

// ---------------------------------------------------------------------------
// HTTP harness handler
// ---------------------------------------------------------------------------

export function createPhoneHandler(fakeServer) {
  const BROWSER_INDEX = join(ROOT, 'packages/browser/dist/index.js');

  return function handler(req, res) {
    const url = new URL(req.url ?? '/', `http://${HOST}:${PHONE_HTTP_PORT}`);
    const pathname = decodeURIComponent(url.pathname);

    if (pathname.startsWith('/control/')) {
      fakeServer.handleControl(req, res).catch(() => {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end('{"ok":false,"error":"control handler failed"}');
      });
      return;
    }

    if (pathname === '/' || pathname === '/index.html') {
      if (!ensureBuilt(BROWSER_INDEX, res, 'packages/browser/dist/index.js')) return;
      const html = join(TEST_DIR, 'index.html');
      fsp.readFile(html, 'utf8')
        .then((data) => serveText(res, data, 'text/html'))
        .catch(() => { res.writeHead(404); res.end('not found'); });
      return;
    }
    if (pathname === '/synthetic-peer.js') {
      const file = join(BROWSER_MEDIA_DIR, 'synthetic-peer.ts');
      fsp.readFile(file, 'utf8')
        .then((data) => serveText(res, data))
        .catch(() => { res.writeHead(404); res.end('not found'); });
      return;
    }
    if (pathname.startsWith('/assets/browser/')) {
      const rel = pathname.replace('/assets/browser/', '');
      serveBuiltFile(res, join(ROOT, 'packages/browser/dist', rel), `packages/browser/dist/${rel}`);
      return;
    }
    if (pathname.startsWith('/assets/core/')) {
      const rel = pathname.replace('/assets/core/', '');
      serveBuiltFile(res, join(ROOT, 'packages/core/dist', rel), `packages/core/dist/${rel}`);
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  };
}

export function createFakeServer() {
  return new PhoneSipServer();
}

export { ROOT };

// ---------------------------------------------------------------------------
// Standalone main (Playwright webServer entry)
// ---------------------------------------------------------------------------

if (import.meta.url === `file://${process.argv[1]}`) {
  const fakeServer = createFakeServer();
  const httpServer = http.createServer(createPhoneHandler(fakeServer));
  const started = await startSipWss(fakeServer);

  await new Promise((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(PHONE_HTTP_PORT, HOST, resolve);
  });

  console.log(`browser-phone harness: http://${HOST}:${PHONE_HTTP_PORT}/  wss://${HOST}:${SIP_WSS_PORT}/sip`);

  const shutdown = async () => {
    await started.close();
    httpServer.close(() => process.exit(0));
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
