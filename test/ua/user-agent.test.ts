import { describe, expect, it } from 'vitest';
import { FakeClock } from '../support/fake-clock.js';
import { FakeTransport } from '../support/fake-transport.js';
import { UserAgent } from '../../src/ua/user-agent.js';
import type { LivenessStrategy } from '../../src/reliability/index.js';
import { parseMessage } from '../../src/messages/parser.js';
import type { SipRequestMessage } from '../../src/messages/message.js';
import { Headers, makeRequest, makeResponse, serializeMessage } from '../../src/messages/index.js';
import { WorkerMediaController } from '../../src/media/worker-controller.js';
import { STUB_SDP } from '../../src/media/index.js';
import type { MediaMessage } from '../../src/media/index.js';
import type { Invitation } from '../../src/ua/invitation.js';

function makeIdGenerator() {
  let n = 0;
  return { branch: () => `id-${(n += 1)}` };
}

/** Recording strategy to prove the UA drives start/stop in sync with connect/disconnect. */
class RecordingLiveness implements LivenessStrategy {
  readonly calls: Array<'start' | 'stop'> = [];
  start(): void {
    this.calls.push('start');
  }
  stop(): void {
    this.calls.push('stop');
  }
}

/** Transport that can hold ACK sends open to expose disposal continuations. */
class DelayedAckTransport extends FakeTransport {
  delayAcks = false;
  byeAttempts = 0;
  private ackResolvers: Array<() => void> = [];

  override async send(data: Uint8Array): Promise<void> {
    const parsed = parseMessage(data);
    if (parsed.ok && parsed.value.kind === 'request' && parsed.value.method === 'BYE') {
      this.byeAttempts += 1;
    }
    await super.send(data);
    if (this.delayAcks && parsed.ok && parsed.value.kind === 'request' && parsed.value.method === 'ACK') {
      await new Promise<void>((resolve) => this.ackResolvers.push(resolve));
    }
  }

  get pendingAcks(): number {
    return this.ackResolvers.length;
  }

  releaseAcks(): void {
    const resolvers = this.ackResolvers;
    this.ackResolvers = [];
    for (const resolve of resolvers) resolve();
  }
}

/** Auto-replies to createOffer/answer/setRemote over a microtask with STUB_SDP. */
class FakeMediaPort {
  postMessage(message: MediaMessage): void {
    if (message.type === 'setRemote') {
      queueMicrotask(() => this.deliver({ type: 'mediaResult', requestId: message.requestId, sessionId: message.sessionId }));
      return;
    }
    queueMicrotask(() => this.deliver({ type: 'mediaResult', requestId: message.requestId, sessionId: message.sessionId, sdp: STUB_SDP }));
  }
  subscribe(listener: (message: MediaMessage) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  private listeners = new Set<(message: MediaMessage) => void>();
  private deliver(message: MediaMessage): void {
    for (const listener of this.listeners) listener(message);
  }
}

function setup(options: {
  liveness?: LivenessStrategy; intervalMs?: number; viaAddress?: string; transport?: FakeTransport;
} = {}) {
  const clock = new FakeClock();
  const transport = options.transport ?? new FakeTransport({ reliable: true, framing: 'stream' });
  const idGenerator = makeIdGenerator();
  const media = new FakeMediaPort();
  const mediaController = new WorkerMediaController(media);
  const ua = new UserAgent({
    transport,
    clock,
    registrarUri: 'sip:registrar.example.com',
    aor: 'sip:alice@example.com',
    contact: '<sip:alice@192.0.2.1:5060>',
    idGenerator,
    liveness: options.liveness,
    mediaController,
    viaAddress: options.viaAddress,
  });
  return { clock, transport, ua, idGenerator };
}

/** The Via header of the outbound INVITE request, or '' if none was sent. */
function captureOutboundVia(transport: FakeTransport): string {
  for (const bytes of transport.sent) {
    const parsed = parseMessage(bytes);
    if (parsed.ok && parsed.value.kind === 'request' && parsed.value.method === 'INVITE') {
      return parsed.value.headers.get('Via') ?? '';
    }
  }
  return '';
}

/** Drain pending microtasks so the offer round-trip and INVITE send complete. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** Deliver an initial INVITE and return the public Invitation emitted by the UA. */
function receiveIncomingCall(ua: UserAgent, transport: FakeTransport): Invitation {
  let invitation: Invitation | undefined;
  ua.once('incomingCall', (incoming: Invitation) => {
    invitation = incoming;
  });

  const headers = new Headers();
  headers.set('Via', 'SIP/2.0/UDP 192.0.2.2:5060;branch=z9hG4bK-incoming');
  headers.set('Max-Forwards', '70');
  headers.set('From', '<sip:bob@example.com>;tag=bob-incoming');
  headers.set('To', '<sip:alice@example.com>');
  headers.set('Call-ID', 'incoming-call@example.com');
  headers.set('CSeq', '1 INVITE');
  headers.set('Contact', '<sip:bob@192.0.2.2:5060>');
  headers.set('Content-Type', 'application/sdp');
  transport.emitData(serializeMessage(makeRequest(
    'INVITE',
    'sip:alice@example.com',
    headers,
    new TextEncoder().encode(STUB_SDP),
  )));

  if (invitation === undefined) throw new Error('UA did not emit an incoming invitation');
  return invitation;
}

function sentResponses(transport: FakeTransport, statusCode: number): number {
  return transport.sent.filter((bytes) => {
    const parsed = parseMessage(bytes);
    return parsed.ok && parsed.value.kind === 'response' && parsed.value.statusCode === statusCode;
  }).length;
}

/** Deliver a 200 OK to the outbound INVITE, confirming the call. */
async function confirmCall(transport: FakeTransport): Promise<void> {
  await flush();
  let bytes: Uint8Array | undefined;
  for (let i = transport.sent.length - 1; i >= 0; i -= 1) {
    const m = parseMessage(transport.sent[i]!);
    if (m.ok && m.value.kind === 'request' && m.value.method === 'INVITE') {
      bytes = transport.sent[i];
      break;
    }
  }
  if (bytes === undefined) throw new Error('no outbound INVITE to answer');
  const parsed = parseMessage(bytes);
  if (!parsed.ok || parsed.value.kind !== 'request') {
    throw new Error('outbound INVITE was not a request');
  }
  const req = parsed.value;
  const headers = new Headers();
  headers.set('Via', req.headers.get('Via') ?? '');
  headers.set('From', req.headers.get('From') ?? '');
  headers.set('To', `${req.headers.get('To') ?? 'sip:bob@example.com'};tag=bob-1`);
  headers.set('Call-ID', req.headers.get('Call-ID') ?? '');
  headers.set('CSeq', req.headers.get('CSeq') ?? '');
  headers.set('Contact', '<sip:bob@192.0.2.2:5060>');
  transport.emitData(serializeMessage(makeResponse(200, 'OK', headers)));
}

/** All sent OPTIONS requests, parsed. */
function sentOptions(transport: FakeTransport): SipRequestMessage[] {
  const out: SipRequestMessage[] = [];
  for (const bytes of transport.sent) {
    const parsed = parseMessage(bytes);
    if (parsed.ok && parsed.value.kind === 'request' && parsed.value.method === 'OPTIONS') {
      out.push(parsed.value);
    }
  }
  return out;
}

describe('UserAgent liveness wiring', () => {
  it('starts an injected strategy on connect and stops it on disconnect', async () => {
    const liveness = new RecordingLiveness();
    const { ua } = setup({ liveness });

    await ua.connect();
    expect(liveness.calls).toEqual(['start']);

    await ua.disconnect();
    expect(liveness.calls).toEqual(['start', 'stop']);
  });

  it('defaults to OPTIONS probes when no strategy is injected and stops them on disconnect', async () => {
    const { clock, transport, ua } = setup();
    await ua.connect();

    // No immediate probe; the first fires at the configured interval (30s).
    clock.advance(29999);
    expect(sentOptions(transport)).toHaveLength(0);
    clock.advance(1);
    const probes = sentOptions(transport);
    expect(probes).toHaveLength(1);
    expect(probes[0]!.headers.get('Via')).toMatch(/branch=z9hG4bK-/);
    expect(probes[0]!.headers.get('Via')).toContain('192.0.2.1:5060');
    expect(probes[0]!.headers.get('CSeq')).toBe('1 OPTIONS');

    // Disconnect stops the probe timer: nothing further is sent.
    const before = sentOptions(transport).length;
    await ua.disconnect();
    clock.advance(60000);
    expect(sentOptions(transport)).toHaveLength(before);
  });

  it('disconnect() leaves no pending registrar refresh timer', async () => {
    const { ua, clock, transport } = setup();
    await ua.connect();
    const registerPromise = ua.register();
    // Echo a 200 OK for the outbound REGISTER so registration completes and arms the refresh timer.
    const bytes = transport.sent.find((b) => {
      const m = parseMessage(b);
      return m.ok && m.value.kind === 'request' && m.value.method === 'REGISTER';
    });
    const parsed = bytes === undefined ? undefined : parseMessage(bytes);
    if (parsed?.ok && parsed.value.kind === 'request') {
      const req = parsed.value;
      const resp = new Headers();
      resp.set('Via', req.headers.get('Via') ?? '');
      resp.set('From', req.headers.get('From') ?? '');
      resp.set('To', req.headers.get('To') ?? '');
      resp.set('Call-ID', req.headers.get('Call-ID') ?? '');
      resp.set('CSeq', req.headers.get('CSeq') ?? '');
      resp.set('Contact', req.headers.get('Contact') ?? '');
      resp.set('Expires', '120');
      transport.emitData(serializeMessage(makeResponse(200, 'OK', resp)));
    }
    await registerPromise;
    // A successful registration arms the registrar's refresh timer.
    expect(clock.pending()).toBeGreaterThan(0);
    await ua.disconnect();
    // Flush the already-completed REGISTER transaction's Timer K (K=0 on a reliable
    // transport, so it terminates on the next clock tick). The registrar's refresh
    // timer runs on a 60s cadence, so a leaked refresh timer would survive this.
    clock.advance(1);
    expect(clock.pending()).toBe(0);
  });
});

describe('UserAgent shutdown settlement', () => {
  it('rejects an active register exactly once when disconnect is repeated', async () => {
    const { ua } = setup();
    await ua.connect();

    let rejections = 0;
    const registration = ua.register().catch((error: unknown) => {
      rejections += 1;
      throw error;
    });

    await ua.disconnect();
    await ua.disconnect();

    await expect(registration).rejects.toThrow('UserAgent disconnected');
    expect(rejections).toBe(1);
  });

  it('rejects an active invite and releases its owner when disconnect is repeated', async () => {
    const { ua, transport } = setup();
    await ua.connect();

    let rejections = 0;
    const invitation = ua.invite('sip:bob@example.com').catch((error: unknown) => {
      rejections += 1;
      throw error;
    });
    await flush();
    expect(captureOutboundVia(transport)).not.toBe('');

    await ua.disconnect();
    await ua.disconnect();

    await expect(invitation).rejects.toThrow('UserAgent disconnected');
    expect(rejections).toBe(1);
    expect(ua.callState).toBe('idle');
  });

  it('rejects an active answer and stops 200 retransmission on disconnect', async () => {
    const { ua, transport, clock } = setup();
    await ua.connect();
    const invitation = receiveIncomingCall(ua, transport);
    let rejections = 0;
    const answer = invitation.answer(STUB_SDP).catch((error: unknown) => {
      rejections += 1;
      throw error;
    });
    await flush();
    expect(sentResponses(transport, 200)).toBe(1);

    await ua.disconnect();
    await ua.disconnect();
    const sentBeforeAdvance = transport.sent.length;
    clock.advance(32000);

    await expect(answer).rejects.toThrow('UserAgent disconnected');
    expect(rejections).toBe(1);
    expect(invitation.session.state).toBe('failed');
    expect(transport.sent).toHaveLength(sentBeforeAdvance);
  });

  it('rejects an active hangup and releases dialog ownership on disconnect', async () => {
    const { ua, transport } = setup();
    await ua.connect();
    const invite = ua.invite('sip:bob@example.com');
    await confirmCall(transport);
    await invite;

    let rejections = 0;
    const hangup = ua.bye().catch((error: unknown) => {
      rejections += 1;
      throw error;
    });
    await flush();

    await ua.disconnect();
    await ua.disconnect();

    await expect(hangup).rejects.toThrow('UserAgent disconnected');
    expect(rejections).toBe(1);
    expect(ua.callState).toBe('idle');
  });

  it('does not start fork cleanup after a delayed ACK resumes following disconnect', async () => {
    const transport = new DelayedAckTransport({ reliable: true, framing: 'stream' });
    const { ua } = setup({ transport });
    await ua.connect();
    const invite = ua.invite('sip:bob@example.com');
    await confirmCall(transport);
    await invite;

    const inviteBytes = transport.sent.find((bytes) => {
      const parsed = parseMessage(bytes);
      return parsed.ok && parsed.value.kind === 'request' && parsed.value.method === 'INVITE';
    });
    const parsedInvite = inviteBytes === undefined ? undefined : parseMessage(inviteBytes);
    if (parsedInvite === undefined || !parsedInvite.ok || parsedInvite.value.kind !== 'request') {
      throw new Error('no outbound INVITE to fork');
    }
    const request = parsedInvite.value;
    const headers = new Headers();
    headers.set('Via', request.headers.get('Via') ?? '');
    headers.set('From', request.headers.get('From') ?? '');
    headers.set('To', `${request.headers.get('To') ?? 'sip:bob@example.com'};tag=bob-2`);
    headers.set('Call-ID', request.headers.get('Call-ID') ?? '');
    headers.set('CSeq', request.headers.get('CSeq') ?? '');
    headers.set('Contact', '<sip:bob@192.0.2.3:5060>');

    transport.delayAcks = true;
    transport.emitData(serializeMessage(makeResponse(200, 'OK', headers)));
    await flush();
    expect(transport.pendingAcks).toBe(1);

    await ua.disconnect();
    transport.releaseAcks();
    await flush();

    expect(transport.byeAttempts).toBe(0);
  });
});

describe('UserAgent viaAddress', () => {
  it('uses a caller-supplied viaAddress for sent-by', async () => {
    const { ua, transport } = setup({ viaAddress: '203.0.113.7:5060' });
    await ua.connect();
    const invite = ua.invite('sip:bob@example.com');
    await confirmCall(transport);
    await invite;
    // Capture the Via the inviter sent and assert it carries the supplied sent-by.
    expect(captureOutboundVia(transport)).toContain('203.0.113.7:5060');
  });

  it('defaults to 192.0.2.1:5060 when viaAddress is absent', async () => {
    const { ua, transport } = setup();
    await ua.connect();
    const invite = ua.invite('sip:bob@example.com');
    await confirmCall(transport);
    await invite;
    expect(captureOutboundVia(transport)).toContain('192.0.2.1:5060');
  });
});
