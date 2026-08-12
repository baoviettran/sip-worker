// CommonJS consumer fixture for the @sip-worker/core tarball. require()s every
// advertised subpath and exercises the codec and SipError.
'use strict';

const assert = require('node:assert/strict');

const root = require('@sip-worker/core');
const messages = require('@sip-worker/core/messages');
const stream = require('@sip-worker/core/stream');
const transport = require('@sip-worker/core/transport');
const transactions = require('@sip-worker/core/transactions');
const dialogs = require('@sip-worker/core/dialogs');
const auth = require('@sip-worker/core/auth');
const ua = require('@sip-worker/core/ua');
const media = require('@sip-worker/core/media');
const reliability = require('@sip-worker/core/reliability');
const bridge = require('@sip-worker/core/bridge');

for (const m of [
  root, messages, stream, transport, transactions, dialogs,
  auth, ua, media, reliability, bridge,
]) {
  assert.ok(m && typeof m === 'object', 'core subpath module must be an object namespace');
}

assert.equal(typeof root.SipError, 'function');
assert.equal(typeof root.TransportError, 'function');
assert.equal(typeof root.SipStreamDecoder, 'function');
assert.equal(typeof root.SipIngress, 'function');
assert.equal(typeof root.UserAgent, 'function');
assert.equal(typeof root.TransactionLayer, 'function');
assert.equal(typeof root.Dialog, 'function');
assert.equal(typeof root.AuthManager, 'function');

assert.equal(typeof messages.parseMessage, 'function');
assert.equal(typeof messages.serializeMessage, 'function');
assert.equal(typeof stream.SipStreamDecoder, 'function');
assert.equal(typeof transport.SipIngress, 'function');
assert.equal(typeof transactions.TransactionLayer, 'function');
assert.equal(typeof transactions.deriveTimers, 'function');
assert.equal(typeof dialogs.Dialog, 'function');
assert.equal(typeof auth.AuthManager, 'function');
assert.equal(typeof auth.computeDigest, 'function');
assert.equal(typeof ua.UserAgent, 'function');
assert.equal(typeof ua.Registrar, 'function');
assert.equal(typeof media.WorkerMediaController, 'function');
assert.equal(typeof reliability.OptionsLiveness, 'function');
assert.equal(typeof bridge.WorkerSupervisor, 'function');

// ---- SipError semantics ----
{
  const err = new root.SipError(0, 'x', 'PROTOCOL_ERROR');
  assert.ok(err instanceof Error);
  assert.equal(err.statusCode, 0);
  assert.equal(err.code, 'PROTOCOL_ERROR');
}

// ---- codec round-trip ----
const request = root.makeRequest('REGISTER', 'sip:alice@example.test');
request.headers.append('From', '<sip:alice@example.test>;tag=c1');
request.headers.append('Call-ID', 'cid-core-cjs');
request.headers.append('Max-Forwards', '70');
const wire = root.serializeMessage(request);
const parsed = messages.parseMessage(wire);
assert.ok(parsed.ok, 'core message round-trip failed');
assert.equal(parsed.value.kind, 'request');

// ---- instanceof identity across root and subpath CJS bundles ----
{
  const config = { branch: () => 'z9hG4bK-cjs' };
  const pairs = [
    [new root.SipStreamDecoder(), stream.SipStreamDecoder],
    [new root.AuthManager(config), auth.AuthManager],
  ];
  for (const [instance, ctor] of pairs) {
    assert.ok(instance instanceof ctor,
      `core root value not instanceof subpath class ${ctor?.name ?? '?'}`);
  }
}

console.log('core-cjs-consumer OK');