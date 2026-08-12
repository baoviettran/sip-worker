// Type fixture: compile against the INSTALLED sip-worker (browser) tarball's
// declarations. Imports values AND types from the root and ./transport subpath.
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
  TypedEventEmitter,
  makeRequest,
  makeResponse,
  serializeMessage,
  parseMessage,
} from 'sip-worker';
import { BrowserWebSocketTransport } from 'sip-worker/transport';
import type {
  BrowserWebSocketFactory,
  BrowserWebSocketLike,
} from 'sip-worker/transport';
import type {
  SipMessage,
  Transport,
  TransportEvent,
  UserAgentOptions,
} from 'sip-worker';

import type { SipRequestMessage } from 'sip-worker';
import type { IdGenerator } from 'sip-worker';

declare const transport: Transport;
const clock = { now: () => 0, setTimeout: () => 0, clearTimeout: () => {} };
declare const idGenerator: IdGenerator;

// ---- root values ----
const rootValues: unknown[] = [
  SipError, TransportError, SipStreamDecoder, SipIngress, UserAgent, AuthManager,
  TransactionLayer, Dialog, OptionsLiveness, TypedEventEmitter,
  makeRequest, makeResponse, serializeMessage, parseMessage,
];
for (const v of rootValues) void v;

void new SipError(0, 'x', 'PROTOCOL_ERROR');
void new TransportError('boom');

// ---- transport subpath ----
const wsFactory: BrowserWebSocketFactory = () => null as unknown as BrowserWebSocketLike;
void wsFactory;
const wsTransport = new BrowserWebSocketTransport('wss://sip.example.test/ws', wsFactory);
void wsTransport;
declare const wsLike: BrowserWebSocketLike;
void wsLike;

// ---- UA options compile against the browser root ----
const uaOptions: UserAgentOptions = {
  transport,
  clock,
  registrarUri: 'sip:example.test',
  aor: 'sip:alice@example.test',
  contact: 'sip:alice@example.test',
  idGenerator,
  authManager: new AuthManager(idGenerator),
};
void new UserAgent(uaOptions);

// ---- codec types ----
const request: SipRequestMessage = makeRequest('REGISTER', 'sip:alice@example.test');
declare const message: SipMessage;
declare const tEvent: TransportEvent;
void request; void message; void tEvent;

export {};