// Runtime fixture: import every advertised sip-worker subpath and exercise a few
// exports from each. Runs against an installed tarball in a fresh ESM consumer.

import {
  SipError,
  SipStreamDecoder,
  SipIngress,
  UserAgent,
  AuthManager,
  TransactionLayer,
  Dialog,
  OptionsLiveness,
  WorkerSupervisor,
  WorkerMediaController,
  parseMessage,
  serializeMessage,
  makeRequest,
  makeResponse,
  computeDigest,
  TypedEventEmitter,
} from 'sip-worker';

import { parseMessage as parseMessageAlt } from 'sip-worker/messages';
import { SipStreamDecoder as StreamDecoderAlt } from 'sip-worker/stream';
import {
  NodeTcpTransport,
  NodeUdpTransport,
  NodeWebSocketTransport,
  toNativePingSocket,
} from 'sip-worker/transport/node';
import { BrowserWebSocketTransport } from 'sip-worker/transport/browser';
import {
  TransactionLayer as TransactionsLayer,
  deriveTimers,
  buildNon2xxAck,
} from 'sip-worker/transactions';
import { Dialog as DialogAlt, makeBranch } from 'sip-worker/dialogs';
import {
  AuthManager as AuthManagerAlt,
  parseDigestChallenges,
  selectChallenge,
  sha256,
  md5,
} from 'sip-worker/auth';
import { UserAgent as UserAgentAlt, Registrar, TypedEventEmitter as TypedEventEmitterAlt } from 'sip-worker/ua';
import {
  WorkerMediaController as MediaControllerAlt,
  StubMainMediaHandler,
  STUB_SDP,
} from 'sip-worker/media';
import {
  OptionsLiveness as OptionsLivenessAlt,
  NodeWebSocketLiveness,
} from 'sip-worker/reliability';
import {
  WorkerSupervisor as SupervisorAlt,
  WorkerRuntime,
  WorkerRestartError,
} from 'sip-worker/bridge';

const rootClasses = [
  SipError,
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
];
for (const C of rootClasses) {
  if (typeof C !== 'function') throw new Error(`root export missing: ${C?.name}`);
}

// Every subpath must resolve its named exports at runtime (identity need not
// match across entries: each is independently bundled).
const subpathValues = [
  parseMessageAlt,
  StreamDecoderAlt,
  TransactionsLayer,
  DialogAlt,
  AuthManagerAlt,
  UserAgentAlt,
  MediaControllerAlt,
  OptionsLivenessAlt,
  SupervisorAlt,
];
for (const v of subpathValues) {
  if (typeof v !== 'function') throw new Error('subpath value not a function');
}

const values = [
  NodeTcpTransport,
  NodeUdpTransport,
  NodeWebSocketTransport,
  toNativePingSocket,
  BrowserWebSocketTransport,
  deriveTimers,
  buildNon2xxAck,
  makeBranch,
  parseDigestChallenges,
  selectChallenge,
  sha256,
  md5,
  Registrar,
  StubMainMediaHandler,
  NodeWebSocketLiveness,
  WorkerRuntime,
  WorkerRestartError,
  computeDigest,
];
for (const v of values) {
  if (typeof v !== 'function') throw new Error(`fixture value not function: ${String(v)}`);
}
if (typeof STUB_SDP !== 'string') throw new Error('STUB_SDP not a string');

// ---- native ping adapter: toNativePingSocket must adapt a Node WebSocket to
// the reliability NativePingSocket surface, and must be a no-op for a socket
// with no native ping hook.
{
  let pongs = 0;
  const nonce = new Uint8Array([1, 2, 3]);
  const pongListeners = new Set();
  const nativeWs = {
    ping(payload) {
      this.sent = payload;
    },
    on(event, listener) {
      if (event === 'pong') pongListeners.add(listener);
    },
    off(event, listener) {
      if (event === 'pong') pongListeners.delete(listener);
    },
    firePong(payload) {
      for (const listener of [...pongListeners]) listener(payload);
    },
  };
  const sock = toNativePingSocket(nativeWs);
  if (!sock) throw new Error('toNativePingSocket refused a native socket');
  const unsubscribe = sock.onPong((payload) => {
    pongs += 1;
    assertEqual(payload, nonce);
  });
  sock.ping(nonce);
  nativeWs.firePong(nonce);
  if (pongs !== 1) throw new Error('pong callback not invoked');
  unsubscribe();
  nativeWs.firePong(nonce);
  if (pongs !== 1) throw new Error('pong callback still wired after unsubscribe');

  if (toNativePingSocket(undefined) !== undefined) throw new Error('undefined socket should yield undefined');
  if (toNativePingSocket({ on() {}, off() {} }) !== undefined) {
    throw new Error('socket without ping should yield undefined');
  }
}
function assertEqual(actual, expected) {
  if (!(actual instanceof Uint8Array) || actual.length !== expected.length) {
    throw new Error('payload mismatch');
  }
  for (let i = 0; i < expected.length; i += 1) {
    if (actual[i] !== expected[i]) throw new Error('payload mismatch at byte ' + i);
  }
}

// Exercise a serialization round-trip through the public API.
const request = makeRequest('REGISTER', 'sip:alice@example.test');
const wire = serializeMessage(request);
const parsed = parseMessage(wire);
if (!parsed.ok) throw new Error('message round-trip failed');

// ---- instanceof identity: a value from the root bundle must be instanceof the
// same class imported from a subpath bundle. This only holds when the shared
// core is code-split into a common chunk both bundles load; duplicating the
// class per entry breaks it. The classes below are the load-bearing public
// surface (default or cheap constructors only).
{
  const rootInstances = [
    [new SipStreamDecoder(), SipStreamDecoder, StreamDecoderAlt],
    [new TypedEventEmitter(), TypedEventEmitter, TypedEventEmitterAlt],
    [new AuthManager(idGenerator()), AuthManager, AuthManagerAlt],
    [new WorkerMediaController(mediaPort()), WorkerMediaController, MediaControllerAlt],
    [new UserAgent(uaOptions()), UserAgent, UserAgentAlt],
    [new TransactionLayer(txOptions()), TransactionLayer, TransactionsLayer],
    [makeDialog(), Dialog, DialogAlt],
  ];
  for (const [instance, rootCtor, subpathCtor] of rootInstances) {
    if (!(instance instanceof rootCtor)) throw new Error(`self instanceof failed: ${rootCtor?.name}`);
    if (!(instance instanceof subpathCtor)) {
      throw new Error(`root value not instanceof subpath class ${subpathCtor?.name ?? '?'}`);
    }
  }
}
function idGenerator() {
  let branchNo = 0;
  return { branch: () => `z9hG4bK-fx${branchNo++}` };
}
function mediaPort() {
  return {
    postMessage() {},
    subscribe() {
      return () => {};
    },
  };
}
function uaOptions() {
  return {
    transport: nodeTransport(),
    clock: makeClock(),
    registrarUri: 'sip:example.test',
    aor: 'sip:alice@example.test',
    contact: 'sip:alice@example.test',
    idGenerator: idGenerator(),
    authManager: new AuthManager(idGenerator()),
  };
}
function txOptions() {
  return {
    transport: nodeTransport(),
    clock: makeClock(),
    timers: { T1: 500, T2: 4000, TF: 32000, T4: 5000, TK: 4000 },
    reliable: true,
    emit() {},
  };
}
function makeDialog() {
  const idGen = idGenerator();
  const req = makeRequest('INVITE', 'sip:bob@example.test');
  req.headers.append('From', '<sip:alice@example.test>;tag=a1');
  req.headers.append('Call-ID', 'cid-1');
  req.headers.append('Max-Forwards', '70');
  const res = serializeMessage(makeResponse(200, 'OK'));
  return Dialog.fromUac(req, parseMessage(res).value, idGen, {
    token: 'UDP',
    sentBy: '192.0.2.1:5060',
  });
}
function makeClock() {
  return {
    now: () => 0,
    setTimeout: () => 0,
    clearTimeout: () => {},
  };
}
function nodeTransport() {
  return {
    egress(_, sink) {
      sink({ type: 'data', data: new Uint8Array(0) });
    },
    capabilities: { reliable: true, framing: 'message', token: 'WSS' },
    connect: () => Promise.resolve(),
    disconnect: () => Promise.resolve(),
    send: () => Promise.resolve(),
    subscribe: () => () => {},
    isConnected: () => false,
  };
}

console.log('esm-consumer OK');
