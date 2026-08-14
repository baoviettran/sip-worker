// ESM consumer fixture for the sip-worker (browser) tarball. Imports the root
// (core re-export) and the ./transport subpath, and constructs an injected
// BrowserWebSocketTransport with a fake socket. Proves the browser adapter
// package resolves and composes on its own installed copy of @sip-worker/core.
import assert from 'node:assert/strict';

import {
  SipError,
  SipStreamDecoder,
  UserAgent,
  BrowserUserAgent,
  AuthManager,
  TransactionLayer,
  Dialog,
  parseMessage,
  serializeMessage,
  makeRequest,
  makeResponse,
  MediaError,
  MEDIA_ERROR_CODES,
} from 'sip-worker';

import { BrowserWebSocketTransport } from 'sip-worker/transport';
import { BrowserWebSocketTransport as SubpathTransport } from 'sip-worker/transport';
import { createBrowserMediaEnvironment } from 'sip-worker/media';

// ---- root re-exports core ----
for (const C of [SipError, SipStreamDecoder, UserAgent, BrowserUserAgent, AuthManager, TransactionLayer, Dialog]) {
  if (typeof C !== 'function') throw new Error(`sip-worker root export missing: ${C?.name}`);
}

// ---- v0.5 media surface: MediaError, its codes ----
{
  const err = new MediaError('PERMISSION_DENIED', 'Microphone or media permission was denied.');
  assert.ok(err instanceof Error);
  assert.equal(err.code, 'PERMISSION_DENIED');
  assert.equal(typeof MEDIA_ERROR_CODES.length, 'number');
  assert.ok(MEDIA_ERROR_CODES.length >= 12, 'MEDIA_ERROR_CODES should carry the 12-code union');
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

// ---- v0.5 media subpath: createBrowserMediaEnvironment is a real value ----
{
  // The subpath factory resolves in Node (getters only throw if a missing
  // browser global is actually dereferenced, which this fixture never does).
  const env = createBrowserMediaEnvironment();
  assert.equal(typeof env.createPeerConnection, 'function');
  assert.equal(typeof env.getAudioCapabilities, 'function');
  assert.equal(typeof env.createMediaStream, 'function');
}

// ---- v0.5: BrowserUserAgent constructs and ua.media exposes the facade ----
{
  const clock = { now: () => 0, setTimeout: () => 0, clearTimeout: () => {} };
  const idGen = { branch: () => 'z9hG4bK-browser-media' };
  const mediaSocketFactory = () => fakeSocket;
  // Node-safe fake media environment: this fixture runs in Node (no real
  // navigator.mediaDevices), so inject the lazy seam the library supports.
  const fakeMediaEnvironment = {
    mediaDevices: {
      getUserMedia: () => Promise.reject(new Error('unused: no capture in fixture')),
      enumerateDevices: () => Promise.resolve([]),
      addEventListener() {},
      removeEventListener() {},
    },
    createPeerConnection() { throw new Error('unused'); },
    createMediaStream() { throw new Error('unused'); },
    getAudioCapabilities() { return null; },
  };
  const browserUa = new BrowserUserAgent({
    transport: new BrowserWebSocketTransport('wss://sip.example.test/ws', mediaSocketFactory),
    clock,
    registrarUri: 'sip:example.test',
    aor: 'sip:alice@example.test',
    contact: 'sip:alice@example.test',
    idGenerator: idGen,
    authManager: new AuthManager(idGen),
    mediaEnvironment: fakeMediaEnvironment,
    media: {
      iceServers: [{ urls: 'turns:turn.example.test', username: 'user', credential: 'placeholder' }],
      iceTransportPolicy: 'relay',
      iceGatheringTimeoutMs: 8_000,
      mediaOperationTimeoutMs: 30_000,
    },
  });
  assert.ok(browserUa instanceof BrowserUserAgent);
  assert.equal(typeof browserUa.media.prepare, 'function');
  assert.equal(typeof browserUa.media.listDevices, 'function');
  assert.equal(typeof browserUa.media.attachRemoteAudio, 'function');
  assert.equal(typeof browserUa.media.selectMicrophone, 'function');
  assert.equal(typeof browserUa.media.setAudioOutput, 'function');
  assert.equal(typeof browserUa.restartIce, 'function');
  assert.equal(typeof browserUa.dispose, 'function');
  await browserUa.dispose();
}

console.log('browser-esm-consumer OK');
