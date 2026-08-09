import { describe, it, expect, beforeEach } from 'vitest';
import { UserAgent } from '../../src/ua/user-agent.js';
import { FakeTransport } from '../support/fake-transport.js';
import { FakeClock } from '../support/fake-clock.js';
import { MockRegistrar } from '../support/mock-registrar.js';
import { Headers } from '../../src/messages/headers.js';
import { makeRequest, makeResponse } from '../../src/messages/message.js';
import type { SipRequestMessage } from '../../src/messages/message.js';
import { parseMessage } from '../../src/messages/parser.js';
import { serializeMessage } from '../../src/messages/serializer.js';
import { AuthManager } from '../../src/auth/manager.js';

describe('Full Call Integration', () => {
  let transport: FakeTransport;
  let clock: FakeClock;
  let registrar: MockRegistrar;
  let ua: UserAgent;
  let idGenerator: { branch: () => string };

  beforeEach(() => {
    transport = new FakeTransport({ reliable: true, framing: 'stream' });
    clock = new FakeClock();
    let branchCounter = 0;
    idGenerator = {
      branch: () => `branch-${++branchCounter}`,
    };
    const mediaController = {
      createOffer: async () => 'v=0\r\no=- 0 0 IN IP4 0.0.0.0\r\ns=-\r\nt=0 0\r\nm=audio 49170 RTP/AVP 0\r\n',
      createAnswer: async () => 'v=0\r\no=- 0 0 IN IP4 0.0.0.0\r\ns=-\r\nt=0 0\r\nm=audio 49170 RTP/AVP 0\r\n',
      setRemote: async () => {},
    } as any;
    const authManager = new AuthManager(idGenerator);
    ua = new UserAgent({
      transport,
      clock,
      registrarUri: 'sip:registrar.example.com',
      aor: 'sip:alice@example.com',
      contact: '<sip:alice@192.0.2.1:5060>',
      credentials: { username: 'alice', password: 'password123' },
      idGenerator,
      authManager,
      mediaController,
    });
    registrar = new MockRegistrar({ transport, challenge: true });
  });

  it('should complete outgoing call flow: register → invite → confirmed → bye', async () => {
    const states: string[] = [];
    ua.on('stateChanged', (event: any) => {
      states.push(event.state);
    });

    // Connect and register
    await ua.connect();
    registrar.start();
    await ua.register();
    expect(ua.registerState).toBe('registered');

    // Initiate outgoing call
    const invitePromise = ua.invite('sip:bob@example.com');

    // Wait for INVITE to be sent
    await waitForSentMessage(transport, 'INVITE');

    // Server sends 180 Ringing
    await sendRinging(transport);

    // Server sends 200 OK with SDP
    await send200Ok(transport);

    // Wait for invite to complete
    await invitePromise;
    expect(ua.callState).toBe('confirmed');

    // Hang up
    const byePromise = ua.bye();
    await waitForSentMessage(transport, 'BYE');
    await sendBye200(transport);
    await byePromise;

    expect(states).toEqual(['registered', 'inviting', 'ringing', 'confirmed', 'terminating', 'terminated']);
  });

  it('handles forked 2xx: first dialog selected, extra dialog ACKed with correct To tag then BYEd', async () => {
    const states: string[] = [];
    ua.on('stateChanged', (event: any) => {
      states.push(event.state);
    });

    await ua.connect();
    registrar.start();
    await ua.register();

    // Initiate outgoing call
    const invitePromise = ua.invite('sip:bob@example.com');
    await waitForSentMessage(transport, 'INVITE');

    // First fork sends 200 OK with To tag fork-a (becomes the selected dialog)
    await send200OkWithTag(transport, 'fork-a');
    await invitePromise;
    expect(ua.callState).toBe('confirmed');

    // Count ACKs/BYEs so far
    const acksBefore = countRequests(transport, 'ACK');
    const byesBefore = countRequests(transport, 'BYE');

    // Second fork sends 200 OK with a different To tag fork-b. This arrives
    // after the INVITE client transaction terminated, so it is a stateless
    // response routed through the DialogSet.
    await send200OkWithTag(transport, 'fork-b');
    // Allow the async onSuccess/handleSuccess + sendByeForDialog to run
    await waitForSentMessage(transport, 'BYE');
    await flush();

    // An ACK for fork-b was sent with the matching To tag
    const newAcks = sentRequests(transport, 'ACK').slice(acksBefore);
    expect(newAcks.length).toBe(1);
    expect(toTagOf(newAcks[0]!)).toBe('fork-b');

    // A BYE for fork-b was sent with the matching To tag
    const newByes = sentRequests(transport, 'BYE').slice(byesBefore);
    expect(newByes.length).toBe(1);
    expect(toTagOf(newByes[0]!)).toBe('fork-b');

    // Respond to the fork-b BYE with 200 so the cleanup completes
    await sendBye200For(transport, newByes[0]!);
    await flush();

    // The application dialog is still fork-a. Hang it up.
    const byePromise = ua.bye();
    await waitForSentMessage(transport, 'BYE');
    // The hangup BYE targets fork-a
    const hangupBye = sentRequests(transport, 'BYE').slice(-1)[0]!;
    expect(toTagOf(hangupBye)).toBe('fork-a');
    await sendBye200For(transport, hangupBye);
    await byePromise;
    // Session reached terminated (ua.bye() clears the active inviter, so
    // callState returns 'idle'; verify via the emitted state trace).
    expect(states).toContain('terminated');
  });

  it('should handle incoming call flow: invite → answer → bye', async () => {
    const incomingCalls: any[] = [];
    ua.on('incomingCall', (event: any) => {
      incomingCalls.push(event);
    });

    await ua.connect();
    registrar.start();
    await ua.register();

    // Server sends INVITE
    const inviteRequest = createInviteRequest();
    transport.emitData(serializeMessage(inviteRequest));

    // Wait for incoming call event
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(incomingCalls.length).toBe(1);

    const invitation = incomingCalls[0];
    const answerPromise = invitation.answer('v=0\r\no=- 0 0 IN IP4 0.0.0.0\r\ns=-\r\nt=0 0\r\nm=audio 49170 RTP/AVP 0\r\n');

    // Wait for 200 OK to be sent (answer() is async)
    await waitForSentResponse(transport, 200);

    // Verify 200 OK was sent
    const sentMessages = transport.sent.map(bytes => parseMessage(bytes));
    const responses = sentMessages.filter(m => m.ok && m.value.kind === 'response');
    expect(responses.some(r => r.ok && r.value.kind === 'response' && r.value.statusCode === 200)).toBe(true);

    // Server sends ACK
    const ackRequest = createAckRequest(invitation.dialog.localTag);
    transport.emitData(serializeMessage(ackRequest));

    await answerPromise;
    expect(invitation.session.state).toBe('confirmed');

    // Server sends BYE
    const byeRequest = createByeRequest(invitation.dialog);
    transport.emitData(serializeMessage(byeRequest));

    // Verify 200 OK for BYE was sent
    await new Promise(resolve => setTimeout(resolve, 0));
    const byeResponses = transport.sent
      .map(bytes => parseMessage(bytes))
      .filter(m => m.ok && m.value.kind === 'response' && m.value.headers.get('CSeq')?.includes('BYE'));
    expect(byeResponses.some(r => r.ok && r.value.kind === 'response' && r.value.statusCode === 200)).toBe(true);

    expect(invitation.session.state).toBe('terminated');
  });

  it('routes a BYE to its incoming dialog while an outgoing dialog remains active', async () => {
    const incomingCalls: any[] = [];
    ua.on('incomingCall', (invitation: any) => {
      incomingCalls.push(invitation);
    });

    await ua.connect();

    const outgoing = ua.invite('sip:carol@example.com');
    await waitForSentMessage(transport, 'INVITE');
    await send200Ok(transport);
    await outgoing;

    transport.emitData(serializeMessage(createInviteRequest()));
    await flush();
    expect(incomingCalls).toHaveLength(1);

    const invitation = incomingCalls[0]!;
    const answer = invitation.answer('v=0\r\no=- 0 0 IN IP4 0.0.0.0\r\ns=-\r\nt=0 0\r\nm=audio 49170 RTP/AVP 0\r\n');
    await flush();
    transport.emitData(serializeMessage(createAckRequest(invitation.dialog.localTag)));
    await answer;

    const bye = createByeRequest(invitation.dialog);
    transport.emitData(serializeMessage(bye));
    await flush();

    const statuses = transport.sent
      .map((bytes) => parseMessage(bytes))
      .filter((parsed) => parsed.ok && parsed.value.kind === 'response' && parsed.value.headers.get('CSeq') === '2 BYE')
      .map((parsed) => parsed.ok && parsed.value.kind === 'response' ? parsed.value.statusCode : 0);
    expect(statuses).toEqual([200]);
    expect(invitation.session.state).toBe('terminated');
    expect(ua.callState).toBe('confirmed');
  });

  it('accepts a matching CANCEL and terminates the pending incoming invitation', async () => {
    const incomingCalls: any[] = [];
    ua.on('incomingCall', (invitation: any) => {
      incomingCalls.push(invitation);
    });

    await ua.connect();
    transport.emitData(serializeMessage(createInviteRequest()));
    await flush();
    expect(incomingCalls).toHaveLength(1);

    transport.emitData(serializeMessage(createCancelRequest()));
    await flush();

    const responses = transport.sent
      .map((bytes) => parseMessage(bytes))
      .filter((parsed) => parsed.ok && parsed.value.kind === 'response')
      .map((parsed) => parsed.ok && parsed.value.kind === 'response'
        ? [parsed.value.statusCode, parsed.value.headers.get('CSeq')]
        : [0, undefined]);
    expect(responses).toContainEqual([200, '1 CANCEL']);
    expect(responses).toContainEqual([487, '1 INVITE']);
    expect(incomingCalls[0]!.session.state).toBe('terminated');
  });

  it('reuses an accepted Invitation for a duplicate INVITE on a new transaction', async () => {
    const incomingCalls: any[] = [];
    ua.on('incomingCall', (invitation: any) => {
      incomingCalls.push(invitation);
    });

    await ua.connect();
    transport.emitData(serializeMessage(createInviteRequest()));
    await flush();
    const invitation = incomingCalls[0]!;
    const answer = invitation.answer('v=0\r\no=- 0 0 IN IP4 0.0.0.0\r\ns=-\r\nt=0 0\r\nm=audio 49170 RTP/AVP 0\r\n');
    await flush();

    transport.emitData(serializeMessage(createInviteRequest('incoming-duplicate')));
    await flush();

    const accepted = transport.sent
      .map((bytes) => parseMessage(bytes))
      .filter((parsed) => parsed.ok
        && parsed.value.kind === 'response'
        && parsed.value.statusCode === 200
        && parsed.value.headers.get('CSeq') === '1 INVITE');
    expect(incomingCalls).toHaveLength(1);
    expect(accepted).toHaveLength(2);
    expect(accepted[1]!.ok && accepted[1]!.value.kind === 'response'
      ? accepted[1]!.value.headers.get('To')
      : undefined).toContain(`tag=${invitation.toTag}`);

    transport.emitData(serializeMessage(createAckRequest(invitation.toTag)));
    await answer;
  });

  it('rejects wrong-tag and replayed BYEs around a valid outgoing-dialog BYE', async () => {
    await ua.connect();
    const outgoing = ua.invite('sip:bob@example.com');
    await waitForSentMessage(transport, 'INVITE');
    await send200Ok(transport);
    await outgoing;

    transport.emitData(serializeMessage(createOutgoingBye(transport, 'wrong-tag', 'mallory')));
    await flush();
    expect(ua.callState).toBe('confirmed');

    transport.emitData(serializeMessage(createOutgoingBye(transport, 'valid')));
    await flush();
    expect(ua.callState).toBe('idle');

    transport.emitData(serializeMessage(createOutgoingBye(transport, 'replay')));
    await flush();

    const statuses = transport.sent
      .map((bytes) => parseMessage(bytes))
      .filter((parsed) => parsed.ok
        && parsed.value.kind === 'response'
        && parsed.value.headers.get('CSeq') === '1 BYE')
      .map((parsed) => parsed.ok && parsed.value.kind === 'response' ? parsed.value.statusCode : 0);
    expect(statuses).toEqual([481, 200, 481]);
  });
});

async function waitForSentMessage(transport: FakeTransport, method: string): Promise<void> {
  while (true) {
    for (const bytes of transport.sent) {
      const parsed = parseMessage(bytes);
      if (parsed.ok && parsed.value.kind === 'request' && parsed.value.method === method) {
        return;
      }
    }
    await new Promise(resolve => setTimeout(resolve, 1));
  }
}

async function waitForSentResponse(transport: FakeTransport, statusCode: number): Promise<void> {
  while (true) {
    for (const bytes of transport.sent) {
      const parsed = parseMessage(bytes);
      if (parsed.ok && parsed.value.kind === 'response' && parsed.value.statusCode === statusCode) {
        return;
      }
    }
    await new Promise(resolve => setTimeout(resolve, 1));
  }
}

async function sendRinging(transport: FakeTransport): Promise<void> {
  const inviteBytes = transport.sent.find(bytes => {
    const parsed = parseMessage(bytes);
    return parsed.ok && parsed.value.kind === 'request' && parsed.value.method === 'INVITE';
  });
  if (!inviteBytes) throw new Error('No INVITE found');

  const invite = parseMessage(inviteBytes);
  if (!invite.ok || invite.value.kind !== 'request') throw new Error('Invalid INVITE');

  const headers = new Headers();
  headers.set('Via', invite.value.headers.get('Via') ?? '');
  headers.set('From', invite.value.headers.get('From') ?? '');
  headers.set('To', (invite.value.headers.get('To') ?? '') + ';tag=remote-tag');
  headers.set('Call-ID', invite.value.headers.get('Call-ID') ?? '');
  headers.set('CSeq', invite.value.headers.get('CSeq') ?? '');
  headers.set('Contact', '<sip:bob@192.0.2.2:5060>');

  const response = makeResponse(180, 'Ringing', headers);
  transport.emitData(serializeMessage(response));
}

async function send200Ok(transport: FakeTransport): Promise<void> {
  const inviteBytes = transport.sent.find(bytes => {
    const parsed = parseMessage(bytes);
    return parsed.ok && parsed.value.kind === 'request' && parsed.value.method === 'INVITE';
  });
  if (!inviteBytes) throw new Error('No INVITE found');

  const invite = parseMessage(inviteBytes);
  if (!invite.ok || invite.value.kind !== 'request') throw new Error('Invalid INVITE');

  const headers = new Headers();
  headers.set('Via', invite.value.headers.get('Via') ?? '');
  headers.set('From', invite.value.headers.get('From') ?? '');
  headers.set('To', (invite.value.headers.get('To') ?? '') + ';tag=remote-tag');
  headers.set('Call-ID', invite.value.headers.get('Call-ID') ?? '');
  headers.set('CSeq', invite.value.headers.get('CSeq') ?? '');
  headers.set('Contact', '<sip:bob@192.0.2.2:5060>');
  headers.set('Content-Type', 'application/sdp');

  const body = new TextEncoder().encode('v=0\r\no=- 0 0 IN IP4 0.0.0.0\r\ns=-\r\nt=0 0\r\nm=audio 49170 RTP/AVP 0\r\n');
  const response = makeResponse(200, 'OK', headers, body);
  transport.emitData(serializeMessage(response));
}

async function sendBye200(transport: FakeTransport): Promise<void> {
  const byeBytes = transport.sent.find(bytes => {
    const parsed = parseMessage(bytes);
    return parsed.ok && parsed.value.kind === 'request' && parsed.value.method === 'BYE';
  });
  if (!byeBytes) throw new Error('No BYE found');

  const bye = parseMessage(byeBytes);
  if (!bye.ok || bye.value.kind !== 'request') throw new Error('Invalid BYE');

  const headers = new Headers();
  headers.set('Via', bye.value.headers.get('Via') ?? '');
  headers.set('From', bye.value.headers.get('From') ?? '');
  headers.set('To', bye.value.headers.get('To') ?? '');
  headers.set('Call-ID', bye.value.headers.get('Call-ID') ?? '');
  headers.set('CSeq', bye.value.headers.get('CSeq') ?? '');

  const response = makeResponse(200, 'OK', headers);
  transport.emitData(serializeMessage(response));
}

function createInviteRequest(branch = 'incoming') {
  const headers = new Headers();
  headers.set('Via', `SIP/2.0/UDP 192.0.2.2:5060;branch=z9hG4bK-${branch}`);
  headers.set('Call-ID', 'incoming-call-1');
  headers.set('From', '<sip:bob@example.com>;tag=remote-tag');
  headers.set('To', '<sip:alice@example.com>');
  headers.set('CSeq', '1 INVITE');
  headers.set('Contact', '<sip:bob@192.0.2.2:5060>');
  headers.set('Content-Type', 'application/sdp');
  const body = new TextEncoder().encode('v=0\r\no=- 0 0 IN IP4 0.0.0.0\r\ns=-\r\nt=0 0\r\nm=audio 49170 RTP/AVP 0\r\n');
  return makeRequest('INVITE', 'sip:alice@example.com', headers, body);
}

function createAckRequest(remoteTag: string) {
  const headers = new Headers();
  headers.set('Via', 'SIP/2.0/UDP 192.0.2.2:5060;branch=z9hG4bK-incoming');
  headers.set('Call-ID', 'incoming-call-1');
  headers.set('From', '<sip:bob@example.com>;tag=remote-tag');
  headers.set('To', `<sip:alice@example.com>;tag=${remoteTag}`);
  headers.set('CSeq', '1 ACK');
  return makeRequest('ACK', 'sip:alice@example.com', headers);
}

function createCancelRequest() {
  const headers = new Headers();
  headers.set('Via', 'SIP/2.0/UDP 192.0.2.2:5060;branch=z9hG4bK-incoming');
  headers.set('Call-ID', 'incoming-call-1');
  headers.set('From', '<sip:bob@example.com>;tag=remote-tag');
  headers.set('To', '<sip:alice@example.com>');
  headers.set('CSeq', '1 CANCEL');
  return makeRequest('CANCEL', 'sip:alice@example.com', headers);
}

function createOutgoingBye(transport: FakeTransport, branch: string, remoteTag = 'remote-tag') {
  const invite = sentRequests(transport, 'INVITE')[0]!;
  const headers = new Headers();
  headers.set('Via', `SIP/2.0/UDP 192.0.2.2:5060;branch=z9hG4bK-${branch}`);
  headers.set('Call-ID', invite.headers.get('Call-ID') ?? '');
  headers.set('From', `${invite.headers.get('To') ?? '<sip:bob@example.com>'};tag=${remoteTag}`);
  headers.set('To', invite.headers.get('From') ?? '');
  headers.set('CSeq', '1 BYE');
  return makeRequest('BYE', 'sip:alice@example.com', headers);
}

function createByeRequest(dialog: any) {
  const headers = new Headers();
  headers.set('Via', 'SIP/2.0/UDP 192.0.2.2:5060;branch=z9hG4bK-incoming-bye');
  headers.set('Call-ID', 'incoming-call-1');
  headers.set('From', '<sip:bob@example.com>;tag=remote-tag');
  headers.set('To', `<sip:alice@example.com>;tag=${dialog.localTag}`);
  headers.set('CSeq', '2 BYE');
  return makeRequest('BYE', dialog.remoteTarget, headers);
}

/** Resolve pending microtasks/timers. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** All sent requests of a given method, parsed. */
function sentRequests(transport: FakeTransport, method: string): SipRequestMessage[] {
  const out: SipRequestMessage[] = [];
  for (const bytes of transport.sent) {
    const parsed = parseMessage(bytes);
    if (parsed.ok && parsed.value.kind === 'request' && parsed.value.method === method) {
      out.push(parsed.value);
    }
  }
  return out;
}

/** Count sent requests of a given method. */
function countRequests(transport: FakeTransport, method: string): number {
  return sentRequests(transport, method).length;
}

/** Extract the To-tag from a request. */
function toTagOf(request: SipRequestMessage): string | undefined {
  const to = request.headers.get('To');
  if (!to) return undefined;
  const match = to.match(/;tag=([^;,\s]+)/);
  return match?.[1];
}

/**
 * Deliver a 200 OK to the INVITE with a specific To tag (for fork scenarios).
 * Reuses the sent INVITE's headers so the transaction layer matches the Via.
 */
async function send200OkWithTag(transport: FakeTransport, toTag: string): Promise<void> {
  const inviteBytes = transport.sent.find(bytes => {
    const parsed = parseMessage(bytes);
    return parsed.ok && parsed.value.kind === 'request' && parsed.value.method === 'INVITE';
  });
  if (!inviteBytes) throw new Error('No INVITE found');
  const invite = parseMessage(inviteBytes);
  if (!invite.ok || invite.value.kind !== 'request') throw new Error('Invalid INVITE');

  const headers = new Headers();
  headers.set('Via', invite.value.headers.get('Via') ?? '');
  headers.set('From', invite.value.headers.get('From') ?? '');
  headers.set('To', (invite.value.headers.get('To') ?? '') + `;tag=${toTag}`);
  headers.set('Call-ID', invite.value.headers.get('Call-ID') ?? '');
  headers.set('CSeq', invite.value.headers.get('CSeq') ?? '');
  headers.set('Contact', '<sip:bob@192.0.2.2:5060>');
  headers.set('Content-Type', 'application/sdp');

  const body = new TextEncoder().encode('v=0\r\no=- 0 0 IN IP4 0.0.0.0\r\ns=-\r\nt=0 0\r\nm=audio 49170 RTP/AVP 0\r\n');
  const response = makeResponse(200, 'OK', headers, body);
  transport.emitData(serializeMessage(response));
}

/**
 * Respond 200 OK to a specific BYE request (identified by its Via/CSeq/Call-ID).
 */
async function sendBye200For(transport: FakeTransport, bye: SipRequestMessage): Promise<void> {
  const headers = new Headers();
  headers.set('Via', bye.headers.get('Via') ?? '');
  headers.set('From', bye.headers.get('From') ?? '');
  headers.set('To', bye.headers.get('To') ?? '');
  headers.set('Call-ID', bye.headers.get('Call-ID') ?? '');
  headers.set('CSeq', bye.headers.get('CSeq') ?? '');

  const response = makeResponse(200, 'OK', headers);
  transport.emitData(serializeMessage(response));
}
