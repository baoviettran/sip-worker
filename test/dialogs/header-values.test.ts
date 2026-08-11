import { describe, expect, it } from 'vitest';
import { extractTag } from '../../src/dialogs/header-values.js';
import { Headers, makeRequest, makeResponse } from '../../src/messages/index.js';
import { responseMatchesRequestIdentity } from '../../src/ua/response-identity.js';

describe('extractTag', () => {
  it.each([
    ['normal header parameter', '<sip:alice@example.com>;tag=normal', 'normal'],
    ['case-insensitive name', '<sip:alice@example.com>;TaG=MiXeD', 'MiXeD'],
    ['quoted display-name decoy', '"Agent;tag=fake;ignored" <sip:alice@example.com>;tag=real', 'real'],
    ['URI parameter only', '<sip:alice@example.com;tag=uri>', undefined],
    ['quoted parameter decoy', '<sip:alice@example.com>;foo="x;tag=fake"', undefined],
  ])('%s', (_name, value, expected) => {
    expect(extractTag(value)).toBe(expected);
  });
});

function request(from: string, to: string): ReturnType<typeof makeRequest> {
  const headers = new Headers();
  headers.set('From', from);
  headers.set('To', to);
  headers.set('Call-ID', 'identity-call');
  headers.set('CSeq', '1 INVITE');
  return makeRequest('INVITE', 'sip:bob@example.com', headers);
}

function response(from: string, to: string): ReturnType<typeof makeResponse> {
  const headers = new Headers();
  headers.set('From', from);
  headers.set('To', to);
  headers.set('Call-ID', 'identity-call');
  headers.set('CSeq', '1 INVITE');
  return makeResponse(200, 'OK', headers);
}

describe('response identity tag parsing', () => {
  it('does not accept a To URI parameter as a response To tag', () => {
    const req = request('<sip:alice@example.com>;tag=alice', '<sip:bob@example.com;tag=uri>');
    const res = response('<sip:alice@example.com>;tag=alice', '<sip:bob@example.com;tag=uri>');
    expect(responseMatchesRequestIdentity(req, res)).toBe(false);
  });

  it('uses case-insensitive header tags instead of quoted and URI decoys', () => {
    const req = request(
      '"Agent;tag=fake-a;ignored" <sip:alice@example.com>;TaG=alice',
      '<sip:bob@example.com;tag=uri>',
    );
    const res = response(
      '"Agent;tag=fake-b;ignored" <sip:alice@example.com>;TAG=alice',
      '<sip:bob@example.com;tag=uri>;tAg=server',
    );
    expect(responseMatchesRequestIdentity(req, res)).toBe(true);
  });
});
