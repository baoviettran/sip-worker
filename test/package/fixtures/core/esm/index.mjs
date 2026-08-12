// ESM consumer fixture for the @sip-worker/core tarball. Imports every
// advertised subpath and exercises the codec (parse/serialize) and SipError.
import assert from 'node:assert/strict';

import {
  SipError,
  TransportError,
  SipStreamDecoder,
  SipIngress,
  UserAgent,
  AuthManager,
  TransactionLayer,
  Dialog,
  OptionsLiveness,
  WorkerSupervisor,
  WorkerMediaController,
  TypedEventEmitter,
  parseMessage,
  serializeMessage,
  makeRequest,
  makeResponse,
  computeDigest,
} from '@sip-worker/core';

import { parseMessage as parseMessageAlt, Headers as MsgHeaders } from '@sip-worker/core/messages';
import { SipStreamDecoder as StreamDecoderAlt } from '@sip-worker/core/stream';
import { SipIngress as IngressAlt } from '@sip-worker/core/transport';
import {
  TransactionLayer as TxAlt,
  deriveTimers,
  buildNon2xxAck,
  DEFAULT_TIMERS,
} from '@sip-worker/core/transactions';
import { Dialog as DialogAlt, makeBranch } from '@sip-worker/core/dialogs';
import {
  AuthManager as AuthAlt,
  parseDigestChallenges,
  selectChallenge,
  sha256,
  md5,
} from '@sip-worker/core/auth';
import { UserAgent as UAAlt, Registrar, TypedEventEmitter as TEEvtAlt } from '@sip-worker/core/ua';
import {
  WorkerMediaController as MediaAlt,
  StubMainMediaHandler,
} from '@sip-worker/core/media';
import { OptionsLiveness as LivenessAlt } from '@sip-worker/core/reliability';
import {
  WorkerSupervisor as SupAlt,
  WorkerRuntime,
  WorkerRestartError,
} from '@sip-worker/core/bridge';

// ---- every subpath resolves its named exports at runtime ----
const subpathValues = [
  parseMessageAlt, MsgHeaders, StreamDecoderAlt, IngressAlt, TxAlt, deriveTimers,
  buildNon2xxAck, DEFAULT_TIMERS, DialogAlt, makeBranch, AuthAlt,
  parseDigestChallenges, selectChallenge, sha256, md5, UAAlt, Registrar,
  TEEvtAlt, MediaAlt, StubMainMediaHandler, LivenessAlt, SupAlt,
  WorkerRuntime, WorkerRestartError,
];
for (const v of subpathValues) {
  if (typeof v !== 'function' && typeof v !== 'object') {
    throw new Error(`core subpath value missing: ${String(v)}`);
  }
}

const rootClasses = [
  SipError, TransportError, SipStreamDecoder, SipIngress, UserAgent, AuthManager,
  TransactionLayer, Dialog, OptionsLiveness, WorkerSupervisor,
  WorkerMediaController, TypedEventEmitter, parseMessage, serializeMessage,
  makeRequest, makeResponse, computeDigest,
];
for (const C of rootClasses) {
  if (typeof C !== 'function') throw new Error(`core root export missing: ${C?.name}`);
}

// ---- SipError semantics ----
{
  const err = new SipError(408, 'Request Timeout', 'TIMEOUT');
  assert.ok(err instanceof Error);
  assert.equal(err.statusCode, 408);
  assert.equal(err.code, 'TIMEOUT');
  assert.ok(new (Object.getPrototypeOf(err).constructor)(0, 'x') instanceof SipError);
  assert.ok(new TransportError('boom') instanceof Error);
}

// ---- codec round-trip through the installed core ----
const request = makeRequest('REGISTER', 'sip:alice@example.test');
request.headers.append('Via', 'SIP/2.0/UDP 192.0.2.1:5060;branch=z9hG4bK-core');
request.headers.append('From', '<sip:alice@example.test>;tag=a1');
request.headers.append('Call-ID', 'cid-core-esm');
request.headers.append('Max-Forwards', '70');
request.headers.append('Content-Length', '0');
const wire = serializeMessage(request);
const parsed = parseMessage(wire);
assert.ok(parsed.ok, 'core message round-trip failed');
assert.equal(parsed.value.kind, 'request');
const via = parseMessage(wire).value.headers.get('Via');
assert.ok(via !== undefined && via.includes('branch='), 'serialized Via missing branch');

// ---- stream decoder decodes a serialized message ----
{
  const dec = new SipStreamDecoder();
  const chunks = dec.push(wire);
  assert.ok(chunks.ok && chunks.value.length >= 1, 'decoder produced no messages');
}

// ---- instanceof identity across root and subpath bundles ----
{
  const idGen = { branch: () => 'z9hG4bK-core' };
  const clock = { now: () => 0, setTimeout: () => 0, clearTimeout: () => {} };
  const transport = {
    capabilities: { reliable: true, framing: 'message', token: 'WS' },
    connect: () => Promise.resolve(),
    disconnect: () => Promise.resolve(),
    send: () => Promise.resolve(),
    subscribe: () => () => {},
    isConnected: () => false,
  };
  const pairs = [
    [new SipStreamDecoder(), StreamDecoderAlt],
    [new TypedEventEmitter(), TEEvtAlt],
    [new AuthManager(idGen), AuthAlt],
    [new WorkerMediaController({ postMessage() {}, subscribe: () => () => {} }), MediaAlt],
    [new UserAgent({
      transport, clock, registrarUri: 'sip:x', aor: 'sip:a@x', contact: 'sip:a@x',
      idGenerator: idGen, authManager: new AuthManager(idGen),
    }), UAAlt],
    [new TransactionLayer({
      transport, clock, timers: deriveTimers(DEFAULT_TIMERS, true), reliable: true, emit() {},
    }), TxAlt],
  ];
  for (const [instance, ctor] of pairs) {
    assert.ok(instance instanceof ctor, 'core root value not instanceof subpath class ' + (ctor?.name ?? '?'));
  }
  const d = Dialog.fromUac(request, makeResponse(200, 'OK'), idGen, { token: 'UDP', sentBy: '192.0.2.1:5060' });
  assert.ok(d instanceof DialogAlt, 'core Dialog not instanceof ./dialogs');
}

console.log('core-esm-consumer OK');