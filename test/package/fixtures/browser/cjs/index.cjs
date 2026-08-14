// CommonJS consumer fixture for the sip-worker (browser) tarball. require()s the
// root and ./transport subpath and constructs an injected BrowserWebSocketTransport.
'use strict';

const assert = require('node:assert/strict');

const root = require('sip-worker');
const browserTransport = require('sip-worker/transport');

assert.ok(root && typeof root === 'object', 'sip-worker root must be an object');
assert.ok(browserTransport && typeof browserTransport === 'object', 'sip-worker/transport must be an object');

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
})().then(() => {
  console.log('browser-cjs-consumer OK');
}).catch((e) => {
  console.error(e);
  process.exit(1);
});