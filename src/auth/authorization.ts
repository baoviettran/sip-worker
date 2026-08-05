/**
 * Renders a client Authorization / Proxy-Authorization Digest header value
 * (RFC 2617 3.2.2) for a retried request.
 *
 * The scheme is `Digest`. username, realm, nonce, uri, response, cnonce and
 * opaque are quoted; algorithm, qop and nc are emitted as unquoted tokens.
 */

export interface AuthorizationParams {
  readonly username: string;
  readonly realm: string;
  readonly nonce: string;
  readonly uri: string;
  readonly response: string;
  readonly algorithm?: 'MD5' | 'SHA-256';
  readonly qop?: 'auth' | 'auth-int';
  readonly nc?: string;
  readonly cnonce?: string;
  readonly opaque?: string;
}

export function renderAuthorization(params: AuthorizationParams, proxy = false): string {
  const header = proxy ? 'Proxy-Authorization' : 'Authorization';
  const parts: string[] = [
    `username="${params.username}"`,
    `realm="${params.realm}"`,
    `nonce="${params.nonce}"`,
    `uri="${params.uri}"`,
    `response="${params.response}"`,
  ];
  if (params.algorithm !== undefined) parts.push(`algorithm=${params.algorithm}`);
  if (params.qop !== undefined) parts.push(`qop=${params.qop}`);
  if (params.nc !== undefined) parts.push(`nc=${params.nc}`);
  if (params.cnonce !== undefined) parts.push(`cnonce="${params.cnonce}"`);
  if (params.opaque !== undefined) parts.push(`opaque="${params.opaque}"`);
  return `${header}: Digest ${parts.join(', ')}`;
}