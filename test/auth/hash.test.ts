import { describe, it, expect } from 'vitest';
import { md5, sha256 } from '../../src/auth/hash.js';

describe('md5', () => {
  it('matches the empty-string vector (RFC 1321 A.5)', () => {
    expect(md5('')).toBe('d41d8cd98f00b204e9800998ecf8427e');
  });

  it('matches the "abc" vector (RFC 1321 A.5)', () => {
    expect(md5('abc')).toBe('900150983cd24fb0d6963f7d28e17f72');
  });

  it('matches the "message digest" vector', () => {
    expect(md5('message digest')).toBe('f96b697d7cb7938d525a2f31aaf161d0');
  });

  it('matches the 448-bit "abcdefghijklmnopqrstuvwxyz" vector', () => {
    expect(md5('abcdefghijklmnopqrstuvwxyz')).toBe('c3fcd3d76192e4007dfb496cca67e13b');
  });
});

describe('sha256', () => {
  it('matches the empty-string vector (FIPS 180-4 B.1)', () => {
    expect(sha256('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });

  it('matches the "abc" vector (FIPS 180-4 B.1)', () => {
    expect(sha256('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('matches the two-block "abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq" vector', () => {
    expect(sha256('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')).toBe(
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
    );
  });
});
