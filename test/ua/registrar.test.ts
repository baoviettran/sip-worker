import { describe, expect, it } from 'vitest';
import { Headers, makeResponse, parseMessage } from '../../src/messages/index.js';
import type { SipRequestMessage } from '../../src/messages/message.js';
import { TransactionLayer, deriveTimers } from '../../src/transactions/index.js';
import type { TransactionLayerEvent } from '../../src/transactions/types.js';
import { FakeClock } from '../support/fake-clock.js';
import { FakeTransport } from '../support/fake-transport.js';
import { AuthManager } from '../../src/auth/manager.js';
import { Registrar, type RegistrarOptions } from '../../src/ua/registrar.js';
import { SipError } from '../../src/errors.js';

const REGISTRAR_URI = 'sip:registrar.example.com';
const REALM = 'example.com';
const AOR = 'sip:alice@example.com';
const CONTACT = '<sip:alice@192.0.2.1:5060>';
const SECRET = 'Circle Of Life';
const NONCE = 'dcd98b7102dd2f0e8b11d0f600bfb0c093';

/** Id generator producing distinct values per call (mirrors Real implementation). */
function makeIdGenerator(): { branch: () => string } {
  let n = 0;
  return { branch: (): string => `reg-${(n += 1)}` };
}

interface Harness {
  clock: FakeClock;
  transport: FakeTransport;
  layer: TransactionLayer;
  events: TransactionLayerEvent[];
  sent: SipRequestMessage[];
  registrar: Registrar;
  authManager: AuthManager | undefined;
}

function setup(options: {
  credentials?: boolean;
  refreshFraction?: number;
} = {}): Harness {
  const { credentials = true, refreshFraction = 0.5 } = options;
  const clock = new FakeClock();
  const transport = new FakeTransport({ reliable: true, framing: 'stream' });
  void transport.connect();
  const sent: SipRequestMessage[] = [];
  transport.onSend = (bytes) => {
    const parsed = parseMessage(bytes);
    if (parsed.ok && parsed.value.kind === 'request') sent.push(parsed.value);
  };
  const timers = deriveTimers({ T1: 500, T2: 4000, T4: 5000 }, true);
  const events: TransactionLayerEvent[] = [];
  const layer = new TransactionLayer({
    transport, clock, timers, reliable: true,
    emit: (event) => events.push(event),
  });
  const idGenerator = makeIdGenerator();
  const authManager = credentials ? new AuthManager(idGenerator) : undefined;
  const options_: RegistrarOptions = {
    registrarUri: REGISTRAR_URI,
    aor: AOR,
    credentials: credentials ? { username: 'alice', password: SECRET } : undefined,
    contact: CONTACT,
    idGenerator,
    layer,
    clock,
    authManager,
    refreshFraction,
  };
  const registrar = new Registrar(options_);
  return { clock, transport, layer, events, sent, registrar, authManager };
}

const branchOf = (request: SipRequestMessage): string =>
  request.headers.get('Via')?.match(/;branch=([^;]+)/)?.[1] ?? '';

/** Route a response to the most recent outbound request through the layer. */
function respond(
  h: Harness,
  statusCode: number,
  over: { expires?: string; contactExpires?: string; minExpires?: string; challenge?: boolean; challengeHeader?: 'WWW-Authenticate' | 'Proxy-Authenticate'; contact?: string | null } = {},
): void {
  const request = h.sent[h.sent.length - 1];
  if (request === undefined) throw new Error('no outbound request to answer');
  const headers = new Headers();
  headers.set('Via', `SIP/2.0/UDP 192.0.2.1:5060;branch=${branchOf(request)}`);
  headers.set('From', request.headers.get('From') ?? `<${AOR}>;tag=fg7b0a`);
  headers.set('To', request.headers.get('To') ?? `<${AOR}>;tag=reg-1`);
  headers.set('Call-ID', request.headers.get('Call-ID') ?? 'call@example.com');
  headers.set('CSeq', request.headers.get('CSeq') ?? '1 REGISTER');
  // `contact: null` omits the Contact header (e.g. a Contact-less redirect to
  // exercise the no-Contact fail path); otherwise default to the UA Contact.
  if (over.contact !== null) headers.set('Contact', over.contact ?? CONTACT);
  if (over.expires !== undefined) headers.set('Expires', over.expires);
  if (over.contactExpires !== undefined) {
    headers.set('Contact', `${over.contact ?? CONTACT};expires=${over.contactExpires}`);
  }
  if (over.minExpires !== undefined) headers.set('Min-Expires', over.minExpires);
  if (over.challenge === true) {
    const challenge = `Digest realm="${REALM}", nonce="${NONCE}", qop="auth", algorithm=SHA-256`;
    headers.set(over.challengeHeader ?? 'WWW-Authenticate', challenge);
  }
  const response = makeResponse(statusCode, statusCode >= 400 ? 'err' : statusCode === 200 ? 'OK' : 'ringing', headers);
  h.layer.receive(response);
}

function finalCSeq(request: SipRequestMessage | undefined): number | undefined {
  const cseq = request?.headers.get('CSeq');
  return cseq === undefined ? undefined : Number(cseq.split(' ')[0]);
}

/** Drive a full registration: send REGISTER, then one response per outbound. */
async function completeRegister(
  h: Harness,
  responses: Array<{ status: number; over?: { expires?: string; contactExpires?: string; challenge?: boolean } }>,
): Promise<void> {
  const registration = h.registrar.register();
  for (let i = 0; i < responses.length; i += 1) {
    await flush();
    const r = responses[i]!;
    respond(h, r.status, r.over);
  }
  await flush();
  await registration;
}

function flush(): Promise<void> { return new Promise((resolve) => setTimeout(resolve, 0)); }

describe('Registrar', () => {
  it('registers unauthenticated and reaches registered on a 200', async () => {
    const h = setup();
    const registration = h.registrar.register();
    await flush();
    expect(h.registrar.state).toBe('registering');

    const request = h.sent[h.sent.length - 1]!;
    expect(request.method).toBe('REGISTER');
    expect(request.uri).toBe(REGISTRAR_URI);
    expect(request.headers.get('Via')).toMatch(/SIP\/2\.0\/UDP \S+;branch=z9hG4bK-/);
    expect(request.headers.get('CSeq')).toBe('1 REGISTER');
    expect(request.headers.get('Max-Forwards')).toBe('70');
    expect(request.headers.get('Contact')).toBe(CONTACT);

    respond(h, 200);
    await registration;
    expect(h.registrar.state).toBe('registered');
  });

  it('answers a 401 via Authorization and resolves after the authenticated 200', async () => {
    const h = setup();
    const registration = h.registrar.register();
    await flush();
    respond(h, 401, { challenge: true });
    await flush();
    const retried = h.sent[h.sent.length - 1]!;
    expect(retried.headers.get('Authorization')).toMatch(/^Digest /);
    expect(retried.headers.get('Proxy-Authorization')).toBeUndefined();
    expect(finalCSeq(retried)).toBe(2);
    respond(h, 200);
    await registration;
    expect(h.registrar.state).toBe('registered');
  });

  it('answers a 407 via Proxy-Authorization', async () => {
    const h = setup();
    const registration = h.registrar.register();
    await flush();
    respond(h, 407, { challenge: true, challengeHeader: 'Proxy-Authenticate' });
    await flush();
    const retried = h.sent[h.sent.length - 1]!;
    expect(retried.headers.get('Proxy-Authorization')).toMatch(/^Digest /);
    expect(retried.headers.get('Authorization')).toBeUndefined();
    respond(h, 200);
    await registration;
    expect(h.registrar.state).toBe('registered');
  });

  it('retries a 423 with a Min-Expires-length interval', async () => {
    const h = setup();
    const registration = h.registrar.register();
    await flush();
    respond(h, 423, { minExpires: '600' });
    await flush();
    const retried = h.sent[h.sent.length - 1]!;
    expect(retried.headers.get('Expires')).toBe('600');
    expect(finalCSeq(retried)).toBe(2);
    respond(h, 200);
    await registration;
    expect(h.registrar.state).toBe('registered');
  });

  it('accepts a shorter granted expiry without an immediate retry', async () => {
    const h = setup();
    const registration = h.registrar.register();
    await flush();
    respond(h, 200, { expires: '120' });
    await flush();
    expect(h.sent).toHaveLength(1);
    await registration;
    expect(h.registrar.state).toBe('registered');
  });

  it('prefers the matching Contact expires over the response Expires', async () => {
    const h = setup();
    const registration = h.registrar.register();
    await flush();
    respond(h, 200, { expires: '300', contactExpires: '90' });
    await registration;
    // The 0.5 fraction of 90 is 45s; a refresh at 60s would mean it used 300.
    await flush();
    expect(h.sent).toHaveLength(1);
    h.clock.advance(60 * 1000);
    await flush();
    const refreshed = h.sent[h.sent.length - 1]!;
    // A refresh at 60s proves the 90s Contact expires won (300s would fire at 150s).
    expect(finalCSeq(refreshed)).toBe(2);
    // Answer the refresh before its transaction times out (F = 32s).
    respond(h, 200);
    await flush();
    expect(h.registrar.state).toBe('registered');
  });

  it('refreshes at the configured fraction of the granted expiry', async () => {
    const h = setup();
    await completeRegister(h, [{ status: 200, over: { expires: '120' } }]);
    await flush();
    // Refresh fraction 0.5 => refresh at 60s. A 50s advance must not refresh.
    h.clock.advance(50 * 1000);
    await flush();
    expect(h.sent).toHaveLength(1);
    // Crossing 60s (plus a margin that stays inside the 120s expiry) refreshes.
    h.clock.advance(20 * 1000);
    await flush();
    expect(h.sent.length).toBeGreaterThanOrEqual(2);
    const refresh = h.sent[h.sent.length - 1]!;
    // Refresh reuses the same Call-ID and the next CSeq number.
    expect(refresh.headers.get('Call-ID')).toBe(h.sent[0]!.headers.get('Call-ID'));
    expect(finalCSeq(refresh)).toBe(2);
  });

  it('unregisters with Contact * and Expires 0', async () => {
    const h = setup();
    await completeRegister(h, [{ status: 200 }]);
    const unregistration = h.registrar.unregister();
    await flush();
    const request = h.sent[h.sent.length - 1]!;
    expect(request.headers.get('Contact')).toBe('*');
    expect(request.headers.get('Expires')).toBe('0');
    expect(finalCSeq(request)).toBe(2);
    respond(h, 200);
    await unregistration;
    expect(h.registrar.state).toBe('unregistered');
  });

  it('keeps a stable Call-ID and strictly increasing CSeq across attempts', async () => {
    const h = setup();
    await completeRegister(h, [
      { status: 401, over: { challenge: true } },
      { status: 401, over: { challenge: true } },
      { status: 200 },
    ]);
    const unreg = h.registrar.unregister();
    await flush();
    respond(h, 200);
    await unreg;
    h.registrar.onTransportDisconnected();
    const re = h.registrar.register();
    await flush();
    respond(h, 200);
    await re;
    const callIds = h.sent.map((r) => r.headers.get('Call-ID'));
    for (const cid of callIds) expect(cid).toBe(callIds[0]);
    const seqs = h.sent.map((r) => finalCSeq(r)) as number[];
    for (let i = 1; i < seqs.length; i += 1) expect(seqs[i]).toBe(seqs[i - 1]! + 1);
    expect(seqs[0]).toBe(1);
  });

  it('re-registers on reconnect after transport loss', async () => {
    const h = setup();
    await completeRegister(h, [{ status: 200 }]);
    h.registrar.onTransportDisconnected();
    expect(h.registrar.state).toBe('unregistered');
    const re = h.registrar.register();
    await flush();
    respond(h, 200);
    await re;
    expect(h.registrar.state).toBe('registered');
  });

  it('releases the retry budget when transport drops mid-auth exchange', async () => {
    const h = setup();
    const registration = h.registrar.register();
    await flush();
    // 401 challenge consumes one retry-budget entry on the AuthManager.
    respond(h, 401, { challenge: true });
    await flush();
    expect(h.authManager!.retriesByRequestSize).toBe(1);
    // Transport loss is a third terminal outcome; it must release the budget,
    // not leak it for the life of the UA.
    h.registrar.onTransportDisconnected();
    await expect(registration).rejects.toBeInstanceOf(SipError);
    expect(h.authManager!.retriesByRequestSize).toBe(0);
  });

  it('leaves a single timer and listener after repeated register/unregister cycles', async () => {
    const h = setup();
    await completeRegister(h, [{ status: 200 }]);
    await flush();
    expect(h.sent).toHaveLength(1);
    await flush();
    // First cycle complete: a refresh timer must be armed but no extra sends.
    h.clock.advance(0);
    await flush();
    expect(h.sent).toHaveLength(1);

    // Unregister cancels the refresh and fires a removal REGISTER exactly once.
    const unreg = h.registrar.unregister();
    await flush();
    respond(h, 200);
    await unreg;
    await flush();
    expect(h.sent).toHaveLength(2);
    expect(h.registrar.state).toBe('unregistered');

    // A second cycle behaves identically: exactly one new REGISTER.
    const reg2 = h.registrar.register();
    await flush();
    respond(h, 200);
    await reg2;
    await flush();
    expect(h.sent).toHaveLength(3);
  });

  it('exposes the current registration state as a status snapshot', async () => {
    const h = setup();
    expect(h.registrar.state).toBe('unregistered');
    await completeRegister(h, [{ status: 200 }]);
    expect(h.registrar.state).toBe('registered');
    const status = h.registrar.status();
    expect(status.state).toBe('registered');
    expect(status.callId).toBeTruthy();
    expect(status.nextCSeq).toBeGreaterThanOrEqual(2);
  });

  it('rejects the registration promise on a transport timeout', async () => {
    const h = setup();
    const registration = h.registrar.register();
    await flush();
    // Fire the transaction-layer timeout event for this REGISTER's key: timer F
    // for a non-INVITE client is 64*T1 = 32000ms.
    h.clock.advance(32000);
    await expect(registration).rejects.toThrow();
    expect(h.registrar.state).toBe('failed');
  });

  it('rejects the registration promise on a nonrecoverable final response', async () => {
    const h = setup();
    const registration = h.registrar.register();
    await flush();
    respond(h, 403);
    await expect(registration).rejects.toThrow();
    expect(h.registrar.state).toBe('failed');
  });

  it('rejects an in-flight register when the transport disconnects', async () => {
    const h = setup();
    const registration = h.registrar.register();
    await flush();
    // UA hook fires mid-exchange; the pending promise must reject, not hang.
    h.registrar.onTransportDisconnected();
    await expect(Promise.race([registration, new Promise((resolve) => setTimeout(resolve, 20))])).rejects.toThrow('transport disconnected');
    expect(h.registrar.state).toBe('failed');
    expect(h.registrar.status()).toMatchObject({ nextCSeq: 2 });
  });

  it('does not get stuck on a failed unregister', async () => {
    const h = setup();
    await completeRegister(h, [{ status: 200 }]);
    const unregistration = h.registrar.unregister();
    await flush();
    // Fail the removal REGISTER with a non-2xx final.
    respond(h, 403);
    await expect(unregistration).rejects.toThrow();
    // The registrar must leave 'unregistering'…
    expect(h.registrar.state).toBe('failed');
    // …and a subsequent register() can proceed with the next CSeq.
    const re = h.registrar.register();
    await flush();
    respond(h, 200);
    await re;
    expect(h.registrar.state).toBe('registered');
    expect(h.registrar.status().nextCSeq).toBeGreaterThanOrEqual(3);
  });

  it('follows a 302 redirect Contact to complete registration', async () => {
    const h = setup();
    const registration = h.registrar.register();
    await flush();
    // First exchange: registrar answers 302 with a redirect target.
    respond(h, 302, { contact: '<sip:redirect-1.example.com>' });
    await flush();
    // The registrar must have sent a NEW REGISTER to the redirect target.
    expect(h.sent[h.sent.length - 1]!.uri).toBe('sip:redirect-1.example.com');
    // Second exchange: the redirected REGISTER is granted.
    respond(h, 200);
    await registration;
    expect(h.registrar.state).toBe('registered');
  });

  it('does not follow a 305 Use Proxy as a REGISTER redirect', async () => {
    const h = setup();
    const registration = h.registrar.register();
    await flush();
    respond(h, 305, { contact: '<sip:proxy.example.com>' });
    // 305 is NOT a followable redirect: the registration must fail, not re-REGISTER.
    await expect(registration).rejects.toThrow(SipError);
    expect(h.sent).toHaveLength(1); // no second REGISTER
    expect(h.registrar.state).toBe('failed');
  });

  it('fails a redirect loop instead of spinning', async () => {
    const h = setup();
    const registration = h.registrar.register();
    await flush();
    // Chain 5 redirects; the 6th (over MAX_REDIRECTS=5) must fail.
    for (let i = 0; i < 5; i += 1) {
      respond(h, 302, { contact: '<sip:hop.example.com>' });
      await flush();
    }
    // 1 initial REGISTER + 5 redirect re-REGISTERs = exactly 6 sends. A looser
    // bound would hide a cap regression. The initial targets the configured
    // registrar; each redirect re-REGISTER targets the redirect Contact.
    expect(h.sent).toHaveLength(6);
    expect(h.sent[0]!.uri).toBe(REGISTRAR_URI);
    for (let i = 1; i < h.sent.length; i += 1) expect(h.sent[i]!.uri).toBe('sip:hop.example.com');
    // Now at the cap: a further 302 must fail rather than resend.
    respond(h, 302, { contact: '<sip:hop.example.com>' });
    await expect(registration).rejects.toThrow(SipError);
    // The cap-failing 302 is handled in onResponse without a new send.
    expect(h.sent).toHaveLength(6);
    expect(h.registrar.state).toBe('failed');
  });

  it('persists a 301 redirect target so a fresh register() routes to it', async () => {
    const h = setup();
    // First registration: registrar answers 301 (permanent) with a target.
    const registration = h.registrar.register();
    await flush();
    respond(h, 301, { contact: '<sip:perm.example.com>' });
    await flush();
    expect(h.sent[h.sent.length - 1]!.uri).toBe('sip:perm.example.com');
    respond(h, 200);
    await registration;
    expect(h.registrar.state).toBe('registered');

    // A 301 is permanent: a fresh registration (after unregister) must open
    // against the persisted target, not the configured registrar URI.
    const unreg = h.registrar.unregister();
    await flush();
    respond(h, 200);
    await unreg;
    expect(h.registrar.state).toBe('unregistered');

    const reReg = h.registrar.register();
    await flush();
    expect(h.sent[h.sent.length - 1]!.uri).toBe('sip:perm.example.com');
    respond(h, 200);
    await reReg;
    expect(h.registrar.state).toBe('registered');
  });

  it('fails a 302 redirect without a Contact rather than re-sending', async () => {
    const h = setup();
    const registration = h.registrar.register();
    await flush();
    // No Contact on the redirect: nothing to follow — must fail, not re-REGISTER.
    respond(h, 302, { contact: null });
    await expect(registration).rejects.toThrow(SipError);
    expect(h.sent).toHaveLength(1);
    expect(h.registrar.state).toBe('failed');
  });
});
