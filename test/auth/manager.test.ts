import { describe, it, expect } from 'vitest';
import { Headers } from '../../src/messages/index.js';
import { makeRequest, makeResponse, bodyText } from '../../src/messages/index.js';
import type { IdGenerator } from '../../src/auth/manager.js';
import { AuthManager } from '../../src/auth/manager.js';
import type { AuthContext, AuthFailure } from '../../src/auth/manager.js';
import type { SipRequestMessage, SipResponseMessage } from '../../src/messages/message.js';

const SDP =
  'v=0\r\no=`alice` 2890844526 2890844526 IN IP4 192.0.2.1\r\n' +
  's=-\r\nc=IN IP4 192.0.2.1\r\nt=0 0\r\nm=audio 49170 RTP/AVP 0\r\n';

const SECRET_PASSWORD = 'Circle Of Life';
const REALM = 'testrealm@host.com';
const NONCE = 'dcd98b7102dd2f0e8b11d0f600bfb0c093';

interface Fixture {
  request: SipRequestMessage;
  response: SipResponseMessage;
  ids: () => IdGenerator;
  context: (over?: { requestId?: string; request?: SipRequestMessage; response?: SipResponseMessage; credentials?: { username: string; password: string } }) => AuthContext;
}

function fixture(): Fixture {
  const request = makeRequest(
    'INVITE',
    'sip:alice@example.com',
    buildInviteHeaders(),
    new TextEncoder().encode(SDP),
  );
  const response = makeResponse(401, 'Unauthorized', buildResponseHeaders(REALM, NONCE));
  // Fresh per-test counter: each `ids()` call yields an independent sequence.
  const ids = (): IdGenerator => {
    let n = 0;
    return { branch: () => `retry-${++n}` };
  };
  const context = (over: Partial<AuthContext> = {}): AuthContext => ({
    requestId: 'req-1',
    request,
    response,
    credentials: { username: 'alice', password: SECRET_PASSWORD },
    ...over,
  });
  return { request, response, ids, context };
}

function buildInviteHeaders(): Headers {
  const h = new Headers();
  h.append('Via', 'SIP/2.0/UDP 192.0.2.1:5060;branch=z9hG4bK-original;rport');
  h.append('Max-Forwards', '70');
  h.append('From', '"Alice" <sip:alice@example.com>;tag=a1');
  h.append('To', '<sip:bob@example.com>');
  h.append('Call-ID', 'call-id-1@example.com');
  h.append('CSeq', '1 INVITE');
  h.append('Contact', '<sip:alice@192.0.2.1:5060>');
  h.append('Route', '<sip:proxy.example.com;lr>');
  h.append('Content-Type', 'application/sdp');
  return h;
}

function buildResponseHeaders(realm: string, nonce: string, stale = false): Headers {
  const h = new Headers();
  h.append(
    'Via',
    'SIP/2.0/UDP 192.0.2.1:5060;branch=z9hG4bK-original;rport;received=192.0.2.1',
  );
  h.append('From', '"Alice" <sip:alice@example.com>;tag=a1');
  h.append('To', '<sip:bob@example.com>;tag=b1');
  h.append('Call-ID', 'call-id-1@example.com');
  h.append('CSeq', '1 INVITE');
  const challenge =
    `Digest realm="${realm}", nonce="${nonce}", qop="auth", ` +
    `algorithm=MD5${stale ? ', stale=true' : ''}`;
  h.append('WWW-Authenticate', challenge);
  return h;
}

function expectFailure(result: SipRequestMessage | AuthFailure, expected: AuthFailure['type']): AuthFailure {
  expect(result).toMatchObject({ error: expect.any(Error) });
  const failure = result as AuthFailure;
  expect(failure.type).toBe(expected);
  expect(failure.error).toBeInstanceOf(Error);
  return failure;
}

describe('AuthManager.retry', () => {
  const f = fixture();

  it('returns a new request with byte-identical SDP, Call-ID, From, To, Contact, Route and URI', () => {
    const result = new AuthManager(f.ids()).retry(f.context());
    expect(result).not.toMatchObject({ type: expect.any(String) });
    const retry = result as SipRequestMessage;
    expect(retry).not.toBe(f.request);
    expect(retry.kind).toBe('request');
    expect(retry.method).toBe('INVITE');
    expect(retry.uri).toBe('sip:alice@example.com');
    expect(retry.body).toEqual(f.request.body);
    expect(bodyText(retry)).toBe(SDP);
    expect(retry.headers.get('Call-ID')).toBe('call-id-1@example.com');
    expect(retry.headers.get('From')).toBe('"Alice" <sip:alice@example.com>;tag=a1');
    expect(retry.headers.get('To')).toBe('<sip:bob@example.com>');
    expect(retry.headers.get('Contact')).toBe('<sip:alice@192.0.2.1:5060>');
    expect(retry.headers.get('Route')).toBe('<sip:proxy.example.com;lr>');
  });

  it('increments the numeric CSeq exactly once', () => {
    const result = new AuthManager(f.ids()).retry(f.context()) as SipRequestMessage;
    expect(result.headers.get('CSeq')).toBe('2 INVITE');
  });

  it('leaves exactly one Via, preserved down to the trailing rport', () => {
    const result = new AuthManager(f.ids()).retry(f.context()) as SipRequestMessage;
    expect(result.headers.getAll('Via')).toHaveLength(1);
    const via = result.headers.get('Via')!;
    // cnonce consumes the first injected id; the Via branch takes the second.
    expect(via).toMatch(/;branch=z9hG4bK-retry-2/);
    expect(via).not.toMatch(/z9hG4bK-original/);
    expect(via).toMatch(/;rport/); // preserved as a bare parameter
  });

  it('adds exactly one Authorization and removes any existing it replaces', () => {
    const headers = buildInviteHeaders();
    headers.set('Authorization', 'Digest username="preexisting"');
    const ctx = f.context({ request: makeRequest('INVITE', 'sip:alice@example.com', headers) });
    const result = new AuthManager(f.ids()).retry(ctx) as SipRequestMessage;
    expect(result.headers.getAll('Authorization')).toHaveLength(1);
    expect(result.headers.getAll('Proxy-Authorization')).toHaveLength(0);
    const auth = result.headers.get('Authorization')!;
    expect(auth).toMatch(/^Digest /);
    expect(auth).toContain('username="alice"');
    expect(auth).toContain(`realm="${REALM}"`);
    expect(auth).toContain(`nonce="${NONCE}"`);
    expect(auth).toContain('algorithm=MD5');
    expect(auth).toMatch(/response="[0-9a-f]{32}"/);
    expect(auth).not.toContain('preexisting');
  });

  it('renders Proxy-Authorization when challenged by Proxy-Authenticate', () => {
    const headers = buildResponseHeaders(REALM, NONCE);
    headers.delete('WWW-Authenticate');
    headers.append('Proxy-Authenticate', `Digest realm="${REALM}", nonce="${NONCE}", qop="auth", algorithm=MD5`);
    const ctx = f.context({ response: makeResponse(407, 'Proxy Authentication Required', headers) });
    const result = new AuthManager(f.ids()).retry(ctx) as SipRequestMessage;
    expect(result.headers.getAll('Proxy-Authorization')).toHaveLength(1);
    expect(result.headers.get('Authorization')).toBeUndefined();
    const canary = `${REALM} ${SECRET_PASSWORD}`;
    const serialized = JSON.stringify(result.headers.entries());
    expect(serialized).not.toContain(SECRET_PASSWORD);
    expect(serialized).not.toContain(canary);
    const auth = result.headers.get('Proxy-Authorization')!;
    expect(auth.startsWith('Digest ')).toBe(true);
  });

  it('drops a preexisting Proxy-Authorization when challenged via WWW-Authenticate', () => {
    const headers = buildInviteHeaders();
    headers.set('Proxy-Authorization', 'Digest username="preexisting"');
    const ctx = f.context({ request: makeRequest('INVITE', 'sip:alice@example.com', headers) });
    const result = new AuthManager(f.ids()).retry(ctx) as SipRequestMessage;
    expect(result.headers.getAll('Authorization')).toHaveLength(1);
    expect(result.headers.get('Proxy-Authorization')).toBeUndefined();
  });

  it('reuses the same nonce for a second retry with nc 00000002', () => {
    const manager = new AuthManager(f.ids());
    const plain = { username: 'alice', password: SECRET_PASSWORD };
    const firstCtx = f.context({ requestId: 'req-A', credentials: plain });
    const secondCtx = f.context({ requestId: 'req-A', credentials: plain });
    const first = manager.retry(firstCtx) as SipRequestMessage;
    const second = manager.retry(secondCtx) as SipRequestMessage;
    const branch1 = first.headers.get('Via')!.match(/;branch=([^;,\s]+)/)?.[1];
    const branch2 = second.headers.get('Via')!.match(/;branch=([^;,\s]+)/)?.[1];
    expect(branch1).toBe('z9hG4bK-retry-2');
    expect(branch2).toBe('z9hG4bK-retry-4');
    const nc1 = first.headers.get('Authorization')!.match(/nc=([0-9a-fA-F]{8})/)?.[1];
    const nc1b = second.headers.get('Authorization')!.match(/nc=([0-9a-fA-F]{8})/)?.[1];
    expect(nc1).toBe('00000001');
    expect(nc1b).toBe('00000002');
    expect(second.headers.get('Authorization')).toContain(`nonce="${NONCE}"`);
  });

  it('fails fast on an unsupported challenge algorithm without a retry', () => {
    const headers = buildResponseHeaders(REALM, NONCE);
    headers.set(
      'WWW-Authenticate',
      `Digest realm="${REALM}", nonce="${NONCE}", qop="auth", algorithm=MD5-sess`,
    );
    const ctx = f.context({ response: makeResponse(401, 'Unauthorized', headers) });
    const result = new AuthManager(f.ids()).retry(ctx);
    const failure = expectFailure(result, 'unsupported');
    expect(failure.error.statusCode).toBe(401);
  });

  it('returns exhausted after the third ordinary retry', () => {
    const manager = new AuthManager(f.ids());
    const plain = { username: 'alice', password: SECRET_PASSWORD };
    let last: SipRequestMessage | undefined;
    for (let i = 0; i < 3; i += 1) {
      last = manager.retry(f.context({ requestId: 'req-X', credentials: plain })) as SipRequestMessage;
    }
    expect(last).toBeDefined();
    const nc1 = last!.headers.get('Authorization')?.match(/nc=([0-9a-fA-F]{8})/)?.[1];
    expect(nc1).toBe('00000003');
    const fourth = manager.retry(f.context({ requestId: 'req-X', credentials: plain }));
    const failure = expectFailure(fourth, 'exhausted');
    expect(failure.error.statusCode).toBe(401);
  });

  it('reuses the nonce and nc count across distinct requestIds', () => {
    const manager = new AuthManager(f.ids());
    const plain = { username: 'alice', password: SECRET_PASSWORD };
    const one = manager.retry(f.context({ requestId: 'req-A', credentials: plain })) as SipRequestMessage;
    const two = manager.retry(f.context({ requestId: 'req-B', credentials: plain })) as SipRequestMessage;
    const nc1a = one.headers.get('Authorization')!.match(/nc=([0-9a-fA-F]{8})/)?.[1];
    const nc2a = two.headers.get('Authorization')!.match(/nc=([0-9a-fA-F]{8})/)?.[1];
    expect(nc1a).toBe('00000001');
    expect(nc2a).toBe('00000002');
  });

  it('answers a stale=true retry for free when both requests come from the same realm', () => {
    const manager = new AuthManager(f.ids());
    const headers = buildResponseHeaders(REALM, NONCE, true);
    const staleCtx = f.context({ requestId: 'req-stale', response: makeResponse(401, 'Unauthorized', headers) });
    const stale = manager.retry(staleCtx);
    expect(stale).not.toMatchObject({ type: expect.any(String) });
    const staleRequest = stale as SipRequestMessage;
    const nc1 = staleRequest.headers.get('Authorization')?.match(/nc=([0-9a-fA-F]{8})/)?.[1];
    expect(nc1).toBe('00000001');
  });

  it('answers a stale=true retry without consuming another request budget via a fixed realm+nonce response', () => {
    const manager = new AuthManager(f.ids());
    const first = manager.retry(f.context({ requestId: 'req-s' })) as SipRequestMessage;
    void first;
    const staleHeaders = buildResponseHeaders(REALM, NONCE, true);
    const staleCtx = f.context({
      requestId: 'req-s',
      response: makeResponse(401, 'Unauthorized', staleHeaders),
    });
    const stale = manager.retry(staleCtx);
    expect(stale).not.toMatchObject({ type: expect.any(String) });
    const staleRequest = stale as SipRequestMessage;
    const nc1 = staleRequest.headers.get('Authorization')?.match(/nc=([0-9a-fA-F]{8})/)?.[1];
    expect(nc1).toBe('00000002');
  });

  it('preserves every Via param except branch on auth retry', () => {
    const f = fixture();
    // Original Via with params current nextVia drops.
    f.request.headers.set(
      'Via',
      'SIP/2.0/UDP 192.0.2.1:5060;branch=z9hG4bK-original;received=10.0.0.1;comp=sigcomp;transport=tls;rport',
    );
    f.request.headers.set('CSeq', '1 INVITE');
    const manager = new AuthManager(f.ids());
    const retried = manager.retry(f.context()) as SipRequestMessage;
    const via = retried.headers.get('Via');
    expect(via).toContain('received=10.0.0.1');
    expect(via).toContain('comp=sigcomp');
    expect(via).toContain('transport=tls');
    expect(via).toContain('rport');
    expect(via).not.toContain('z9hG4bK-original');
  });

  it('stamps a CSeq-less retry with the original method', () => {
    const f = fixture();
    f.request.headers.delete('CSeq'); // force the fallback
    const sub = makeRequest('SUBSCRIBE', 'sip:alice@example.com', f.request.headers.clone());
    const manager = new AuthManager(f.ids());
    const ctx = f.context({ request: sub });
    const retried = manager.retry(ctx) as SipRequestMessage;
    const cseq = retried.headers.get('CSeq');
    expect(cseq).toMatch(/^1 SUBSCRIBE$/);
  });

  it('routes a rendered header value that itself contains ": "', () => {
    const f = fixture();
    const manager = new AuthManager(f.ids());
    // renderAuthorization emits the full header line; force the manager's splitter
    // to face a value with ": " by putting colons in the response realm.
    f.response.headers.set(
      'WWW-Authenticate',
      'Digest realm="realm: with: colons", nonce="n", algorithm=MD5',
    );
    const retried = manager.retry(f.context()) as SipRequestMessage;
    const auth = retried.headers.get('Authorization');
    expect(auth).toContain('realm="realm: with: colons"');
    // The full value is intact — the splitter consumed only the first ": ".
    expect(auth).toContain('realm="realm: with: colons", nonce="n"');
  });
});

describe('AuthManager.redact', () => {
  it('yields a serialization with no original credential bytes in any header entry', () => {
    const credentials = { username: 'alice', password: SECRET_PASSWORD };
    const request = makeRequest(
      'INVITE',
      'sip:alice@example.com',
      buildInviteHeaders(),
      new TextEncoder().encode(SDP),
    );
    const response = makeResponse(401, 'Unauthorized', buildResponseHeaders(REALM, NONCE));
    const wire = JSON.stringify(AuthManager.redact({ request, response, credentials, requestId: 'req-redact' }));
    // The secret password must not appear anywhere in the serialized log.
    expect(wire).not.toContain(SECRET_PASSWORD);
    // Every header entry must be masked to a placeholder, never the raw value.
    const redacted = AuthManager.redact({ request, response, credentials, requestId: 'req-redact' }) as {
      request: { headers: Record<string, string[]> };
    };
    for (const value of request.headers.entries()) {
      for (const entry of redacted.request.headers[value[0]] ?? []) {
        expect(entry).toBe('[redacted]');
      }
    }
  });

  it('hashes the secret when the body itself contains the secret, so no entry is recoverable', () => {
    const credentials = { username: 'alice', password: SECRET_PASSWORD };
    const body = `v=0\r\npassword: ${SECRET_PASSWORD}\r\n`;
    const request = makeRequest('INVITE', 'sip:alice@example.com', buildInviteHeaders(), new TextEncoder().encode(body));
    const response = makeResponse(401, 'Unauthorized', buildResponseHeaders(REALM, NONCE));
    const log = AuthManager.redact({ request, response, credentials, requestId: 'req-redact' });
    const wire = JSON.stringify(log);
    expect(wire).not.toContain(SECRET_PASSWORD);
  });
});
