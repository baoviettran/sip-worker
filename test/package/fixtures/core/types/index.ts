// Type fixture: compile against the INSTALLED @sip-worker/core tarball's
// declarations. Imports values AND types from every advertised subpath so each
// .d.ts / .d.cts resolution is proven for the core package.
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
import type {
  SipMessage,
  SipErrorCode,
  Transport,
  TransportCapabilities,
  TransportEvent,
  Clock,
  MessageSink,
  ClientTransaction,
  ServerTransaction,
  DerivedTimers,
  TimerConfig,
  TransactionKey,
  TransactionLayerEvent,
  RegistrationIdentity,
  RegisterState,
  SessionState,
  SessionEvent,
  UserAgentOptions,
  RegistrationStateChangedEvent,
} from '@sip-worker/core';

import {
  parseMessage as msgParse,
  Headers as MsgHeaders,
  isRequest,
  bodyText,
} from '@sip-worker/core/messages';
import type {
  SipRequestMessage,
  SipResponseMessage,
  ParseResult,
} from '@sip-worker/core/messages';

import { SipStreamDecoder as StreamDecoder } from '@sip-worker/core/stream';
import { SipIngress as Ingress, type MessageSink as Sink } from '@sip-worker/core/transport';
import type {
  TransportCapabilities as Caps,
  TransportEvent as TEvent,
  TransportToken,
} from '@sip-worker/core/transport';

import {
  TransactionLayer as TxLayer,
  deriveTimers,
  buildNon2xxAck,
  DEFAULT_TIMERS,
} from '@sip-worker/core/transactions';
import type {
  TransactionKey as TKey,
  TimerConfig as TConfig,
  DerivedTimers as DTimers,
  TransactionLayerOptions as TxOptions,
  ClientTransaction as Ctx,
  ServerTransaction as Stx,
} from '@sip-worker/core/transactions';

import { Dialog as DialogClass, makeBranch, extractTag } from '@sip-worker/core/dialogs';
import type { IdGenerator } from '@sip-worker/core/dialogs';

import {
  AuthManager as AuthCls,
  parseDigestChallenges,
  selectChallenge,
  computeDigest as digest,
} from '@sip-worker/core/auth';
import type {
  AuthContext,
  AuthFailure,
  DigestChallenge,
  DigestAlgorithm,
  DigestParams,
  AuthorizationParams,
} from '@sip-worker/core/auth';

import { UserAgent as UACls, Registrar } from '@sip-worker/core/ua';
import type { UserAgentOptions as UaOptions, RegistrarOptions, RegistrarStatus } from '@sip-worker/core/ua';

import {
  WorkerMediaController as MediaCls,
  StubMainMediaHandler,
  STUB_SDP,
  MediaTimeoutError,
} from '@sip-worker/core/media';
import type {
  MediaCommand,
  MediaPort,
  MediaReply,
  MediaRequestMessage,
  WorkerMediaControllerOptions,
} from '@sip-worker/core/media';

import { OptionsLiveness as LivenessCls } from '@sip-worker/core/reliability';
import type {
  LivenessStrategy,
  OptionsLivenessOptions,
  RequestFactory,
} from '@sip-worker/core/reliability';

import {
  WorkerSupervisor as SupCls,
  WorkerRuntime,
  WorkerRestartError,
} from '@sip-worker/core/bridge';
import type {
  RegistrationSnapshot,
  SerializedError,
  SupervisorEvent,
  SupervisorToWorker,
  WorkerPort,
  WorkerToSupervisor,
  WorkerRuntimeOptions,
  WorkerSupervisorOptions,
  WorkerFactory,
} from '@sip-worker/core/bridge';

// ---- shared constructor values ----
declare const transport: Transport;
const clock: Clock = { now: () => 0, setTimeout: () => 0, clearTimeout: () => {} };
declare const idGenerator: IdGenerator;
const timers: DerivedTimers = deriveTimers(DEFAULT_TIMERS, true);
const layer: TransactionLayer = new TransactionLayer({
  transport,
  clock,
  timers,
  reliable: true,
  emit: (event: TransactionLayerEvent) => void event,
});
const authManager = new AuthManager(idGenerator);

// ---- root values + types ----
const rootValues: unknown[] = [
  SipError, TransportError, SipStreamDecoder, SipIngress, UserAgent, AuthManager,
  TransactionLayer, Dialog, OptionsLiveness, WorkerSupervisor,
  WorkerMediaController, TypedEventEmitter, parseMessage, serializeMessage,
  makeRequest, makeResponse, computeDigest,
];
for (const v of rootValues) void v;

const code: SipErrorCode = 'REGISTRATION_FAILED';
void new SipError(0, 'failed', code);
void new TransportError('transport failed');

declare const caps: TransportCapabilities;
declare const tEvent: TransportEvent;
declare const sink: MessageSink;
declare const clientTx: ClientTransaction;
declare const serverTx: ServerTransaction;
declare const tKey: TransactionKey;
declare const layerEvent: TransactionLayerEvent;
declare const tConfig: TimerConfig;
declare const regIdentity: RegistrationIdentity;
declare const regState: RegisterState;
declare const sessState: SessionState;
declare const sessEvent: SessionEvent;
void caps; void sink; void clientTx; void serverTx; void tKey;
void layerEvent; void tConfig; void regIdentity; void regState;
void sessState; void sessEvent; void tEvent;

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

// ---- messages ----
void msgParse(new Uint8Array());
const request: SipRequestMessage = makeRequest('REGISTER', 'sip:alice@example.test');
declare const response: SipResponseMessage;
const parseResult: ParseResult<SipMessage> = msgParse(request.body);
void parseResult;
void MsgHeaders;
void isRequest(request);
void bodyText(request);
void response;

// ---- stream + transport ----
declare const dec: StreamDecoder;
void dec;
const ingress: Ingress = new Ingress(transport, layer as unknown as Sink, () => {});
void ingress;
declare const token: TransportToken;
declare const caps2: Caps;
declare const tevt: TEvent;
void token; void caps2; void tevt;

// ---- transactions ----
const derived: DTimers = deriveTimers(tConfig, true);
void derived;
void buildNon2xxAck(request, response);
void DEFAULT_TIMERS;
declare const txKey: TKey;
declare const txOpts: TxOptions;
declare const ctx: Ctx;
declare const stx2: Stx;
void txKey; void txOpts; void ctx; void stx2;

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

// ---- auth ----
declare const authContext: AuthContext;
const retried = authManager.retry(authContext);
declare const authFailure: AuthFailure;
void retried; void authFailure;
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
void alg; void authz;

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
const emitter = new UACls(uaOptions);
emitter.on('registrationStateChanged', (event: RegistrationStateChangedEvent) => void event);
void new TypedEventEmitter();

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
declare const strategy: LivenessStrategy;
void strategy;

// ---- media ----
void new MediaCls({} as MediaPort);
void new MediaCls({} as MediaPort, {} as WorkerMediaControllerOptions);
void new StubMainMediaHandler({} as MediaPort);
void STUB_SDP;
declare const mediaCmd: MediaCommand;
declare const mediaReply: MediaReply;
declare const mediaReq: MediaRequestMessage;
declare const mediaTimeout: MediaTimeoutError;
void mediaCmd; void mediaReply; void mediaReq; void mediaTimeout;

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
void workerPort;
void new WorkerRuntime(runtimeOptions);
declare const restart: WorkerRestartError;
declare const serializedErr: SerializedError;
declare const supervisorEvent: SupervisorEvent;
void restart; void serializedErr; void supervisorEvent;

export {};