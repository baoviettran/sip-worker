// Combined ESM fixture: installs all three packed tarballs and asserts
// cross-package class identity plus deterministic signaling smoke flows.
//
// The browser (`sip-worker`) and node (`@sip-worker/node`) packages re-export
// `@sip-worker/core`; when all three tarballs are installed together, the shared
// core is deduplicated, so `sip-worker.SipError` must be the SAME constructor as
// `@sip-worker/core.SipError`, and a node-adapter-observed error must be a real
// `@sip-worker/core.TransportError`, not a bundled duplicate.
import assert from 'node:assert/strict';

import {
  SipError as CoreError,
  TransportError as CoreTransportError,
} from '@sip-worker/core';
import { SipError as BrowserError } from 'sip-worker';
import { NodeUdpTransport, NodeWebSocketTransport } from '@sip-worker/node';

// ---- (1) cross-package class identity: browser re-exports the core constructor ----
assert.equal(BrowserError, CoreError, 'sip-worker.SipError !== @sip-worker/core.SipError');
assert.ok(new BrowserError(0, 'x') instanceof CoreError);

// ---- (2) a node-adapter observed error is a CoreTransportError, not a bundled
// duplicate constructor ----
{
  const listeners = new Map();
  const fakeDgram = {
    on(type, fn) { listeners.set(type, fn); },
    off(type) { listeners.delete(type); },
    bind(port, cb) { cb?.(); },
    send(data, port, host, cb) { cb?.(new Error('send refused')); },
    close(cb) { cb?.(); },
  };
  const udp = new NodeUdpTransport(fakeDgram, {
    localPort: 5060,
    remoteHost: '192.0.2.10',
    remotePort: 5060,
  });
  await udp.connect();
  let observed;
  try {
    await udp.send(new Uint8Array([1]));
  } catch (e) {
    observed = e;
  }
  assert.ok(observed instanceof CoreTransportError, 'node observed error is not a CoreTransportError');
}

// ---- (3) NodeUdpTransport is a function ----
assert.equal(typeof NodeUdpTransport, 'function');

// ---- (4) deterministic browser signaling smoke: UA register → 2xx via a fake
// transport fed through the installed packages. Proves package composition. ----
{
  const clock = { now: () => 0, setTimeout: () => 0, clearTimeout: () => {} };
  const idGen = { branch: () => 'z9hG4bK-combined' };
  const outbound = [];
  const listeners = new Set();
  class FakeTransport {
    constructor() { this.connected = false; }
    capabilities = { reliable: true, framing: 'message', token: 'WS' };
    connect() { this.connected = true; return Promise.resolve(); }
    disconnect() { this.connected = false; return Promise.resolve(); }
    send(data) { outbound.push(data.slice()); return Promise.resolve(); }
    subscribe(l) { listeners.add(l); return () => listeners.delete(l); }
    isConnected() { return this.connected; }
  }
  const transport = new FakeTransport();
  const { UserAgent, AuthManager } = await import('sip-worker');
  const { makeResponse, serializeMessage } = await import('sip-worker');
  const ua = new UserAgent({
    transport,
    clock,
    registrarUri: 'sip:example.test',
    aor: 'sip:alice@example.test',
    contact: 'sip:alice@example.test',
    idGenerator: idGen,
    authManager: new AuthManager(idGen),
  });
  await ua.connect();
  // After connect the UA is composed; answer every outbound REGISTER (initial,
  // refresh, and unregister) with a 200 OK. A recurring drain keeps the
  // unregister exchange answerable too.
  const drain = setInterval(() => {
    while (outbound.length) {
      const wire = outbound.shift();
      const lines = new TextDecoder().decode(wire).split('\r\n');
      const cseq = lines.find((l) => l.startsWith('CSeq'))?.split(/\s+/)[1];
      const callId = lines.find((l) => l.startsWith('Call-ID'))?.slice(9);
      const from = lines.find((l) => l.startsWith('From'))?.slice(5);
      const via = lines.find((l) => l.startsWith('Via'))?.slice(4);
      const res = makeResponse(200, 'OK');
      res.headers.set('Via', via);
      res.headers.set('From', from);
      res.headers.set('To', `${from};tag=regtag`);
      res.headers.set('Call-ID', callId);
      res.headers.set('CSeq', `${cseq} REGISTER`);
      res.headers.set('Contact', '<sip:alice@example.test>;expires=3600');
      const resWire = serializeMessage(res);
      for (const l of listeners) l({ type: 'data', data: resWire });
    }
  }, 5);
  await ua.register();
  assert.equal(ua.registerState, 'registered', 'UA did not reach registered');
  await ua.unregister();
  assert.equal(ua.registerState, 'unregistered', 'UA did not reach unregistered');
  clearInterval(drain);
}

// ---- (5) deterministic node adapter smoke: a fake WS send failure surfaces as
// a core TransportError through the installed @sip-worker/node package ----
{
  const listeners = new Map();
  const fakeWs = {
    readyState: 1,
    protocol: 'sip',
    on(type, fn) { listeners.set(type, fn); },
    off(type) { listeners.delete(type); },
    send(data, cb) { cb?.(new Error('ws send refused')); },
    close() {},
  };
  const ws = new NodeWebSocketTransport(fakeWs);
  await ws.connect();
  let observed;
  try {
    await ws.send(new Uint8Array([1]));
  } catch (e) {
    observed = e;
  }
  assert.ok(observed instanceof CoreTransportError, 'node WS observed error is not a CoreTransportError');
}

console.log('combined-esm-compatibility OK');