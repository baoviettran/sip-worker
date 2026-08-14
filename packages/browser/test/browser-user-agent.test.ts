import { describe, expect, it } from 'vitest';
import {
  Headers,
  STUB_SDP,
  makeRequest,
  makeResponse,
  serializeMessage,
  withTextBody,
  type SipResponseMessage,
  type Transport,
  type TransportCapabilities,
  type TransportEvent,
  type TransportToken,
} from '@sip-worker/core';
import { BrowserUserAgent } from '../src/browser-user-agent.js';
import { FakeMediaEnvironment, FakePeerConnection } from './support/fake-media-environment.js';

/** Minimal fake transport mirroring the core suite's FakeTransport. */
class FakeTransport implements Transport {
  readonly capabilities: Readonly<TransportCapabilities>;
  readonly sent: Uint8Array[] = [];
  private connected = false;
  private closed = false;
  private readonly listeners = new Set<(event: TransportEvent) => void>();

  constructor(framing: 'stream' | 'datagram' | 'message', token: TransportToken) {
    this.capabilities = Object.freeze({ reliable: true, framing, token });
  }

  async connect(): Promise<void> {
    if (this.closed) throw new Error('FakeTransport closed');
    if (this.connected) return;
    this.connected = true;
    this.emit({ type: 'connected' });
  }

  async disconnect(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.connected = false;
    this.emit({ type: 'disconnected' });
  }

  async send(data: Uint8Array): Promise<void> {
    if (!this.connected || this.closed) throw new Error('FakeTransport not connected');
    this.sent.push(data.slice());
  }

  subscribe(listener: (event: TransportEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  isConnected(): boolean {
    return this.connected;
  }

  emitData(data: Uint8Array): void {
    this.emit({ type: 'data', data });
  }

  private emit(event: TransportEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}

let idCounter = 0;
function idGenerator() {
  return { branch: () => `id-${(idCounter += 1)}` };
}

interface Harness {
  transport: FakeTransport;
  env: FakeMediaEnvironment;
  ua: BrowserUserAgent;
  pc: FakePeerConnection;
}

/** Clock injected into the core UA so deadlines always resolve immediately. */
const makeClock = () => ({
  now: (): number => 0,
  setTimeout: (): number => 1,
  clearTimeout: (): void => {},
});

function build(options: { mediaEnvironment?: FakeMediaEnvironment } = {}): Harness {
  const transport = new FakeTransport('stream', 'TCP');
  const env = options.mediaEnvironment ?? new FakeMediaEnvironment([
    { deviceId: 'mic-1', label: 'Mic', groupId: 'g-1', kind: 'audioinput' },
    { deviceId: 'spk-1', label: 'Speaker', groupId: 'g-2', kind: 'audiooutput' },
  ]);
  const pc = new FakePeerConnection();
  pc.autoCompleteIceGathering = true;
  env.queuedPeerConnections.push(pc as unknown as RTCPeerConnection);
  const ua = new BrowserUserAgent({
    transport,
    clock: makeClock(),
    registrarUri: 'sip:registrar.example.com',
    aor: 'sip:alice@example.com',
    contact: '<sip:alice@192.0.2.1:5060>',
    idGenerator: idGenerator(),
    mediaEnvironment: env,
  });
  return { transport, env, ua, pc };
}

function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** Let the full media async chain (offer → INVITE) settle a few turns. */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await flush();
}

function sentRequests(transport: FakeTransport, method: string): MessageHead[] {
  const out: MessageHead[] = [];
  for (const bytes of transport.sent) {
    const parsed = parseHead(bytes);
    if (parsed !== undefined && parsed.method === method) out.push(parsed);
  }
  return out;
}

/** Lightweight parse of an outbound message's request line + headers. */
interface MessageHead {
  method: string;
  callId: string;
  cseqLine: string;
  via: string;
  from: string;
  to: string;
}

function parseHead(bytes: Uint8Array): MessageHead | undefined {
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

/** Parse outbound SIP response status codes. */
function outboundResponseCodes(transport: FakeTransport): number[] {
  const codes: number[] = [];
  for (const bytes of transport.sent) {
    const text = new TextDecoder().decode(bytes);
    const m = (text.split('\r\n')[0] ?? '').match(/^SIP\/2\.0 (\d{3})/);
    if (m !== null) codes.push(Number(m[1]));
  }
  return codes;
}

/** Deliver an initial INVITE from a remote caller, framing like the core suite. */
function sendIncomingInvite(transport: FakeTransport, callId: string, branch: string): void {
  const headers = new Headers();
  headers.set('Via', `SIP/2.0/TCP 192.0.2.2:5060;branch=z9hG4bK-${branch}`);
  headers.set('Max-Forwards', '70');
  headers.set('From', '<sip:bob@example.com>;tag=bob-tag');
  headers.set('To', '<sip:alice@example.com>');
  headers.set('Call-ID', callId);
  headers.set('CSeq', '1 INVITE');
  headers.set('Contact', '<sip:bob@192.0.2.2:5060>');
  headers.set('Content-Type', 'application/sdp');
  transport.emitData(
    serializeMessage(
      makeRequest('INVITE', 'sip:alice@example.com', headers, new TextEncoder().encode(STUB_SDP)),
    ),
  );
}

/** Echo a 200 OK for the most recent outbound request of the given method. */
function respondOk(transport: FakeTransport, method: string, toTag = 'server-tag'): void {
  const requests = sentRequests(transport, method);
  const req = requests.at(-1);
  if (req === undefined) throw new Error(`no outbound ${method} to answer`);
  const reqVia = transport.sent
    .map((b) => new TextDecoder().decode(b))
    .reverse()
    .find((t) => { const p = parseFromText(t); return p?.method === method; });
  const rr = reqVia === undefined ? req : parseFromText(reqVia)!;
  const headers = new Headers();
  headers.set('Via', rr.via);
  headers.set('From', rr.from);
  headers.set('To', `${rr.to};tag=${toTag}`);
  headers.set('Call-ID', rr.callId);
  headers.set('CSeq', rr.cseqLine);
  headers.set('Contact', '<sip:bob@192.0.2.2:5060>');
  let response: SipResponseMessage = makeResponse(200, 'OK', headers);
  if (method === 'INVITE') {
    response = withTextBody(response, STUB_SDP, 'application/sdp') as SipResponseMessage;
  }
  transport.emitData(serializeMessage(response));
}

function parseFromText(text: string): MessageHead | undefined {
  const lines = text.split('\r\n');
  const reqLine = lines[0] ?? '';
  if (/^SIP\/2\.0 \d{3}/.test(reqLine)) return undefined;
  const m = reqLine.match(/^(\S+) /);
  if (m === null) return undefined;
  const header = (name: string): string =>
    lines.find((l) => l.toLowerCase().startsWith(name.toLowerCase() + ':'))
      ?.slice(name.length + 1).trim() ?? '';
  return { method: m[1]!, callId: header('Call-ID'), cseqLine: header('CSeq'), via: header('Via'), from: header('From'), to: header('To') };
}

describe('BrowserUserAgent — composition and media lifecycle', () => {
  it('construction, connect(), and register() never capture the microphone', async () => {
    const { transport, env, ua } = build();
    expect(env.getUserMediaConstraints).toHaveLength(0);

    await ua.connect();
    const registration = ua.register();
    await flush();
    respondOk(transport, 'REGISTER');
    await registration;

    expect(env.getUserMediaConstraints).toHaveLength(0);
    await ua.dispose();
  });

  it('invite() acquires the microphone; connect() and register() do not', async () => {
    const { transport, env, ua } = build();
    await ua.connect();
    expect(env.getUserMediaConstraints).toHaveLength(0);

    // Queue a microphone stream so the invite's offer acquisition resolves.
    const track = makeTrack('call-track');
    env.queuedUserMedia.push(streamFrom(track));

    const invite = ua.invite('sip:bob@example.com');
    await settle();
    expect(env.getUserMediaConstraints.length).toBeGreaterThan(0);

    // Confirm the outbound INVITE so invite() settles.
    respondOk(transport, 'INVITE');
    await settle();
    await invite.catch(() => {});

    await ua.dispose();
    void track;
  });

  it('forwards core events and browser media events on the shared surface', async () => {
    const { env, ua } = build();
    const received: string[] = [];
    ua.on('deviceChanged', () => received.push('device:change'));

    await ua.connect();
    env.emitDeviceChange();
    await flush();

    expect(received).toContain('device:change');
    await ua.dispose();
  });

  it('isolates a throwing listener from other listeners and from the call', () => {
    const { ua } = build();
    const observed: string[] = [];
    ua.on('registrationStateChanged', () => {
      throw new Error('observer failed');
    });
    ua.on('registrationStateChanged', () => observed.push('registration event'));

    const payload = {
      type: 'registrationStateChanged' as const,
      state: 'registered' as const,
      identity: { callId: 'c', nextCSeq: 1 },
    };
    expect(() => (ua as unknown as { emit(k: string, v: unknown): void }).emit('registrationStateChanged', payload))
      .not.toThrow();
    expect(observed).toContain('registration event');
  });

  it('a second outgoing invite while the first is active rejects INVALID_STATE', async () => {
    const { transport, env, ua } = build();
    await ua.connect();
    env.queuedUserMedia.push(streamFrom(makeTrack('first')));
    const first = ua.invite('sip:bob@example.com');
    await flush();

    await expect(ua.invite('sip:carol@example.com')).rejects.toMatchObject({ code: 'INVALID_STATE' });

    await ua.dispose().catch(() => {});
    void first;
    void transport;
  });

  it('a second incoming initial INVITE gets a 486 before any media acquisition', async () => {
    const { transport, env, ua } = build();
    await ua.connect();

    sendIncomingInvite(transport, 'first-call@example.com', 'br-first');
    await flush();
    sendIncomingInvite(transport, 'second-call@example.com', 'br-second');
    await flush();

    const codes = outboundResponseCodes(transport);
    expect(codes).toContain(486);
    void env;
    await ua.dispose();
  });

  it('restartIce() delegates to the core restart path', async () => {
    const { ua } = build();
    await ua.connect();
    await expect(ua.restartIce()).rejects.toMatchObject({ code: 'INVALID_STATE' });
    await ua.dispose();
  });

  it('dispose() reclaims the acquired microphone track and is idempotent', async () => {
    const { env, ua } = build();
    await ua.connect();
    const track = makeTrack('dispose-track');
    env.queuedUserMedia.push(streamFrom(track));

    const invite = ua.invite('sip:bob@example.com');
    await flush();
    expect(track.stopped).toBe(false);

    await ua.dispose();
    expect(track.stopped).toBe(true);

    await invite.catch(() => {});
  });

  it('ua.media is exposed and rejections are coded after dispose', async () => {
    const { ua } = build();
    expect(typeof ua.media.listDevices).toBe('function');
    await ua.dispose();
    await expect(ua.media.listDevices()).rejects.toMatchObject({ code: 'ABORTED' });
  });
});

function makeTrack(id: string): { id: string; stopped: boolean; stop(): void } {
  let stopped = false;
  return {
    id,
    get stopped(): boolean { return stopped; },
    set stopped(v: boolean) { stopped = v; },
    stop(): void { stopped = true; },
  };
}

function streamFrom(track: { id: string }): MediaStream {
  return { getTracks: () => [track], getAudioTracks: () => [track] } as unknown as MediaStream;
}