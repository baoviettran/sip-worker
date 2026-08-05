import { md5, sha256 } from './hash.js';

export type DigestAlgorithm = 'MD5' | 'SHA-256';

export interface DigestParams {
  readonly algorithm: DigestAlgorithm;
  readonly username: string;
  readonly password: string;
  readonly realm: string;
  readonly nonce: string;
  readonly method: string;
  readonly uri: string;
  /** Present when the server challenged with a qop directive. */
  readonly qop?: 'auth' | 'auth-int';
  readonly nc?: string;
  readonly cnonce?: string;
}

/**
 * Computes the HTTP Digest `response` value (RFC 2617 3.2.2) for the given
 * request parameters.
 *
 * With `qop: 'auth'` the digest is `H(HA1:nonce:nc:cnonce:qop:HA2)`; without
 * qop the nonce-count and client-nonce fields are omitted and the digest is
 * `H(HA1:nonce:HA2)`. HA1 is `H(username:realm:password)` (no algorithm token
 * is appended since only MD5 and plain SHA-256 are supported) and HA2 is
 * `H(method:uri)`.
 *
 * Throws a `TypeError` when `qop` is set but `nc` or `cnonce` is missing.
 */
export function computeDigest(params: DigestParams): string {
  const { algorithm, username, password, realm, nonce, method, uri, qop, nc, cnonce } = params;
  if (qop !== undefined && (nc === undefined || cnonce === undefined)) {
    throw new TypeError('computeDigest: nc and cnonce are required when qop is set');
  }

  const h: (input: string) => string = algorithm === 'MD5' ? md5 : sha256;
  const ha1 = h(`${username}:${realm}:${password}`);
  const ha2 = h(`${method}:${uri}`);
  const data = qop !== undefined && nc !== undefined && cnonce !== undefined
    ? `${ha1}:${nonce}:${nc}:${cnonce}:${qop}:${ha2}`
    : `${ha1}:${nonce}:${ha2}`;
  return h(data);
}
