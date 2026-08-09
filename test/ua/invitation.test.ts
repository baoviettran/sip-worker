/**
 * Tests for incoming invitation handling (UAS perspective).
 */

import { describe, expect, it } from 'vitest';
import { Headers, makeRequest, bodyText } from '../../src/messages/index.js';
import type { SipRequestMessage } from '../../src/messages/message.js';
import { parseMessage } from '../../src/messages/parser.js';
import { TransactionLayer, deriveTimers } from '../../src/transactions/index.js';
import type { TransactionLayerEvent } from '../../src/transactions/types.js';
import { FakeClock } from '../support/fake-clock.js';
import { FakeTransport } from '../support/fake-transport.js';
import { WorkerMediaController } from '../../src/media/worker-controller.js';
import { STUB_SDP } from '../../src/media/index.js';
import type { MediaCommand, MediaMessage } from '../../src/media/index.js';
import type { SessionState, SessionEvent } from '../../src/ua/session.js';
import { Invitation, type InvitationOptions } from '../../src/ua/invitation.js';

const REMOTE_URI = 'sip:alice@example.com';
const LOCAL_URI = 'sip:bob@example.com';
const CONTACT = `<${LOCAL_URI}>`;

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
  autoReplySetRemote = true;
  private listeners = new Set<(message: MediaMessage) => void>();

  postMessage(message: MediaMessage): void {
    if (message.type !== 'createOffer' && message.type !== 'createAnswer' && message.type !== 'setRemote') {
      return;
    }
    this.commands.push(message);
    if (message.type === 'setRemote') {
      if (this.autoReplySetRemote) queueMicrotask(() => this.deliver({ type: 'mediaResult', requestId: message.requestId, sessionId: message.sessionId }));
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

  rejectPendingSetRemote(message: string): void {
    const command = [...this.commands].reverse().find((candidate) => candidate.type === 'setRemote');
    if (command?.type !== 'setRemote') throw new Error('no pending setRemote command');
    this.deliver({
      type: 'mediaError', requestId: command.requestId, sessionId: command.sessionId, message,
    });
  }

  private deliver(message: MediaMessage): void {
    for (const listener of this.listeners) listener(message);
  }
}

interface Harness {
  clock: FakeClock;
  transport: FakeTransport;
  layer: TransactionLayer;
  events: TransactionLayerEvent[];
  sent: Uint8Array[];
  media: FakeMediaPort;
  controller: WorkerMediaController;
  invitation: Invitation;
  recorded: Array<{ previous: SessionState; state: SessionState }>;
  idGenerator: { branch: () => string };
}

function setup(): Harness {
  const clock = new FakeClock();
  const transport = new FakeTransport({ reliable: false, framing: 'datagram' });
  void transport.connect();
  const sent: Uint8Array[] = [];
  transport.onSend = (bytes) => {
    sent.push(bytes);
  };
  const timers = deriveTimers({ T1: 500, T2: 4000, T4: 5000 }, false);
  const events: TransactionLayerEvent[] = [];
  const layer = new TransactionLayer({
    transport, clock, timers, reliable: false,
    emit: (event) => events.push(event),
  });
  const idGenerator = makeIdGenerator();
  const media = new FakeMediaPort();
  const controller = new WorkerMediaController(media);

  // Build incoming INVITE
  const inviteHeaders = new Headers();
  inviteHeaders.set('Via', 'SIP/2.0/UDP 192.0.2.1:5060;branch=z9hG4bK-inv-1');
  inviteHeaders.set('Max-Forwards', '70');
  inviteHeaders.set('From', `<${REMOTE_URI}>;tag=alice-1`);
  inviteHeaders.set('To', `<${LOCAL_URI}>`);
  inviteHeaders.set('Call-ID', 'call-123@example.com');
  inviteHeaders.set('CSeq', '1 INVITE');
  inviteHeaders.set('Contact', `<${REMOTE_URI}>`);
  inviteHeaders.set('Content-Type', 'application/sdp');

  const encoder = new TextEncoder();
  const remoteSdp = 'v=0\r\no=alice 1 1 IN IP4 192.0.2.1\r\ns=-\r\nt=0 0\r\nm=audio 10000 RTP/AVP 0\r\n';
  const body = encoder.encode(remoteSdp);

  const invite = makeRequest('INVITE', LOCAL_URI, inviteHeaders, body);

  // Deliver INVITE to transaction layer
  layer.receive(invite);

  // Find the server transaction
  const requestEvent = events.find((e) => e.type === 'request') as { type: 'request'; transaction: any; request: SipRequestMessage } | undefined;
  if (requestEvent === undefined) throw new Error('no request event');

  const recorded: Array<{ previous: SessionState; state: SessionState }> = [];
  const options: InvitationOptions = {
    request: requestEvent.request,
    transaction: requestEvent.transaction,
    contact: CONTACT,
    viaAddress: '192.0.2.2:5060',
    idGenerator,
    layer,
    clock,
    controller,
    T1: 500,
    T2: 4000,
  };
  const invitation = new Invitation(options);
  invitation.session.on((event: SessionEvent) => {
    recorded.push({ previous: event.previous, state: event.state });
  });

  return { clock, transport, layer, events, sent, media, controller, invitation, recorded, idGenerator };
}

function routeRequest(h: Harness, request: SipRequestMessage): void {
  const before = h.events.length;
  h.layer.receive(request);
  for (const event of h.events.slice(before)) {
    if (event.type === 'request') {
      h.invitation.handleIncomingRequest(event.transaction, event.request);
    } else if (event.type === 'statelessRequest') {
      h.invitation.handleStatelessRequest(event.request);
    }
  }
}

function flush(): Promise<void> { return new Promise((resolve) => setTimeout(resolve, 0)); }

/** Extract 200 OK responses from sent bytes. */
function okResponses(sent: Uint8Array[]): Array<{ msg: any; bytes: Uint8Array }> {
  const out: Array<{ msg: any; bytes: Uint8Array }> = [];
  for (const bytes of sent) {
    const parsed = parseMessage(bytes);
    if (parsed.ok && parsed.value.kind === 'response' && parsed.value.statusCode === 200) {
      out.push({ msg: parsed.value, bytes: bytes.slice() });
    }
  }
  return out;
}

describe('Invitation (incoming SIP call session)', () => {
  it('receives INVITE, answers with 200 OK, receives ACK → confirmed', async () => {
    const h = setup();

    // Answer the INVITE
    const answerPromise = h.invitation.answer(STUB_SDP);
    await flush();

    // Remote SDP was set
    expect(h.media.setRemoteSdps.length).toBe(1);
    expect(h.media.setRemoteSdps[0]).toContain('o=alice');

    // 200 OK was sent (transaction layer sends it, plus automatic 100 Trying)
    const okList = okResponses(h.sent);
    // Debug: log all sent messages
    expect(okList.length).toBe(1);
    const ok = okList[0]!.msg;
    expect(ok.statusCode).toBe(200);
    expect(bodyText(ok)).toBe(STUB_SDP);

    // Session is not yet confirmed (waiting for ACK)
    expect(h.invitation.session.state).not.toBe('confirmed');

    // Send ACK (stateless - different branch from INVITE so it doesn't match the server transaction)
    const ackHeaders = new Headers();
    ackHeaders.set('Via', 'SIP/2.0/UDP 192.0.2.1:5060;branch=z9hG4bK-ack-different');
    ackHeaders.set('Max-Forwards', '70');
    ackHeaders.set('From', `<${REMOTE_URI}>;tag=alice-1`);
    ackHeaders.set('To', `<${LOCAL_URI}>;tag=${h.invitation.toTag}`);
    ackHeaders.set('Call-ID', 'call-123@example.com');
    ackHeaders.set('CSeq', '1 ACK');

    const ack = makeRequest('ACK', REMOTE_URI, ackHeaders);

    routeRequest(h, ack);
    await flush();

    // Answer promise resolves
    await answerPromise;
    expect(h.invitation.session.state).toBe('confirmed');
  });

  it('ignores an ACK whose numeric CSeq differs from the accepted INVITE', async () => {
    const h = setup();
    const answer = h.invitation.answer(STUB_SDP);
    await flush();

    const ackHeaders = new Headers();
    ackHeaders.set('Via', 'SIP/2.0/UDP 192.0.2.1:5060;branch=z9hG4bK-wrong-cseq');
    ackHeaders.set('Max-Forwards', '70');
    ackHeaders.set('From', `<${REMOTE_URI}>;tag=alice-1`);
    ackHeaders.set('To', `<${LOCAL_URI}>;tag=${h.invitation.toTag}`);
    ackHeaders.set('Call-ID', 'call-123@example.com');
    ackHeaders.set('CSeq', '2 ACK');
    routeRequest(h, makeRequest('ACK', REMOTE_URI, ackHeaders));

    expect(h.invitation.session.state).not.toBe('confirmed');
    h.clock.advance(500);
    await flush();
    expect(okResponses(h.sent)).toHaveLength(2);

    const validAckHeaders = ackHeaders.clone();
    validAckHeaders.set('Via', 'SIP/2.0/UDP 192.0.2.1:5060;branch=z9hG4bK-valid-cseq');
    validAckHeaders.set('CSeq', '1 ACK');
    routeRequest(h, makeRequest('ACK', REMOTE_URI, validAckHeaders));

    await answer;
    expect(h.invitation.session.state).toBe('confirmed');
  });

  it('retransmits 200 OK at T1, 2*T1, 4*T1 intervals', async () => {
    const h = setup();

    void h.invitation.answer(STUB_SDP);
    await flush();

    // Initial send
    let okList = okResponses(h.sent);
    expect(okList.length).toBe(1);

    // Advance to T1 (500ms)
    h.clock.advance(500);
    await flush();
    okList = okResponses(h.sent);
    expect(okList.length).toBe(2);

    // Advance to 2*T1 (1000ms more)
    h.clock.advance(1000);
    await flush();
    okList = okResponses(h.sent);
    expect(okList.length).toBe(3);

    // Advance to 4*T1 (2000ms more)
    h.clock.advance(2000);
    await flush();
    okList = okResponses(h.sent);
    expect(okList.length).toBe(4);
  });

  it('stops retransmission when ACK arrives', async () => {
    const h = setup();

    void h.invitation.answer(STUB_SDP);
    await flush();

    let okList = okResponses(h.sent);
    expect(okList.length).toBe(1);

    // Advance to T1
    h.clock.advance(500);
    await flush();
    okList = okResponses(h.sent);
    expect(okList.length).toBe(2);

    // Send ACK
    const ackHeaders = new Headers();
    ackHeaders.set('Via', 'SIP/2.0/UDP 192.0.2.1:5060;branch=z9hG4bK-ack-1');
    ackHeaders.set('Max-Forwards', '70');
    ackHeaders.set('From', `<${REMOTE_URI}>;tag=alice-1`);
    ackHeaders.set('To', `<${LOCAL_URI}>;tag=${h.invitation.toTag}`);
    ackHeaders.set('Call-ID', 'call-123@example.com');
    ackHeaders.set('CSeq', '1 ACK');

    const ack = makeRequest('ACK', REMOTE_URI, ackHeaders);
    routeRequest(h, ack);
    await flush();

    // Advance time - no more retransmissions
    h.clock.advance(1000);
    await flush();
    okList = okResponses(h.sent);
    expect(okList.length).toBe(2); // Still 2, no new sends
  });

  it('times out after 64*T1 if no ACK', async () => {
    const h = setup();

    const answerPromise = h.invitation.answer(STUB_SDP);
    await flush();

    // Advance to 64*T1 (32000ms)
    h.clock.advance(32000);

    // Should fail
    await expect(answerPromise).rejects.toThrow('ACK timeout');
    expect(h.invitation.session.state).toBe('failed');
  });

  it('rejects INVITE with 486 → no retransmission', async () => {
    const h = setup();

    h.invitation.reject(486, 'Busy Here');
    await flush();

    // 486 response was sent
    const responses = h.sent.map((bytes) => parseMessage(bytes)).filter((p) => p.ok && p.value.kind === 'response');
    expect(responses.length).toBeGreaterThanOrEqual(1);
    const first = responses[0]!;
    if (!first.ok || first.value.kind !== 'response') throw new Error('Expected response');
    expect(first.value.statusCode).toBe(486);

    // Session failed
    expect(h.invitation.session.state).toBe('failed');

    // The retransmitter should not be started (no TU-level retransmissions)
    // Transaction-level retransmissions are OK (handled by the transaction layer)
    // Check that the invitation's retransmitter is undefined
    expect((h.invitation as any).retransmitter).toBeUndefined();
  });

  it('sends only the first rejection when reject is called twice', async () => {
    const h = setup();

    h.invitation.reject(486, 'Busy Here');
    h.invitation.reject(603, 'Decline');
    await flush();

    const finalStatuses = h.sent
      .map((bytes) => parseMessage(bytes))
      .filter((parsed) => parsed.ok && parsed.value.kind === 'response' && parsed.value.statusCode >= 200)
      .map((parsed) => parsed.ok && parsed.value.kind === 'response' ? parsed.value.statusCode : 0);
    expect(finalStatuses).toEqual([486]);
    expect(h.recorded.filter((event) => event.state === 'failed')).toHaveLength(1);
    const lateAnswer = h.invitation.answer(STUB_SDP);
    const outcome = await Promise.race([
      lateAnswer.then(() => 'resolved', (error: Error) => error.message),
      flush().then(() => 'pending'),
    ]);
    expect(outcome).toBe('answer() already called');
    void lateAnswer.catch(() => undefined);
  });


  it('rejects a second answer while the first answer is pending', async () => {
    const h = setup();
    const first = h.invitation.answer(STUB_SDP);

    await expect(h.invitation.answer(STUB_SDP)).rejects.toThrow('answer() already called');
    await flush();

    expect(okResponses(h.sent)).toHaveLength(1);
    void first.catch(() => undefined);
  });

  it('keeps cancellation first-wins when pending media setup later rejects', async () => {
    const h = setup();
    h.media.autoReplySetRemote = false;
    const answer = h.invitation.answer(STUB_SDP);

    const cancelHeaders = new Headers();
    cancelHeaders.set('Via', 'SIP/2.0/UDP 192.0.2.1:5060;branch=z9hG4bK-inv-1');
    cancelHeaders.set('Max-Forwards', '70');
    cancelHeaders.set('From', `<${REMOTE_URI}>;tag=alice-1`);
    cancelHeaders.set('To', `<${LOCAL_URI}>`);
    cancelHeaders.set('Call-ID', 'call-123@example.com');
    cancelHeaders.set('CSeq', '1 CANCEL');
    routeRequest(h, makeRequest('CANCEL', LOCAL_URI, cancelHeaders));

    await expect(answer).rejects.toMatchObject({ statusCode: 487 });
    expect(h.invitation.session.state).toBe('terminated');

    h.media.rejectPendingSetRemote('late media failure');
    await flush();

    expect(h.invitation.session.state).toBe('terminated');
    expect(h.recorded.filter((event) => event.state === 'terminated')).toHaveLength(1);
    expect(h.recorded.some((event) => event.state === 'failed')).toBe(false);
  });

  it('rejects answer once when a valid BYE arrives before ACK', async () => {
    const h = setup();
    const answer = h.invitation.answer(STUB_SDP);
    await flush();

    const byeHeaders = new Headers();
    byeHeaders.set('Via', 'SIP/2.0/UDP 192.0.2.1:5060;branch=z9hG4bK-bye-before-ack');
    byeHeaders.set('Max-Forwards', '70');
    byeHeaders.set('From', `<${REMOTE_URI}>;tag=alice-1`);
    byeHeaders.set('To', `<${LOCAL_URI}>;tag=${h.invitation.toTag}`);
    byeHeaders.set('Call-ID', 'call-123@example.com');
    byeHeaders.set('CSeq', '2 BYE');
    routeRequest(h, makeRequest('BYE', LOCAL_URI, byeHeaders));

    await expect(answer).rejects.toThrow('BYE received before ACK');
    expect(h.invitation.session.state).toBe('terminated');

    h.clock.advance(32000);
    expect(h.recorded.filter((event) => event.state === 'terminated')).toHaveLength(1);
    expect(h.recorded.some((event) => event.state === 'failed')).toBe(false);
  });

  it('keeps BYE first-wins when its 200 send re-entrantly delivers the matching ACK', async () => {
    const h = setup();
    const answer = h.invitation.answer(STUB_SDP);
    await flush();

    const captureSend = h.transport.onSend;
    let sentAck = false;
    h.transport.onSend = (bytes) => {
      captureSend?.(bytes);
      const parsed = parseMessage(bytes);
      if (sentAck
        || !parsed.ok
        || parsed.value.kind !== 'response'
        || parsed.value.statusCode !== 200
        || parsed.value.headers.get('CSeq') !== '2 BYE') return;
      sentAck = true;

      const ackHeaders = new Headers();
      ackHeaders.set('Via', 'SIP/2.0/UDP 192.0.2.1:5060;branch=z9hG4bK-ack-during-bye-200');
      ackHeaders.set('Max-Forwards', '70');
      ackHeaders.set('From', `<${REMOTE_URI}>;tag=alice-1`);
      ackHeaders.set('To', `<${LOCAL_URI}>;tag=${h.invitation.toTag}`);
      ackHeaders.set('Call-ID', 'call-123@example.com');
      ackHeaders.set('CSeq', '1 ACK');
      routeRequest(h, makeRequest('ACK', REMOTE_URI, ackHeaders));
    };

    const byeHeaders = new Headers();
    byeHeaders.set('Via', 'SIP/2.0/UDP 192.0.2.1:5060;branch=z9hG4bK-bye-before-reentrant-ack');
    byeHeaders.set('Max-Forwards', '70');
    byeHeaders.set('From', `<${REMOTE_URI}>;tag=alice-1`);
    byeHeaders.set('To', `<${LOCAL_URI}>;tag=${h.invitation.toTag}`);
    byeHeaders.set('Call-ID', 'call-123@example.com');
    byeHeaders.set('CSeq', '2 BYE');
    routeRequest(h, makeRequest('BYE', LOCAL_URI, byeHeaders));

    await expect(answer).rejects.toThrow('BYE received before ACK');
    const byeAcceptances = h.sent
      .map((bytes) => parseMessage(bytes))
      .filter((parsed) => parsed.ok
        && parsed.value.kind === 'response'
        && parsed.value.statusCode === 200
        && parsed.value.headers.get('CSeq') === '2 BYE');
    expect(byeAcceptances).toHaveLength(1);
    expect(h.invitation.session.state).toBe('terminated');
    expect(h.recorded.some((event) => event.state === 'confirmed')).toBe(false);
  });

  it('does not restart retransmission after a re-entrant BYE during the initial 200 send', async () => {
    const h = setup();
    const captureSend = h.transport.onSend;
    let sentBye = false;
    h.transport.onSend = (bytes) => {
      captureSend?.(bytes);
      const parsed = parseMessage(bytes);
      if (sentBye
        || !parsed.ok
        || parsed.value.kind !== 'response'
        || parsed.value.statusCode !== 200
        || parsed.value.headers.get('CSeq') !== '1 INVITE') return;
      sentBye = true;

      const byeHeaders = new Headers();
      byeHeaders.set('Via', 'SIP/2.0/UDP 192.0.2.1:5060;branch=z9hG4bK-bye-during-200');
      byeHeaders.set('Max-Forwards', '70');
      byeHeaders.set('From', `<${REMOTE_URI}>;tag=alice-1`);
      byeHeaders.set('To', `<${LOCAL_URI}>;tag=${h.invitation.toTag}`);
      byeHeaders.set('Call-ID', 'call-123@example.com');
      byeHeaders.set('CSeq', '2 BYE');
      routeRequest(h, makeRequest('BYE', LOCAL_URI, byeHeaders));
    };

    const answer = h.invitation.answer(STUB_SDP);
    await expect(answer).rejects.toThrow('BYE received before ACK');
    expect(h.invitation.session.state).toBe('terminated');

    h.clock.advance(32000);
    await flush();

    const inviteAcceptances = h.sent
      .map((bytes) => parseMessage(bytes))
      .filter((parsed) => parsed.ok
        && parsed.value.kind === 'response'
        && parsed.value.statusCode === 200
        && parsed.value.headers.get('CSeq') === '1 INVITE');
    expect(inviteAcceptances).toHaveLength(1);
    expect(h.invitation.session.state).toBe('terminated');
    expect(h.recorded.some((event) => event.state === 'failed')).toBe(false);
  });

  it('after confirmed, receives BYE, sends 200 OK → terminated', async () => {
    const h = setup();

    void h.invitation.answer(STUB_SDP);
    await flush();

    // Send ACK
    const ackHeaders = new Headers();
    ackHeaders.set('Via', 'SIP/2.0/UDP 192.0.2.1:5060;branch=z9hG4bK-ack-1');
    ackHeaders.set('Max-Forwards', '70');
    ackHeaders.set('From', `<${REMOTE_URI}>;tag=alice-1`);
    ackHeaders.set('To', `<${LOCAL_URI}>;tag=${h.invitation.toTag}`);
    ackHeaders.set('Call-ID', 'call-123@example.com');
    ackHeaders.set('CSeq', '1 ACK');

    const ack = makeRequest('ACK', REMOTE_URI, ackHeaders);
    routeRequest(h, ack);
    await flush();

    expect(h.invitation.session.state).toBe('confirmed');

    // A BYE cannot reuse the INVITE's remote CSeq.
    const replayHeaders = new Headers();
    replayHeaders.set('Via', 'SIP/2.0/UDP 192.0.2.1:5060;branch=z9hG4bK-bye-replay');
    replayHeaders.set('Max-Forwards', '70');
    replayHeaders.set('From', `<${REMOTE_URI}>;tag=alice-1`);
    replayHeaders.set('To', `<${LOCAL_URI}>;tag=${h.invitation.toTag}`);
    replayHeaders.set('Call-ID', 'call-123@example.com');
    replayHeaders.set('CSeq', '1 BYE');
    routeRequest(h, makeRequest('BYE', LOCAL_URI, replayHeaders));
    await flush();

    const replayResponse = h.sent
      .map((bytes) => parseMessage(bytes))
      .find((parsed) => parsed.ok
        && parsed.value.kind === 'response'
        && parsed.value.headers.get('CSeq') === '1 BYE');
    expect(replayResponse?.ok && replayResponse.value.kind === 'response'
      ? replayResponse.value.statusCode
      : undefined).toBe(481);
    expect(h.invitation.session.state).toBe('confirmed');

    // Receive BYE
    const byeHeaders = new Headers();
    byeHeaders.set('Via', 'SIP/2.0/UDP 192.0.2.1:5060;branch=z9hG4bK-bye-1');
    byeHeaders.set('Max-Forwards', '70');
    byeHeaders.set('From', `<${REMOTE_URI}>;tag=alice-1`);
    byeHeaders.set("To", `<${LOCAL_URI}>;tag=${h.invitation.toTag}`);
    byeHeaders.set('Call-ID', 'call-123@example.com');
    byeHeaders.set('CSeq', '2 BYE');

    const bye = makeRequest('BYE', LOCAL_URI, byeHeaders);
    routeRequest(h, bye);
    await flush();

    // 200 OK for BYE was sent
    const okList = okResponses(h.sent);
    expect(okList.length).toBeGreaterThanOrEqual(2); // 200 for INVITE + 200 for BYE
    const byeResponse = okList[okList.length - 1]!.msg;
    expect(byeResponse.statusCode).toBe(200);

    expect(h.invitation.session.state).toBe('terminated');
  });
});
