import { describe, expect, it } from 'vitest';
import { FakeClock } from '../support/fake-clock.js';
import { FakeTransport } from '../support/fake-transport.js';
import { UserAgent } from '../../src/ua/user-agent.js';
import type { LivenessStrategy } from '../../src/reliability/index.js';
import { parseMessage } from '../../src/messages/parser.js';
import type { SipRequestMessage, SipResponseMessage } from '../../src/messages/message.js';
import { Headers, makeRequest, makeResponse, serializeMessage, withTextBody } from '../../src/messages/index.js';
import { WorkerMediaController } from '../../src/media/worker-controller.js';
import { STUB_SDP } from '../../src/media/index.js';
import type { MediaMessage } from '../../src/media/index.js';
import type { Invitation } from '../../src/ua/invitation.js';
import type { Inviter } from '../../src/ua/inviter.js';
import { responseMatchesRequestIdentity } from '../../src/ua/response-identity.js';

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
  connectCalls = 0;

  override async connect(): Promise<void> {
    this.connectCalls += 1;
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
    if (message.type === 'closeSession') return;
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
  protected listeners = new Set<(message: MediaMessage) => void>();
  protected deliver(message: MediaMessage): void {
    for (const listener of this.listeners) listener(message);
  }
}

/**
 * A UA media port that counts closeSession calls and can hold the setRemote
 * reply so an outgoing invite stays pending until the test resolves or rejects
 * it — proving UA terminal ownership closes media exactly once.
 */
class UaControllableMediaPort extends FakeMediaPort {
  holdSetRemote = false;
  closeSessionCount = 0;
  private heldSetRemote: Array<{ requestId: string; sessionId: string }> = [];

  override postMessage(message: MediaMessage): void {
    if (message.type === 'closeSession') {
      this.closeSessionCount += 1;
      return;
    }
    if (message.type === 'setRemote' && this.holdSetRemote) {
      this.heldSetRemote.push({ requestId: message.requestId, sessionId: message.sessionId });
      return;
    }
    super.postMessage(message);
  }

  get heldSetRemoteCount(): number {
    return this.heldSetRemote.length;
  }

  private replyToHeldSetRemote(over: { code?: string; message?: string } = {}): void {
    const held = this.heldSetRemote.shift();
    if (held === undefined) return;
    if (over.code !== undefined) {
      this.deliver({
        type: 'mediaError',
        requestId: held.requestId,
        sessionId: held.sessionId,
        message: over.message ?? over.code,
        code: over.code as never,
      });
      return;
    }
    this.deliver({ type: 'mediaResult', requestId: held.requestId, sessionId: held.sessionId });
  }

  completeHeldSetRemote(): void {
    this.replyToHeldSetRemote();
  }

  rejectHeldSetRemote(code: string): void {
    this.replyToHeldSetRemote({ code });
  }
}

function setup(options: {
  liveness?: LivenessStrategy; intervalMs?: number; viaAddress?: string; transport?: FakeTransport;
  credentials?: boolean; media?: boolean | FakeMediaPort;
} = {}) {
  const clock = new FakeClock();
  const transport = options.transport ?? new FakeTransport({ reliable: true, framing: 'stream' });
  const idGenerator = makeIdGenerator();
  const media = typeof options.media === 'object' ? options.media : new FakeMediaPort();
  const mediaController = options.media === false ? undefined : new WorkerMediaController(media);
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
  options: { challenge?: boolean; contact?: string; expires?: string; sdp?: string } = {},
): void {
  const headers = new Headers();
  headers.set('Via', request.headers.get('Via') ?? '');
  headers.set('From', request.headers.get('From') ?? '');
  headers.set('To', `${request.headers.get('To') ?? ''};tag=server`);
  headers.set('Call-ID', request.headers.get('Call-ID') ?? '');
  headers.set('CSeq', request.headers.get('CSeq') ?? '');
  if (options.contact !== undefined) headers.set('Contact', options.contact);
  if (options.expires !== undefined) headers.set("Expires", options.expires);
  if (options.challenge === true) {
    headers.set(
      'WWW-Authenticate',
      `Digest realm="${AUTH_REALM}", nonce="${AUTH_NONCE}", qop="auth", algorithm=SHA-256`,
    );
  }
  let response = makeResponse(statusCode, statusCode === 200 ? 'OK' : 'Unauthorized', headers);
  if (options.sdp !== undefined) {
    response = withTextBody(response, options.sdp, 'application/sdp') as SipResponseMessage;
  }
  transport.emitData(serializeMessage(response));
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

/** Build an initial INVITE from a remote peer (the UAC of an incoming call). */
function makeIncomingInvite(
  callId = 'incoming-call@example.com',
  viaBranch = 'z9hG4bK-incoming',
): SipRequestMessage {
  const headers = new Headers();
  headers.set('Via', `SIP/2.0/UDP 192.0.2.2:5060;branch=${viaBranch}`);
  headers.set('Max-Forwards', '70');
  headers.set('From', '<sip:bob@example.com>;tag=bob-incoming');
  headers.set('To', '<sip:alice@example.com>');
  headers.set('Call-ID', callId);
  headers.set('CSeq', '1 INVITE');
  headers.set('Contact', '<sip:bob@192.0.2.2:5060>');
  headers.set('Content-Type', 'application/sdp');
  return makeRequest(
    'INVITE',
    'sip:alice@example.com',
    headers,
    new TextEncoder().encode(STUB_SDP),
  );
}

/** Deliver an initial INVITE and return the public Invitation emitted by the UA. */
function receiveIncomingCall(ua: UserAgent, transport: FakeTransport): Invitation {
  let invitation: Invitation | undefined;
  ua.once('incomingCall', (event: { type: 'incomingCall'; invitation: Invitation }) => {
    invitation = event.invitation;
  });

  transport.emitData(serializeMessage(makeIncomingInvite()));

  if (invitation === undefined) throw new Error('UA did not emit an incoming invitation');
  return invitation;
}

/** The last response the UA sent on the transport, parsed. */
function lastResponse(transport: FakeTransport): SipResponseMessage {
  const responses = transport.sent
    .map((bytes) => parseMessage(bytes))
    .filter((message) => message.ok && message.value.kind === 'response');
  const last = responses.at(-1);
  if (last === undefined || !last.ok || last.value.kind !== 'response') {
    throw new Error('no outbound response');
  }
  return last.value;
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
  const response = withTextBody(
    makeResponse(200, 'OK', headers),
    STUB_SDP,
    'application/sdp',
  ) as SipResponseMessage;
  transport.emitData(serializeMessage(response));
}

/** Deliver another 200 OK for an extra fork of the outbound INVITE. */
function emitFork200(transport: FakeTransport, toTag: string): void {
  const invite = sentRequests(transport, 'INVITE')[0];
  if (invite === undefined) throw new Error('no outbound INVITE to fork');
  const headers = new Headers();
  headers.set('Via', invite.headers.get('Via') ?? '');
  headers.set('From', invite.headers.get('From') ?? '');
  headers.set('To', `${invite.headers.get('To') ?? '<sip:bob@example.com>'};tag=${toTag}`);
  headers.set('Call-ID', invite.headers.get('Call-ID') ?? '');
  headers.set('CSeq', invite.headers.get('CSeq') ?? '');
  headers.set('Contact', '<sip:bob@192.0.2.3:5060>');
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

const lastRequest = (transport: FakeTransport, method: string): SipRequestMessage => {
  const requests = sentRequests(transport, method);
  const last = requests.at(-1);
  if (last === undefined) throw new Error(`no outbound ${method} request`);
  return last;
};

function createRemoteBye(
  transport: FakeTransport,
  remoteTag = 'bob-1',
  branch = 'remote-bye',
): SipRequestMessage {
  const invite = sentRequests(transport, 'INVITE')[0];
  if (invite === undefined) throw new Error('no INVITE for remote BYE');
  const headers = new Headers();
  headers.set('Via', `SIP/2.0/UDP 192.0.2.2:5060;branch=z9hG4bK-${branch}`);
  headers.set('Call-ID', invite.headers.get('Call-ID') ?? '');
  headers.set('From', `${invite.headers.get('To') ?? '<sip:bob@example.com>'};tag=${remoteTag}`);
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
    respondTo(transport, authenticatedInvite, 200, { contact: '<sip:bob@192.0.2.2:5060>', sdp: STUB_SDP });
    await invitation;

    await ua.disconnect();
  });
});

describe('UserAgent liveness wiring', () => {
  it('returns timers and listeners to baseline across repeated UA lifecycles', async () => {
    for (let cycle = 0; cycle < 25; cycle += 1) {
      const h = setup({ liveness: new RecordingLiveness() });
      await h.ua.connect();
      // A connected UA owns at least one transport listener (ingress + transport).
      expect(h.transport.listenerCount()).toBeGreaterThan(0);
      await h.ua.disconnect();
      // Disconnect must detach every transport listener and clear every timer.
      expect(h.transport.listenerCount()).toBe(0);
      expect(h.clock.pending()).toBe(0);
    }
  });

  it('starts an injected strategy on connect and stops it on disconnect', async () => {
    const liveness = new RecordingLiveness();
    const { ua } = setup({ liveness });

    await ua.connect();
    expect(liveness.calls).toEqual(['start']);

    await ua.disconnect();
    expect(liveness.calls).toEqual(['start', 'stop']);
  });

  it('shares one promise and composes one stack across concurrent connect calls', async () => {
    const transport = new DelayedConnectTransport({ reliable: true, framing: 'stream' });
    const liveness = new RecordingLiveness();
    const { ua } = setup({ transport, liveness });

    const first = ua.connect();
    const second = ua.connect();

    expect(second).toBe(first);
    expect(transport.connectCalls).toBe(1);
    transport.releaseConnect();
    await Promise.all([first, second]);
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
      resp.set('To', `${req.headers.get('To') ?? ''};tag=server`);
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

  it('emits failed when an automatic registration refresh fails', async () => {
    const { ua, transport, clock } = setup();
    const failures: Error[] = [];
    ua.on('failed', (event: { error: Error }) => failures.push(event.error));
    await ua.connect();

    const registration = ua.register();
    await flush();
    const request = lastRequest(transport, 'REGISTER');
    respondTo(transport, request, 200, { expires: '2' });
    await registration;

    clock.advance(1000);
    await flush();
    clock.advance(32000);
    await flush();

    expect(failures).toContainEqual(expect.objectContaining({ code: 'REGISTRATION_FAILED' }));
    await ua.disconnect();
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
    await expect(registration).rejects.toMatchObject({ code: 'LIFECYCLE_ABORTED' });
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
    const answerOutcome = invitation.answer().then(
      () => undefined,
      (error: unknown) => {
        rejections += 1;
        return error;
      },
    );
    await flush();
    expect(sentResponses(transport, 200)).toBe(1);

    await ua.disconnect();
    await ua.disconnect();
    expect(clock.pending()).toBe(0);
    const sentBeforeAdvance = transport.sent.length;
    clock.advance(32000);

    expect(await answerOutcome).toMatchObject({ message: 'UserAgent disconnected' });
    expect(rejections).toBe(1);
    expect(invitation.session.state).toBe('failed');
    expect(transport.sent).toHaveLength(sentBeforeAdvance);

  });

  it.each([
    { phase: 'Timer 100', complete: false },
    { phase: 'Completed', complete: true },
  ])('terminates an incoming INVITE server transaction in $phase on disconnect', async ({ complete }) => {
    const { ua, transport, clock } = setup();
    await ua.connect();
    const invitation = receiveIncomingCall(ua, transport);
    if (complete) invitation.reject(486, 'Busy Here');
    expect(clock.pending()).toBeGreaterThan(0);

    await ua.disconnect();
    const sentAtDisconnect = transport.sent.length;

    expect(clock.pending()).toBe(0);
    clock.advance(64000);
    expect(transport.sent).toHaveLength(sentAtDisconnect);
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
    ua.on('callStateChanged', (event: { state: string }) => {
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

  it('does not send a local BYE after a terminating observer receives a remote BYE', async () => {
    const transport = new DelayedAckTransport({ reliable: true, framing: 'stream' });
    const { ua, clock } = setup({ transport, liveness: new RecordingLiveness() });
    await ua.connect();
    const invite = ua.invite('sip:bob@example.com');
    await confirmCall(transport);
    await invite;
    clock.advance(32000); // Release the accepted INVITE transaction's Timer M.

    ua.on('callStateChanged', (event: { state: string }) => {
      if (event.state === 'terminating') {
        transport.emitData(serializeMessage(createRemoteBye(transport)));
      }
    });

    let settlements = 0;
    await ua.bye().then(() => {
      settlements += 1;
    });
    clock.advance(0); // Release the remote BYE server transaction's Timer J.

    expect(settlements).toBe(1);
    expect(transport.byeAttempts).toBe(0);
    expect(clock.pending()).toBe(0);
    expect(ua.callState).toBe('idle');
  });

  it('does not send INVITE after an inviting listener disconnects re-entrantly', async () => {
    const transport = new DelayedAckTransport({ reliable: true, framing: 'stream' });
    const { ua } = setup({ transport });
    await ua.connect();

    let disconnect: Promise<void> | undefined;
    ua.on('callStateChanged', (event: { state: string }) => {
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
    const answer = incoming.answer();
    const answerRejection = expect(answer).rejects.toThrow('UserAgent disconnected');
    await flush();

    let spawned: Promise<void> | undefined;
    ua.on('callStateChanged', (event: { state: string }) => {
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
    ua.on('callStateChanged', (event: { state: string }) => {
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
    const answer = invitation.answer();
    const rejection = expect(answer).rejects.toThrow('UserAgent disconnected');
    await flush();

    let stateEvents = 0;
    ua.on('callStateChanged', () => {
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

  it('retains a failed-cleanup fork owner until a valid remote BYE ends it', async () => {
    const { ua, transport } = setup();
    await ua.connect();
    const invitation = ua.invite('sip:bob@example.com');
    await confirmCall(transport);
    await invitation;

    emitFork200(transport, 'bob-failed-cleanup');
    await flush();
    const cleanupBye = sentRequests(transport, 'BYE').at(-1)!;
    respondTo(transport, cleanupBye, 486);
    await flush();

    const hangup = ua.bye();
    const selectedBye = sentRequests(transport, 'BYE').at(-1)!;
    respondTo(transport, selectedBye, 200);
    await hangup;

    const remoteBye = createRemoteBye(
      transport,
      'bob-failed-cleanup',
      'failed-cleanup-remote-bye',
    );
    transport.emitData(serializeMessage(remoteBye));
    await flush();
    const response = transport.sent
      .map((bytes) => parseMessage(bytes))
      .filter((message) => message.ok
        && message.value.kind === 'response'
        && message.value.headers.get('Call-ID') === remoteBye.headers.get('Call-ID')
        && message.value.headers.get('CSeq') === '1 BYE')
      .at(-1);

    expect(response?.ok).toBe(true);
    if (response === undefined || !response.ok || response.value.kind !== 'response') {
      throw new Error('missing failed-cleanup remote BYE response');
    }
    expect(response.value.statusCode).toBe(200);
    expect(ua.callState).toBe('idle');
  });

  it('expires a failed-cleanup fork owner with the accepted INVITE lifetime', async () => {
    const { ua, transport, clock } = setup({ liveness: new RecordingLiveness() });
    await ua.connect();
    const invitation = ua.invite('sip:bob@example.com');
    await confirmCall(transport);
    await invitation;

    emitFork200(transport, 'bob-expiring-cleanup');
    await flush();
    const cleanupBye = sentRequests(transport, 'BYE').at(-1)!;
    respondTo(transport, cleanupBye, 486);
    await flush();
    clock.advance(0); // Release the rejected cleanup BYE transaction's Timer K.

    const owners = (ua as unknown as { dialogOwners: Map<string, unknown> }).dialogOwners;
    expect([...owners.keys()].some((key) => key.includes('bob-expiring-cleanup'))).toBe(true);

    clock.advance(32000); // Timer M bounds retained extra-fork ownership.

    expect([...owners.keys()].some((key) => key.includes('bob-expiring-cleanup'))).toBe(false);
    const expiredBye = createRemoteBye(
      transport,
      'bob-expiring-cleanup',
      'expired-cleanup-remote-bye',
    );
    transport.emitData(serializeMessage(expiredBye));
    await flush();
    const response = transport.sent
      .map((bytes) => parseMessage(bytes))
      .filter((message) => message.ok
        && message.value.kind === 'response'
        && message.value.headers.get('CSeq') === '1 BYE')
      .at(-1);
    expect(response?.ok && response.value.kind === 'response' ? response.value.statusCode : 0).toBe(481);
  });

  it('releases a late-fork dialog owner after its cleanup BYE settles', async () => {
    const { ua, transport } = setup();
    await ua.connect();
    const invitation = ua.invite('sip:bob@example.com');
    await confirmCall(transport);
    await invitation;
    const invite = sentRequests(transport, 'INVITE')[0]!;

    const hangup = ua.bye();
    const selectedBye = sentRequests(transport, 'BYE').at(-1)!;
    respondTo(transport, selectedBye, 200);
    await hangup;

    const headers = new Headers();
    headers.set('Via', invite.headers.get('Via') ?? '');
    headers.set('From', invite.headers.get('From') ?? '');
    headers.set('To', `${invite.headers.get('To') ?? '<sip:bob@example.com>'};tag=bob-late`);
    headers.set('Call-ID', invite.headers.get('Call-ID') ?? '');
    headers.set('CSeq', invite.headers.get('CSeq') ?? '');
    headers.set('Contact', '<sip:bob@192.0.2.3:5060>');
    transport.emitData(serializeMessage(makeResponse(200, 'OK', headers)));
    await flush();

    const cleanupBye = sentRequests(transport, 'BYE').at(-1)!;
    expect(cleanupBye).not.toBe(selectedBye);
    respondTo(transport, cleanupBye, 200);
    await flush();

    const probe = createRemoteBye(transport, 'bob-late', 'released-late-fork');
    transport.emitData(serializeMessage(probe));
    await flush();
    const response = transport.sent
      .map((bytes) => parseMessage(bytes))
      .filter((message) => message.ok
        && message.value.kind === 'response'
        && message.value.headers.get('Call-ID') === probe.headers.get('Call-ID')
        && message.value.headers.get('CSeq') === '1 BYE')
      .at(-1);

    expect(response?.ok).toBe(true);
    if (response === undefined || !response.ok || response.value.kind !== 'response') {
      throw new Error('missing late-fork probe response');
    }
    expect(response.value.statusCode).toBe(481);
  });

  it('adds a To tag to an unmatched CANCEL 481 accepted by strict response identity', async () => {
    const { ua, transport } = setup();
    await ua.connect();
    const headers = new Headers();
    headers.set('Via', 'SIP/2.0/UDP 192.0.2.2:5060;branch=z9hG4bK-unmatched-cancel');
    headers.set('From', '<sip:bob@example.com>;tag=bob-cancel');
    headers.set('To', '<sip:alice@example.com>');
    headers.set('Call-ID', 'unmatched-cancel@example.com');
    headers.set('CSeq', '1 CANCEL');
    const cancel = makeRequest('CANCEL', 'sip:alice@example.com', headers);

    transport.emitData(serializeMessage(cancel));
    await flush();

    const parsed = transport.sent
      .map((bytes) => parseMessage(bytes))
      .find((message) => message.ok
        && message.value.kind === 'response'
        && message.value.headers.get('CSeq') === '1 CANCEL');
    expect(parsed?.ok).toBe(true);
    if (parsed === undefined || !parsed.ok || parsed.value.kind !== 'response') {
      throw new Error('missing unmatched CANCEL response');
    }
    expect(parsed.value.statusCode).toBe(481);
    expect(parsed.value.headers.get('To')).toMatch(/;tag=/);
    expect(responseMatchesRequestIdentity(cancel, parsed.value)).toBe(true);
  });

  it('keeps invite pending while setRemote is held, and does not close media early on confirmation', async () => {
    const transport = new FakeTransport({ reliable: true, framing: 'stream' });
    const media = new UaControllableMediaPort();
    media.holdSetRemote = true;
    const { ua } = setup({ transport, media });
    await ua.connect();

    const invitation = ua.invite('sip:bob@example.com');
    await flush();
    const invite = sentRequests(transport, 'INVITE')[0]!;
    const headers = new Headers();
    headers.set('Via', invite.headers.get('Via') ?? '');
    headers.set('From', invite.headers.get('From') ?? '');
    headers.set('To', `${invite.headers.get('To') ?? 'sip:bob@example.com'};tag=bob-1`);
    headers.set('Call-ID', invite.headers.get('Call-ID') ?? '');
    headers.set('CSeq', invite.headers.get('CSeq') ?? '');
    headers.set('Contact', '<sip:bob@192.0.2.2:5060>');
    const okResponse = withTextBody(makeResponse(200, 'OK', headers), STUB_SDP, 'application/sdp') as SipResponseMessage;
    transport.emitData(serializeMessage(okResponse));
    await flush();

    expect(media.heldSetRemoteCount).toBe(1);
    await expect(Promise.race([invitation.then(() => true, () => 'rejected'), 'pending'])).resolves.toBe('pending');

    media.completeHeldSetRemote();
    await invitation;
    expect(ua.callState).toBe('confirmed');
    // Media is only closed on a terminal transition, not on confirmation.
    expect(media.closeSessionCount).toBe(0);
  });

  it('fails invite, closes media exactly once, and sends no local BYE on rejected setRemote', async () => {
    const transport = new FakeTransport({ reliable: true, framing: 'stream' });
    const media = new UaControllableMediaPort();
    media.holdSetRemote = true;
    const { ua } = setup({ transport, media });
    await ua.connect();

    const invitation = ua.invite('sip:bob@example.com');
    await flush();
    const invite = sentRequests(transport, 'INVITE')[0]!;
    const headers = new Headers();
    headers.set('Via', invite.headers.get('Via') ?? '');
    headers.set('From', invite.headers.get('From') ?? '');
    headers.set('To', `${invite.headers.get('To') ?? 'sip:bob@example.com'};tag=bob-1`);
    headers.set('Call-ID', invite.headers.get('Call-ID') ?? '');
    headers.set('CSeq', invite.headers.get('CSeq') ?? '');
    headers.set('Contact', '<sip:bob@192.0.2.2:5060>');
    const okResponse = withTextBody(makeResponse(200, 'OK', headers), STUB_SDP, 'application/sdp') as SipResponseMessage;
    transport.emitData(serializeMessage(okResponse));
    await flush();
    expect(media.heldSetRemoteCount).toBe(1);

    media.rejectHeldSetRemote('REMOTE_DESCRIPTION_REJECTED');
    await expect(invitation).rejects.toMatchObject({ code: 'REMOTE_DESCRIPTION_REJECTED' });
    // UA terminal ownership releases the outgoing owner on failure.
    expect(ua.callState).toBe('idle');
    // UA terminal ownership closes media exactly once on the terminal transition.
    expect(media.closeSessionCount).toBe(1);
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

describe('UserAgent Via transport token', () => {
  it.each([
    ['UDP', 'SIP/2.0/UDP'],
    ['TCP', 'SIP/2.0/TCP'],
    ['WS', 'SIP/2.0/WS'],
    ['WSS', 'SIP/2.0/WSS'],
  ] as const)('reflects the %s transport token in the outbound INVITE Via', async (token, expectedPrefix) => {
    const transport = new FakeTransport({ reliable: true, framing: 'stream', token });
    const { ua } = setup({ transport });
    await ua.connect();
    const invite = ua.invite('sip:bob@example.com');
    await confirmCall(transport);
    await invite;
    expect(captureOutboundVia(transport)).toMatch(new RegExp(`^${expectedPrefix}`));
  });
});

describe('UserAgent truthful event surface', () => {
  it('emits registrationStateChanged (not stateChanged) with the full shape', async () => {
    const { ua, transport } = setup();
    const registrationEvents: Array<{ type: string; state: string; identity?: unknown }> = [];
    ua.on('registrationStateChanged', (event) => registrationEvents.push(event));
    await ua.connect();

    const registration = ua.register();
    await flush();
    const reg = lastRequest(transport, 'REGISTER');
    respondTo(transport, reg, 200, { expires: '120' });
    await registration;
    await flush();

    expect(registrationEvents.length).toBeGreaterThan(0);
    expect(registrationEvents[0]).toMatchObject({
      type: 'registrationStateChanged',
      state: 'registered',
    });
    expect((registrationEvents[0]!.identity as { callId: string }).callId).toBeTruthy();

    await ua.disconnect();
  });

  it('isolates throwing registrationStateChanged observers and still resolves register()', async () => {
    const { ua, transport } = setup();
    const observed: Array<{ type: string; state: string }> = [];
    ua.on('registrationStateChanged', () => {
      throw new Error('observer failed');
    });
    ua.on('registrationStateChanged', (event) => observed.push(event));
    await ua.connect();

    const registration = ua.register();
    await flush();
    const reg = lastRequest(transport, 'REGISTER');
    respondTo(transport, reg, 200, { expires: '120' });
    await registration;
    await flush();

    expect(observed.some((event) => event.state === 'registered')).toBe(true);

    await ua.disconnect();
  });

  it('emits callStateChanged (not stateChanged) across an outgoing call', async () => {
    const { ua, transport } = setup();
    const callEvents: Array<{ type: string; state: string }> = [];
    ua.on('callStateChanged', (event) => callEvents.push(event));
    await ua.connect();

    const invite = ua.invite('sip:bob@example.com');
    await confirmCall(transport);
    await invite;

    expect(callEvents.some((event) => event.state === 'inviting')).toBe(true);
    expect(callEvents.some((event) => event.state === 'confirmed')).toBe(true);
    expect(callEvents.every((event) => event.type === 'callStateChanged')).toBe(true);

    await ua.disconnect();
  });

  it('emits incomingCall as a shaped event, not the raw invitation', async () => {
    const { ua, transport } = setup();
    const incomingEvents: Array<{ type: string; invitation?: Invitation }> = [];
    ua.on('incomingCall', (event) => incomingEvents.push(event));
    await ua.connect();

    receiveIncomingCall(ua, transport);

    expect(incomingEvents).toHaveLength(1);
    expect(incomingEvents[0]).toMatchObject({ type: 'incomingCall' });
    expect(incomingEvents[0]!.invitation).toBeDefined();
    expect(incomingEvents[0]!.invitation).not.toBe(incomingEvents[0]); // raw object vs shaped event

    await ua.disconnect();
  });

  it('answers an incoming INVITE with 488 when media is unavailable', async () => {
    const { ua, transport } = setup({ media: false });
    const incoming: unknown[] = [];
    ua.on('incomingCall', (event) => incoming.push(event));
    await ua.connect();

    transport.emitData(serializeMessage(makeIncomingInvite()));
    await flush();

    const response = lastResponse(transport);
    expect(response.statusCode).toBe(488);
    expect(response.reasonPhrase).toBe('Not Acceptable Here');
    expect(incoming).toHaveLength(0);
    await ua.disconnect();
  });

  it('restartIce rejects INVALID_STATE when no call is confirmed', async () => {
    const { ua } = setup();
    await ua.connect();
    await expect(ua.restartIce()).rejects.toMatchObject({ code: 'INVALID_STATE' });
    await ua.disconnect();
  });

  it('restartIce on a confirmed outgoing call sends an in-dialog re-INVITE with incremented CSeq', async () => {
    const { ua, transport } = setup();
    await ua.connect();
    // Confirm the initial call inline (before awaiting invite), matching the
    // negotiator test harness: 2xx → setRemote auto-answers → confirmed.
    const pending = ua.invite('sip:bob@example.com');
    await flush();
    const initialInvite = lastRequest(transport, 'INVITE');
    const initialHeaders = new Headers();
    initialHeaders.set('Via', initialInvite.headers.get('Via') ?? '');
    initialHeaders.set('From', initialInvite.headers.get('From') ?? '');
    initialHeaders.set('To', `${initialInvite.headers.get('To') ?? '<sip:bob@example.com>'};tag=bob-1`);
    initialHeaders.set('Call-ID', initialInvite.headers.get('Call-ID') ?? '');
    initialHeaders.set('CSeq', initialInvite.headers.get('CSeq') ?? '');
    initialHeaders.set('Contact', '<sip:bob@192.0.2.2:5060>');
    const initial200 = withTextBody(makeResponse(200, 'OK', initialHeaders), STUB_SDP, 'application/sdp') as SipResponseMessage;
    transport.emitData(serializeMessage(initial200));
    await pending;
    await flush();

    const restart = ua.restartIce();
    await flush();

    const invite = lastRequest(transport, 'INVITE');
    // The re-INVITE is the last INVITE after the initial one; it must reuse the
    // dialog identity with a higher CSeq.
    const cseqNumber = Number(invite.headers.get('CSeq')?.trim().split(/\s+/)[0]);
    expect(cseqNumber).toBeGreaterThan(1);
    expect(invite.headers.get('Call-ID')).toBe(initialInvite.headers.get('Call-ID'));
    expect(invite.headers.get('To')).toContain('tag=bob-1');

    // Reply 200 with an answer echoing the re-INVITE To tag; FakeMediaPort
    // auto-answers setRemote.
    const answerHeaders = new Headers();
    answerHeaders.set('Via', invite.headers.get('Via') ?? '');
    answerHeaders.set('From', invite.headers.get('From') ?? '');
    answerHeaders.set('To', invite.headers.get('To') ?? '');
    answerHeaders.set('Call-ID', invite.headers.get('Call-ID') ?? '');
    answerHeaders.set('CSeq', invite.headers.get('CSeq') ?? '');
    answerHeaders.set('Contact', '<sip:bob@192.0.2.2:5060>');
    const answer = withTextBody(makeResponse(200, 'OK', answerHeaders), STUB_SDP, 'application/sdp') as SipResponseMessage;
    transport.emitData(serializeMessage(answer));
    await restart;
  });

  it('answers a second incoming initial INVITE while the first call is busy with 486, no new Invitation', async () => {
    const { ua, transport } = setup();
    await ua.connect();
    const first = receiveIncomingCall(ua, transport);

    const incoming: unknown[] = [];
    ua.on('incomingCall', (event) => incoming.push(event));
    transport.emitData(serializeMessage(makeIncomingInvite('second-call@example.com', 'z9hG4bK-second')));
    await flush();

    expect(sentResponses(transport, 486)).toBe(1);
    const rejection = lastResponse(transport);
    expect(rejection.statusCode).toBe(486);
    expect(rejection.headers.get('CSeq')?.trim()).toBe('1 INVITE');
    expect(incoming).toHaveLength(0);
    expect(ua.activeInvitationsFor).toHaveLength(1);
    expect([...ua.activeInvitationsFor.values()][0]).toBe(first);

    await ua.disconnect();
  });

  it('answers a second incoming initial INVITE with 486 while an outgoing inviter is active', async () => {
    const { ua, transport } = setup();
    await ua.connect();
    const outgoing = ua.invite('sip:bob@example.com');
    await flush();

    const incoming: unknown[] = [];
    ua.on('incomingCall', (event) => incoming.push(event));
    transport.emitData(serializeMessage(makeIncomingInvite('outgoing-busy@example.com', 'z9hG4bK-outgoing-busy')));
    await flush();

    expect(sentResponses(transport, 486)).toBe(1);
    expect(incoming).toHaveLength(0);
    expect(ua.callState).toMatch(/inviting|proceeding|early/);

    // Consume the in-flight invite so disconnect() does not orphan a rejected
    // LIFECYCLE_ABORTED promise (which vitest surfaces as an unhandled error).
    await ua.disconnect().then(() => {}, () => {});
    await outgoing.catch(() => {});
  });

  it('still routes a duplicate INVITE for the same inviteId to the duplicate path, not 486', async () => {
    const { ua, transport } = setup();
    await ua.connect();
    receiveIncomingCall(ua, transport);

    // The first call is busy, but a retransmission with the SAME inviteId must
    // take the duplicate path (no 486 and no new Invitation), not the 486 rule.
    transport.emitData(serializeMessage(makeIncomingInvite('incoming-call@example.com')));
    await flush();

    expect(sentResponses(transport, 486)).toBe(0);
    expect(ua.activeInvitationsFor.size).toBe(1);

    await ua.disconnect();
  });

  it('accepts a second incoming initial INVITE after the first call is fully terminated', async () => {
    const { ua, transport } = setup();
    await ua.connect();
    const first = receiveIncomingCall(ua, transport);
    first.reject(486, 'Busy Here');
    await flush();

    const incoming: unknown[] = [];
    ua.on('incomingCall', (event) => incoming.push(event));
    transport.emitData(serializeMessage(makeIncomingInvite('after-terminated@example.com', 'z9hG4bK-after')));
    await flush();

    expect(incoming).toHaveLength(1);
    expect(sentResponses(transport, 486)).toBe(1); // only the first call's own rejection

    await ua.disconnect();
  });

  it('routes an incoming in-dialog re-INVITE to the negotiator and answers 200', async () => {
    const { ua, transport } = setup();
    await ua.connect();
    // Establish a confirmed outgoing call first (inline confirm).
    const pending = ua.invite('sip:bob@example.com');
    await flush();
    const initialInvite = lastRequest(transport, 'INVITE');
    const initialHeaders = new Headers();
    initialHeaders.set('Via', initialInvite.headers.get('Via') ?? '');
    initialHeaders.set('From', initialInvite.headers.get('From') ?? '');
    initialHeaders.set('To', `${initialInvite.headers.get('To') ?? '<sip:bob@example.com>'};tag=bob-1`);
    initialHeaders.set('Call-ID', initialInvite.headers.get('Call-ID') ?? '');
    initialHeaders.set('CSeq', initialInvite.headers.get('CSeq') ?? '');
    initialHeaders.set('Contact', '<sip:bob@192.0.2.2:5060>');
    const initial200 = withTextBody(makeResponse(200, 'OK', initialHeaders), STUB_SDP, 'application/sdp') as SipResponseMessage;
    transport.emitData(serializeMessage(initial200));
    await pending;
    await flush();

    // Build an in-dialog re-INVITE from the remote (To carries our tag).
    const headers = new Headers();
    headers.set('Via', 'SIP/2.0/UDP 192.0.2.2:5060;branch=z9hG4bK-ua-reinvite');
    headers.set('Max-Forwards', '70');
    headers.set('From', `${initialHeaders.get('To') ?? '<sip:bob@example.com>'};tag=bob-1`);
    headers.set('To', initialInvite.headers.get('From') ?? '');
    headers.set('Call-ID', initialInvite.headers.get('Call-ID') ?? '');
    headers.set('CSeq', '2 INVITE');
    headers.set('Contact', '<sip:bob@192.0.2.2:5060>');
    headers.set('Content-Type', 'application/sdp');
    const reinvite = makeRequest(
      'INVITE',
      'sip:alice@example.com',
      headers,
      new TextEncoder().encode(STUB_SDP),
    );

    transport.emitData(serializeMessage(reinvite));
    await flush();

    const response = lastResponse(transport);
    expect(response.statusCode).toBe(200);
    expect(response.headers.get('CSeq')).toBe('2 INVITE');
  });
});
