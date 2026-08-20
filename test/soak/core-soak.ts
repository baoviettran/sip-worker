import type { Clock } from '../../packages/core/src/transport/transport.js';
import { UserAgent } from '../../packages/core/src/ua/user-agent.js';
import { AuthManager } from '../../packages/core/src/auth/index.js';
import { Headers } from '../../packages/core/src/messages/index.js';
import { parseMessage } from '../../packages/core/src/messages/parser.js';
import { serializeMessage } from '../../packages/core/src/messages/serializer.js';
import { makeResponse } from '../../packages/core/src/messages/message.js';
import type { SipRequestMessage } from '../../packages/core/src/messages/message.js';
import { FakeTransport } from '../../packages/core/test/support/fake-transport.js';
import { MockRegistrar } from '../../packages/core/test/support/mock-registrar.js';
import { CountingClock, countSubscriptions } from './measure.js';
import type { SubscriptionCounter } from './measure.js';

const STUB_SDP = 'v=0\r\no=- 0 0 IN IP4 0.0.0.0\r\ns=-\r\nt=0 0\r\nm=audio 49170 RTP/AVP 0\r\n';
const SDP_BODY = new TextEncoder().encode(STUB_SDP);

/**
 * Deterministic peer on the shared `FakeTransport.onSend` slot. Answers
 * outgoing INVITE (180 + 200 with a remote To tag and SDP) and BYE (200);
 * ignores REGISTER/ACK/CANCEL. MUST be installed BEFORE `MockRegistrar.start()`
 * so the registrar's previousOnSend chain calls this handler first. Never
 * touches `previousOnSend` itself.
 */
export class AutoPeer {
  invitesHandled = 0;
  byesHandled = 0;

  constructor(private readonly transport: FakeTransport) {
    this.transport.onSend = (bytes) => this.handleSend(bytes);
  }

  private handleSend(bytes: Uint8Array): void {
    const parsed = parseMessage(bytes);
    if (!parsed.ok || parsed.value.kind !== 'request') return;
    const request = parsed.value;
    if (request.method === 'INVITE') {
      this.invitesHandled += 1;
      this.deliver(this.buildResponse(request, 180, 'Ringing', false));
      this.deliver(this.buildResponse(request, 200, 'OK', true));
    } else if (request.method === 'BYE') {
      this.byesHandled += 1;
      this.deliver(this.buildResponse(request, 200, 'OK', false));
    }
  }

  private buildResponse(request: SipRequestMessage, status: number, reason: string, withSdp: boolean) {
    const headers = new Headers();
    headers.set('Via', request.headers.get('Via') ?? '');
    headers.set('From', request.headers.get('From') ?? '');
    headers.set('To', `${request.headers.get('To') ?? ''};tag=remote-tag`);
    headers.set('Call-ID', request.headers.get('Call-ID') ?? '');
    headers.set('CSeq', request.headers.get('CSeq') ?? '');
    headers.set('Contact', '<sip:bob@192.0.2.2:5060>');
    if (withSdp) {
      headers.set('Content-Type', 'application/sdp');
      return makeResponse(status, reason, headers, SDP_BODY);
    }
    return makeResponse(status, reason, headers);
  }

  private deliver(response: ReturnType<typeof makeResponse>): void {
    this.transport.emitData(serializeMessage(response));
  }
}

export interface SoakHarness {
  readonly ua: UserAgent;
  readonly transport: FakeTransport;
  readonly clock: CountingClock;
  readonly registrar: MockRegistrar;
  readonly peer: AutoPeer;
  readonly subscriptions: SubscriptionCounter;
  readonly states: string[];
  dispose(): Promise<void>;
}

export function bootSoakHarness(): SoakHarness {
  const transport = new FakeTransport({ reliable: true, framing: 'stream' });
  // Order: AutoPeer first, MockRegistrar.start() second (it chains previousOnSend).
  const peer = new AutoPeer(transport);
  const registrar = new MockRegistrar({ transport, challenge: true });
  const clock = new CountingClock({ now: () => Date.now(), setTimeout, clearTimeout });
  const subscriptions = countSubscriptions(transport);

  let branchCounter = 0;
  const idGenerator = { branch: () => `branch-${++branchCounter}` };
  const authManager = new AuthManager(idGenerator);
  // Media controller stub copied verbatim from call.test.ts: the outgoing
  // invite carries an offer from createOffer, and the 200's SDP answer is
  // applied via setRemote.
  const mediaController = {
    createOffer: async () => STUB_SDP,
    createAnswer: async () => STUB_SDP,
    setRemote: async () => {},
  } as const;

  const ua = new UserAgent({
    transport,
    clock,
    registrarUri: 'sip:registrar.example.com',
    aor: 'sip:alice@example.com',
    contact: '<sip:alice@192.0.2.1:5060>',
    credentials: { username: 'alice', password: 'password123' },
    idGenerator,
    authManager,
    mediaController,
  });

  const states: string[] = [];
  ua.on('registrationStateChanged', (event: { state: string }) => states.push(event.state));
  ua.on('callStateChanged', (event: { state: string }) => states.push(event.state));

  return {
    ua,
    transport,
    clock,
    registrar,
    peer,
    subscriptions,
    states,
    dispose: () => ua.disconnect(),
  };
}

export interface CoreSoakSample {
  readonly tMs: number;
  readonly timers: number;
  readonly listeners: number;
}

export interface CoreSoakOptions {
  /** Number of call cycles to run (the loop also stops once maxDurationMs passes). */
  readonly cycles: number;
  /** Real pause between cycles (default 100ms). */
  readonly interCycleMs?: number;
  /** Wall-clock budget in ms; the loop stops early once elapsed time passes this. */
  readonly maxDurationMs?: number;
}

export interface CoreSoakResult {
  readonly samples: CoreSoakSample[];
  readonly callFailures: number;
  readonly invitesHandled: number;
  readonly byesHandled: number;
  /** CountingClock.pending() after ua.disconnect() — must be 0. */
  readonly zeroTimers: number;
  /** transport subscriber count after ua.disconnect() — must be 0. */
  readonly zeroListeners: number;
  readonly stateTrace: string[];
}

export async function runCoreSoak(options: CoreSoakOptions): Promise<CoreSoakResult> {
  const { cycles, interCycleMs = 100, maxDurationMs } = options;
  const harness = bootSoakHarness();
  const { ua, clock, registrar, peer, subscriptions, states } = harness;

  const samples: CoreSoakSample[] = [];
  let callFailures = 0;
  const startedAt = Date.now();

  try {
    await ua.connect();
    registrar.start();
    await ua.register();
    if (ua.registerState !== 'registered') throw new Error('register did not reach registered');

    for (let i = 0; i < cycles; i += 1) {
      const cycleStart = states.length;
      const ok = await runCallCycle(ua, states, cycleStart);
      if (!ok) callFailures += 1;
      samples.push({ tMs: Date.now(), timers: clock.pending(), listeners: subscriptions.count() });
      if (maxDurationMs !== undefined && Date.now() - startedAt >= maxDurationMs) break;
      await new Promise((resolve) => setTimeout(resolve, interCycleMs));
    }
  } finally {
    await harness.dispose();
  }

  return {
    samples,
    callFailures,
    invitesHandled: peer.invitesHandled,
    byesHandled: peer.byesHandled,
    zeroTimers: clock.pending(),
    zeroListeners: subscriptions.count(),
    stateTrace: states,
  };
}

async function runCallCycle(ua: UserAgent, states: string[], cycleStart: number): Promise<boolean> {
  try {
    await ua.invite('sip:bob@example.com');
    await waitForCondition(() => ua.callState === 'confirmed', 5_000);
    await ua.bye();
    // After bye() the UA clears the active inviter, so callState reads 'idle';
    // teardown is proven by the emitted state trace (call.test.ts convention).
    await waitForCondition(() => states.slice(cycleStart).includes('terminated'), 5_000);
    return true;
  } catch {
    return false;
  }
}

async function waitForCondition(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('waitForCondition: timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
