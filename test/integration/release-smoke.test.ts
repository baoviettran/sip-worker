/**
 * Release-candidate smoke gate (Plan 06, Task 6).
 *
 * A single test file proving the supported v1 lifecycle and recovery
 * boundaries through ONLY public package APIs and deterministic test
 * adapters. All pacing runs on the injected `FakeClock` — never real time.
 *
 * Scenario A — public root: authenticated REGISTER → outgoing authenticated
 *   INVITE → offer/answer → ACK → BYE/200 → unregister, and asserts the emitted
 *   trace contains `registered → inviting → confirmed → terminated → unregistered`.
 * Scenario B — incoming call: receive + answer, prove the TU stops retransmitting
 *   the 2xx on ACK, then handle BYE.
 * Scenario C — liveness: OPTIONS timeout (default strategy) and native ping/pong
 *   timeout (NodeWebSocketLiveness via `toNativePingSocket`) each surface a typed
 *   `TransportError`.
 * Scenario D — worker death: replacement re-registers with preserved Call-ID and
 *   an increased CSeq while the old generation's pending promise rejects.
 */

import { describe, expect, it } from 'vitest';
// Public root only for the user-agent path (mirrors the packed consumer).
import {
  UserAgent,
  AuthManager,
  WorkerMediaController,
  StubMainMediaHandler,
  NodeWebSocketLiveness,
  WorkerRuntime,
  WorkerSupervisor,
  WorkerRestartError,
  STUB_SDP,
} from '../../packages/core/src/index.js';
import { TransportError } from '../../packages/core/src/errors.js';
import { Headers, makeRequest, makeResponse } from '../../packages/core/src/messages/index.js';
import type { SipRequestMessage, SipResponseMessage } from '../../packages/core/src/messages/message.js';
import { parseMessage } from '../../packages/core/src/messages/parser.js';
import { serializeMessage } from '../../packages/core/src/messages/serializer.js';
import { bodyText } from '../../packages/core/src/messages/message.js';
import { FakeClock } from '../../packages/core/test/support/fake-clock.js';
import { FakeTransport } from '../../packages/core/test/support/fake-transport.js';
import { MockRegistrar } from '../../packages/core/test/support/mock-registrar.js';
import { toNativePingSocket, NodeWebSocketTransport } from '../../src/transport/node/ws.js';
import type { NodeWebSocketLike } from '../../src/transport/node/ws.js';
import type {
  RegistrationSnapshot,
  SupervisorToWorker,
  WorkerRuntimePort,
  WorkerSupervisorPort,
  WorkerToSupervisor,
} from '../../packages/core/src/bridge/worker-protocol.js';
import type { SupervisedWorker, WorkerFactory } from '../../packages/core/src/bridge/worker-supervisor.js';
import type { NativeNodeWebSocket } from '../../src/transport/node/ws.js';

const REGISTRAR_URI = 'sip:registrar.example.com';
const AOR = 'sip:alice@example.com';
const CONTACT = '<sip:alice@192.0.2.1:5060>';
const REMOTE = 'sip:bob@example.com';
const SDP_FIXTURE = 'v=0\r\no=- 0 0 IN IP4 0.0.0.0\r\ns=-\r\nt=0 0\r\nm=audio 49170 RTP/AVP 0\r\n';

function makeId(): { branch: () => string } {
  let n = 0;
  return { branch: (): string => `id-${(n += 1)}` };
}

/** Drain pending microtasks deterministically (no real timers). */
async function ticks(times = 6): Promise<void> {
  for (let i = 0; i < times; i += 1) await Promise.resolve();
}

/**
 * A synchronously-delivering two-sided media port. Posting a command fans out to
 * every subscriber; the stub handler replies synchronously, so offer/answer/setRemote
 * resolve on the next microtask with no real time.
 */
class LoopbackMediaPort {
  private readonly listeners = new Set<(message: any) => void>();
  postMessage(message: any): void {
    for (const listener of [...this.listeners]) listener(message);
  }
  subscribe(listener: (message: any) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

/** Wire the stub media pair (WorkerMediaController ↔ StubMainMediaHandler) over one port. */
function makeMediaPair() {
  const port = new LoopbackMediaPort();
  const controller = new WorkerMediaController(port);
  const stub = new StubMainMediaHandler(port);
  return { port, controller, stub };
}

/** All parsed messages sent over the transport. */
function sent(transport: FakeTransport) {
  return transport.sent
    .map((bytes) => parseMessage(bytes))
    .filter((m): m is { ok: true; value: SipRequestMessage | SipResponseMessage } => m.ok)
    .map((m) => m.value);
}

/** The Nth request of `method` sent so far (0-based). */
function nthRequest(transport: FakeTransport, method: string, index: number): SipRequestMessage | undefined {
  let seen = 0;
  for (const bytes of transport.sent) {
    const parsed = parseMessage(bytes);
    if (parsed.ok && parsed.value.kind === 'request' && parsed.value.method === method) {
      if (seen === index) return parsed.value;
      seen += 1;
    }
  }
  return undefined;
}

/** Microtask-poll until the Nth `method` request has been sent (bounded by a budget). */
async function waitForMethod(transport: FakeTransport, method: string, index = 0): Promise<SipRequestMessage> {
  for (let i = 0; i < 200; i += 1) {
    const req = nthRequest(transport, method, index);
    if (req !== undefined) return req;
    await ticks();
  }
  throw new Error(`timeout waiting for ${method} #${index}`);
}

/** Build a response echoing the request's routing headers. */
function echoResponse(request: SipRequestMessage, code: number, reason: string, extra: [string, string][] = []): SipResponseMessage {
  const headers = new Headers();
  headers.set('Via', request.headers.get('Via') ?? '');
  headers.set('From', request.headers.get('From') ?? '');
  const to = request.headers.get('To') ?? '';
  headers.set('To', /;tag=/.test(to) ? to : `${to};tag=server`);
  headers.set('Call-ID', request.headers.get('Call-ID') ?? '');
  headers.set('CSeq', request.headers.get('CSeq') ?? '');
  for (const [name, value] of extra) headers.set(name, value);
  return makeResponse(code, reason, headers);
}

/** Send a 401 Digest challenge for a REGISTER/INVITE so the retry carries Authorization. */
function sendChallenge(transport: FakeTransport, request: SipRequestMessage): void {
  transport.emitData(serializeMessage(
    echoResponse(request, 401, 'Unauthorized', [
      ['WWW-Authenticate', 'Digest realm="example.com", nonce="dcd98b7102dd2f0e8b11d0f600bfb0c093", qop="auth", algorithm=SHA-256'],
    ]),
  ));
}

/** Deliver an ordered list of responses as raw wires to the transport. */
function deliver(transport: FakeTransport, ...responses: SipResponseMessage[]): void {
  for (const response of responses) transport.emitData(serializeMessage(response));
}

/** Assert `needle` appears in `haystack` as a contiguous subsequence. */
function assertTraceContains(haystack: string[], needle: string[]): void {
  let at = 0;
  for (const state of haystack) {
    if (state === needle[at]) at += 1;
    if (at === needle.length) break;
  }
  expect(at).toBe(needle.length);
}

// ---------------------------------------------------------------------------
// Scenario A: the full lifecycle trace from the PUBLIC ROOT
// ---------------------------------------------------------------------------

describe('release smoke: Scenario A (full lifecycle from public root)', () => {
  it('registered → inviting → confirmed → terminated → unregistered with authenticated REGISTER/INVITE', async () => {
    const clock = new FakeClock();
    const transport = new FakeTransport({ reliable: true, framing: 'stream' });
    const idGenerator = makeId();
    const authManager = new AuthManager(idGenerator);
    const { controller: mediaController } = makeMediaPair();
    const ua = new UserAgent({
      transport,
      clock,
      registrarUri: REGISTRAR_URI,
      aor: AOR,
      contact: CONTACT,
      credentials: { username: 'alice', password: 'Circle Of Life' },
      idGenerator,
      authManager,
      mediaController,
    });
    const server = new MockRegistrar({ transport, challenge: true });

    const states: string[] = [];
    ua.on('registrationStateChanged', (e: any) => states.push(e.state));
    ua.on('callStateChanged', (e: any) => states.push(e.state));

    await ua.connect();
    server.start();

    // Authenticated REGISTER: challenge → retry with Authorization → 2xx.
    await ua.register();
    expect(ua.registerState).toBe('registered');
    const authReg = server.requests.map((r) => Boolean(r.headers.has('Authorization')));
    expect(authReg).toEqual([false, true]);

    // Outgoing INVITE: challenge → authenticated retry → provisional → 200 → confirmed.
    const invitePromise = ua.invite(REMOTE);
    const invite1 = await waitForMethod(transport, 'INVITE', 0);
    expect(invite1.headers.has('Authorization')).toBe(false);
    sendChallenge(transport, invite1);

    const invite2 = await waitForMethod(transport, 'INVITE', 1);
    expect(invite2.headers.has('Authorization')).toBe(true);
    // The offer body came from the media bridge: the deterministic STUB_SDP.
    expect(bodyText(invite2)).toBe(STUB_SDP);

    const echoedTo = (request: SipRequestMessage): SipResponseMessage =>
      echoResponse(request, 200, 'OK', [
        ['To', `${request.headers.get('To') ?? ''};tag=bob-tag`],
        ['Contact', '<sip:bob@192.0.2.2:5060>'],
        ['Content-Type', 'application/sdp'],
      ]);
    const ringing = echoResponse(invite2, 180, 'Ringing', [['To', `${invite2.headers.get('To') ?? ''};tag=bob-tag`]]);
    const okResponse = echoedTo(invite2);
    const okWithBody = makeResponse(
      okResponse.statusCode,
      okResponse.reasonPhrase,
      okResponse.headers,
      new TextEncoder().encode(SDP_FIXTURE),
    );
    deliver(transport, ringing, okWithBody);

    await invitePromise;
    expect(ua.callState).toBe('confirmed');
    expect(ua.identity).toBeDefined();

    // BYE → 200 → terminated.
    const byePromise = ua.bye();
    const bye = await waitForMethod(transport, 'BYE', 0);
    deliver(transport, echoResponse(bye, 200, 'OK'));
    await byePromise;

    // Unregister via Contact * / Expires 0.
    await ua.unregister();
    expect(ua.registerState).toBe('unregistered');
    const last = server.requests[server.requests.length - 1];
    expect(last?.headers.get('Contact')).toBe('*');

    await ua.disconnect();

    expect(states).toEqual(['registered', 'inviting', 'ringing', 'confirmed', 'terminating', 'terminated', 'unregistered']);
    assertTraceContains(states, ['registered', 'inviting', 'confirmed', 'terminated', 'unregistered']);
  });
});

// ---------------------------------------------------------------------------
// Scenario B: incoming call — answer, stop 2xx retransmission on ACK, handle BYE
// ---------------------------------------------------------------------------

describe('release smoke: Scenario B (incoming call, TU 2xx retransmission)', () => {
  it('answers, stops retransmitting the 2xx on ACK, then handles BYE', async () => {
    const clock = new FakeClock();
    const transport = new FakeTransport({ reliable: true, framing: 'stream' });
    const idGenerator = makeId();
    const authManager = new AuthManager(idGenerator);
    const media = makeMediaPair();
    const ua = new UserAgent({
      transport,
      clock,
      registrarUri: REGISTRAR_URI,
      aor: AOR,
      contact: CONTACT,
      credentials: { username: 'alice', password: 'Circle Of Life' },
      idGenerator,
      authManager,
      mediaController: media.controller,
    });
    const server = new MockRegistrar({ transport });
    const states: string[] = [];
    ua.on('registrationStateChanged', (e: any) => states.push(e.state));
    ua.on('callStateChanged', (e: any) => states.push(e.state));

    await ua.connect();
    server.start();
    await ua.register();

    // Incoming INVITE with an SDP offer.
    let invitation: any;
    ua.on('incomingCall', (event: any) => { invitation = event.invitation ?? event; });
    const inviteHeaders = new Headers();
    inviteHeaders.set('Via', 'SIP/2.0/UDP 192.0.2.2:5060;branch=z9hG4bK-inv-1');
    inviteHeaders.set('Max-Forwards', '70');
    inviteHeaders.set('From', `<${REMOTE}>;tag=bob-tag`);
    inviteHeaders.set('To', `<${AOR}>`);
    inviteHeaders.set('Call-ID', 'incoming-call-1');
    inviteHeaders.set('CSeq', '1 INVITE');
    inviteHeaders.set('Contact', `<${REMOTE}>`);
    inviteHeaders.set('Content-Type', 'application/sdp');
    const incomingInvite = makeRequest('INVITE', AOR, inviteHeaders, new TextEncoder().encode(SDP_FIXTURE));
    transport.emitData(serializeMessage(incomingInvite));
    await ticks();
    expect(invitation).toBeDefined();

    // Answer: one 200 OK is sent, then the TU retransmitter schedules at T1 (500ms on the clock).
    const answerPromise = invitation.answer(STUB_SDP);
    await ticks();
    expect(countStatusCode(sent(transport), 200)).toBe(1);

    // Advance past T1: the TU retransmits the 2xx (it is not yet confirmed).
    clock.advance(500);
    await ticks();
    expect(countStatusCode(sent(transport), 200)).toBe(2);

    // ACK matching the dialog stops retransmission and confirms the call.
    const ack = new Headers();
    ack.set('Via', 'SIP/2.0/UDP 192.0.2.2:5060;branch=z9hG4bK-ack-1');
    ack.set('Max-Forwards', '70');
    ack.set('From', `<${REMOTE}>;tag=bob-tag`);
    ack.set('To', `<${AOR}>;tag=${invitation.toTag}`);
    ack.set('Call-ID', 'incoming-call-1');
    ack.set('CSeq', '1 ACK');
    transport.emitData(serializeMessage(makeRequest('ACK', REMOTE, ack)));
    await answerPromise;
    expect(invitation.session.state).toBe('confirmed');

    // Advance well past T1 again: no further 2xx may be retransmitted.
    const afterAck = countStatusCode(sent(transport), 200);
    clock.advance(5000);
    await ticks();
    expect(countStatusCode(sent(transport), 200)).toBe(afterAck);

    // In-dialog BYE → 200 → terminated.
    const bye = new Headers();
    bye.set('Via', 'SIP/2.0/UDP 192.0.2.2:5060;branch=z9hG4bK-bye-1');
    bye.set('Max-Forwards', '70');
    bye.set('From', `<${REMOTE}>;tag=bob-tag`);
    bye.set('To', `<${AOR}>;tag=${invitation.toTag}`);
    bye.set('Call-ID', 'incoming-call-1');
    bye.set('CSeq', '2 BYE');
    transport.emitData(serializeMessage(makeRequest('BYE', REMOTE, bye)));
    await ticks();
    expect(invitation.session.state).toBe('terminated');
    expect(countStatusCode(sent(transport), 200)).toBe(afterAck + 1); // the BYE's own 200

    await ua.disconnect();

    assertTraceContains(states, ['registered', 'confirmed', 'terminated']);
  });
});

function countStatusCode(messages: (SipRequestMessage | SipResponseMessage)[], code: number): number {
  return messages.filter((m) => m.kind === 'response' && m.statusCode === code).length;
}

// ---------------------------------------------------------------------------
// Scenario C: liveness timeouts surface typed TransportErrors
// ---------------------------------------------------------------------------

describe('release smoke: Scenario C (liveness failures are typed)', () => {
  it('OPTIONS timeout (default strategy) reports one typed TransportError', async () => {
    const clock = new FakeClock();
    const transport = new FakeTransport({ reliable: true, framing: 'stream' });
    const idGenerator = makeId();
    const ua = new UserAgent({
      transport,
      clock,
      registrarUri: REGISTRAR_URI,
      aor: AOR,
      contact: CONTACT,
      idGenerator,
    });
    const failures: Error[] = [];
    ua.on('failed', (e: any) => failures.push(e.error));

    await ua.connect();

    // Probe interval is 30s; the non-INVITE transaction then times out at 64*T1 = 32s.
    clock.advance(70_000);

    expect(failures.length).toBe(1);
    expect(failures[0]).toBeInstanceOf(TransportError);
    expect((failures[0] as TransportError).message).toBe('liveness timeout');

    await ua.disconnect();
  });

  it('native Ping/Pong timeout (NodeWebSocketLiveness via toNativePingSocket) reports a typed TransportError', async () => {
    const clock = new FakeClock();
    const idGenerator = makeId();

    // A real Node WS transport over a fake WS that also exposes native ping/pong.
    const ws = new FakeNativeNodeWebSocket();
    const transport = new NodeWebSocketTransport(ws);
    const nativePing = toNativePingSocket(ws);
    expect(nativePing).toBeDefined();
    expect(toNativePingSocket({} as NativeNodeWebSocket)).toBeUndefined();

    const failures: Error[] = [];
    const ua = new UserAgent({
      transport,
      clock,
      registrarUri: REGISTRAR_URI,
      aor: AOR,
      contact: CONTACT,
      idGenerator,
      // Node composition root wiring: supply native ping/pong when the socket
      // exposes it (deferred from Task 1).
      liveness: new NodeWebSocketLiveness({
        socket: nativePing!,
        clock,
        probeIntervalMs: 1000,
        deadlineMs: 500,
        onFailure: (error) => failures.push(error),
      }),
    });

    const connecting = ua.connect();
    ws.emitOpen('sip');
    await connecting;

    // Probe at 1000ms (ping sent); deadline at +500ms (no pong) → one failure, then stop.
    clock.advance(1000);
    expect(ws.pings.length).toBe(1);
    clock.advance(500);

    expect(failures.length).toBe(1);
    expect(failures[0]).toBeInstanceOf(TransportError);
    expect((failures[0] as TransportError).message).toBe('liveness timeout');

    // Strategy stops after the timeout: advancing far does not probe again.
    clock.advance(60_000);
    expect(ws.pings.length).toBe(1);

    await ua.disconnect();
  });
});

/** A fake WS socket that also satisfies the native Ping/Pong surface. */
class FakeNativeNodeWebSocket implements NodeWebSocketLike, NativeNodeWebSocket {
  readonly listeners = new Map<string, Set<(args: any[]) => void>>();
  readonly pings: Uint8Array[] = [];
  readyState = 0;
  protocol = '';
  ping(payload: Uint8Array): void { this.pings.push(payload.slice()); }
  on(event: string, listener: (...args: any[]) => void): void {
    let set = this.listeners.get(event);
    if (set === undefined) { set = new Set(); this.listeners.set(event, set); }
    set.add(listener);
  }
  off(event: string, listener: (...args: any[]) => void): void {
    this.listeners.get(event)?.delete(listener);
  }
  removeListener?(event: string, listener: (...args: any[]) => void): void { this.off(event, listener); }
  send(_data: Uint8Array, callback: (error?: Error) => void): void { callback(undefined); }
  close(): void { this.readyState = 3; this.emit('close', 1000, new Uint8Array()); }
  emitOpen(protocol = 'sip'): void { this.protocol = protocol; this.readyState = 1; this.emit('open'); }
  private emit(event: string, ...args: any[]): void {
    for (const listener of [...(this.listeners.get(event) ?? [])]) (listener as any)(...args);
  }
}

// ---------------------------------------------------------------------------
// Scenario D: worker death — re-registration preserves Call-ID and advances CSeq
// ---------------------------------------------------------------------------

const D_SNAPSHOT: RegistrationSnapshot = {
  aor: AOR,
  registrar: REGISTRAR_URI,
  credentials: { username: 'alice', password: 'Circle Of Life' },
  registerExpires: 600,
  contactUri: CONTACT,
  callId: 'reg-a',
  nextCSeq: 18,
};

const D_HEARTBEAT = 1000;
const D_TIMEOUT = 3000;

/** Bidirectional in-memory port pair mirroring a MessageChannel worker boundary. */
class LinkedPortPair {
  private superListeners = new Set<(message: WorkerToSupervisor) => void>();
  private workerListeners = new Set<(message: SupervisorToWorker) => void>();
  supervisor: WorkerSupervisorPort = {
    postMessage: (message) => { for (const l of this.workerListeners) l(message); },
    subscribe: (listener) => { this.superListeners.add(listener); return () => this.superListeners.delete(listener); },
  };
  worker: WorkerRuntimePort = {
    postMessage: (message: WorkerToSupervisor) => { for (const l of this.superListeners) l(message); },
    subscribe: (listener: (message: SupervisorToWorker) => void) => { this.workerListeners.add(listener); return () => this.workerListeners.delete(listener); },
  };
  clear(): void { this.superListeners.clear(); this.workerListeners.clear(); }
}

/**
 * A fake worker beat: a linked port plus a live running WorkerRuntime + UserAgent
 * bootstrapped from the recovery snapshot. Mirrors the pattern in
 * test/integration/worker-recovery.test.ts, against the public root APIs.
 */
class FakeWorkerBeat implements SupervisedWorker {
  readonly pair: LinkedPortPair;
  readonly port: WorkerSupervisorPort;
  readonly clock: FakeClock;
  readonly server: MockRegistrar;
  readonly runtime: WorkerRuntime;
  terminated = false;
  private readonly transport: FakeTransport;

  constructor(clock: FakeClock) {
    this.clock = clock;
    this.pair = new LinkedPortPair();
    this.port = this.pair.supervisor;
    this.transport = new FakeTransport({ reliable: true, framing: 'stream' });
    this.server = new MockRegistrar({ transport: this.transport });
    this.runtime = new WorkerRuntime({
      port: this.pair.worker,
      buildUserAgent: (registration: RegistrationSnapshot) => {
        const idGenerator = makeId();
        return new UserAgent({
          transport: this.transport,
          clock,
          registrarUri: registration.registrar,
          aor: registration.aor,
          contact: registration.contactUri,
          credentials: registration.credentials,
          idGenerator,
          authManager: new AuthManager(idGenerator),
          // Resume the snapshot's Call-ID and next CSeq onto the wire.
          initialIdentity: { callId: registration.callId, nextCSeq: registration.nextCSeq },
        });
      },
    });
    this.server.start();
  }

  /** Awaits until this beat reports `registered` up to its supervisor half. */
  async waitRegistered(): Promise<void> {
    await this.runtime.ready();
    await Promise.resolve();
    await Promise.resolve();
  }

  /** Simulate the worker process dying: stop the runtime and drop the port. */
  kill(): void {
    this.runtime.close();
    this.pair.clear();
  }

  terminate(): void {
    this.terminated = true;
    this.kill();
  }

  get calls(): number {
    return this.server.requests.length;
  }

  get latestCSeq(): number | undefined {
    const req = this.server.requests[this.server.requests.length - 1];
    const cseq = req?.headers.get('CSeq');
    return cseq === undefined ? undefined : Number.parseInt(cseq.split(' ')[0] ?? '', 10);
  }

  get callIds(): string[] {
    return this.server.requests.map((r) => r.headers.get('Call-ID') ?? '');
  }
}

describe('release smoke: Scenario D (worker death and registration recovery)', () => {
  it('re-registers with preserved Call-ID and increased CSeq; old session promise rejects', async () => {
    const clock = new FakeClock();
    const beats: FakeWorkerBeat[] = [];
    const factory: WorkerFactory = {
      spawn: () => {
        const beat = new FakeWorkerBeat(clock);
        beats.push(beat);
        return { port: beat.port, terminate: () => beat.terminate() };
      },
    };

    const supervisor = new WorkerSupervisor({
      factory,
      clock,
      registration: D_SNAPSHOT,
      heartbeatIntervalMs: D_HEARTBEAT,
      heartbeatTimeoutMs: D_TIMEOUT,
    });

    // Pending registration is the "old session promise" that must reject on death.
    const pendingRegister: ReturnType<WorkerSupervisor['register']> = supervisor.register();

    supervisor.start();
    await beats[0]!.waitRegistered();
    const beat1 = beats[0]!;
    expect(beat1.latestCSeq).toBe(18);
    expect(beat1.callIds[0]).toBe('reg-a');

    // Kill generation 1 and advance past the heartbeat deadline → death + replacement.
    clock.advance(D_HEARTBEAT);
    beat1.kill();
    clock.advance(D_HEARTBEAT + D_TIMEOUT);

    // The pending (old) register rejects with a typed WorkerRestartError.
    await expect(pendingRegister).rejects.toBeInstanceOf(WorkerRestartError);

    expect(beats.length).toBe(2);
    expect(beats[0]!.terminated).toBe(true);

    // Generation 2 re-registers on the SAME Call-ID at the ADVANCED CSeq (19).
    await beats[1]!.waitRegistered();
    const beat2 = beats[1]!;
    expect(beat2.calls).toBeGreaterThan(0);
    expect(beat2.latestCSeq).toBe(19);
    expect(beat2.callIds[0]).toBe('reg-a');
  });
});
