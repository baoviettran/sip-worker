/**
 * Deterministic test harness for the BrowserPhone composition root (v0.7).
 *
 * Builds a {@link BrowserPhone} with every environment seam injected: a fake
 * browser WebSocket (auto-opened, so `connect()` resolves), a fake media
 * environment with one scriptable peer connection, a browser lifecycle host,
 * a controlled clock, and a monotonic id generator. The outbound REGISTER is
 * auto-answered with a 200 OK so `register()` resolves; INVITE handling is left
 * to the explicit `answerInviteAndConnectMedia` helper so the tests control call
 * establishment.
 *
 * Module-scoped helpers (`sentRequests`, `outboundResponseCodes`,
 * `answerInviteAndConnectMedia`, `respondOk`, `sendIncomingInvite`) act on the
 * most recently built phone, so the task brief's snippet reads verbatim.
 */

import {
  Headers,
  STUB_SDP,
  makeRequest,
  makeResponse,
  serializeMessage,
  withTextBody,
  type SipResponseMessage,
} from '@sip-worker/core';
import { BrowserPhone } from '../../src/phone/browser-phone.js';
import type { WebRtcMediaManager } from '../../src/media/media-manager.js';
import type { BrowserWebSocketFactory, BrowserWebSocketLike } from '../../src/transport/ws.js';
import type { BrowserLifecycleHost } from '../../src/recovery/browser-lifecycle.js';
import type { BrowserPhoneOptions, ReconnectOptions } from '../../src/phone/types.js';
import { FakeBrowserWebSocket } from './fake-browser-web-socket.js';
import { FakeMediaEnvironment, FakePeerConnection } from './fake-media-environment.js';
import { ControlledClock } from './controlled-clock.js';

/** In-memory browser online/offline/page-lifecycle host. */
class FakeLifecycleHost implements BrowserLifecycleHost {
  private online = true;
  private readonly listeners = new Map<string, Set<() => void>>();

  isOnline(): boolean {
    return this.online;
  }

  subscribe(type: 'online' | 'offline' | 'pagehide', listener: () => void): () => void {
    let listeners = this.listeners.get(type);
    if (listeners === undefined) {
      listeners = new Set();
      this.listeners.set(type, listeners);
    }
    listeners.add(listener);
    return () => {
      listeners?.delete(listener);
    };
  }

  setOnline(value: boolean): void {
    this.online = value;
    const event = value ? 'online' : 'offline';
    for (const listener of [...(this.listeners.get(event) ?? [])]) {
      listener();
    }
  }
}

/**
 * Phone-specific WebSocket fake: `close()` emits the real browser `close` event
 * so the transport's `disconnect()` settles. The shared {@link FakeBrowserWebSocket}
 * keeps manual `emitClose` (the transport suite depends on it); this subclass
 * opts into auto-close for the composition-harness flow.
 */
class FakePhoneWebSocket extends FakeBrowserWebSocket {
  override close(code?: number, reason?: string): void {
    super.close(code, reason);
    this.emitClose(code ?? 1000, reason ?? '');
  }
}

const REALM = 'sip.example.com';
const NONCE = '0cef7a94b60e1e00c9d1e5e';

function statusText(status: number): string {
  return status === 200 ? 'OK' : 'Unauthorized';
}

/**
 * Deterministic SIP-over-WSS server fake for recovery orchestration.
 *
 * Each transport connect attempt asks the factory for a new socket generation;
 * the server hands out fresh sockets and tracks all of them. The FIRST socket
 * is auto-opened so the initial `connect()` resolves immediately. After
 * `dropSocket()` (an unexpected loss) the phone's bounded reconnect may open
 * further sockets. Per-connect behavior is scripted via `connectOnNext`:
 * `'open'` (default) hands out an already-open socket, `'error'` hands a
 * closed one so the transport rejects immediately, `'pending'` hands out a
 * still-connecting socket that `openNextSocket()` later opens. The server
 * auto-answers every outbound REGISTER (200) so recovered re-registration also
 * settles; Register Call-ID/CSeq history is aggregate across every generation.
 */
type ConnectBehavior = 'open' | 'error' | 'pending';

class FakeSipServer {
  /** All sockets ever handed out, in factory-call order. */
  readonly sockets: FakePhoneWebSocket[] = [];
  /** Headers of REGISTER requests across every socket, in wire order. */
  readonly registers: MessageHead[] = [];
  private nextBehavior: ConnectBehavior[] = [];
  /** When false, outbound REGISTERs are not auto-answered by the server. */
  autoRespondRegister: boolean;

  constructor(autoRespond = true) {
    this.autoRespondRegister = autoRespond;
  }

  /** Script the behavior for the next `count` non-initial factory calls. */
  connectOnNext(behavior: ConnectBehavior, count = 1): void {
    for (let i = 0; i < count; i += 1) this.nextBehavior.push(behavior);
  }

  readonly factory: BrowserWebSocketFactory = (): BrowserWebSocketLike => {
    const socket = new FakePhoneWebSocket();
    socket.binaryType = 'arraybuffer';
    const isFirst = this.sockets.length === 0;
    const behavior = isFirst ? 'open' : (this.nextBehavior.shift() ?? 'open');
    if (behavior === 'open') {
      socket.readyState = 1;
      socket.protocol = 'sip';
    } else if (behavior === 'error') {
      socket.readyState = 3;
    } else {
      socket.readyState = 0;
    }
    this.track(socket);
    return socket;
  };

  get current(): FakePhoneWebSocket {
    const current = this.sockets[this.sockets.length - 1];
    if (current === undefined) throw new Error('no server socket has been created yet');
    return current;
  }

  private track(socket: FakePhoneWebSocket): void {
    this.sockets.push(socket);
    const originalSend = socket.send.bind(socket);
    socket.send = (data: Uint8Array): void => {
      originalSend(data);
      const head = parseHead(data);
      if (head !== undefined && head.method === 'REGISTER') this.registers.push(head);
      if (this.autoRespondRegister && head !== undefined && head.method === 'REGISTER') {
        this.answerRegister(200);
      }
    };
  }

  /** Open the most recently created (pending) socket as a successful connection. */
  openNextSocket(): void {
    const socket = this.current;
    if (socket.readyState !== 0) throw new Error('openNextSocket expected a pending socket');
    socket.emitOpen('sip');
  }

  /** Answer the most recent outbound REGISTER with the given status (default 200). */
  answerRegister(status = 200): void {
    const last = this.registers.at(-1);
    if (last === undefined) throw new Error('no outbound REGISTER to answer');
    const sentText = this.sockets
      .flatMap((s) => s.sent)
      .map((b) => new TextDecoder().decode(b))
      .reverse()
      .find((t) => parseFromText(t)?.method === 'REGISTER');
    const via = sentText === undefined ? last : parseFromText(sentText)!;
    const headers = new Headers();
    headers.set('Via', via.via);
    headers.set('From', via.from);
    headers.set('To', `${via.to};tag=${status === 200 ? 'server-tag' : ''}`);
    headers.set('Call-ID', via.callId);
    headers.set('CSeq', via.cseqLine);
    headers.set('Contact', '<sip:bob@192.0.2.2:5060>');
    if (status === 401) headers.set('WWW-Authenticate', `Digest realm="${REALM}", nonce="${NONCE}"`);
    this.current.emitMessage(serializeMessage(makeResponse(status, statusText(status), headers)));
  }

  /** Close the current connection abnormally (unexpected transport loss). */
  dropSocket(code = 1006): void {
    this.current.emitClose(code, '');
  }
}

let idCounter = 0;
function idGenerator() {
  return { branch: () => `id-${(idCounter += 1)}` };
}

/** The assembled harness; the PhoneHarness owns every injected seam. */
export interface PhoneHarness {
  readonly phone: BrowserPhone;
  readonly socket: FakeBrowserWebSocket;
  readonly server: FakeSipServer;
  readonly lifecycle: FakeLifecycleHost;
  readonly env: FakeMediaEnvironment;
  readonly pc: FakePeerConnection;
  readonly clock: ControlledClock;
  /** The runtime's media manager, for driving in-call device replacement. */
  readonly manager: WebRtcMediaManager;
}

interface BuildPhoneOptions {
  readonly media?: BrowserPhoneOptions['media'];
  readonly url?: string;
  readonly reconnect?: Partial<ReconnectOptions>;
  /** When true, outbound REGISTER is not auto-answered by the harness. */
  readonly autoRespondRegister?: boolean;
  /** Credentials for authenticated (challenging) registration. */
  readonly credentials?: { readonly username: string; readonly password: string };
}

let current: PhoneHarness | undefined;

/** Build a fresh phone, replacing the current module-scoped harness. */
export function buildPhone(options: BuildPhoneOptions = {}): PhoneHarness {
  const server = new FakeSipServer(options.autoRespondRegister !== false);
  const factory: BrowserWebSocketFactory = server.factory;

  const lifecycle = new FakeLifecycleHost();
  const env = new FakeMediaEnvironment([
    { deviceId: 'mic-1', label: 'Mic', groupId: 'g-1', kind: 'audioinput' },
    { deviceId: 'mic-2', label: 'Mic 2', groupId: 'g-1', kind: 'audioinput' },
    { deviceId: 'spk-1', label: 'Speaker', groupId: 'g-2', kind: 'audiooutput' },
  ]);
  const pc = new FakePeerConnection();
  pc.autoCompleteIceGathering = true;
  env.queuedPeerConnections.push(pc as unknown as RTCPeerConnection);

  const clock = new ControlledClock();

  // A call's offer/answer acquire a local microphone track from the media
  // environment. Seed a mic stream so `acquireMicrophone` resolves.
  env.queuedUserMedia.push(makeAudioStream());

  const phone = new BrowserPhone({
    options: {
      signaling: {
        url: options.url ?? 'wss://sip.example.test/ws',
        reconnect: options.reconnect === undefined
          ? undefined
          : { maxAttempts: 3, initialDelayMs: 10, maxDelayMs: 20, recoveryTimeoutMs: 100, ...options.reconnect },
      },
      account: {
        registrarUri: 'sip:registrar.example.com',
        aor: 'sip:alice@example.com',
        contact: '<sip:alice@192.0.2.1:5060>',
        ...(options.credentials === undefined
          ? {}
          : { username: options.credentials.username, password: options.credentials.password }),
      },
      media: options.media,
    },
    factory,
    lifecycle,
    mediaEnvironment: env,
    clock,
    idGenerator: idGenerator(),
    // RFC 3261 14.2 glare-retry windows are deterministic under random=0: the
    // Call-ID owner waits 2100ms, the other endpoint 0ms (both floor(0*1901/2001)).
    random: () => 0,
  });

  const harness: PhoneHarness = {
    phone,
    // The initial socket is created on the first factory call (phone.connect()),
    // so resolve it lazily rather than capturing it (undefined) at build time.
    get socket(): FakeBrowserWebSocket {
      return server.sockets[0]!;
    },
    server,
    lifecycle,
    env,
    pc,
    clock,
    // The phone keeps its runtime private; the harness reaches the manager
    // through it so tests can drive in-call device replacement directly.
    manager: (phone as unknown as { runtime: { manager: WebRtcMediaManager } }).runtime.manager,
  };
  current = harness;
  return harness;
}

function currentHarness(): PhoneHarness {
  if (current === undefined) throw new Error('buildPhone() must run before harness helpers');
  return current;
}

/** Deliver an initial INVITE from a remote caller. */
export function sendIncomingInvite(callId: string, branch: string): void {
  currentHarness().socket.emitMessage(
    serializeMessage(
      makeRequest('INVITE', 'sip:alice@example.com', buildIncomingHeaders(`<sip:bob@example.com>;tag=bob-tag`, callId, branch), new TextEncoder().encode(STUB_SDP)),
    ),
  );
}

/** Build the headers of an incoming INVITE from a caller-side From header. */
export function buildIncomingHeaders(
  fromHeader: string,
  callId = `long-from-${callIdSeed}@example.com`,
  branch = 'long-from',
): Headers {
  const headers = new Headers();
  headers.set('Via', `SIP/2.0/TCP 192.0.2.2:5060;branch=z9hG4bK-${branch}`);
  headers.set('Max-Forwards', '70');
  headers.set('From', fromHeader);
  headers.set('To', '<sip:alice@example.com>');
  headers.set('Call-ID', callId);
  headers.set('CSeq', '1 INVITE');
  headers.set('Contact', '<sip:bob@192.0.2.2:5060>');
  headers.set('Content-Type', 'application/sdp');
  return headers;
}

/** Deliver an initial INVITE built from pre-formed headers. */
export function emitIncoming(headers: Headers): void {
  currentHarness().socket.emitMessage(
    serializeMessage(
      makeRequest('INVITE', 'sip:alice@example.com', headers, new TextEncoder().encode(STUB_SDP)),
    ),
  );
}

let callIdSeed = 0;

/** The phone from the most recently built harness. */
export function currentPhone(): BrowserPhone {
  return currentHarness().phone;
}

/** The most recent outbound INVITE request head, if any. */
export function lastInvite(): MessageHead | undefined {
  return sentRequests('INVITE').at(-1);
}

/**
 * Send a remote BYE for the dialog formed by the most recent outbound INVITE
 * (mirrors core's createRemoteBye: INVITE To → BYE From + remote tag, INVITE
 * From → BYE To, from the INVITE's Call-ID, CSeq '1 BYE'). The remote tag is
 * the one the phone's outbound 200 OK assigned to its To (the callee's tag).
 */
export function emitRemoteBye(remoteTag = remoteTagOfLast200(), branch = 'remote-bye'): void {
  const harness = currentHarness();
  const inv = lastInvite();
  if (inv === undefined) throw new Error('no outbound INVITE to build BYE from');
  const headers = new Headers();
  headers.set('Via', `SIP/2.0/UDP 192.0.2.2:5060;branch=z9hG4bK-${branch}`);
  headers.set('Max-Forwards', '70');
  const from = inv.to.includes('tag=') ? inv.to : `${inv.to};tag=${remoteTag}`;
  headers.set('From', from);
  headers.set('To', inv.from);
  headers.set('Call-ID', inv.callId);
  headers.set('CSeq', '1 BYE');
  harness.socket.emitMessage(
    serializeMessage(makeRequest('BYE', localUriOf(inv.from), headers)),
  );
}

/** The most recently emitted remote re-INVITE, for the matching ACK helper. */
let lastRemoteReinvite: MessageHead | undefined;

/**
 * Send an in-dialog re-INVITE from the remote peer (holds/un-holds the phone).
 * Mirrors `emitRemoteBye`: INVITE To → re-INVITE From + remote tag, INVITE From
 * → re-INVITE To, the INVITE's Call-ID, an incremented CSeq (default 2), a fresh
 * Via branch, and an SDP body whose `a=` line carries the requested direction.
 */
export function emitRemoteReinvite(
  direction: 'sendrecv' | 'sendonly' | 'inactive' = 'sendonly',
  cseq = 2,
): void {
  const harness = currentHarness();
  const inv = lastInvite();
  if (inv === undefined) throw new Error('no outbound INVITE to build re-INVITE from');
  const headers = new Headers();
  headers.set('Via', `SIP/2.0/UDP 192.0.2.2:5060;branch=z9hG4bK-${cseq}-reinvite`);
  headers.set('Max-Forwards', '70');
  const from = inv.to.includes('tag=') ? inv.to : `${inv.to};tag=${remoteTagOfLast200()}`;
  headers.set('From', from);
  headers.set('To', inv.from);
  headers.set('Call-ID', inv.callId);
  headers.set('CSeq', `${cseq} INVITE`);
  headers.set('Contact', '<sip:bob@192.0.2.2:5060>');
  headers.set('Content-Type', 'application/sdp');
  const sdp = STUB_SDP.replace('a=sendrecv', `a=${direction}`);
  lastRemoteReinvite = {
    method: 'INVITE',
    callId: inv.callId,
    cseqLine: `${cseq} INVITE`,
    via: headers.get('Via') ?? '',
    from,
    to: inv.from,
  };
  harness.socket.emitMessage(
    serializeMessage(makeRequest('INVITE', localUriOf(inv.from), headers, new TextEncoder().encode(sdp))),
  );
}

/**
 * Send the ACK that completes the most recent remote re-INVITE (the phone's
 * 200 OK was already sent): same From/To/Call-ID as the re-INVITE, a fresh Via
 * branch, and the ACK method.
 */
export function emitReinviteAck(cseq?: number): void {
  const harness = currentHarness();
  const reinvite = lastRemoteReinvite;
  if (reinvite === undefined) throw new Error('no remote re-INVITE to ACK');
  const cseqNum = cseq ?? (reinvite.cseqLine.split(' ')[0] ?? '2');
  const headers = new Headers();
  headers.set('Via', `SIP/2.0/UDP 192.0.2.2:5060;branch=z9hG4bK-${cseqNum}-ack`);
  headers.set('Max-Forwards', '70');
  headers.set('From', reinvite.from);
  headers.set('To', reinvite.to);
  headers.set('Call-ID', reinvite.callId);
  headers.set('CSeq', `${cseqNum} ACK`);
  harness.socket.emitMessage(
    serializeMessage(makeRequest('ACK', localUriOf(reinvite.to), headers)),
  );
}

/** The callee/ser tag assigned by the phone's most recent outbound 200 OK. */
function remoteTagOfLast200(): string {
  const harness = currentHarness();
  for (const bytes of [...harness.socket.sent].reverse()) {
    const text = new TextDecoder().decode(bytes);
    const first = text.split('\r\n')[0] ?? '';
    if (!first.startsWith('SIP/2.0 200')) continue;
    const to = text.split('\r\n').find((l) => l.toLowerCase().startsWith('to:')) ?? '';
    const tag = to.match(/tag=([^;>\s]+)/)?.[1];
    if (tag !== undefined && tag !== '') return tag;
  }
  return 'server-tag';
}

/** The uri side of an `Ex: uri` From/To header string. */
function localUriOf(fromOrTo: string): string {
  const m = fromOrTo.match(/<([^>]+)>/);
  return m?.[1] ?? fromOrTo;
}


/** A media stream with a single microphone audio track (send-capable). */
export function makeAudioStream(): MediaStream {
  const track = { id: 'mic-track', stop(): void {}, enabled: true };
  return { getTracks: () => [track], getAudioTracks: () => [track], stop(): void {} } as unknown as MediaStream;
}

export function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** Let the full async media/SIP chain settle a few turns. */
export async function settle(): Promise<void> {
  for (let i = 0; i < 12; i += 1) await flush();
}

/** Lightweight parse of an outbound request line + headers. */
export interface MessageHead {
  method: string;
  callId: string;
  cseqLine: string;
  via: string;
  from: string;
  to: string;
}

export function parseHead(bytes: Uint8Array): MessageHead | undefined {
  const text = new TextDecoder().decode(bytes);
  const lines = text.split('\r\n');
  const reqLine = lines[0] ?? '';
  if (/^SIP\/2\.0 \d{3}/.test(reqLine)) return undefined; // a response
  const m = reqLine.match(/^(\S+) /);
  if (m === null) return undefined;
  const header = (name: string): string =>
    lines.find((l) => l.toLowerCase().startsWith(name.toLowerCase() + ':'))
      ?.slice(name.length + 1).trim() ?? '';
  return {
    method: m[1]!,
    callId: header('Call-ID'),
    cseqLine: header('CSeq'),
    via: header('Via'),
    from: header('From'),
    to: header('To'),
  };
}

function parseFromText(text: string): MessageHead | undefined {
  return parseHead(new TextEncoder().encode(text));
}

/** Requests of the given method sent by the current phone's transport
 * (aggregated across every socket generation). */
export function sentRequests(method: string): MessageHead[] {
  const out: MessageHead[] = [];
  for (const bytes of allSentBytes()) {
    const parsed = parseHead(bytes);
    if (parsed !== undefined && parsed.method === method) out.push(parsed);
  }
  return out;
}

/** Every byte sent across all server sockets, oldest first. */
function allSentBytes(): Uint8Array[] {
  const harness = currentHarness();
  const out: Uint8Array[] = [];
  for (const socket of harness.server.sockets) out.push(...socket.sent);
  return out;
}

/** Call-IDs of outbound REGISTERs, in wire order (stable across recovery). */
export function registerCallIds(): Array<string | undefined> {
  return currentHarness().server.registers.map((r) => r.callId);
}

/** The `Call-ID <cseq>` header numbers of outbound REGISTERs, in wire order. */
export function registerCSeqs(): Array<number | undefined> {
  return currentHarness().server.registers.map((r) => {
    const m = r.cseqLine.match(/^(\d+)/);
    return m === null ? undefined : Number(m[1]);
  });
}

/** Outbound SIP response status codes, in send order. */
export function outboundResponseCodes(): number[] {
  const codes: number[] = [];
  for (const bytes of allSentBytes()) {
    const text = new TextDecoder().decode(bytes);
    const m = (text.split('\r\n')[0] ?? '').match(/^SIP\/2\.0 (\d{3})/);
    if (m !== null) codes.push(Number(m[1]));
  }
  return codes;
}

/** Echo a 200 OK for the most recent outbound request of the given method. */
export function respondOk(
  method: string,
  toTag = 'server-tag',
): void {
  const harness = currentHarness();
  const requests = sentRequests(method);
  const last = requests.at(-1);
  if (last === undefined) throw new Error(`no outbound ${method} to answer`);
  const viaText = harness.socket.sent
    .map((b) => new TextDecoder().decode(b))
    .reverse()
    .find((t) => {
      const parsed = parseFromText(t);
      return parsed?.method === method;
    });
  const via = viaText === undefined ? last : parseFromText(viaText)!;
  const headers = new Headers();
  headers.set('Via', via.via);
  headers.set('From', via.from);
  headers.set('To', `${via.to};tag=${toTag}`);
  headers.set('Call-ID', via.callId);
  headers.set('CSeq', via.cseqLine);
  headers.set('Contact', '<sip:bob@192.0.2.2:5060>');
  let response: SipResponseMessage = makeResponse(200, 'OK', headers);
  if (method === 'INVITE') {
    response = withTextBody(response, STUB_SDP, 'application/sdp') as SipResponseMessage;
  }
  harness.socket.emitMessage(serializeMessage(response));
}

/**
 * Send the third-party ACK that answers an incoming INVITE whose 200 OK the
 * phone already sent. The callee's `answer()` resolves only once this ACK
 * arrives (matching core's confirm-on-ACK contract).
 */
export function sendAck(): void {
  const harness = currentHarness();
  const text = [...harness.socket.sent]
    .reverse()
    .find((t) => /^SIP\/2\.0 200/.test(new TextDecoder().decode(t).split('\r\n')[0] ?? 'SIP/2.0 000'));
  if (text === undefined) throw new Error('no outbound 200 OK to ACK');
  const lines = new TextDecoder().decode(text).split('\r\n');
  const header = (name: string): string =>
    lines.find((l) => l.toLowerCase().startsWith(name.toLowerCase() + ':'))
      ?.slice(name.length + 1).trim() ?? '';
  const cseq = header('CSeq');
  const cseqNum = (cseq.split(' ')[0] ?? '1');
  const ackHeaders = new Headers();
  // Via must NOT reuse the 200's branch (transaction keyed separately).
  ackHeaders.set('Via', `SIP/2.0/TCP 192.0.2.2:5060;branch=z9hG4bK-ack-${Math.random().toString(36).slice(2)}`);
  ackHeaders.set('Max-Forwards', '70');
  ackHeaders.set('From', header('From'));
  ackHeaders.set('To', header('To'));
  ackHeaders.set('Call-ID', header('Call-ID'));
  ackHeaders.set('CSeq', `${cseqNum} ACK`);
  harness.socket.emitMessage(serializeMessage(
    makeRequest('ACK', localUriOf(header('To')), ackHeaders),
  ));
}

/** Confirm the current outbound INVITE (200 OK) and drive the media session to
 * `connected` (ICE connected), settling the awaited `call.start()`.
 */
export async function answerInviteAndConnectMedia(): Promise<void> {
  const harness = currentHarness();
  // The offer→INVITE media chain is async; let it flush out before answering.
  await settle();
  respondOk('INVITE');
  await settle();
  harness.pc._setIceConnection('connected');
  await settle();
}
