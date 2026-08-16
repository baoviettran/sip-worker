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
  BrowserUserAgent,
  BrowserPhone,
  BrowserCall,
  OutgoingBrowserCall,
  IncomingBrowserCall,
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
import type { BrowserMediaOptions } from 'sip-worker/media';
import type {
  SipMessage,
  Transport,
  TransportEvent,
  UserAgentOptions,
  BrowserUserAgentOptions,
  BrowserUserAgentEventMap,
} from 'sip-worker';

import type { SipRequestMessage } from 'sip-worker';
import type { IdGenerator } from 'sip-worker';

declare const transport: Transport;
const clock = { now: () => 0, setTimeout: () => 0, clearTimeout: () => {} };
declare const idGenerator: IdGenerator;

// ---- root values ----
const rootValues: unknown[] = [
  SipError, TransportError, SipStreamDecoder, SipIngress, UserAgent, AuthManager,
  TransactionLayer, Dialog, OptionsLiveness, TypedEventEmitter, BrowserUserAgent,
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

// ---- v0.5: BrowserUserAgent composition root + media facade compile ----
// ---- v0.5 media subpath type: BrowserMediaOptions resolves from sip-worker/media ----
declare const mediaOpts: BrowserMediaOptions;
void mediaOpts;

const browserOptions: BrowserUserAgentOptions = {
  transport,
  clock,
  registrarUri: 'sip:example.test',
  aor: 'sip:alice@example.test',
  contact: 'sip:alice@example.test',
  idGenerator,
  media: {
    iceServers: [
      { urls: 'turns:turn.example.test', username: 'user', credential: 'placeholder' },
    ],
    iceTransportPolicy: 'relay',
    iceGatheringTimeoutMs: 8_000,
    mediaOperationTimeoutMs: 30_000,
    microphoneDeviceId: 'placeholder-device-id',
    audioConstraints: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    codecPreference: ['opus', 'PCMU', 'PCMA'],
  },
};
const browserUa = new BrowserUserAgent(browserOptions);
void browserUa;

// ua.media.prepare
const preparePromise: Promise<void> = browserUa.media.prepare({
  microphoneDeviceId: 'placeholder-device-id',
  signal: new AbortController().signal,
});
void preparePromise;

// ua.media attachRemoteAudio (app-owned element) with teardown
const element: HTMLMediaElement = document.createElement('audio');
declare function doCall(ua: BrowserUserAgent): Promise<void>;

// listDevices / selectMicrophone / setAudioOutput resolve types
void browserUa.media.listDevices();
void browserUa.media.selectMicrophone('placeholder-device-id');
void browserUa.media.setAudioOutput(element, 'placeholder-device-id');

// restartIce / dispose / unified typed event surface
const restartPromise: Promise<void> = browserUa.restartIce();
void restartPromise;
const disposePromise: Promise<void> = browserUa.dispose();
void disposePromise;
declare const eventMap: BrowserUserAgentEventMap;
declare const mapKeys: keyof BrowserUserAgentEventMap;
void eventMap; void mapKeys;

async function attachAndTeardown(ua: BrowserUserAgent): Promise<void> {
  const detach = await ua.media.attachRemoteAudio(element, { outputDeviceId: 'placeholder-device-id', play: true });
  try {
    await doCall(ua);
  } finally {
    detach();
    await ua.dispose();
  }
}
void attachAndTeardown;

// ---- v0.7: the preferred BrowserPhone/BrowserCall surface compiles ----
declare const phone: BrowserPhone;
declare const outgoing: OutgoingBrowserCall;
declare const incoming: IncomingBrowserCall;
declare const browserCall: BrowserCall;
declare const phoneOptions: import('sip-worker').BrowserPhoneOptions;
declare const reconnectOptions: import('sip-worker').ReconnectOptions;
declare const dtmfOptions: import('sip-worker').DtmfOptions;
declare const resourceSnapshot: import('sip-worker').ResourceSnapshot;
declare const connectionState: import('sip-worker').ConnectionState;
declare const registrationState: import('sip-worker').RegistrationState;
declare const callState: import('sip-worker').CallState;
declare const diagnosticCode: import('sip-worker').DiagnosticCode;
void phone; void outgoing; void incoming; void browserCall;
void phoneOptions; void reconnectOptions; void dtmfOptions; void resourceSnapshot;
void connectionState; void registrationState; void callState; void diagnosticCode;

// Phone-level surface: connection/registration getters, events, diagnostics.
declare const phoneEvents: keyof import('sip-worker').BrowserPhoneEventMap;
declare const callEvents: keyof import('sip-worker').BrowserCallEventMap;
const conn: import('sip-worker').ConnectionState = phone.connectionState;
const reg: import('sip-worker').RegistrationState = phone.registrationState;
const resources: import('sip-worker').ResourceSnapshot = phone.diagnostics.resources();
void phoneEvents; void callEvents; void conn; void reg; void resources;

/**
 * Compile the full v0.7 call-control surface without invoking network
 * operations: mute, hold, RFC 4733 DTMF, resume, ICE restart, hangup, dispose.
 */
async function compilePhoneSurface(
  phone: BrowserPhone,
  call: OutgoingBrowserCall,
  signal: AbortSignal,
): Promise<void> {
  call.setMuted(true);
  await call.hold();
  await call.sendDtmf('1', { signal });
  await call.resume();
  await call.restartIce();
  await call.hangup();
  await phone.dispose();
}
void compilePhoneSurface;

export {};
