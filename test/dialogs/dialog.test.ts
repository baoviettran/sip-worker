import { describe, expect, it } from 'vitest';
import { Dialog } from '../../src/dialogs/index.js';
import type { IdGenerator } from '../../src/dialogs/index.js';
import { Headers, makeRequest, makeResponse, serializeMessage } from '../../src/messages/index.js';
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
  for (const record of records) headers.append('Record-Route', record);
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

  it('excludes Contact parameters from a bare Contact URI', () => {
    const response = make2xx();
    response.headers.set('Contact', 'sip:bob@host;expires=60');
    const dialog = Dialog.fromUac(makeInvite(), response, fakeIdGenerator());
    expect(dialog.remoteTarget).toBe('sip:bob@host');
  });

  it.each([
    ['expires', 'sip:bob@host ; expires = 60'],
    ['q', 'sip:bob@host ; q = 0.5'],
  ])('trims whitespace before a bare Contact %s parameter', (_parameter, contact) => {
    const response = make2xx();
    response.headers.set('Contact', contact);
    const dialog = Dialog.fromUac(makeInvite(), response, fakeIdGenerator());
    expect(dialog.remoteTarget).toBe('sip:bob@host');
  });

  it('retains URI parameters before a bare Contact header parameter', () => {
    const response = make2xx();
    response.headers.set('Contact', 'sip:bob@host;transport=tcp;expires=60');
    const dialog = Dialog.fromUac(makeInvite(), response, fakeIdGenerator());
    expect(dialog.remoteTarget).toBe('sip:bob@host;transport=tcp');
  });

  it('retains bracketed URI parameters before Contact header parameters', () => {
    const response = make2xx();
    response.headers.set('Contact', '<sip:bob@host;transport=tcp>;expires=60');
    const dialog = Dialog.fromUac(makeInvite(), response, fakeIdGenerator());
    expect(dialog.remoteTarget).toBe('sip:bob@host;transport=tcp');
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

  it('routes with header tags while ignoring quoted and URI tag decoys', () => {
    const dialog = Dialog.fromUac(makeInvite(), make2xx(), fakeIdGenerator());
    const validHeaders = new Headers();
    validHeaders.set('From', '<sip:bob@example.com;tag=uri-remote>;TaG=bob77');
    validHeaders.set('To', '<sip:alice@example.com;tag=uri-local>;TAG=alice9');
    validHeaders.set('Call-ID', 'abc123');
    validHeaders.set('CSeq', '1 BYE');
    const valid = makeRequest('BYE', 'sip:alice@example.com', validHeaders);
    expect(dialog.matchesRequest(valid)).toBe(true);

    const forgedHeaders = validHeaders.clone();
    forgedHeaders.set('From', '"Agent;tag=bob77;ignored" <sip:bob@example.com>');
    forgedHeaders.set('To', '<sip:alice@example.com>;tag=alice9');
    const forged = makeRequest('BYE', 'sip:alice@example.com', forgedHeaders);
    expect(dialog.matchesRequest(forged)).toBe(false);
  });
  it('uses the remote target and complete route set for loose routing', () => {
    // Repeated Record-Route fields [p1, p2] reverse to [p2, p1].
    const response = make2xx(['<sip:p1.example.com;lr>', '<sip:p2.example.com;lr>']);
    response.headers.set('Contact', 'sip:bob@192.0.2.5:5060');
    const dialog = Dialog.fromUac(makeInvite(), response, fakeIdGenerator());
    const bye = dialog.createRequest('BYE');
    expect(bye.uri).toBe('sip:bob@192.0.2.5:5060');
    expect(bye.headers.get('Route')).toBe('<sip:p2.example.com;lr>, <sip:p1.example.com;lr>');
    const wire = new TextDecoder().decode(serializeMessage(bye));
    expect(wire).toContain('Route: <sip:p2.example.com;lr>, <sip:p1.example.com;lr>\r\n');
  });

  it('keeps a quoted comma in a Record-Route display name out of list splitting', () => {
    const dialog = Dialog.fromUac(
      makeInvite(),
      make2xx(['"Edge, One" <sip:p1.example.com;lr>, <sip:p2.example.com;lr>']),
      fakeIdGenerator(),
    );
    const bye = dialog.createRequest('BYE');

    expect(bye.uri).toBe('sip:bob@192.0.2.5:5060');
    expect(bye.headers.get('Route')).toBe('<sip:p2.example.com;lr>, <sip:p1.example.com;lr>');
  });

  it('uses the first strict route and appends the remote target to the remaining routes', () => {
    // Record-Route [p2 loose, p1 strict] reversed => route set [p1 strict, p2 loose].
    // A strict router receives the request directly, with the remaining route
    // set entries followed by the remote target (RFC 3261 12.2.1.1).
    const dialog = Dialog.fromUac(
      makeInvite(),
      make2xx(['<sip:p2.example.com;lr>', '<sip:p1.example.com>']),
      fakeIdGenerator(),
    );
    const bye = dialog.createRequest('BYE');
    expect(bye.uri).toBe('sip:p1.example.com');
    expect(bye.headers.get('Route')).toBe(
      '<sip:p2.example.com;lr>, <sip:bob@192.0.2.5:5060>',
    );
    const wire = new TextDecoder().decode(serializeMessage(bye));
    expect(wire).toMatch(/^BYE sip:p1\.example\.com SIP\/2\.0\r\n/);
    expect(wire).toContain('Route: <sip:p2.example.com;lr>, <sip:bob@192.0.2.5:5060>\r\n');
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
