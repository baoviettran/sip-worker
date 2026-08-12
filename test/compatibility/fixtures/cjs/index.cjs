// Combined CommonJS fixture: require()s all three installed tarballs and asserts
// cross-package class identity plus deterministic signaling smoke flows.
//
// Same assertions as the ESM fixture, via require(). We do NOT compare ESM
// constructors to CommonJS constructors — only within each module system.
'use strict';

const assert = require('node:assert/strict');

const core = require('@sip-worker/core');
const browser = require('sip-worker');
const node = require('@sip-worker/node');

const CoreError = core.SipError;
const CoreTransportError = core.TransportError;
const BrowserError = browser.SipError;

function fakeDgram() {
  const listeners = new Map();
  return {
    on(type, fn) { listeners.set(type, fn); },
    off(type) { listeners.delete(type); },
    bind(port, cb) { cb?.(); },
    send(data, port, host, cb) { cb?.(new Error('send refused')); },
    close(cb) { cb?.(); },
  };
}

function deliverRegisterResponses(outbound, listeners) {
  while (outbound.length) {
    const wire = outbound.shift();
    const lines = new TextDecoder().decode(wire).split('\r\n');
    const cseq = lines.find((l) => l.startsWith('CSeq'))?.split(/\s+/)[1];
    const callId = lines.find((l) => l.startsWith('Call-ID'))?.slice(9);
    const from = lines.find((l) => l.startsWith('From'))?.slice(5);
    const via = lines.find((l) => l.startsWith('Via'))?.slice(4);
    const res = browser.makeResponse(200, 'OK');
    res.headers.set('Via', via);
    res.headers.set('From', from);
    res.headers.set('To', `${from};tag=regtag`);
    res.headers.set('Call-ID', callId);
    res.headers.set('CSeq', `${cseq} REGISTER`);
    res.headers.set('Contact', '<sip:alice@example.test>;expires=3600');
    const resWire = browser.serializeMessage(res);
    for (const l of listeners) l({ type: 'data', data: resWire });
  }
}

async function main() {
  // ---- (1) cross-package class identity (within CJS) ----
  assert.equal(BrowserError, CoreError, 'sip-worker.SipError !== @sip-worker/core.SipError');
  assert.ok(new BrowserError(0, 'x') instanceof CoreError);

  // ---- (3) NodeUdpTransport is a function ----
  assert.equal(typeof node.NodeUdpTransport, 'function');

  // ---- (2) node-adapter observed error is a real core TransportError ----
  {
    const udp = new node.NodeUdpTransport(fakeDgram(), {
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

  // ---- (4) deterministic browser signaling smoke: UA register → 2xx ----
  {
    const clock = { now: () => 0, setTimeout: () => 0, clearTimeout: () => {} };
    const idGen = { branch: () => 'z9hG4bK-combined-cjs' };
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
    const ua = new browser.UserAgent({
      transport,
      clock,
      registrarUri: 'sip:example.test',
      aor: 'sip:alice@example.test',
      contact: 'sip:alice@example.test',
      idGenerator: idGen,
      authManager: new browser.AuthManager(idGen),
    });
    await ua.connect();
    const drain = setInterval(() => {
      try {
        deliverRegisterResponses(outbound, listeners);
      } catch (e) {
        clearInterval(drain);
        console.error(e);
        process.exit(1);
      }
    }, 5);
    await ua.register();
    assert.equal(ua.registerState, 'registered', 'UA did not reach registered');
    await ua.unregister();
    assert.equal(ua.registerState, 'unregistered', 'UA did not reach unregistered');
    clearInterval(drain);
  }

  // ---- (5) deterministic node adapter smoke: WS send failure → core TransportError ----
  {
    const fakeWs = {
      readyState: 1,
      protocol: 'sip',
      on() {},
      off() {},
      send(data, cb) { cb?.(new Error('ws send refused')); },
      close() {},
    };
    const ws = new node.NodeWebSocketTransport(fakeWs);
    await ws.connect();
    let observed;
    try {
      await ws.send(new Uint8Array([1]));
    } catch (e) {
      observed = e;
    }
    assert.ok(observed instanceof CoreTransportError, 'node WS observed error is not a CoreTransportError');
  }

  console.log('combined-cjs-compatibility OK');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});