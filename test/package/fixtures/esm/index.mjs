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
  computeDigest,
  TypedEventEmitter,
} from 'sip-worker';

import { parseMessage as parseMessageAlt } from 'sip-worker/messages';
import { SipStreamDecoder as StreamDecoderAlt } from 'sip-worker/stream';
import {
  NodeTcpTransport,
  NodeUdpTransport,
  NodeWebSocketTransport,
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
import { UserAgent as UserAgentAlt, Registrar } from 'sip-worker/ua';
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

// Exercise a serialization round-trip through the public API.
const request = makeRequest('REGISTER', 'sip:alice@example.test');
const wire = serializeMessage(request);
const parsed = parseMessage(wire);
if (!parsed.ok) throw new Error('message round-trip failed');

console.log('esm-consumer OK');
