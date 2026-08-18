import { describe, expect, it } from 'vitest';
import { InviteClientTransaction } from '../../src/transactions/invite-client.js';
import { NonInviteClientTransaction } from '../../src/transactions/non-invite-client.js';
import { InviteServerTransaction } from '../../src/transactions/invite-server.js';
import { NonInviteServerTransaction } from '../../src/transactions/non-invite-server.js';
import { deriveTimers } from '../../src/transactions/timers.js';
import type { TransactionLayerEvent } from '../../src/transactions/types.js';
import type { SipRequestMessage, SipResponseMessage } from '../../src/messages/message.js';
import { Headers, makeRequest, makeResponse } from '../../src/messages/index.js';
import { FakeClock } from '../support/fake-clock.js';
import { FakeTransport } from '../support/fake-transport.js';

const TIMERS = deriveTimers({ T1: 500, T2: 4000, T4: 5000 }, true);

type Class = '1xx' | '2xx' | '3xx' | '4xx' | '5xx' | '6xx';
const CLASS_CODES: Record<Class, number> = { '1xx': 180, '2xx': 200, '3xx': 300, '4xx': 404, '5xx': 500, '6xx': 603 };

interface ClientCell { state: string; tu: number; sends: number }
interface ServerCell { state: string; sends: number }
type RejectCell = ServerCell & { rejected: true };

function makeRequestMsg(method: string): SipRequestMessage {
  return { kind: 'request', method, uri: 'sip:example.com', headers: new Headers(), body: new Uint8Array() };
}

function response(code: number, method: string): SipResponseMessage {
  const headers = new Headers();
  headers.set('CSeq', `1 ${method}`);
  return makeResponse(code, 'x', headers);
}

interface ClientFixture {
  tx: InviteClientTransaction | NonInviteClientTransaction;
  events: TransactionLayerEvent[];
  transport: FakeTransport;
}

function clientFixture(method: string): ClientFixture {
  const clock = new FakeClock();
  const transport = new FakeTransport({ reliable: true, framing: 'datagram' });
  void transport.connect();
  const events: TransactionLayerEvent[] = [];
  const tx = method === 'INVITE'
    ? new InviteClientTransaction({
        request: makeRequestMsg('INVITE'),
        key: 'branch|example.com:5060|INVITE',
        transport, clock, timers: TIMERS, reliable: true,
        emit: (e) => events.push(e),
        buildNon2xxAck: (req) => makeRequest('ACK', req.uri),
      })
    : new NonInviteClientTransaction({
        request: makeRequestMsg(method),
        key: `branch|example.com:5060|${method}`,
        transport, clock, timers: TIMERS, reliable: true,
        emit: (e) => events.push(e),
        buildNon2xxAck: (req) => makeRequest('ACK', req.uri),
      });
  return { tx, events, transport };
}

function runClient(f: ClientFixture, reach: Class | null, then: Class): ClientCell {
  f.tx.start();
  if (reach !== null) f.tx.receive(response(CLASS_CODES[reach], f.tx.request.method));
  const tuBefore = f.events.filter((e) => e.type === 'response').length;
  const sentBefore = f.transport.sent.length;
  f.tx.receive(response(CLASS_CODES[then], f.tx.request.method));
  return {
    state: f.tx.state,
    tu: f.events.filter((e) => e.type === 'response').length - tuBefore,
    sends: f.transport.sent.length - sentBefore,
  };
}

interface ServerFixture {
  tx: InviteServerTransaction | NonInviteServerTransaction;
  transport: FakeTransport;
}

function serverFixture(method: string): ServerFixture {
  const clock = new FakeClock();
  const transport = new FakeTransport({ reliable: true, framing: 'datagram' });
  void transport.connect();
  const tx = method === 'INVITE'
    ? new InviteServerTransaction({
        request: makeRequestMsg('INVITE'),
        key: 'branch|example.com:5060|INVITE',
        transport, clock, timers: TIMERS, reliable: true,
        emit: () => {},
      })
    : new NonInviteServerTransaction({
        request: makeRequestMsg(method),
        key: `branch|example.com:5060|${method}`,
        transport, clock, timers: TIMERS, reliable: true,
        emit: () => {},
      });
  return { tx, transport };
}

async function runInviteServer(reach: number | null, then: number): Promise<ServerCell> {
  const f = serverFixture('INVITE');
  f.tx.receiveRequest(f.tx.request);
  if (reach !== null) await f.tx.sendResponseAwait(response(reach, 'INVITE'));
  const sentBefore = f.transport.sent.length;
  await f.tx.sendResponseAwait(response(then, 'INVITE'));
  return { state: f.tx.state, sends: f.transport.sent.length - sentBefore };
}

async function runNonInviteServer(reach: number | null, then: number): Promise<ServerCell | RejectCell> {
  const f = serverFixture('OPTIONS');
  f.tx.receiveRequest(f.tx.request);
  if (reach !== null) await f.tx.sendResponseAwait(response(reach, 'OPTIONS'));
  const sentBefore = f.transport.sent.length;
  try {
    await f.tx.sendResponseAwait(response(then, 'OPTIONS'));
    return { state: f.tx.state, sends: f.transport.sent.length - sentBefore };
  } catch {
    return { rejected: true, state: f.tx.state, sends: f.transport.sent.length - sentBefore };
  }
}

const INVITE_CLIENT_MATRIX: [string, Class | null, Class, ClientCell][] = [
  ['Calling', null, '1xx', { state: 'Proceeding', tu: 1, sends: 0 }],
  ['Calling', null, '2xx', { state: 'Accepted', tu: 1, sends: 0 }],
  ['Calling', null, '3xx', { state: 'Completed', tu: 1, sends: 1 }],
  ['Calling', null, '4xx', { state: 'Completed', tu: 1, sends: 1 }],
  ['Calling', null, '5xx', { state: 'Completed', tu: 1, sends: 1 }],
  ['Calling', null, '6xx', { state: 'Completed', tu: 1, sends: 1 }],
  ['Proceeding', '1xx', '1xx', { state: 'Proceeding', tu: 1, sends: 0 }],
  ['Proceeding', '1xx', '2xx', { state: 'Accepted', tu: 1, sends: 0 }],
  ['Proceeding', '1xx', '3xx', { state: 'Completed', tu: 1, sends: 1 }],
  ['Proceeding', '1xx', '4xx', { state: 'Completed', tu: 1, sends: 1 }],
  ['Proceeding', '1xx', '5xx', { state: 'Completed', tu: 1, sends: 1 }],
  ['Proceeding', '1xx', '6xx', { state: 'Completed', tu: 1, sends: 1 }],
  ['Accepted', '2xx', '1xx', { state: 'Accepted', tu: 0, sends: 0 }],
  ['Accepted', '2xx', '2xx', { state: 'Accepted', tu: 1, sends: 0 }],
  ['Accepted', '2xx', '3xx', { state: 'Accepted', tu: 0, sends: 0 }],
  ['Accepted', '2xx', '4xx', { state: 'Accepted', tu: 0, sends: 0 }],
  ['Accepted', '2xx', '5xx', { state: 'Accepted', tu: 0, sends: 0 }],
  ['Accepted', '2xx', '6xx', { state: 'Accepted', tu: 0, sends: 0 }],
  ['Completed', '3xx', '1xx', { state: 'Completed', tu: 0, sends: 0 }],
  ['Completed', '3xx', '2xx', { state: 'Completed', tu: 0, sends: 0 }],
  ['Completed', '3xx', '3xx', { state: 'Completed', tu: 0, sends: 1 }],
  ['Completed', '3xx', '4xx', { state: 'Completed', tu: 0, sends: 1 }],
  ['Completed', '3xx', '5xx', { state: 'Completed', tu: 0, sends: 1 }],
  ['Completed', '3xx', '6xx', { state: 'Completed', tu: 0, sends: 1 }],
];

const NON_INVITE_CLIENT_MATRIX: [string, Class | null, Class, ClientCell][] = [
  ['Trying', null, '1xx', { state: 'Proceeding', tu: 1, sends: 0 }],
  ['Trying', null, '2xx', { state: 'Completed', tu: 1, sends: 0 }],
  ['Trying', null, '3xx', { state: 'Completed', tu: 1, sends: 0 }],
  ['Trying', null, '4xx', { state: 'Completed', tu: 1, sends: 0 }],
  ['Trying', null, '5xx', { state: 'Completed', tu: 1, sends: 0 }],
  ['Trying', null, '6xx', { state: 'Completed', tu: 1, sends: 0 }],
  ['Proceeding', '1xx', '1xx', { state: 'Proceeding', tu: 1, sends: 0 }],
  ['Proceeding', '1xx', '2xx', { state: 'Completed', tu: 1, sends: 0 }],
  ['Proceeding', '1xx', '3xx', { state: 'Completed', tu: 1, sends: 0 }],
  ['Proceeding', '1xx', '4xx', { state: 'Completed', tu: 1, sends: 0 }],
  ['Proceeding', '1xx', '5xx', { state: 'Completed', tu: 1, sends: 0 }],
  ['Proceeding', '1xx', '6xx', { state: 'Completed', tu: 1, sends: 0 }],
  ['Completed', '2xx', '1xx', { state: 'Completed', tu: 0, sends: 0 }],
  ['Completed', '2xx', '2xx', { state: 'Completed', tu: 0, sends: 0 }],
  ['Completed', '2xx', '3xx', { state: 'Completed', tu: 0, sends: 0 }],
  ['Completed', '2xx', '4xx', { state: 'Completed', tu: 0, sends: 0 }],
  ['Completed', '2xx', '5xx', { state: 'Completed', tu: 0, sends: 0 }],
  ['Completed', '2xx', '6xx', { state: 'Completed', tu: 0, sends: 0 }],
];

const INVITE_SERVER_MATRIX: [string, number | null, number, ServerCell][] = [
  ['Proceeding', null, 180, { state: 'Proceeding', sends: 1 }],
  ['Proceeding', null, 200, { state: 'Accepted', sends: 1 }],
  ['Proceeding', null, 300, { state: 'Completed', sends: 1 }],
  ['Proceeding', null, 404, { state: 'Completed', sends: 1 }],
  ['Accepted', 200, 180, { state: 'Accepted', sends: 0 }],
  ['Accepted', 200, 200, { state: 'Accepted', sends: 1 }],
  ['Accepted', 200, 300, { state: 'Accepted', sends: 0 }],
  ['Completed', 404, 100, { state: 'Completed', sends: 0 }],
  ['Completed', 404, 200, { state: 'Completed', sends: 0 }],
  ['Completed', 404, 300, { state: 'Completed', sends: 0 }],
];

const NON_INVITE_SERVER_MATRIX: [string, number | null, number, ServerCell | RejectCell][] = [
  ['Trying', null, 100, { state: 'Proceeding', sends: 1 }],
  ['Trying', null, 180, { rejected: true, state: 'Trying', sends: 0 }],
  ['Trying', null, 200, { state: 'Completed', sends: 1 }],
  ['Trying', null, 404, { state: 'Completed', sends: 1 }],
  ['Proceeding', 100, 100, { state: 'Proceeding', sends: 1 }],
  ['Proceeding', 100, 180, { rejected: true, state: 'Proceeding', sends: 0 }],
  ['Proceeding', 100, 200, { state: 'Completed', sends: 1 }],
  ['Completed', 200, 100, { state: 'Completed', sends: 0 }],
  ['Completed', 200, 180, { rejected: true, state: 'Completed', sends: 0 }],
  ['Completed', 200, 200, { state: 'Completed', sends: 0 }],
  ['Completed', 200, 404, { state: 'Completed', sends: 0 }],
];

describe('INVITE client — response matrix (RFC 3261 fig 5 / RFC 6026 §8.4)', () => {
  it.each(INVITE_CLIENT_MATRIX)('%s then %s -> %o', (_label, reach, then, want) => {
    expect(runClient(clientFixture('INVITE'), reach, then)).toEqual(want);
  });
});

describe('non-INVITE client — response matrix (RFC 3261 fig 6)', () => {
  it.each(NON_INVITE_CLIENT_MATRIX)('%s then %s -> %o', (_label, reach, then, want) => {
    expect(runClient(clientFixture('REGISTER'), reach, then)).toEqual(want);
  });
});

describe('INVITE server — TU-response matrix (RFC 3261 fig 7 / RFC 6026 §8.5-8.7)', () => {
  it.each(INVITE_SERVER_MATRIX)('%s then %s -> %o', async (_label, reach, then, want) => {
    expect(await runInviteServer(reach, then)).toEqual(want);
  });
});

describe('non-INVITE server — TU-response matrix (RFC 3261 fig 8 / RFC 4320 §4.1)', () => {
  it.each(NON_INVITE_SERVER_MATRIX)('%s then %s -> %o', async (_label, reach, then, want) => {
    expect(await runNonInviteServer(reach, then)).toEqual(want);
  });
});
