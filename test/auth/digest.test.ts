import { describe, it, expect } from 'vitest';
import { computeDigest } from '../../src/auth/digest.js';
import type { DigestParams } from '../../src/auth/digest.js';

describe('computeDigest', () => {
  it('computes an MD5 response with qop=auth (RFC 2617 3.5 example)', () => {
    const digest = computeDigest({
      algorithm: 'MD5',
      username: 'Mufasa',
      password: 'Circle Of Life',
      realm: 'testrealm@host.com',
      nonce: 'dcd98b7102dd2f0e8b11d0f600bfb0c093',
      method: 'GET',
      uri: '/dir/index.html',
      qop: 'auth',
      nc: '00000001',
      cnonce: '0a4f113b',
    });
    expect(digest).toBe('6629fae49393a05397450978507c4ef1');
  });

  it('computes an MD5 response without qop', () => {
    const digest = computeDigest({
      algorithm: 'MD5',
      username: 'Mufasa',
      password: 'Circle Of Life',
      realm: 'testrealm@host.com',
      nonce: 'dcd98b7102dd2f0e8b11d0f600bfb0c093',
      method: 'GET',
      uri: '/dir/index.html',
    });
    expect(digest).toBe('670fd8c2df070c60b045671b8b24ff02');
  });

  it('rejects a missing nc/cnonce when qop is set', () => {
    const params: DigestParams = {
      algorithm: 'MD5',
      username: 'Mufasa',
      password: 'Circle Of Life',
      realm: 'testrealm@host.com',
      nonce: 'dcd98b7102dd2f0e8b11d0f600bfb0c093',
      method: 'GET',
      uri: '/dir/index.html',
      qop: 'auth',
    };
    expect(() => computeDigest(params)).toThrow(/nc and cnonce/);
    expect(() => computeDigest({ ...params, nc: '00000001' })).toThrow(/nc and cnonce/);
    expect(() => computeDigest({ ...params, cnonce: '0a4f113b' })).toThrow(/nc and cnonce/);
  });

  it('computes an MD5 auth-int response with entity-body integrity (RFC 2617 3.5)', () => {
    const digest = computeDigest({
      algorithm: 'MD5',
      username: 'Mufasa',
      password: 'Circle Of Life',
      realm: 'testrealm@host.com',
      nonce: 'dcd98b7102dd2f0e8b11d0f600bfb0c093',
      method: 'GET',
      uri: '/dir/index.html',
      qop: 'auth-int',
      nc: '00000001',
      cnonce: '0a4f113b',
      body: new TextEncoder().encode('hello world!\n'),
    });
    // Auth-int for body "hello world!\n" (same credentials/params as the 3.5
    // example). Computed: H(HA1:nonce:nc:cnonce:qop:H(method:uri:H(body))) with
    // the repo's md5. The auth (non-int) counterpart is 6629fae49393a05397450978507c4ef1.
    expect(digest).toBe('ba1a66c6c77a0510308d727ab5e3a97c');
  });

  it('throws when auth-int is requested without a body', () => {
    const params: DigestParams = {
      algorithm: 'MD5',
      username: 'Mufasa',
      password: 'Circle Of Life',
      realm: 'testrealm@host.com',
      nonce: 'dcd98b7102dd2f0e8b11d0f600bfb0c093',
      method: 'GET',
      uri: '/dir/index.html',
      qop: 'auth-int',
      nc: '00000001',
      cnonce: '0a4f113b',
    };
    expect(() => computeDigest(params)).toThrow(/entityBody|body/);
  });
});
