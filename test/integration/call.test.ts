import { describe, it, expect, beforeEach } from 'vitest';
import { UserAgent } from '../../src/ua/user-agent.js';
import { FakeTransport } from '../support/fake-transport.js';
import { FakeClock } from '../support/fake-clock.js';
import { MockRegistrar } from '../support/mock-registrar.js';
import { Headers } from '../../src/messages/headers.js';
import { makeRequest, makeResponse } from '../../src/messages/message.js';
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

function createInviteRequest() {
  const headers = new Headers();
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
  headers.set('Call-ID', 'incoming-call-1');
  headers.set('From', '<sip:bob@example.com>;tag=remote-tag');
  headers.set('To', `<sip:alice@example.com>;tag=${remoteTag}`);
  headers.set('CSeq', '1 ACK');
  return makeRequest('ACK', 'sip:alice@example.com', headers);
}

function createByeRequest(dialog: any) {
  const headers = new Headers();
  headers.set('Call-ID', 'incoming-call-1');
  headers.set('From', '<sip:bob@example.com>;tag=remote-tag');
  headers.set('To', `<sip:alice@example.com>;tag=${dialog.localTag}`);
  headers.set('CSeq', '2 BYE');
  return makeRequest('BYE', dialog.remoteTarget, headers);
}
