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
import type { Inviter } from '../../src/ua/inviter.js';

const AUTH_REALM = 'example.com';
const AUTH_NONCE = 'ua-shared-nonce';

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
  inviteAttempts = 0;
  private ackResolvers: Array<() => void> = [];

  override async send(data: Uint8Array): Promise<void> {
    const parsed = parseMessage(data);
    if (parsed.ok && parsed.value.kind === 'request' && parsed.value.method === 'BYE') {
      this.byeAttempts += 1;
    }
    if (parsed.ok && parsed.value.kind === 'request' && parsed.value.method === 'INVITE') {
      this.inviteAttempts += 1;
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

/** Transport that exposes a pending connection so shutdown can win the race. */
class DelayedConnectTransport extends FakeTransport {
  private release: (() => void) | undefined;

  override async connect(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.release = resolve;
    });
    await super.connect();
  }

  override async disconnect(): Promise<void> {
    const release = this.release;
    this.release = undefined;
    release?.();
    await super.disconnect();
  }

  get connectPending(): boolean {
    return this.release !== undefined;
  }

  releaseConnect(): void {
    const release = this.release;
    this.release = undefined;
    if (release === undefined) throw new Error('connect was not pending');
    release();
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
  credentials?: boolean;
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
    credentials: options.credentials ? { username: 'alice', password: 'secret' } : undefined,
  });
  return { clock, transport, ua, idGenerator };
}

function digestNonceCount(request: SipRequestMessage): string | undefined {
  return request.headers.get('Authorization')?.match(/nc=([0-9a-fA-F]{8})/)?.[1];
}

function respondTo(
  transport: FakeTransport,
  request: SipRequestMessage,
  statusCode: number,
  options: { challenge?: boolean; contact?: string } = {},
): void {
  const headers = new Headers();
  headers.set('Via', request.headers.get('Via') ?? '');
  headers.set('From', request.headers.get('From') ?? '');
  headers.set('To', `${request.headers.get('To') ?? ''};tag=server`);
  headers.set('Call-ID', request.headers.get('Call-ID') ?? '');
  headers.set('CSeq', request.headers.get('CSeq') ?? '');
  if (options.contact !== undefined) headers.set('Contact', options.contact);
  if (options.challenge === true) {
    headers.set(
      'WWW-Authenticate',
      `Digest realm="${AUTH_REALM}", nonce="${AUTH_NONCE}", qop="auth", algorithm=SHA-256`,
    );
  }
  transport.emitData(serializeMessage(makeResponse(statusCode, statusCode === 200 ? 'OK' : 'Unauthorized', headers)));
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

function sentRequests(transport: FakeTransport, method: string): SipRequestMessage[] {
  const requests: SipRequestMessage[] = [];
  for (const bytes of transport.sent) {
    const parsed = parseMessage(bytes);
    if (parsed.ok && parsed.value.kind === 'request' && parsed.value.method === method) {
      requests.push(parsed.value);
    }
  }
  return requests;
}

function createRemoteBye(transport: FakeTransport): SipRequestMessage {
  const invite = sentRequests(transport, 'INVITE')[0];
  if (invite === undefined) throw new Error('no INVITE for remote BYE');
  const headers = new Headers();
  headers.set('Via', 'SIP/2.0/UDP 192.0.2.2:5060;branch=z9hG4bK-remote-bye');
  headers.set('Call-ID', invite.headers.get('Call-ID') ?? '');
  headers.set('From', `${invite.headers.get('To') ?? '<sip:bob@example.com>'};tag=bob-1`);
  headers.set('To', invite.headers.get('From') ?? '');
  headers.set('CSeq', '1 BYE');
  return makeRequest('BYE', 'sip:alice@example.com', headers);
}

function disconnectOnRequest(
  ua: UserAgent,
  transport: FakeTransport,
  method: string,
): () => Promise<void> | undefined {
  let disconnect: Promise<void> | undefined;
  transport.onSend = (bytes) => {
    const parsed = parseMessage(bytes);
    if (disconnect === undefined && parsed.ok && parsed.value.kind === 'request' && parsed.value.method === method) {
      disconnect = ua.disconnect();
    }
  };
  return () => disconnect;
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

describe('UserAgent Digest ownership', () => {
  it('uses one credentials-created AuthManager for REGISTER and INVITE', async () => {
    const { ua, transport } = setup({ credentials: true });
    await ua.connect();

    const registration = ua.register();
    await flush();
    const initialRegister = sentRequests(transport, 'REGISTER').at(-1)!;
    respondTo(transport, initialRegister, 401, { challenge: true });
    await flush();
    const authenticatedRegister = sentRequests(transport, 'REGISTER').at(-1)!;
    expect(authenticatedRegister.headers.get('Authorization')).toMatch(/^Digest /);
    expect(digestNonceCount(authenticatedRegister)).toBe('00000001');
    respondTo(transport, authenticatedRegister, 200);
    await registration;

    const invitation = ua.invite('sip:bob@example.com');
    await flush();
    const initialInvite = sentRequests(transport, 'INVITE').at(-1)!;
    respondTo(transport, initialInvite, 401, { challenge: true });
    await flush();
    const authenticatedInvite = sentRequests(transport, 'INVITE').at(-1)!;
    expect(authenticatedInvite.headers.get('Authorization')).toMatch(/^Digest /);
    expect(digestNonceCount(authenticatedInvite)).toBe('00000002');
    respondTo(transport, authenticatedInvite, 200, { contact: '<sip:bob@192.0.2.2:5060>' });
    await invitation;

    await ua.disconnect();
  });
});

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
    // Shutdown owns both the registrar refresh and its completed client transaction.
    expect(clock.pending()).toBe(0);
  });
});

describe('UserAgent shutdown settlement', () => {
  it('does not resume connection setup after disconnect wins a pending connect', async () => {
    const transport = new DelayedConnectTransport({ reliable: true, framing: 'stream' });
    const liveness = new RecordingLiveness();
    const { ua } = setup({ transport, liveness });

    const connecting = ua.connect();
    expect(transport.connectPending).toBe(true);
    const rejection = expect(connecting).rejects.toThrow('UserAgent disconnected');
    await ua.disconnect();
    const connectWasPending = transport.connectPending;
    if (connectWasPending) transport.releaseConnect();

    await rejection;
    expect(connectWasPending).toBe(false);
    expect(transport.isConnected()).toBe(false);
    expect(liveness.calls).toEqual([]);
  });

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

  it('owns hangup before a terminating listener disconnects re-entrantly', async () => {
    const transport = new DelayedAckTransport({ reliable: true, framing: 'stream' });
    const { ua } = setup({ transport });
    await ua.connect();
    const invite = ua.invite('sip:bob@example.com');
    await confirmCall(transport);
    await invite;

    let disconnect: Promise<void> | undefined;
    ua.on('stateChanged', (event: { state: string }) => {
      if (event.state === 'terminating') disconnect = ua.disconnect();
    });

    const hangup = ua.bye();
    const rejection = expect(hangup).rejects.toThrow('UserAgent disconnected');
    if (disconnect === undefined) throw new Error('terminating listener did not disconnect');
    await disconnect;
    await rejection;

    expect(transport.byeAttempts).toBe(0);
    expect(ua.callState).toBe('idle');
  });

  it('does not send INVITE after an inviting listener disconnects re-entrantly', async () => {
    const transport = new DelayedAckTransport({ reliable: true, framing: 'stream' });
    const { ua } = setup({ transport });
    await ua.connect();

    let disconnect: Promise<void> | undefined;
    ua.on('stateChanged', (event: { state: string }) => {
      if (event.state === 'inviting') disconnect = ua.disconnect();
    });

    const invite = ua.invite('sip:bob@example.com');
    const rejection = expect(invite).rejects.toThrow('UserAgent disconnected');
    await flush();
    if (disconnect === undefined) throw new Error('inviting listener did not disconnect');
    await disconnect;
    await rejection;

    expect(transport.inviteAttempts).toBe(0);
    expect(ua.callState).toBe('idle');
  });

  it('rejects a new outgoing owner created from an incoming-owner dispose callback', async () => {
    const { ua, transport } = setup();
    await ua.connect();
    const incoming = receiveIncomingCall(ua, transport);
    const answer = incoming.answer(STUB_SDP);
    const answerRejection = expect(answer).rejects.toThrow('UserAgent disconnected');
    await flush();

    let spawned: Promise<void> | undefined;
    ua.on('stateChanged', (event: { state: string }) => {
      if (event.state === 'failed' && spawned === undefined) {
        spawned = ua.invite('sip:carol@example.com');
      }
    });

    await ua.disconnect();
    await answerRejection;
    if (spawned === undefined) throw new Error('dispose callback did not attempt a new invite');
    await expect(spawned).rejects.toThrow('UserAgent disconnected');
    expect(sentRequests(transport, 'INVITE')).toHaveLength(0);
    expect(ua.callState).toBe('idle');
  });

  it('settles invite before a confirmed listener disconnects re-entrantly', async () => {
    const { ua, transport } = setup();
    await ua.connect();
    let disconnect: Promise<void> | undefined;
    ua.on('stateChanged', (event: { state: string }) => {
      if (event.state === 'confirmed') disconnect = ua.disconnect();
    });

    const invite = ua.invite('sip:bob@example.com');
    const outcome = invite.then(
      () => ({ resolved: true as const }),
      (error: unknown) => ({ resolved: false as const, error }),
    );
    await confirmCall(transport);
    const result = await outcome;
    if (disconnect === undefined) throw new Error('confirmed listener did not disconnect');
    await disconnect;

    expect(result).toEqual({ resolved: true });
    expect(ua.callState).toBe('idle');
  });

  it('does not overwrite failed when a remote-BYE response send disconnects re-entrantly', async () => {
    const { ua, transport } = setup();
    await ua.connect();
    const invite = ua.invite('sip:bob@example.com');
    await confirmCall(transport);
    await invite;
    const owner = (ua as unknown as { activeInviter?: Inviter }).activeInviter;
    if (owner === undefined) throw new Error('outgoing owner missing');

    let disconnect: Promise<void> | undefined;
    transport.onSend = (bytes) => {
      const parsed = parseMessage(bytes);
      if (parsed.ok && parsed.value.kind === 'response'
        && parsed.value.headers.get('CSeq')?.endsWith(' BYE')) {
        disconnect = ua.disconnect();
      }
    };
    transport.emitData(serializeMessage(createRemoteBye(transport)));
    if (disconnect === undefined) throw new Error('BYE response send did not disconnect');
    await disconnect;

    expect(owner.session.state).toBe('failed');
  });

  it('terminates a REGISTER transaction installed after synchronous disconnect', async () => {
    const { ua, transport, clock } = setup();
    await ua.connect();
    const getDisconnect = disconnectOnRequest(ua, transport, 'REGISTER');

    const registration = ua.register();
    const rejection = expect(registration).rejects.toThrow('UserAgent disconnected');
    const disconnect = getDisconnect();
    if (disconnect === undefined) throw new Error('REGISTER send did not disconnect');
    await disconnect;
    await rejection;

    const sentBeforeAdvance = transport.sent.length;
    expect(clock.pending()).toBe(0);
    clock.advance(32000);
    expect(transport.sent).toHaveLength(sentBeforeAdvance);
  });

  it('terminates an INVITE transaction installed after synchronous disconnect', async () => {
    const { ua, transport, clock } = setup();
    await ua.connect();
    const getDisconnect = disconnectOnRequest(ua, transport, 'INVITE');

    const invitation = ua.invite('sip:bob@example.com');
    const rejection = expect(invitation).rejects.toThrow('UserAgent disconnected');
    await flush();
    const disconnect = getDisconnect();
    if (disconnect === undefined) throw new Error('INVITE send did not disconnect');
    await disconnect;
    await rejection;

    const sentBeforeAdvance = transport.sent.length;
    expect(clock.pending()).toBe(0);
    clock.advance(32000);
    expect(transport.sent).toHaveLength(sentBeforeAdvance);
  });

  it('terminates a selected BYE transaction installed after synchronous disconnect', async () => {
    const { ua, transport, clock } = setup();
    await ua.connect();
    const invite = ua.invite('sip:bob@example.com');
    await confirmCall(transport);
    await invite;
    const getDisconnect = disconnectOnRequest(ua, transport, 'BYE');

    const hangup = ua.bye();
    const rejection = expect(hangup).rejects.toThrow('UserAgent disconnected');
    const disconnect = getDisconnect();
    if (disconnect === undefined) throw new Error('BYE send did not disconnect');
    await disconnect;
    await rejection;

    const sentBeforeAdvance = transport.sent.length;
    expect(clock.pending()).toBe(0);
    clock.advance(32000);
    expect(transport.sent).toHaveLength(sentBeforeAdvance);
  });

  it('detaches the UA session listener from a retained invitation on disconnect', async () => {
    const { ua, transport } = setup();
    await ua.connect();
    const invitation = receiveIncomingCall(ua, transport);
    const answer = invitation.answer(STUB_SDP);
    const rejection = expect(answer).rejects.toThrow('UserAgent disconnected');
    await flush();

    let stateEvents = 0;
    ua.on('stateChanged', () => {
      stateEvents += 1;
    });
    await ua.disconnect();
    await rejection;
    const eventsAtDisconnect = stateEvents;

    invitation.session.transition('ringing');
    expect(stateEvents).toBe(eventsAtDisconnect);
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
