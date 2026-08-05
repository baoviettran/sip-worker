import { describe, it, expect } from 'vitest';
import { parseDigestChallenges, selectChallenge } from '../../src/auth/challenge.js';
import type { DigestChallenge } from '../../src/auth/challenge.js';
import { ParseError } from '../../src/errors.js';

describe('parseDigestChallenges', () => {
  it('parses multiple challenges with a quoted comma in the realm and prefers SHA-256 with qop=auth', () => {
    const parsed = parseDigestChallenges([
      'Digest realm="a,b", nonce="n1", algorithm=MD5, qop="auth,auth-int"',
      'Digest realm="a,b", nonce="n2", algorithm=SHA-256, qop="auth"',
    ]);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value).toHaveLength(2);
    expect(parsed.value[0]!.realm).toBe('a,b');
    expect(parsed.value[0]!.qop).toEqual(['auth', 'auth-int']);
    expect(parsed.value[1]!.qop).toEqual(['auth']);
    // Prefer SHA-256 over MD5 (both offer qop=auth).
    expect(selectChallenge(parsed.value)?.nonce).toBe('n2');
  });

  it('parses two challenges within a single scanner pass', () => {
    const parsed = parseDigestChallenges([
      'Digest realm="r", nonce="n1", algorithm=MD5, Digest realm="r", nonce="n2", algorithm=SHA-256',
    ]);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value).toHaveLength(2);
    expect(selectChallenge(parsed.value)?.nonce).toBe('n2');
  });

  it('normalizes algorithm case and retains opaque, stale, and domain', () => {
    const parsed = parseDigestChallenges([
      'Digest realm="r", nonce="n1", algorithm=md5, opaque="o1", stale=true, domain="sip:host"',
    ]);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value[0]!.algorithm).toBe('MD5');
    expect(parsed.value[0]!.opaque).toBe('o1');
    expect(parsed.value[0]!.stale).toBe(true);
    expect(parsed.value[0]!.domain).toBe('sip:host');
  });

  it('ignores unsupported algorithms when selecting', () => {
    const parsed = parseDigestChallenges([
      'Digest realm="r", nonce="n1", algorithm=MD5-sess',
      'Digest realm="r", nonce="n2", algorithm=SHA-256',
    ]);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value).toHaveLength(2);
    expect(selectChallenge(parsed.value)?.nonce).toBe('n2');
  });

  it('does not select a lone unsupported-algorithm challenge', () => {
    const parsed = parseDigestChallenges([
      'Digest realm="r", nonce="n1", algorithm=MD5-sess, qop="auth"',
    ]);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value).toHaveLength(1);
    // The raw algorithm is retained so selection can reject it.
    expect(selectChallenge(parsed.value)).toBeUndefined();
  });

  it('selectChallenge ignores candidates lacking a realm or nonce', () => {
    const candidateMissingRealm = { nonce: 'n1', algorithm: 'MD5' } as DigestChallenge;
    const candidateMissingNonce = { realm: 'r', algorithm: 'MD5' } as DigestChallenge;
    const valid = { realm: 'r', nonce: 'n3', algorithm: 'MD5' } as DigestChallenge;
    expect(selectChallenge([valid, candidateMissingRealm, candidateMissingNonce])?.nonce).toBe('n3');
  });

  it('returns a ParseError on a malformed escape', () => {
    const parsed = parseDigestChallenges(['Digest realm="a\\', 'nonce="n1"']);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toBeInstanceOf(ParseError);
    expect(typeof parsed.error.offset).toBe('number');
  });

  it('returns a ParseError on an unterminated quoted string', () => {
    const parsed = parseDigestChallenges(['Digest realm="r", nonce="n1']);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toBeInstanceOf(ParseError);
  });

  it('returns a ParseError when a challenge is missing a realm', () => {
    const parsed = parseDigestChallenges(['Digest nonce="n1", algorithm=MD5']);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toBeInstanceOf(ParseError);
  });

  it('returns a ParseError when a challenge is missing a nonce', () => {
    const parsed = parseDigestChallenges(['Digest realm="r", algorithm=MD5']);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toBeInstanceOf(ParseError);
  });
});