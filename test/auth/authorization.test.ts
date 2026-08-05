import { describe, it, expect } from 'vitest';
import { renderAuthorization } from '../../src/auth/authorization.js';

describe('renderAuthorization', () => {
  it('quotes username/realm/nonce/uri/response/cnonce/opaque but not algorithm/qop/nc', () => {
    const line = renderAuthorization({
      username: 'alice',
      realm: 'sip.example.com',
      nonce: 'nonce1',
      uri: 'sip:alice@example.com',
      response: 'abc123',
      algorithm: 'MD5',
      qop: 'auth',
      nc: '00000001',
      cnonce: 'cnonce1',
      opaque: 'opaque1',
    });
    expect(line).toBe(
      'Authorization: Digest username="alice", realm="sip.example.com", nonce="nonce1", ' +
        'uri="sip:alice@example.com", response="abc123", algorithm=MD5, qop=auth, ' +
        'nc=00000001, cnonce="cnonce1", opaque="opaque1"',
    );
  });

  it('renders as Proxy-Authorization for a 407 challenge', () => {
    const line = renderAuthorization(
      { username: 'alice', realm: 'r', nonce: 'n', uri: 'sip:x', response: 'abc' },
      true,
    );
    expect(line.startsWith('Proxy-Authorization: ')).toBe(true);
    expect(line).not.toMatch(/^Authorization:/);
  });

  it('omits absent optional fields', () => {
    const line = renderAuthorization({
      username: 'alice',
      realm: 'r',
      nonce: 'n',
      uri: 'sip:x',
      response: 'abc',
    });
    expect(line).toBe('Authorization: Digest username="alice", realm="r", nonce="n", uri="sip:x", response="abc"');
  });
});