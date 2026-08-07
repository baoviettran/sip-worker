import { describe, expect, it } from 'vitest';
import { Headers, makeResponse, bodyText, withTextBody } from '../../src/messages/index.js';
import type { SipRequestMessage, SipResponseMessage } from '../../src/messages/message.js';
import { parseMessage } from '../../src/messages/parser.js';
import { TransactionLayer, deriveTimers } from '../../src/transactions/index.js';
import type { TransactionLayerEvent } from '../../src/transactions/types.js';
import { FakeClock } from '../support/fake-clock.js';
import { FakeTransport } from '../support/fake-transport.js';
import { AuthManager } from '../../src/auth/manager.js';
import { WorkerMediaController } from '../../src/media/worker-controller.js';
import { STUB_SDP } from '../../src/media/index.js';
import type { MediaCommand, MediaMessage } from '../../src/media/index.js';
import { TransportError } from '../../src/errors.js';
import type { SessionState, SessionEvent } from '../../src/ua/session.js';
import { Inviter, type InviterOptions } from '../../src/ua/inviter.js';

const REMOTE_URI = 'sip:bob@192.0.2.2';
const AOR = 'sip:alice@example.com';
const CONTACT = `<${AOR}>`;
const SECRET = 'Circle Of Life';
const REALM = 'example.com';
const NOAUTH_NONCE = 'dcd98b0d5bf5425e1a26f9e1f9d3b997';

/** Assert a promise has not settled yet. */
const PENDING = Symbol('pending');
function expectPending<T>(promise: Promise<T>): Promise<void> {
  return expect(Promise.race([promise, PENDING])).resolves.toBe(PENDING);
}

/** Id generator producing distinct branch seeds per call. */
function makeIdGenerator(): { branch: () => string } {
  let n = 0;
  return { branch: (): string => `test-${(n += 1)}` };
}

/**
 * A two-sided in-memory media port. Captures outbound commands and
 * auto-replies over a microtask with STUB_SDP (offer/answer) or void
 * (setRemote), keyed by the requestId the controller awaits.
 */
class FakeMediaPort {
  commands: MediaCommand[] = [];
  private listeners = new Set<(message: MediaMessage) => void>();

  postMessage(message: MediaMessage): void {
    if (message.type !== 'createOffer' && message.type !== 'createAnswer' && message.type !== 'setRemote') {
      return;
    }
    this.commands.push(message);
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

  get setRemoteSdps(): string[] {
    return this.commands
      .filter((c) => c.type === 'setRemote')
      .map((c) => (c.type === 'setRemote' ? c.remoteSdp : ''));
  }

  get offerCount(): number {
    return this.commands.filter((c) => c.type === 'createOffer').length;
  }

  private deliver(message: MediaMessage): void {
    for (const listener of this.listeners) listener(message);
  }
}

/** A transport whose send always fails, to force a transportError. */
class RejectingTransport extends FakeTransport {
  override async send(_data: Uint8Array): Promise<void> {
    throw new TransportError('send failed');
  }
}

interface Harness {
  clock: FakeClock;
  transport: FakeTransport;
  layer: TransactionLayer;
  events: TransactionLayerEvent[];
  sent: SipRequestMessage[];
  media: FakeMediaPort;
  controller: WorkerMediaController;
  inviter: Inviter;
  recorded: Array<{ previous: SessionState; state: SessionState }>;
  idGenerator: { branch: () => string };
}

function finalCSeq(request: SipRequestMessage): number {
  const cseq = request.headers.get('CSeq');
  return cseq === undefined ? 0 : Number(cseq.trim().split(/\s+/)[0] ?? '');
}

/** ACK requests observed on the wire (2xx ACKs from the session + non-2xx). */
function acks(h: Harness): Array<{ msg: SipRequestMessage; bytes: Uint8Array }> {
  const out: Array<{ msg: SipRequestMessage; bytes: Uint8Array }> = [];
  for (const bytes of h.transport.sent) {
    const parsed = parseMessage(bytes);
    if (parsed.ok && parsed.value.kind === 'request' && parsed.value.method === 'ACK') {
      out.push({ msg: parsed.value, bytes: bytes.slice() });
    }
  }
  return out;
}

function setup(options: { credentials?: boolean; rejectTransport?: boolean } = {}): Harness {
  const { credentials = true, rejectTransport = false } = options;
  const clock = new FakeClock();
  const transport: FakeTransport = rejectTransport
    ? new RejectingTransport({ reliable: true, framing: 'stream' })
    : new FakeTransport({ reliable: true, framing: 'stream' });
  void transport.connect();
  const sent: SipRequestMessage[] = [];
  transport.onSend = (bytes) => {
    const parsed = parseMessage(bytes);
    if (parsed.ok && parsed.value.kind === 'request') sent.push(parsed.value);
  };
  const timers = deriveTimers({ T1: 500, T2: 4000, T4: 5000 }, true);
  const events: TransactionLayerEvent[] = [];
  const layer = new TransactionLayer({
    transport, clock, timers, reliable: true,
    emit: (event) => events.push(event),
  });
  const idGenerator = makeIdGenerator();
  const media = new FakeMediaPort();
  const controller = new WorkerMediaController(media);
  const recorded: Harness['recorded'] = [];
  const authManager = credentials ? new AuthManager(idGenerator) : undefined;
  const options_: InviterOptions = {
    to: REMOTE_URI,
    from: AOR,
    contact: CONTACT,
    viaAddress: '192.0.2.1:5060',
    idGenerator,
    layer,
    clock,
    controller,
    authManager,
    credentials: credentials ? { username: 'alice', password: SECRET } : undefined,
  };
  const inviter = new Inviter(options_);
  inviter.session.on((event: SessionEvent) => {
    recorded.push({ previous: event.previous, state: event.state });
  });
  return { clock, transport, layer, events, sent, media, controller, inviter, recorded, idGenerator };
}

function flush(): Promise<void> { return new Promise((resolve) => setTimeout(resolve, 0)); }

/** Route a response to the most recent outbound request through the layer. */
function respond(
  h: Harness,
  statusCode: number,
  over: { sdp?: string; toTag?: string; challenge?: boolean } = {},
): void {
  const request = h.sent[h.sent.length - 1];
  if (request === undefined) throw new Error('no outbound request to answer');
  const headers = new Headers();
  headers.set('Via', request.headers.get('Via') ?? `SIP/2.0/UDP 192.0.2.1:5060;branch=z9hG4bK-test`);
  headers.set('From', request.headers.get('From') ?? `<${AOR}>;tag=inv-1`);
  // Construct To header with tag (don't use request's To which has no tag)
  const toUri = request.headers.get('To')?.match(/<([^>]+)>/)?.[1] ?? REMOTE_URI;
  headers.set('To', `<${toUri}>;tag=${over.toTag ?? 'bob-1'}`);
  headers.set('Call-ID', request.headers.get('Call-ID') ?? 'call@example.com');
  headers.set('CSeq', request.headers.get('CSeq') ?? '1 INVITE');
  headers.set('Max-Forwards', '70');
  // A 2xx INVITE response must carry a Contact header (RFC 3261 12.1.1)
  if (statusCode >= 200 && statusCode < 300) {
    headers.set('Contact', '<sip:bob@192.0.2.2:5060>');
  }
  if (over.challenge === true) {
    headers.set('WWW-Authenticate', `Digest realm="${REALM}", nonce="${NOAUTH_NONCE}", qop="auth", algorithm=SHA-256`);
  }
  let message: SipResponseMessage = makeResponse(
    statusCode,
    statusCode >= 400 ? 'err' : statusCode === 200 ? 'OK' : 'ringing',
    headers,
  );
  if (over.sdp !== undefined) message = withTextBody(message, over.sdp, 'application/sdp') as SipResponseMessage;
  h.layer.receive(message);
}

describe('Inviter (outgoing SIP call session)', () => {
  it('walks the full trace to confirmed with a direct 2xx ACK', async () => {
    const h = setup();
    const invite = h.inviter.invite();

    // offer requested before INVITE is serialized
    await flush();
    expect(h.media.offerCount).toBe(1);

    // INVITE sent with an SDP offer and Call-ID
    const inv = h.sent[0]!;
    expect(inv).toBeDefined();
    expect(inv.method).toBe('INVITE');
    expect(inv.headers.get('Content-Type')).toBe('application/sdp');
    expect(inv.headers.get('Call-ID')).toBeTruthy();
    expect(bodyText(inv)).toBe(STUB_SDP);
    expect(h.inviter.session.state).toBe('inviting');

    respond(h, 100);
    await flush();
    expect(h.inviter.session.state).toBe('inviting');

    respond(h, 180);
    await flush();
    expect(h.inviter.session.state).toBe('ringing');

    respond(h, 183, { sdp: 'v=0\r\rm=audio 10000 RTP/AVP 0\r\n' });
    await flush();
    expect(h.inviter.session.state).toBe('early');
    expect(h.media.setRemoteSdps).toContain('v=0\r\rm=audio 10000 RTP/AVP 0\r\n');

    respond(h, 200, { sdp: STUB_SDP, toTag: 'bob-1' });
    await invite;
    expect(h.inviter.session.state).toBe('confirmed');
    // A direct 2xx ACK went out on the wire (INVITE + ACK).
    expect(acks(h).length).toBe(1);

    const trace = h.recorded.map((r) => r.state);
    expect(trace).toContain('inviting');
    expect(trace).toContain('ringing');
    expect(trace).toContain('early');
    expect(trace).toContain('confirmed');
  });

  it('answers a 401 with a transactional ACK then an authenticated re-INVITE', async () => {
    const h = setup({ credentials: true });
    const invite = h.inviter.invite();
    await flush();

    respond(h, 401, { challenge: true });
    await flush();

    // Order on the wire: original INVITE, non-2xx ACK, authenticated re-INVITE.
    expect(h.sent[0]!.method).toBe('INVITE');
    expect(h.sent[1]).toBeDefined();
    expect(h.sent[1]!.method).toBe('ACK');
    expect(h.sent[2]).toBeDefined();
    expect(h.sent[2]!.method).toBe('INVITE');
    expect(h.sent[2]!.headers.get('Authorization')).toMatch(/^Digest /);
    expect(finalCSeq(h.sent[2]!)).toBe(2);

    respond(h, 200, { sdp: STUB_SDP, toTag: 'bob-1' });
    await invite;
    expect(h.inviter.session.state).toBe('confirmed');
  });

  it('rejects with a SipError 486 and reaches failed', async () => {
    const h = setup();
    const invite = h.inviter.invite();
    await flush();

    respond(h, 486);
    await expect(invite).rejects.toMatchObject({ statusCode: 486 });
    expect(h.inviter.session.state).toBe('failed');
  });

  it('rejects invite on a transaction timeout (timer B)', async () => {
    const h = setup();
    const invite = h.inviter.invite();
    await flush();

    // INVITE timer B = 64*T1 = 32000ms on a reliable transport.
    h.clock.advance(32000);
    await expect(invite).rejects.toThrow();
    expect(h.inviter.session.state).toBe('failed');
  });

  it('rejects invite on a transport error', async () => {
    const h = setup({ rejectTransport: true });
    const invite = h.inviter.invite();
    await expect(invite).rejects.toThrow();
    expect(h.inviter.session.state).toBe('failed');
  });

  it('hangup sends a BYE and waits for its 200 before terminating', async () => {
    const h = setup();
    const invite = h.inviter.invite();
    await flush();
    respond(h, 200, { sdp: STUB_SDP, toTag: 'bob-1' });
    await invite;
    expect(h.inviter.session.state).toBe('confirmed');

    const bye = h.inviter.hangup();
    await flush();
    const last = h.sent[h.sent.length - 1]!;
    expect(last.method).toBe('BYE');
    expect(h.inviter.session.state).toBe('terminating');
    await expectPending(bye);

    respond(h, 200, { toTag: 'bob-1' });
    await bye;
    expect(h.inviter.session.state).toBe('terminated');
  });

  it('resends a byte-identical cached ACK on a repeated same-dialog 200', async () => {
    const h = setup();
    const invite = h.inviter.invite();
    await flush();
    respond(h, 200, { sdp: STUB_SDP, toTag: 'bob-1' });
    await invite;
    expect(h.inviter.session.state).toBe('confirmed');
    expect(acks(h).length).toBe(1);
    const firstAck = acks(h)[0]!.bytes;

    respond(h, 200, { sdp: STUB_SDP, toTag: 'bob-1' });
    await flush();

    expect(acks(h).length).toBe(2);
    const secondAck = acks(h)[1]!.bytes;
    expect(Buffer.from(secondAck).equals(Buffer.from(firstAck))).toBe(true);
    expect(h.recorded.filter((r) => r.state === 'confirmed')).toHaveLength(1);
  });
});
