import { describe, expect, it } from 'vitest';
import { buildNon2xxAck } from '../../src/transactions/index.js';
import type { SipRequestMessage, SipResponseMessage } from '../../src/messages/message.js';
import { Headers, makeRequest, makeResponse } from '../../src/messages/index.js';

function topBranch(request: SipRequestMessage): string | undefined {
  return request.headers.get('Via')?.match(/;branch=([^;]+)/)?.[1];
}

function makeInvite(): SipRequestMessage {
  const headers = new Headers();
  headers.set('Via', 'SIP/2.0/UDP 192.0.2.1:5060;branch=z9hG4bK-abc');
  headers.set('From', '<sip:alice@example.com>');
  headers.set('To', '<sip:bob@example.com>');
  headers.set('Call-ID', 'abc123');
  headers.set('CSeq', '41 INVITE');
  headers.set('Max-Forwards', '70');
  headers.set('Route', '<sip:proxy.example.com>');
  headers.set('Content-Type', 'application/sdp');
  return makeRequest('INVITE', 'sip:bob@example.com', headers, new Uint8Array([1, 2, 3]));
}

function makeResponse486(): SipResponseMessage {
  const headers = new Headers();
  headers.set('Via', 'SIP/2.0/UDP 192.0.2.1:5060;branch=z9hG4bK-abc');
  headers.set('From', '<sip:alice@example.com>');
  headers.set('To', '<sip:bob@example.com>;tag=server9');
  headers.set('Call-ID', 'abc123');
  headers.set('CSeq', '41 INVITE');
  return makeResponse(486, 'Busy Here', headers);
}

describe('buildNon2xxAck', () => {
  it('builds transaction ACK with original branch and numeric CSeq', () => {
    const accept = buildNon2xxAck(makeInvite(), makeResponse486());
    expect(accept.method).toBe('ACK');
    expect(topBranch(accept)).toBe('z9hG4bK-abc');
    expect(accept.headers.get('CSeq')).toBe('41 ACK');
    expect(accept.headers.get('To')).toBe('<sip:bob@example.com>;tag=server9');
  });

  it('copies request URI, top Via, Route, From, Call-ID, Max-Forwards', () => {
    const invite = makeInvite();
    const ack = buildNon2xxAck(invite, makeResponse486());
    expect(ack.uri).toBe('sip:bob@example.com');
    expect(ack.headers.get('Via')).toBe(invite.headers.get('Via'));
    expect(ack.headers.get('Route')).toBe(invite.headers.get('Route'));
    expect(ack.headers.get('From')).toBe(invite.headers.get('From'));
    expect(ack.headers.get('Call-ID')).toBe('abc123');
    expect(ack.headers.get('Max-Forwards')).toBe('70');
  });

  it('drops the body and content headers', () => {
    const ack = buildNon2xxAck(makeInvite(), makeResponse486());
    expect(ack.body.length).toBe(0);
    expect(ack.headers.has('Content-Type')).toBe(false);
    expect(ack.headers.has('Content-Length')).toBe(false);
  });
});
