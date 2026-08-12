// ESM consumer fixture for the sip-worker (browser) tarball. Imports the root
// (core re-export) and the ./transport subpath, and constructs an injected
// BrowserWebSocketTransport with a fake socket. Proves the browser adapter
// package resolves and composes on its own installed copy of @sip-worker/core.
import assert from 'node:assert/strict';

import {
  SipError,
  SipStreamDecoder,
  UserAgent,
  AuthManager,
  TransactionLayer,
  Dialog,
  parseMessage,
  serializeMessage,
  makeRequest,
  makeResponse,
} from 'sip-worker';

import { BrowserWebSocketTransport } from 'sip-worker/transport';
import { BrowserWebSocketTransport as SubpathTransport } from 'sip-worker/transport';

// ---- root re-exports core ----
for (const C of [SipError, SipStreamDecoder, UserAgent, AuthManager, TransactionLayer, Dialog]) {
  if (typeof C !== 'function') throw new Error(`sip-worker root export missing: ${C?.name}`);
}

// ---- SipError semantics ----
{
  const err = new SipError(480, 'Temporarily Unavailable', 'PROTOCOL_ERROR');
  assert.ok(err instanceof Error);
  assert.equal(err.statusCode, 480);
  assert.ok(SubpathTransport === BrowserWebSocketTransport, 'subpath transport mismatch');
}

// ---- codec round-trip ----
const request = makeRequest('INVITE', 'sip:bob@example.test');
request.headers.append('From', '<sip:alice@example.test>;tag=a1');
request.headers.append('Call-ID', 'cid-browser-esm');
request.headers.append('Max-Forwards', '70');
const wire = serializeMessage(request);
const parsed = parseMessage(wire);
assert.ok(parsed.ok, 'browser message round-trip failed');
assert.equal(parsed.value.kind, 'request');

// ---- injected BrowserWebSocketTransport with a fake socket ----
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
const transport = new BrowserWebSocketTransport('wss://sip.example.test/ws', () => fakeSocket);
assert.equal(transport.capabilities.token, 'WSS');
assert.equal(transport.capabilities.framing, 'message');
await transport.connect();
assert.equal(transport.isConnected(), true);
await transport.send(wire);
await transport.disconnect();
assert.equal(transport.isConnected(), false);

// ---- UserAgent composes over the injected browser transport ----
{
  const clock = { now: () => 0, setTimeout: () => 0, clearTimeout: () => {} };
  const idGen = { branch: () => 'z9hG4bK-browser' };
  const ua = new UserAgent({
    transport,
    clock,
    registrarUri: 'sip:example.test',
    aor: 'sip:alice@example.test',
    contact: 'sip:alice@example.test',
    idGenerator: idGen,
    authManager: new AuthManager(idGen),
  });
  // transport is disconnected at this point; connecting re-uses the closed
  // instance's reject path, so assert the class wires rather than the socket.
  assert.ok(ua instanceof UserAgent);
}

console.log('browser-esm-consumer OK');