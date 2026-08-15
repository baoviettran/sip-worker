import { describe, expect, it } from 'vitest';
import { Headers, makeRequest, makeResponse, bodyText, withTextBody } from '../../src/messages/index.js';
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
  protected listeners = new Set<(message: MediaMessage) => void>();

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

  protected deliver(message: MediaMessage): void {
    for (const listener of this.listeners) listener(message);
  }
}

/**
 * A media port that can HOLD the setRemote reply until the test chooses to
 * complete or reject it, exposing a coded mediaError path and a closeSession
 * counter. Used to prove invite() settlement is gated on remote media.
 */
class ControllableMediaPort extends FakeMediaPort {
  holdSetRemote = false;
  closeSessionCount = 0;
  private heldSetRemote: Array<{ requestId: string; sessionId: string }> = [];

  override postMessage(message: MediaMessage): void {
    if (message.type === 'closeSession') {
      this.closeSessionCount += 1;
      return;
    }
    if (message.type === 'setRemote' && this.holdSetRemote) {
      this.commands.push(message);
      this.heldSetRemote.push({ requestId: message.requestId, sessionId: message.sessionId });
      return;
    }
    super.postMessage(message);
  }

  get heldSetRemoteCount(): number {
    return this.heldSetRemote.length;
  }

  /** Complete or reject the oldest held setRemote request. */
  replyToHeldSetRemote(over: { code?: string; message?: string } = {}): void {
    const held = this.heldSetRemote.shift();
    if (held === undefined) throw new Error('no held setRemote to reply to');
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
  authManager: AuthManager | undefined;
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

function setup(options: { credentials?: boolean; rejectTransport?: boolean; mediaPort?: FakeMediaPort } = {}): Harness {
  const { credentials = true, rejectTransport = false, mediaPort } = options;
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
  const media = mediaPort ?? new FakeMediaPort();
  const controller = new WorkerMediaController(media);
  const recorded: Harness['recorded'] = [];
  const authManager = credentials ? new AuthManager(idGenerator) : undefined;
  const options_: InviterOptions = {
    to: REMOTE_URI,
    from: AOR,
    contact: CONTACT,
    viaAddress: '192.0.2.1:5060',
    viaToken: 'TCP',
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
  return { clock, transport, layer, events, sent, media, controller, inviter, authManager, recorded, idGenerator };
}

function flush(): Promise<void> { return new Promise((resolve) => setTimeout(resolve, 0)); }

/** Route a response to the most recent outbound request through the layer. */
function respond(
  h: Harness,
  statusCode: number,
  over: {
    sdp?: string;
    toTag?: string;
    challenge?: boolean;
    identityMismatch?: 'call-id' | 'from-tag' | 'to-uri' | 'to-tag';
    stale?: boolean;
  } = {},
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
  if (over.identityMismatch === 'call-id') headers.set('Call-ID', 'forged-call@example.com');
  if (over.identityMismatch === 'from-tag') headers.set('From', `<${AOR}>;tag=forged-from`);
  if (over.identityMismatch === 'to-uri') headers.set('To', '<sip:mallory@example.com>;tag=bob-1');
  if (over.identityMismatch === 'to-tag') headers.set('To', `<${toUri}>`);
  // A 2xx INVITE response must carry a Contact header (RFC 3261 12.1.1)
  if (statusCode >= 200 && statusCode < 300) {
    headers.set('Contact', '<sip:bob@192.0.2.2:5060>');
  }
  if (over.challenge === true) {
    const stale = over.stale === true ? ', stale=true' : '';
    headers.set('WWW-Authenticate', `Digest realm="${REALM}", nonce="${NOAUTH_NONCE}", qop="auth", algorithm=SHA-256${stale}`);
  }
  let message: SipResponseMessage = makeResponse(
    statusCode,
    statusCode >= 400 ? 'err' : statusCode === 200 ? 'OK' : 'ringing',
    headers,
  );
  if (over.sdp !== undefined) message = withTextBody(message, over.sdp, 'application/sdp') as SipResponseMessage;
  h.layer.receive(message);
}

async function drainMicrotasks(): Promise<void> {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
}

function unrelatedRequest(cseq: number, suffix: string): SipRequestMessage {
  const headers = new Headers();
  headers.set('Via', `SIP/2.0/UDP 192.0.2.1:5060;branch=z9hG4bK-unrelated-${suffix}`);
  headers.set('From', '<sip:probe@example.com>;tag=probe');
  headers.set('To', `<${REMOTE_URI}>`);
  headers.set('Call-ID', `unrelated-${suffix}@example.com`);
  headers.set('CSeq', `${cseq} OPTIONS`);
  return makeRequest('OPTIONS', REMOTE_URI, headers);
}

/** A separate OPTIONS transaction that deliberately shares the INVITE dialog identity. */
function sameDialogOptionsRequest(invite: SipRequestMessage): SipRequestMessage {
  const headers = new Headers();
  headers.set('Via', 'SIP/2.0/UDP 192.0.2.1:5060;branch=z9hG4bK-late-options');
  headers.set('From', invite.headers.get('From')!);
  headers.set('To', invite.headers.get('To')!);
  headers.set('Call-ID', invite.headers.get('Call-ID')!);
  headers.set('CSeq', `${finalCSeq(invite)} OPTIONS`);
  return makeRequest('OPTIONS', REMOTE_URI, headers);
}

function responseFor(
  request: SipRequestMessage,
  over: { statusCode?: number; sdp?: string; toTag?: string } = {},
): SipResponseMessage {
  const statusCode = over.statusCode ?? 200;
  const headers = new Headers();
  headers.set('Via', request.headers.get('Via')!);
  headers.set('From', request.headers.get('From')!);
  const toUri = request.headers.get('To')?.match(/<([^>]+)>/)?.[1] ?? REMOTE_URI;
  const requestToTag = request.headers.get('To')?.match(/;tag=([^;,\s]+)/)?.[1];
  headers.set('To', `<${toUri}>;tag=${over.toTag ?? requestToTag ?? 'server'}`);
  headers.set('Call-ID', request.headers.get('Call-ID')!);
  headers.set('CSeq', request.headers.get('CSeq')!);
  if (statusCode >= 200 && statusCode < 300) {
    headers.set('Contact', '<sip:bob@192.0.2.2:5060>');
  }
  let response: SipResponseMessage = makeResponse(
    statusCode,
    statusCode === 200 ? 'OK' : 'Error',
    headers,
  );
  if (over.sdp !== undefined) {
    response = withTextBody(response, over.sdp, 'application/sdp') as SipResponseMessage;
  }
  return response;
}

function receive(h: Harness, request: SipRequestMessage, over: Parameters<typeof responseFor>[1] = {}): void {
  h.layer.receive(responseFor(request, over));
}

async function confirmCall(h: Harness): Promise<SipRequestMessage> {
  const invitation = h.inviter.invite();
  await drainMicrotasks();
  const invite = h.sent.find((request) => request.method === 'INVITE')!;
  receive(h, invite, { sdp: STUB_SDP, toTag: 'bob-1' });
  await invitation;
  return invite;
}

function observeForkCleanups(h: Harness): Promise<void>[] {
  const cleanups: Promise<void>[] = [];
  const internal = h.inviter as unknown as {
    sendByeForDialog: (dialog: never) => Promise<void>;
  };
  const original = internal.sendByeForDialog.bind(h.inviter);
  internal.sendByeForDialog = (dialog) => {
    const cleanup = original(dialog);
    cleanups.push(cleanup);
    return cleanup;
  };
  return cleanups;
}

describe('Inviter (outgoing SIP call session)', () => {
  it('uses a distinct INVITE branch for a second Inviter while the first is in Accepted', async () => {
    const h = setup();
    const firstInvitation = h.inviter.invite();
    await drainMicrotasks();
    const firstInvite = h.sent.find((request) => request.method === 'INVITE')!;
    receive(h, firstInvite, { sdp: STUB_SDP, toTag: 'bob-first' });
    await firstInvitation;

    const second = new Inviter({
      to: REMOTE_URI,
      from: AOR,
      contact: CONTACT,
      viaAddress: '192.0.2.1:5060',
      viaToken: 'TCP',
      idGenerator: h.idGenerator,
      layer: h.layer,
      clock: h.clock,
      controller: h.controller,
    });
    const secondInvitation = second.invite();
    await drainMicrotasks();

    const invites = h.sent.filter((request) => request.method === 'INVITE');
    expect(invites).toHaveLength(2);
    expect(invites[1]!.headers.get('Via')).not.toBe(invites[0]!.headers.get('Via'));

    receive(h, invites[1]!, { sdp: STUB_SDP, toTag: 'bob-second' });
    await secondInvitation;
    expect(second.session.state).toBe('confirmed');
  });

  it('ignores a server timeout that shares its accepted client transaction key', async () => {
    const h = setup();
    const invitation = h.inviter.invite();
    await drainMicrotasks();
    const invite = h.sent.find((request) => request.method === 'INVITE')!;
    receive(h, invite, { sdp: STUB_SDP, toTag: 'bob-confirmed' });
    await invitation;

    h.layer.receive(invite);
    const serverRequest = h.events.find((event) => event.type === 'request');
    if (serverRequest?.type !== 'request') throw new Error('server transaction was not created');
    h.layer.sendResponse(
      serverRequest.transaction.key,
      responseFor(invite, { statusCode: 486, toTag: 'local-server' }),
    );

    // Timer M terminates the accepted client while Timer H emits a same-key
    // server timeout. Neither server event may fail the confirmed UA session.
    h.clock.advance(32000);

    expect(h.events).toContainEqual({ type: 'timeout', key: serverRequest.transaction.key });
    expect(h.inviter.session.state).toBe('confirmed');
  });

  it.each([
    [
      'wrong branch',
      (via: string): string => via.replace(/branch=[^;,\s]+/, 'branch=z9hG4bK-wrong-invite'),
    ],
    [
      'wrong sent-by',
      (via: string): string => via.replace('192.0.2.1:5060', '192.0.2.99:5060'),
    ],
  ])('ignores a keyless INVITE 2xx with the %s', async (_label, mutateVia) => {
    const h = setup();
    const invitation = h.inviter.invite();
    await drainMicrotasks();
    const invite = h.sent.find((request) => request.method === 'INVITE')!;
    const mismatched = responseFor(invite, { sdp: STUB_SDP, toTag: 'wrong-key' });
    mismatched.headers.set('Via', mutateVia(mismatched.headers.get('Via')!));

    h.layer.receive(mismatched);
    expect(h.events.at(-1)).toEqual(expect.objectContaining({ type: 'statelessResponse' }));
    await drainMicrotasks();

    await expectPending(invitation);
    expect(h.inviter.session.state).toBe('inviting');

    receive(h, invite, { sdp: STUB_SDP, toTag: 'bob-valid' });
    await invitation;
    expect(h.inviter.session.state).toBe('confirmed');
  });

  it('ignores a keyless late OPTIONS 2xx with the INVITE dialog identity', async () => {
    const h = setup();
    const invitation = h.inviter.invite();
    await drainMicrotasks();
    const invite = h.sent.find((request) => request.method === 'INVITE')!;
    const options = sameDialogOptionsRequest(invite);

    const optionsTransaction = h.layer.sendRequest(options);
    receive(h, options);
    h.clock.advance(0);
    expect(optionsTransaction.state).toBe('Terminated');

    h.layer.receive(responseFor(options, { toTag: 'bob-options' }));
    expect(h.events.at(-1)).toEqual(expect.objectContaining({ type: 'statelessResponse' }));
    await drainMicrotasks();

    await expectPending(invitation);
    expect(h.inviter.session.state).toBe('inviting');

    receive(h, invite, { sdp: STUB_SDP, toTag: 'bob-1' });
    await invitation;
    expect(h.inviter.session.state).toBe('confirmed');
  });

  it('ignores a same-CSeq response owned by another operation while inviting', async () => {
    const h = setup();
    const invitation = h.inviter.invite();
    await drainMicrotasks();
    const invite = h.sent.find((request) => request.method === 'INVITE')!;
    const unrelated = unrelatedRequest(finalCSeq(invite), 'invite-response');

    h.layer.sendRequest(unrelated);
    receive(h, unrelated);

    await expectPending(invitation);
    expect(h.inviter.session.state).toBe('inviting');

    receive(h, invite, { sdp: STUB_SDP, toTag: 'bob-1' });
    await invitation;
    expect(h.inviter.session.state).toBe('confirmed');
  });

  it('ignores a timeout owned by another operation while inviting', async () => {
    const h = setup();
    const unrelated = unrelatedRequest(1, 'invite-timeout');
    h.layer.sendRequest(unrelated);
    h.clock.advance(1);
    const invitation = h.inviter.invite();
    await drainMicrotasks();
    const invite = h.sent.find((request) => request.method === 'INVITE')!;

    h.clock.advance(31999);

    await expectPending(invitation);
    expect(h.inviter.session.state).toBe('inviting');

    receive(h, invite, { sdp: STUB_SDP, toTag: 'bob-1' });
    await invitation;
    expect(h.inviter.session.state).toBe('confirmed');
  });

  it('ignores a same-CSeq response owned by another operation while hanging up', async () => {
    const h = setup();
    await confirmCall(h);
    const hangup = h.inviter.hangup();
    const bye = h.sent[h.sent.length - 1]!;
    const unrelated = unrelatedRequest(finalCSeq(bye), 'hangup-response');

    h.layer.sendRequest(unrelated);
    receive(h, unrelated);

    await expectPending(hangup);
    expect(h.inviter.session.state).toBe('terminating');

    receive(h, bye);
    await hangup;
    expect(h.inviter.session.state).toBe('terminated');
  });

  it('ignores a timeout owned by another operation while hanging up', async () => {
    const h = setup();
    await confirmCall(h);
    const unrelated = unrelatedRequest(2, 'hangup-timeout');
    h.layer.sendRequest(unrelated);
    h.clock.advance(1);
    const hangup = h.inviter.hangup();
    const bye = h.sent[h.sent.length - 1]!;

    h.clock.advance(31999);

    await expectPending(hangup);
    expect(h.inviter.session.state).toBe('terminating');

    receive(h, bye);
    await hangup;
    expect(h.inviter.session.state).toBe('terminated');
  });

  it('ignores a same-CSeq response owned by another operation during fork cleanup', async () => {
    const h = setup();
    const cleanups = observeForkCleanups(h);
    const invite = await confirmCall(h);
    receive(h, invite, { sdp: STUB_SDP, toTag: 'bob-2' });
    await drainMicrotasks();
    const cleanup = cleanups[0]!;
    const bye = h.sent.filter((request) => request.method === 'BYE').at(-1)!;
    const unrelated = unrelatedRequest(finalCSeq(bye), 'fork-response');

    h.layer.sendRequest(unrelated);
    receive(h, unrelated);

    await expectPending(cleanup);
    expect(h.inviter.session.state).toBe('confirmed');

    receive(h, bye);
    await cleanup;
    expect(h.inviter.session.state).toBe('confirmed');
  });

  it('ignores a timeout owned by another operation during fork cleanup', async () => {
    const h = setup();
    const cleanups = observeForkCleanups(h);
    const invite = await confirmCall(h);
    const unrelated = unrelatedRequest(2, 'fork-timeout');
    h.layer.sendRequest(unrelated);
    h.clock.advance(1);
    receive(h, invite, { sdp: STUB_SDP, toTag: 'bob-2' });
    await drainMicrotasks();
    const cleanup = cleanups[0]!;
    const bye = h.sent.filter((request) => request.method === 'BYE').at(-1)!;

    h.clock.advance(31999);

    await expectPending(cleanup);
    expect(h.inviter.session.state).toBe('confirmed');

    receive(h, bye);
    await cleanup;
    expect(h.inviter.session.state).toBe('confirmed');
  });

  it('keeps the selected call healthy when an extra-fork cleanup BYE is rejected', async () => {
    const h = setup();
    const invite = await confirmCall(h);
    receive(h, invite, { sdp: STUB_SDP, toTag: 'bob-2' });
    await drainMicrotasks();
    const bye = h.sent.filter((request) => request.method === 'BYE').at(-1)!;
    receive(h, bye, { statusCode: 486 });
    await drainMicrotasks();

    expect(h.inviter.session.state).toBe('confirmed');
    expect(h.inviter.dialog?.remoteTag).toBe('bob-1');
  });

  it('does not apply SDP from an extra fork to the selected call', async () => {
    const h = setup();
    const invite = await confirmCall(h);
    const forkSdp = 'v=0\r\no=fork-b 2 2 IN IP4 192.0.2.22\r\ns=-\r\nt=0 0\r\n';
    receive(h, invite, { sdp: forkSdp, toTag: 'bob-2' });
    await drainMicrotasks();
    const bye = h.sent.filter((request) => request.method === 'BYE').at(-1)!;
    receive(h, bye);
    await drainMicrotasks();

    expect(h.media.setRemoteSdps).not.toContain(forkSdp);
    expect(h.media.setRemoteSdps.at(-1)).toBe(STUB_SDP);
    expect(h.inviter.session.state).toBe('confirmed');
    expect(h.inviter.dialog?.remoteTag).toBe('bob-1');
  });

  it('keeps the selected call healthy when an extra-fork ACK send rejects', async () => {
    const h = setup();
    const invite = await confirmCall(h);
    const captureSend = h.transport.onSend;
    h.transport.onSend = (bytes) => {
      captureSend?.(bytes);
      const parsed = parseMessage(bytes);
      if (parsed.ok
        && parsed.value.kind === 'request'
        && parsed.value.method === 'ACK'
        && parsed.value.headers.get('To')?.includes('tag=bob-2')) {
        throw new TransportError('extra-fork ACK failed');
      }
    };
    receive(h, invite, { sdp: STUB_SDP, toTag: 'bob-2' });
    await drainMicrotasks();

    const bye = h.sent.filter((request) => request.method === 'BYE').at(-1);
    expect(bye).toBeDefined();
    if (bye === undefined) throw new Error('missing extra-fork cleanup BYE');
    receive(h, bye);
    await drainMicrotasks();

    expect(h.inviter.session.state).toBe('confirmed');
    expect(h.inviter.dialog?.remoteTag).toBe('bob-1');
  });

  it('ACKs and cleans up a late fork after selected-dialog hangup completes', async () => {
    const h = setup();
    const invite = await confirmCall(h);
    const hangup = h.inviter.hangup();
    const selectedBye = h.sent.filter((request) => request.method === 'BYE').at(-1)!;
    receive(h, selectedBye);
    await hangup;
    expect(h.inviter.session.state).toBe('terminated');

    receive(h, invite, { sdp: STUB_SDP, toTag: 'bob-late' });
    await drainMicrotasks();

    const lateAck = acks(h).find((ack) =>
      ack.msg.headers.get('To')?.includes('tag=bob-late'),
    );
    expect(lateAck).toBeDefined();
    const byes = h.sent.filter((request) => request.method === 'BYE');
    expect(byes).toHaveLength(2);
    const cleanupBye = byes.at(-1)!;
    receive(h, cleanupBye);
    await drainMicrotasks();
    expect(h.inviter.session.state).toBe('terminated');
  });

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

  it.each([
    ['Call-ID', 'call-id'],
    ['From tag', 'from-tag'],
    ['To URI', 'to-uri'],
    ['To tag', 'to-tag'],
  ] as const)('ignores a forged 401 with mismatched %s', async (_label, identityMismatch) => {
    const h = setup({ credentials: true });
    const invitation = h.inviter.invite();
    const outcome = invitation.then(
      () => undefined,
      (error: unknown) => error,
    );
    await flush();

    respond(h, 401, { challenge: true, identityMismatch });
    await flush();
    const settled = await Promise.race([outcome, PENDING]);
    const inviteAttempts = h.sent.filter((request) => request.method === 'INVITE').length;
    const retryBudgets = h.authManager!.retriesByRequestSize;
    const state = h.inviter.session.state;

    h.inviter.dispose(new Error('test cleanup'));
    await outcome;

    expect(settled).toBe(PENDING);
    expect(inviteAttempts).toBe(1);
    expect(retryBudgets).toBe(0);
    expect(state).toBe('inviting');
  });

  it('does not confirm from a forged 200 with the matching transaction key', async () => {
    const h = setup();
    const invitation = h.inviter.invite();
    const outcome = invitation.then(
      () => undefined,
      (error: unknown) => error,
    );
    await flush();

    respond(h, 200, { sdp: STUB_SDP, identityMismatch: 'call-id' });
    await flush();
    const settled = await Promise.race([outcome, PENDING]);
    const state = h.inviter.session.state;

    h.inviter.dispose(new Error('test cleanup'));
    await outcome;

    expect(settled).toBe(PENDING);
    expect(state).toBe('inviting');
  });

  it('does not fail from a forged terminal response with the matching transaction key', async () => {
    const h = setup();
    const invitation = h.inviter.invite();
    const outcome = invitation.then(
      () => undefined,
      (error: unknown) => error,
    );
    await flush();

    respond(h, 486, { identityMismatch: 'from-tag' });
    await flush();
    const settled = await Promise.race([outcome, PENDING]);
    const state = h.inviter.session.state;

    h.inviter.dispose(new Error('test cleanup'));
    await outcome;

    expect(settled).toBe(PENDING);
    expect(state).toBe('inviting');
  });

  it('does not enter ringing from a forged provisional response', async () => {
    const h = setup();
    const invitation = h.inviter.invite();
    const outcome = invitation.then(
      () => undefined,
      (error: unknown) => error,
    );
    await flush();

    respond(h, 180, { identityMismatch: 'to-uri' });
    await flush();
    const settled = await Promise.race([outcome, PENDING]);
    const state = h.inviter.session.state;

    h.inviter.dispose(new Error('test cleanup'));
    await outcome;

    expect(settled).toBe(PENDING);
    expect(state).toBe('inviting');
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
    expect(h.authManager!.retriesByRequestSize).toBe(0);
  });

  it('rejects the fourth challenge in one logical INVITE exchange', async () => {
    const h = setup({ credentials: true });
    const invite = h.inviter.invite();
    const outcome = invite.then(
      () => undefined,
      (error: unknown) => error,
    );
    await flush();

    for (let challenge = 0; challenge < 4; challenge += 1) {
      respond(h, 401, { challenge: true });
      await flush();
    }

    const settled = await Promise.race([outcome, PENDING]);
    const inviteAttempts = h.sent.filter((request) => request.method === 'INVITE').length;
    if (settled === PENDING) {
      h.inviter.dispose(new Error('test cleanup'));
      await outcome;
    }

    expect(settled).toMatchObject({ statusCode: 401, message: expect.stringContaining('budget exhausted') });
    expect(inviteAttempts).toBe(4);
    expect(h.inviter.session.state).toBe('failed');
    expect(h.authManager!.retriesByRequestSize).toBe(0);
  });
  it('rejects the fourth stale challenge instead of looping INVITE forever', async () => {
    const h = setup({ credentials: true });
    const invite = h.inviter.invite();
    const outcome = invite.then(
      () => undefined,
      (error: unknown) => error,
    );
    await flush();

    for (let challenge = 0; challenge < 4; challenge += 1) {
      respond(h, 401, { challenge: true, stale: true });
      await flush();
    }

    h.clock.advance(32000);
    const settled = await outcome;

    expect(settled).toMatchObject({ statusCode: 401, message: expect.stringContaining('budget exhausted') });
    expect(h.sent.filter((request) => request.method === 'INVITE')).toHaveLength(4);
    expect(h.inviter.session.state).toBe('failed');
  });

  it('releases the logical INVITE exchange after an authenticated terminal failure', async () => {
    const h = setup({ credentials: true });
    const invite = h.inviter.invite();
    await flush();

    respond(h, 401, { challenge: true });
    await flush();
    expect(h.authManager!.retriesByRequestSize).toBe(1);

    respond(h, 486);
    await expect(invite).rejects.toMatchObject({ statusCode: 486 });
    expect(h.authManager!.retriesByRequestSize).toBe(0);
  });

  it('releases the logical INVITE exchange when disposed after authentication', async () => {
    const h = setup({ credentials: true });
    const invite = h.inviter.invite();
    await flush();

    respond(h, 401, { challenge: true });
    await flush();
    expect(h.authManager!.retriesByRequestSize).toBe(1);

    h.inviter.dispose(new Error('shutdown'));
    await expect(invite).rejects.toThrow('shutdown');
    expect(h.authManager!.retriesByRequestSize).toBe(0);
  });

  it('rejects with a SipError 486 and reaches failed', async () => {
    const h = setup();
    const invite = h.inviter.invite();
    await flush();

    respond(h, 486);
    await expect(invite).rejects.toMatchObject({ statusCode: 486, code: 'CALL_FAILED' });
    expect(h.inviter.session.state).toBe('failed');
  });

  it('rejects invite on a transaction timeout (timer B)', async () => {
    const h = setup();
    const invite = h.inviter.invite();
    await flush();

    // INVITE timer B = 64*T1 = 32000ms on a reliable transport.
    h.clock.advance(32000);
    await expect(invite).rejects.toMatchObject({ code: 'TIMEOUT' });
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

  it('recovers after a rejected local BYE so a later hangup can succeed', async () => {
    const h = setup();
    await confirmCall(h);

    const firstHangup = h.inviter.hangup();
    const firstBye = h.sent.at(-1)!;
    receive(h, firstBye, { statusCode: 486 });
    await expect(firstHangup).rejects.toMatchObject({ statusCode: 486 });
    expect(h.inviter.session.state).toBe('confirmed');

    const secondHangup = h.inviter.hangup();
    const secondBye = h.sent.at(-1)!;
    expect(secondBye).not.toBe(firstBye);
    expect(secondBye.method).toBe('BYE');
    receive(h, secondBye);
    await secondHangup;

    expect(h.inviter.session.state).toBe('terminated');
  });

  it('does not settle hangup from a forged BYE response', async () => {
    const h = setup();
    await confirmCall(h);
    const hangup = h.inviter.hangup();
    const outcome = hangup.then(
      () => undefined,
      (error: unknown) => error,
    );
    const bye = h.sent[h.sent.length - 1]!;

    receive(h, bye, { toTag: 'forged-remote' });
    const settled = await Promise.race([outcome, PENDING]);
    const state = h.inviter.session.state;

    h.inviter.dispose(new Error('test cleanup'));
    await outcome;

    expect(settled).toBe(PENDING);
    expect(state).toBe('terminating');
  });

  it('ignores a forged stateless INVITE 2xx after confirmation', async () => {
    const h = setup();
    const invite = await confirmCall(h);
    const acknowledgements = acks(h).length;
    const byes = h.sent.filter((request) => request.method === 'BYE').length;
    const forged = responseFor(invite, { sdp: STUB_SDP, toTag: 'forged-fork' });
    forged.headers.set('To', '<sip:mallory@example.com>;tag=forged-fork');

    h.clock.advance(32000);

    h.layer.receive(forged);
    expect(h.events.at(-1)).toEqual(expect.objectContaining({ type: 'statelessResponse' }));
    await drainMicrotasks();

    expect(h.inviter.session.state).toBe('confirmed');
    expect(acks(h)).toHaveLength(acknowledgements);
    expect(h.sent.filter((request) => request.method === 'BYE')).toHaveLength(byes);
  });

  it('does not settle fork cleanup from a forged BYE response', async () => {
    const h = setup();
    const cleanups = observeForkCleanups(h);
    const invite = await confirmCall(h);
    receive(h, invite, { sdp: STUB_SDP, toTag: 'bob-2' });
    await drainMicrotasks();
    const cleanup = cleanups[0]!;
    const outcome = cleanup.then(
      () => undefined,
      (error: unknown) => error,
    );
    const bye = h.sent.filter((request) => request.method === 'BYE').at(-1)!;

    receive(h, bye, { toTag: 'forged-remote' });
    const settled = await Promise.race([outcome, PENDING]);
    const state = h.inviter.session.state;

    h.inviter.dispose(new Error('test cleanup'));
    await outcome;

    expect(settled).toBe(PENDING);
    expect(state).toBe('confirmed');
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

    receive(h, h.sent.find((request) => request.method === 'INVITE')!, { sdp: STUB_SDP, toTag: 'bob-1' });
    await flush();

    expect(acks(h).length).toBe(2);
    const secondAck = acks(h)[1]!.bytes;
    expect(Buffer.from(secondAck).equals(Buffer.from(firstAck))).toBe(true);
    expect(h.recorded.filter((r) => r.state === 'confirmed')).toHaveLength(1);
  });

  it('stays PENDING while setRemote is held unreplied, then resolves to confirmed', async () => {
    const controllable = new ControllableMediaPort();
    controllable.holdSetRemote = true;
    const h = setup({ mediaPort: controllable });
    const invitation = h.inviter.invite();
    await drainMicrotasks();
    const invite = h.sent.find((request) => request.method === 'INVITE')!;

    receive(h, invite, { sdp: STUB_SDP, toTag: 'bob-1' });
    await flush();

    expect(controllable.heldSetRemoteCount).toBe(1);
    await expectPending(invitation);
    expect(h.inviter.session.state).toBe('inviting');

    controllable.replyToHeldSetRemote();
    await invitation;
    expect(h.inviter.session.state).toBe('confirmed');
  });

  it('rejects invite with NEGOTIATION_FAILED when the selected 2xx carries no SDP', async () => {
    const h = setup();
    const invitation = h.inviter.invite();
    await flush();
    const invite = h.sent.find((request) => request.method === 'INVITE')!;

    receive(h, invite, { sdp: '', toTag: 'bob-1' });
    await expect(invitation).rejects.toMatchObject({
      name: 'MediaError',
      code: 'NEGOTIATION_FAILED',
      sessionId: h.inviter.mediaSessionId,
      operation: 'setRemote',
    });
    expect(h.inviter.session.state).toBe('failed');
    // No setRemote is posted when the selected SDP is empty.
    expect(h.media.setRemoteSdps).toHaveLength(0);
    // The dialog was created and ACKed before the SDP check, so it is closed
    // with a BYE rather than left dangling on the remote.
    const byes = h.sent.filter((request) => request.method === 'BYE');
    expect(byes.length).toBeGreaterThan(0);
    const bye = byes.at(-1)!;
    expect(bye.headers.get('To')).toContain('tag=bob-1');
  });

  it('rejects invite, sends a BYE, and leaves media close-once when setRemote fails on a created dialog', async () => {
    const controllable = new ControllableMediaPort();
    controllable.holdSetRemote = true;
    const h = setup({ mediaPort: controllable });
    const invitation = h.inviter.invite();
    await drainMicrotasks();
    const invite = h.sent.find((request) => request.method === 'INVITE')!;

    receive(h, invite, { sdp: STUB_SDP, toTag: 'bob-1' });
    await flush();
    expect(controllable.heldSetRemoteCount).toBe(1);

    controllable.replyToHeldSetRemote({ code: 'REMOTE_DESCRIPTION_REJECTED', message: 'bad answer' });
    await expect(invitation).rejects.toMatchObject({
      name: 'MediaError',
      code: 'REMOTE_DESCRIPTION_REJECTED',
    });
    expect(h.inviter.session.state).toBe('failed');

    // A BYE goes out for the created dialog when the rejection permits it.
    // (Media closure is UA terminal ownership and is verified at the UA level.)
    const byes = h.sent.filter((request) => request.method === 'BYE');
    expect(byes.length).toBeGreaterThan(0);
  });

  it('rejects invite on dispose while setRemote is held, with no unhandled rejection', async () => {
    const controllable = new ControllableMediaPort();
    controllable.holdSetRemote = true;
    const h = setup({ mediaPort: controllable });
    const invitation = h.inviter.invite();
    await drainMicrotasks();
    const invite = h.sent.find((request) => request.method === 'INVITE')!;

    receive(h, invite, { sdp: STUB_SDP, toTag: 'bob-1' });
    await flush();
    expect(controllable.heldSetRemoteCount).toBe(1);

    h.inviter.dispose(new Error('shutdown'));
    await expect(invitation).rejects.toThrow('shutdown');
    expect(h.inviter.session.state).toBe('failed');
  });

  it('does not double-negotiate a second/forked 2xx while the first setRemote is pending', async () => {
    const controllable = new ControllableMediaPort();
    controllable.holdSetRemote = true;
    const h = setup({ mediaPort: controllable });
    const invitation = h.inviter.invite();
    await drainMicrotasks();
    const invite = h.sent.find((request) => request.method === 'INVITE')!;

    receive(h, invite, { sdp: STUB_SDP, toTag: 'bob-1' });
    await flush();
    expect(controllable.heldSetRemoteCount).toBe(1);

    // A forked/repeated 2xx arrives during the pending setRemote.
    receive(h, invite, { sdp: STUB_SDP, toTag: 'bob-2' });
    await flush();

    // Still exactly one held setRemote; the fork must not start a second negotiation.
    expect(controllable.heldSetRemoteCount).toBe(1);
    await expectPending(invitation);

    controllable.replyToHeldSetRemote();
    await invitation;
    expect(h.inviter.session.state).toBe('confirmed');
    expect(h.recorded.filter((r) => r.state === 'confirmed')).toHaveLength(1);
  });

  it('does not settle a same-tag repeated 2xx ahead of a pending setRemote', async () => {
    const controllable = new ControllableMediaPort();
    controllable.holdSetRemote = true;
    const h = setup({ mediaPort: controllable });
    const invitation = h.inviter.invite();
    await drainMicrotasks();
    const invite = h.sent.find((request) => request.method === 'INVITE')!;

    receive(h, invite, { sdp: STUB_SDP, toTag: 'bob-1' });
    await flush();
    expect(controllable.heldSetRemoteCount).toBe(1);

    // A retransmitted same-to-tag 2xx arrives while setRemote is still pending.
    receive(h, invite, { sdp: STUB_SDP, toTag: 'bob-1' });
    await flush();

    // Still pending: the repeat must not resolve/confirm before setRemote.
    expect(controllable.heldSetRemoteCount).toBe(1);
    await expectPending(invitation);
    expect(h.inviter.session.state).toBe('inviting');

    controllable.replyToHeldSetRemote();
    await invitation;
    expect(h.inviter.session.state).toBe('confirmed');
    expect(h.recorded.filter((r) => r.state === 'confirmed')).toHaveLength(1);
  });

  it('does not let a stale same-tag repeat reopen settlement after a rejected setRemote', async () => {
    const controllable = new ControllableMediaPort();
    controllable.holdSetRemote = true;
    const h = setup({ mediaPort: controllable });
    const invitation = h.inviter.invite();
    await drainMicrotasks();
    const invite = h.sent.find((request) => request.method === 'INVITE')!;

    receive(h, invite, { sdp: STUB_SDP, toTag: 'bob-1' });
    await flush();
    expect(controllable.heldSetRemoteCount).toBe(1);

    controllable.replyToHeldSetRemote({ code: 'REMOTE_DESCRIPTION_REJECTED', message: 'bad' });
    await expect(invitation).rejects.toMatchObject({ code: 'REMOTE_DESCRIPTION_REJECTED' });
    expect(h.inviter.session.state).toBe('failed');

    // A late retransmission of the same tag must be a no-op after the failure.
    receive(h, invite, { sdp: STUB_SDP, toTag: 'bob-1' });
    await drainMicrotasks();
    expect(h.inviter.session.state).toBe('failed');
  });
});
