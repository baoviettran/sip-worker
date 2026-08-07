import { describe, expect, it } from 'vitest';
import { Dialog } from '../../src/dialogs/index.js';
import type { IdGenerator } from '../../src/dialogs/index.js';
import { Headers, makeRequest, makeResponse } from '../../src/messages/index.js';
import type { SipRequestMessage, SipResponseMessage } from '../../src/messages/message.js';

function topBranch(request: SipRequestMessage): string | undefined {
  return request.headers.get('Via')?.match(/;branch=([^;]+)/)?.[1];
}

function makeInvite(): SipRequestMessage {
  const headers = new Headers();
  headers.set('Via', 'SIP/2.0/UDP 192.0.2.1:5060;branch=z9hG4bK-invite');
  headers.set('From', '<sip:alice@example.com>;tag=alice9');
  headers.set('To', '<sip:bob@example.com>');
  headers.set('Call-ID', 'abc123');
  headers.set('CSeq', '41 INVITE');
  headers.set('Max-Forwards', '70');
  return makeRequest('INVITE', 'sip:bob@example.com', headers);
}

function make2xx(records: string[] = []): SipResponseMessage {
  const headers = new Headers();
  headers.set('Via', 'SIP/2.0/UDP 192.0.2.1:5060;branch=z9hG4bK-invite');
  headers.set('From', '<sip:alice@example.com>;tag=alice9');
  headers.set('To', '<sip:bob@example.com>;tag=bob77');
  headers.set('Call-ID', 'abc123');
  headers.set('CSeq', '41 INVITE');
  headers.set('Contact', '<sip:bob@192.0.2.5:5060>');
  if (records.length > 0) headers.set('Record-Route', records.join(', '));
  return makeResponse(200, 'OK', headers);
}

function fakeIdGenerator(): IdGenerator {
  let n = 0;
  return { branch: () => `ack-${++n}` };
}

function requestWithCSeq(method: string, number: number): SipRequestMessage {
  const headers = new Headers();
  headers.set('From', '<sip:alice@example.com>;tag=alice9');
  headers.set('To', '<sip:bob@example.com>;tag=bob77');
  headers.set('Call-ID', 'abc123');
  headers.set('CSeq', `${number} ${method}`);
  return makeRequest(method, 'sip:bob@example.com', headers);
}

describe('Dialog.fromUac', () => {
  it('reads the remote tag from To and the local tag from From', () => {
    const dialog = Dialog.fromUac(makeInvite(), make2xx(), fakeIdGenerator());
    expect(dialog.remoteTag).toBe('bob77');
    expect(dialog.localTag).toBe('alice9');
  });

  it('reads the remote target from the Contact header', () => {
    const dialog = Dialog.fromUac(makeInvite(), make2xx(), fakeIdGenerator());
    expect(dialog.remoteTarget).toBe('sip:bob@192.0.2.5:5060');
  });

  it('extracts the URI contact with a trailing URI parameter (delegates to extractUri)', () => {
    const response = make2xx();
    response.headers.set('Contact', '<sip:bob@192.0.2.5:5060>;expires=60');
    const dialog = Dialog.fromUac(makeInvite(), response, fakeIdGenerator());
    expect(dialog.remoteTarget).toBe('sip:bob@192.0.2.5:5060');
  });

  it('falls back to the request URI when Contact is absent', () => {
    const headers = new Headers();
    headers.set('Via', 'SIP/2.0/UDP 192.0.2.1:5060;branch=z9hG4bK-invite');
    headers.set('From', '<sip:alice@example.com>;tag=alice9');
    headers.set('To', '<sip:bob@example.com>;tag=bob77');
    headers.set('Call-ID', 'abc123');
    headers.set('CSeq', '41 INVITE');
    const noContact = makeResponse(200, 'OK', headers);
    const dialog = Dialog.fromUac(makeInvite(), noContact, fakeIdGenerator());
    expect(dialog.remoteTarget).toBe('sip:bob@example.com');
  });

  it('keeps the UAC route set as the reversed Record-Route order', () => {
    const dialog = Dialog.fromUac(
      makeInvite(),
      make2xx(['<sip:p1.example.com;lr>', '<sip:p2.example.com;lr>']),
      fakeIdGenerator(),
    );
    expect(dialog.routeSet).toEqual(['sip:p2.example.com;lr', 'sip:p1.example.com;lr']);
  });

  it('keeps the call id and the numeric CSeq from the INVITE', () => {
    const dialog = Dialog.fromUac(makeInvite(), make2xx(), fakeIdGenerator());
    expect(dialog.callId).toBe('abc123');
    expect(dialog.getLocalCSeq()).toBe(41);
  });
});

describe('dialog routing', () => {
  it('routes loose-routing requests through the first route with the rest in Route', () => {
    const dialog = Dialog.fromUac(
      makeInvite(),
      make2xx(['<sip:p1.example.com;lr>', '<sip:p2.example.com;lr>']),
      fakeIdGenerator(),
    );
    const bye = dialog.createRequest('BYE');
    expect(bye.uri).toBe('sip:p2.example.com;lr');
    expect(bye.headers.get('Route')).toBe('sip:p1.example.com;lr');
  });

  it('does not append the target to Route for a loose first route', () => {
    // Record-Route [p1 strict, p2 loose] reversed => route set [p2 loose, p1 strict].
    // The first entry is loose, so the request targets it directly and the
    // remaining entries go in Route without appending the remote target.
    const dialog = Dialog.fromUac(
      makeInvite(),
      make2xx(['<sip:p1.example.com>', '<sip:p2.example.com;lr>']),
      fakeIdGenerator(),
    );
    const bye = dialog.createRequest('BYE');
    expect(bye.uri).toBe('sip:p2.example.com;lr');
    expect(bye.headers.get('Route')).toBe('sip:p1.example.com');
  });

  it('appends the target to Route for a strict first route', () => {
    // Record-Route [p2 loose, p1 strict] reversed => route set [p1 strict, p2 loose].
    // The first entry is strict, so the request is addressed to the remote
    // target and the whole route set is kept in Route with the target appended
    // as the last value (RFC 3261 12.2.1.1).
    const dialog = Dialog.fromUac(
      makeInvite(),
      make2xx(['<sip:p2.example.com;lr>', '<sip:p1.example.com>']),
      fakeIdGenerator(),
    );
    const bye = dialog.createRequest('BYE');
    expect(bye.uri).toBe('sip:bob@192.0.2.5:5060');
    expect(bye.headers.get('Route')).toBe(
      'sip:p1.example.com, sip:p2.example.com;lr, sip:bob@192.0.2.5:5060',
    );
  });

  it('uses the remote target directly when the route set is empty', () => {
    const dialog = Dialog.fromUac(makeInvite(), make2xx(), fakeIdGenerator());
    const bye = dialog.createRequest('BYE');
    expect(bye.uri).toBe('sip:bob@192.0.2.5:5060');
    expect(bye.headers.has('Route')).toBe(false);
  });
});

describe('createAck', () => {
  it('uses the INVITE numeric CSeq with method ACK and does not mutate localCSeq', () => {
    const dialog = Dialog.fromUac(makeInvite(), make2xx(), fakeIdGenerator());
    const ack = dialog.createAck(make2xx());
    expect(ack.headers.get('CSeq')).toBe('41 ACK');
    expect(dialog.getLocalCSeq()).toBe(41);
  });

  it('mints a fresh Via branch different from the INVITE branch', () => {
    const dialog = Dialog.fromUac(makeInvite(), make2xx(), fakeIdGenerator());
    const ack = dialog.createAck(make2xx());
    expect(topBranch(ack)).toBe('z9hG4bK-ack-1');
    expect(topBranch(ack)).not.toBe(topBranch(makeInvite()));
  });

  it('carries From/To tags, Call-ID, and Max-Forwards', () => {
    const dialog = Dialog.fromUac(makeInvite(), make2xx(), fakeIdGenerator());
    const ack = dialog.createAck(make2xx());
    expect(ack.headers.get('From')).toBe('<sip:alice@example.com>;tag=alice9');
    expect(ack.headers.get('To')).toBe('<sip:bob@example.com>;tag=bob77');
    expect(ack.headers.get('Call-ID')).toBe('abc123');
    expect(ack.headers.get('Max-Forwards')).toBe('70');
  });
});

describe('createRequest (BYE)', () => {
  it('increments localCSeq exactly once before constructing the request', () => {
    const dialog = Dialog.fromUac(makeInvite(), make2xx(), fakeIdGenerator());
    const bye = dialog.createRequest('BYE');
    expect(bye.headers.get('CSeq')).toBe('42 BYE');
    expect(dialog.getLocalCSeq()).toBe(42);
    const bye2 = dialog.createRequest('BYE');
    expect(bye2.headers.get('CSeq')).toBe('43 BYE');
    expect(dialog.getLocalCSeq()).toBe(43);
  });

  it('carries dialog tags, Call-ID, and Max-Forwards', () => {
    const dialog = Dialog.fromUac(makeInvite(), make2xx(), fakeIdGenerator());
    const bye = dialog.createRequest('BYE');
    expect(bye.headers.get('From')).toBe('<sip:alice@example.com>;tag=alice9');
    expect(bye.headers.get('To')).toBe('<sip:bob@example.com>;tag=bob77');
    expect(bye.headers.get('Call-ID')).toBe('abc123');
    expect(bye.headers.get('Max-Forwards')).toBe('70');
  });
});

describe('receiveRequest', () => {
  it('accepts increasing remote CSeq values and rejects lower or equal ones', () => {
    const dialog = Dialog.fromUac(makeInvite(), make2xx(), fakeIdGenerator());
    expect(dialog.receiveRequest(requestWithCSeq('BYE', 1))).toBe(true);
    expect(dialog.getRemoteCSeq()).toBe(1);
    expect(dialog.receiveRequest(requestWithCSeq('BYE', 1))).toBe(false);
    expect(dialog.receiveRequest(requestWithCSeq('BYE', 0))).toBe(false);
    expect(dialog.receiveRequest(requestWithCSeq('BYE', 2))).toBe(true);
    expect(dialog.getRemoteCSeq()).toBe(2);
  });

  it('does not reject ACK or CANCEL based on CSeq', () => {
    const dialog = Dialog.fromUac(makeInvite(), make2xx(), fakeIdGenerator());
    expect(dialog.receiveRequest(requestWithCSeq('ACK', 1))).toBe(true);
    expect(dialog.receiveRequest(requestWithCSeq('CANCEL', 1))).toBe(true);
    expect(dialog.getRemoteCSeq()).toBe(0);
  });
});
