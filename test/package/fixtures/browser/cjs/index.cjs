// CommonJS consumer fixture for the sip-worker (browser) tarball. require()s the
// root and ./transport subpath and constructs an injected BrowserWebSocketTransport.
'use strict';

const assert = require('node:assert/strict');

const root = require('sip-worker');
const browserTransport = require('sip-worker/transport');
const browserMedia = require('sip-worker/media');

assert.ok(root && typeof root === 'object', 'sip-worker root must be an object');
assert.ok(browserTransport && typeof browserTransport === 'object', 'sip-worker/transport must be an object');
assert.ok(browserMedia && typeof browserMedia === 'object', 'sip-worker/media must be an object');
assert.equal(typeof browserMedia.createBrowserMediaEnvironment, 'function');

assert.equal(typeof root.SipError, 'function');
assert.equal(typeof root.SipStreamDecoder, 'function');
assert.equal(typeof root.UserAgent, 'function');
assert.equal(typeof root.BrowserUserAgent, 'function');
assert.equal(typeof root.MediaError, 'function');
assert.equal(typeof root.AuthManager, 'function');
assert.equal(typeof root.TransactionLayer, 'function');
assert.equal(typeof root.Dialog, 'function');
assert.equal(typeof browserTransport.BrowserWebSocketTransport, 'function');
assert.equal(typeof root.MEDIA_ERROR_CODES.length === 'number', true);

// ---- SipError semantics ----
{
  const err = new root.SipError(480, 'Temporarily Unavailable', 'PROTOCOL_ERROR');
  assert.ok(err instanceof Error);
  assert.equal(err.statusCode, 480);
}

// ---- codec round-trip ----
const request = root.makeRequest('REGISTER', 'sip:alice@example.test');
request.headers.append('From', '<sip:alice@example.test>;tag=c1');
request.headers.append('Call-ID', 'cid-browser-cjs');
request.headers.append('Max-Forwards', '70');
const wire = root.serializeMessage(request);
const parsed = root.parseMessage(wire);
assert.ok(parsed.ok, 'browser message round-trip failed');
assert.equal(parsed.value.kind, 'request');

// ---- injected BrowserWebSocketTransport ----
const OPEN = 1;
const listeners = new Map();
const fakeSocket = {
  readyState: OPEN,
  protocol: 'sip',
  binaryType: '',
  addEventListener(type, fn) { listeners.set(type, fn); },
  removeEventListener(type) { listeners.delete(type); },
  send() {},
  close() { this.readyState = 3; listeners.get('close')?.({ code: 1000 }); },
};
(async () => {
  const transport = new browserTransport.BrowserWebSocketTransport('wss://sip.example.test/ws', () => fakeSocket);
  assert.equal(transport.capabilities.token, 'WSS');
  await transport.connect();
  assert.equal(transport.isConnected(), true);
  await transport.send(wire);
  await transport.disconnect();
  assert.equal(transport.isConnected(), false);

  // ---- v0.7: BrowserPhone composition root constructs over injected seams ----
  assert.equal(typeof root.BrowserPhone, 'function');
  assert.equal(typeof root.BrowserCall, 'function');
  assert.equal(typeof root.OutgoingBrowserCall, 'function');
  assert.equal(typeof root.IncomingBrowserCall, 'function');

  const phone = new root.BrowserPhone({
    options: {
      signaling: {
        url: 'wss://sip.example.test/ws',
        reconnect: { initialDelayMs: 250, maxDelayMs: 5_000, maxAttempts: 8, recoveryTimeoutMs: 30_000 },
      },
      account: {
        registrarUri: 'sip:example.test',
        aor: 'sip:alice@example.test',
        contact: 'sip:alice@example.test',
      },
      media: { holdDirection: 'sendonly' },
    },
    factory: () => fakeSocket,
    lifecycle: { isOnline: () => true, subscribe: () => () => {} },
    mediaEnvironment: {
      mediaDevices: {
        getUserMedia: () => Promise.reject(new Error('unused')),
        enumerateDevices: () => Promise.resolve([]),
        addEventListener() {},
        removeEventListener() {},
      },
      createPeerConnection() { throw new Error('unused'); },
      createMediaStream() { throw new Error('unused'); },
      getAudioCapabilities() { return null; },
    },
    clock: { now: () => 0, setTimeout: () => 0, clearTimeout: () => {} },
    idGenerator: { branch: () => 'z9hG4bK-browser-phone' },
  });
  assert.equal(phone.connectionState, 'disconnected');
  assert.equal(phone.registrationState, 'unregistered');
  assert.equal(typeof phone.diagnostics.resources, 'function');
  const resources = phone.diagnostics.resources();
  assert.equal(typeof resources.activeSocketGenerations, 'number');
  assert.equal(typeof resources.peerConnections, 'number');
  assert.equal(typeof phone.createCall, 'function');
  await phone.dispose();
})().then(() => {
  console.log('browser-cjs-consumer OK');
}).catch((e) => {
  console.error(e);
  process.exit(1);
});
