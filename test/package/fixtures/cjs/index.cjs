// Runtime fixture: require() every advertised sip-worker subpath and exercise a
// few exports from each. Runs against an installed tarball in a fresh CJS consumer.

'use strict';

const assert = require('node:assert/strict');

const root = require('sip-worker');
const messages = require('sip-worker/messages');
const stream = require('sip-worker/stream');
const nodeTransport = require('sip-worker/transport/node');
const browserTransport = require('sip-worker/transport/browser');
const transactions = require('sip-worker/transactions');
const dialogs = require('sip-worker/dialogs');
const auth = require('sip-worker/auth');
const ua = require('sip-worker/ua');
const media = require('sip-worker/media');
const reliability = require('sip-worker/reliability');
const bridge = require('sip-worker/bridge');

for (const m of [
  root, messages, stream, nodeTransport, browserTransport,
  transactions, dialogs, auth, ua, media, reliability, bridge,
]) {
  assert.ok(m && typeof m === 'object', 'subpath module must be an object namespace');
}

assert.equal(typeof root.SipStreamDecoder, 'function');
assert.equal(typeof root.SipIngress, 'function');
assert.equal(typeof root.UserAgent, 'function');
assert.equal(typeof root.AuthManager, 'function');

assert.equal(typeof messages.parseMessage, 'function');
assert.equal(typeof messages.serializeMessage, 'function');
assert.equal(typeof stream.SipStreamDecoder, 'function');

assert.equal(typeof nodeTransport.NodeUdpTransport, 'function');
assert.equal(typeof nodeTransport.NodeTcpTransport, 'function');
assert.equal(typeof nodeTransport.NodeWebSocketTransport, 'function');
assert.equal(typeof browserTransport.BrowserWebSocketTransport, 'function');

assert.equal(typeof transactions.TransactionLayer, 'function');
assert.equal(typeof transactions.deriveTimers, 'function');
assert.equal(typeof transactions.buildNon2xxAck, 'function');

assert.equal(typeof dialogs.Dialog, 'function');
assert.equal(typeof dialogs.makeBranch, 'function');

assert.equal(typeof auth.AuthManager, 'function');
assert.equal(typeof auth.computeDigest, 'function');
assert.equal(typeof auth.sha256, 'function');
assert.equal(typeof auth.md5, 'function');

assert.equal(typeof ua.UserAgent, 'function');
assert.equal(typeof ua.Registrar, 'function');

assert.equal(typeof media.WorkerMediaController, 'function');
assert.equal(typeof media.StubMainMediaHandler, 'function');

assert.equal(typeof reliability.OptionsLiveness, 'function');
assert.equal(typeof reliability.NodeWebSocketLiveness, 'function');

assert.equal(typeof bridge.WorkerSupervisor, 'function');
assert.equal(typeof bridge.WorkerRuntime, 'function');
assert.equal(typeof bridge.WorkerRestartError, 'function');

// Exercise a serialization round-trip through the public API.
const request = root.makeRequest('REGISTER', 'sip:alice@example.test');
const wire = root.serializeMessage(request);
const parsed = messages.parseMessage(wire);
assert.ok(parsed.ok, 'message round-trip failed');

console.log('cjs-consumer OK');
