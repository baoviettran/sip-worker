// Type fixture: compile against the INSTALLED tarball's declarations. Imports
// values AND types from every advertised subpath so each .d.ts resolution is
// proven. Only public named exports that exist in the barrels are referenced.

// ---- root ----
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
  TypedEventEmitter,
  WorkerRegistrationError as RootWorkerRegistrationError,
  WorkerClosedError as RootWorkerClosedError,
  parseMessage,
  serializeMessage,
  makeRequest,
  computeDigest,
} from 'sip-worker';
import type {
  SipMessage,
  Transport,
  TransportEvent,
  ClientTransaction,
  RegistrationIdentity,
  RegisterState,
  MediaMessage,
} from 'sip-worker';
import type {
  RegistrationStateChangedEvent,
  RegistrationFailedEvent,
  RegistrationEvent,
  RegistrationEventEmitter,
} from 'sip-worker';

// ---- subpaths ----
import {
  parseMessage as msgParse,
  Headers as MsgHeaders,
} from 'sip-worker/messages';
import type {
  SipRequestMessage,
  SipResponseMessage,
  ParseResult,
} from 'sip-worker/messages';

import { SipStreamDecoder as StreamDecoder } from 'sip-worker/stream';

import {
  NodeTcpTransport,
  NodeUdpTransport,
  NodeWebSocketTransport,
  toNativePingSocket,
} from 'sip-worker/transport/node';
import type {
  DatagramSocketLike,
  NativeNodeWebSocket,
  NodeWebSocketLike,
  StreamSocketLike,
  NodeTcpTransportOptions,
  NodeUdpTransportOptions,
} from 'sip-worker/transport/node';

import { BrowserWebSocketTransport } from 'sip-worker/transport/browser';
import type { BrowserWebSocketLike, BrowserWebSocketFactory } from 'sip-worker/transport/browser';

import {
  TransactionLayer as TxLayer,
  deriveTimers,
  buildNon2xxAck,
  MAGIC_COOKIE,
  DEFAULT_TIMERS,
} from 'sip-worker/transactions';
import type {
  TransactionKey,
  TimerConfig,
  DerivedTimers,
  TransactionLayerEvent,
  ServerTransaction,
  TransactionLayerOptions,
} from 'sip-worker/transactions';

import { Dialog as DialogClass, makeBranch, extractTag, isStrictRouter } from 'sip-worker/dialogs';
import type { IdGenerator } from 'sip-worker/dialogs';

import {
  AuthManager as AuthCls,
  parseDigestChallenges,
  selectChallenge,
  computeDigest as digest,
} from 'sip-worker/auth';
import type {
  AuthFailure,
  DigestChallenge,
  DigestAlgorithm,
  DigestParams,
  AuthorizationParams,
  AuthContext,
} from 'sip-worker/auth';

import { UserAgent as UACls, Registrar } from 'sip-worker/ua';
import type { UserAgentOptions, RegistrarOptions, RegistrarStatus } from 'sip-worker/ua';

import {
  WorkerMediaController as MediaCls,
  StubMainMediaHandler,
  STUB_SDP,
  MediaTimeoutError,
} from 'sip-worker/media';
import type {
  MediaCommand,
  MediaPort,
  MediaReply,
  MediaRequestMessage,
  WorkerMediaControllerOptions,
} from 'sip-worker/media';

import { OptionsLiveness as LivenessCls, NodeWebSocketLiveness } from 'sip-worker/reliability';
import type {
  LivenessStrategy,
  NativePingSocket,
  NodeWebSocketLivenessOptions,
  OptionsLivenessOptions,
  RequestFactory,
} from 'sip-worker/reliability';

import {
  WorkerSupervisor as SupCls,
  WorkerRuntime,
  WorkerRestartError,
  WorkerRegistrationError,
  WorkerClosedError,
} from 'sip-worker/bridge';
import type {
  RegistrationSnapshot,
  SerializedError,
  SupervisorEvent,
  SupervisorToWorker,
  WorkerToSupervisor,
  WorkerPort,
  WorkerFactory,
  WorkerSupervisorOptions,
  WorkerRuntimeOptions,
} from 'sip-worker/bridge';

// ---- shared constructor-arg values ----
declare const transport: Transport;
const clock = { now: () => 0, setTimeout: () => 0, clearTimeout: () => {} };
declare const idGenerator: IdGenerator;
const timers: DerivedTimers = deriveTimers(DEFAULT_TIMERS, false);
const layer: TransactionLayer = new TransactionLayer({
  transport,
  clock,
  timers,
  reliable: false,
  emit: (event: TransactionLayerEvent) => void event,
});
const authManager = new AuthManager(idGenerator);

// ---- root values + types ----
const rootValues: unknown[] = [
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
  parseMessage,
  serializeMessage,
  makeRequest,
  computeDigest,
];
for (const v of rootValues) void v;

const uaOptions: UserAgentOptions = {
  transport,
  clock,
  registrarUri: 'sip:example.test',
  aor: 'sip:alice@example.test',
  contact: 'sip:alice@example.test',
  idGenerator,
  authManager,
};
void new UACls(uaOptions);

// ---- registration event types belong on the root ----
const emitter: RegistrationEventEmitter = new UserAgent(uaOptions);
emitter.on('stateChanged', (e: RegistrationStateChangedEvent) => void e.state);
emitter.on('failed', (e: RegistrationFailedEvent) => void e.error);
declare const anyEvent: RegistrationEvent;
void anyEvent;

// ---- messages ----
void msgParse(new Uint8Array());
const request: SipRequestMessage = makeRequest('REGISTER', 'sip:alice@example.test');
declare const response: SipResponseMessage;
const parseResult: ParseResult<SipMessage> = msgParse(request.body);
void parseResult;
void MsgHeaders;
void response;

// ---- stream ----
declare const dec: StreamDecoder;
void dec;

// ---- transport/node ----
void new NodeUdpTransport(
  null as unknown as DatagramSocketLike,
  { localPort: 5060, remoteHost: 'sip.example.test', remotePort: 5060 } as NodeUdpTransportOptions,
);
void new NodeTcpTransport(
  null as unknown as StreamSocketLike,
  { host: 'sip.example.test', port: 5060 } as NodeTcpTransportOptions,
);
void new NodeWebSocketTransport(null as unknown as NodeWebSocketLike);

// ---- native ping adapter is part of the exported surface ----
declare const nativeWs: NativeNodeWebSocket;
const nativePingSocket: NativePingSocket = toNativePingSocket(nativeWs) as unknown as NativePingSocket;
void nativePingSocket;
void toNativePingSocket(undefined);

// ---- transport/browser ----
const wsFactory: BrowserWebSocketFactory = () => null as unknown as BrowserWebSocketLike;
void wsFactory;
void new BrowserWebSocketTransport('wss://sip.example.test/ws', wsFactory);

// ---- transactions ----
declare const timerConfig: TimerConfig;
const derived = deriveTimers(timerConfig, true);
void derived;
declare const serverTx: ServerTransaction;
void serverTx;
void buildNon2xxAck(request, response);
void MAGIC_COOKIE;
declare const tKey: TransactionKey;
declare const layerEvent: TransactionLayerEvent;
const validTransactionKey: TransactionKey = 'branch|example.com:5060|INVITE';
void validTransactionKey;
// @ts-expect-error TransactionKey requires branch, sent-by, and method components.
const invalidTransactionKey: TransactionKey = 'branch|INVITE';
void invalidTransactionKey;
declare const layerOptions: TransactionLayerOptions;
void tKey;
void layerEvent;
void layerOptions;

// ---- dialogs ----
declare const requestMsg: SipRequestMessage;
declare const responseMsg: SipResponseMessage;
const dialog: typeof DialogClass = DialogClass;
void dialog;
if (typeof DialogClass.fromUac === 'function') {
  const d = DialogClass.fromUac(requestMsg, responseMsg, idGenerator, {
    token: 'UDP',
    sentBy: '192.0.2.1:5060',
  });
  void d;
}
void makeBranch('branch');
void extractTag('tag');
void isStrictRouter('router');

// ---- auth ----
declare const authContext: AuthContext;
const retried = authManager.retry(authContext);
declare const authFailure: AuthFailure;
void retried;
void authFailure;
void parseDigestChallenges(['WWW-Authenticate: Digest realm="x", nonce="y"']);
void selectChallenge([] as DigestChallenge[]);
void digest({
  algorithm: 'MD5',
  username: 'user',
  password: 'pass',
  realm: 'realm',
  nonce: 'nonce',
  method: 'REGISTER',
  uri: 'sip:example.test',
});
declare const alg: DigestAlgorithm;
declare const authz: AuthorizationParams;
void alg;
void authz;

// ---- ua ----
const regOptions: RegistrarOptions = {
  registrarUri: 'sip:example.test',
  aor: 'sip:alice@example.test',
  contact: 'sip:alice@example.test',
  viaAddress: '192.0.2.1:5060',
  viaToken: 'TCP',
  idGenerator,
  layer,
  clock,
  authManager,
};
void new Registrar(regOptions);
declare const regStatus: RegistrarStatus;
void regStatus;
declare const regId: RegistrationIdentity;
declare const regState: RegisterState;
void regId;
void regState;

// ---- reliability ----
const livenessOpts: OptionsLivenessOptions = {
  layer,
  clock,
  requestFactory: ((index: number) =>
    makeRequest('OPTIONS', `sip:probe${index}@example.test`)) as unknown as RequestFactory,
  probeIntervalMs: 30000,
  onFailure: (e: Error) => void e,
};
void new LivenessCls(livenessOpts);
declare const nativeSocket: NativePingSocket;
const wsLivenessOpts: NodeWebSocketLivenessOptions = {
  socket: nativeSocket,
  clock,
  probeIntervalMs: 30000,
  deadlineMs: 5000,
  onFailure: (e: Error) => void e,
};
void new NodeWebSocketLiveness(wsLivenessOpts);
declare const strategy: LivenessStrategy;
void strategy;

// ---- bridge ----
const supOptions: WorkerSupervisorOptions = {
  factory: null as unknown as WorkerFactory,
  clock,
  registration: null as unknown as RegistrationSnapshot,
  heartbeatIntervalMs: 1000,
  heartbeatTimeoutMs: 3000,
};
void new SupCls(supOptions);
declare const workerPort: WorkerPort;
const runtimeLegacyPort = workerPort as unknown as WorkerToSupervisor;
const runtimeOptions: WorkerRuntimeOptions = {
  port: { postMessage: (m: WorkerToSupervisor) => void m, subscribe: (l: (m: SupervisorToWorker) => void) => () => void l } as never,
  buildUserAgent: (snapshot: RegistrationSnapshot) =>
    new UACls({
      transport,
      clock,
      registrarUri: snapshot.registrar,
      aor: snapshot.aor,
      contact: snapshot.contactUri,
      credentials: snapshot.credentials,
      idGenerator,
    }),
};
void runtimeLegacyPort;
void new WorkerRuntime(runtimeOptions);
declare const restart: WorkerRestartError;
void restart;
declare const regFailed: WorkerRegistrationError;
void regFailed;
declare const workerClosed: WorkerClosedError;
void workerClosed;
declare const serializedErr: SerializedError;
void serializedErr;
// Root-level re-exports of the new error classes are importable.
void RootWorkerRegistrationError;
void RootWorkerClosedError;
declare const supToWorker: SupervisorToWorker;
declare const workerToSup: WorkerToSupervisor;
declare const supEvent: SupervisorEvent;
void supToWorker;
void workerToSup;
void supEvent;

// ---- media ----
void new MediaCls({} as MediaPort);
void new MediaCls({} as MediaPort, {} as WorkerMediaControllerOptions);
void new StubMainMediaHandler({} as MediaPort);
void STUB_SDP;
declare const mediaCmd: MediaCommand;
declare const mediaReply: MediaReply;
declare const mediaReq: MediaRequestMessage;
declare const mediaTimeout: MediaTimeoutError;
declare const mediaOpts: WorkerMediaControllerOptions;
void mediaCmd;
void mediaReply;
void mediaReq;
void mediaTimeout;
void mediaOpts;

// ---- transport event type is exported from root ----
declare const tEvent: TransportEvent;
declare const clientTx: ClientTransaction;
declare const mediaMsg: MediaMessage;
void tEvent;
void clientTx;
void mediaMsg;

export {};
