/**
 * End-to-end worker recovery integration test.
 *
 * A fake worker is a real WorkerRuntime wired to a UserAgent + MockRegistrar
 * over an in-memory two-way WorkerPort. The main-thread supervisor
 * (WorkerSupervisor) heartbeats it, the worker "dies", and the replacement
 * generation (a fresh WorkerRuntime + UserAgent on a fresh MockRegistrar)
 * restores registration with the preserved Call-ID and an advanced CSeq.
 *
 * All pacing runs on the injected FakeClock — no real time.
 */

import { describe, expect, it } from 'vitest';
import { FakeClock } from '../support/fake-clock.js';
import { FakeTransport } from '../support/fake-transport.js';
import { AuthManager } from '../../src/auth/manager.js';
import { UserAgent } from '../../src/ua/user-agent.js';
import { MockRegistrar } from '../support/mock-registrar.js';
import type {
  RegistrationSnapshot,
  SupervisorToWorker,
  WorkerSupervisorPort,
  WorkerToSupervisor,
  WorkerRuntimePort,
} from '../../src/bridge/worker-protocol.js';
import { WorkerRegistrationError } from '../../src/bridge/worker-protocol.js';
import { WorkerSupervisor } from '../../src/bridge/worker-supervisor.js';
import type { SupervisedWorker, WorkerFactory } from '../../src/bridge/worker-supervisor.js';
import { WorkerRuntime } from '../../src/bridge/worker-runtime.js';

const HEARTBEAT_MS = 1000;
const TIMEOUT_MS = 3000;

const snapshot: RegistrationSnapshot = {
  aor: 'sip:alice@example.com',
  registrar: 'sip:registrar.example.com',
  credentials: { username: 'alice', password: 'Circle Of Life' },
  registerExpires: 600,
  contactUri: '<sip:alice@192.0.2.1:5060>',
  callId: 'reg-a',
  nextCSeq: 18,
};

function makeIdGenerator() {
  let n = 0;
  return { branch: () => `id-${(n += 1)}` };
}

/**
 * A bidirectional linked port: one half faces the supervisor (main thread), the
 * other faces the worker. Messages written to either half fan out to the other
 * half's listener, exactly like a MessageChannel / Worker structured-clone
 * boundary, but synchronously under the virtual clock.
 */
class LinkedPortPair {
  private superListeners = new Set<(message: WorkerToSupervisor) => void>();
  private workerListeners = new Set<(message: SupervisorToWorker) => void>();

  /** Supervisor half. */
  supervisor: WorkerSupervisorPort = {
    postMessage: (message) => {
      for (const l of this.workerListeners) l(message);
    },
    subscribe: (listener) => {
      this.superListeners.add(listener);
      return () => this.superListeners.delete(listener);
    },
  };

  /** Worker half. */
  worker: WorkerRuntimePort = {
    postMessage: (message) => {
      for (const l of this.superListeners) l(message);
    },
    subscribe: (listener) => {
      this.workerListeners.add(listener);
      return () => this.workerListeners.delete(listener);
    },
  };

  /** Drop both halves' listeners, as if the worker process died. */
  clear(): void {
    this.superListeners.clear();
    this.workerListeners.clear();
  }
}

/** A fake worker beat: a linked port plus a live running WorkerRuntime + UA. */
class FakeWorkerBeat implements SupervisedWorker {
  readonly pair: LinkedPortPair;
  readonly port: WorkerSupervisorPort;
  readonly clock: FakeClock;
  readonly server: MockRegistrar;
  readonly runtime: WorkerRuntime;
  terminated = false;

  constructor(clock: FakeClock) {
    this.clock = clock;
    this.pair = new LinkedPortPair();
    this.port = this.pair.supervisor;
    const transport = new FakeTransport({ reliable: true, framing: 'stream' });
    this.server = new MockRegistrar({ transport });
    this.runtime = new WorkerRuntime({
      port: this.pair.worker,
      buildUserAgent: (registration: RegistrationSnapshot) =>
        new UserAgent({
          transport,
          clock,
          registrarUri: registration.registrar,
          aor: registration.aor,
          contact: registration.contactUri,
          credentials: registration.credentials,
          idGenerator: makeIdGenerator(),
          authManager: new AuthManager(makeIdGenerator()),
          // Resume the snapshot's Call-ID and next CSeq onto the wire.
          initialIdentity: { callId: registration.callId, nextCSeq: registration.nextCSeq },
        }),
    });
    this.server.start();
  }

  /** Awaits until this beat reports `registered` up to its supervisor half. */
  async waitRegistered(): Promise<void> {
    await this.runtime.ready();
    // Give the async connect()+register() a microtask to settle and report.
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

describe('worker recovery (integration)', () => {
  it('restores registration with preserved Call-ID and advanced CSeq after death', async () => {
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
      registration: snapshot,
      heartbeatIntervalMs: HEARTBEAT_MS,
      heartbeatTimeoutMs: TIMEOUT_MS,
    });
    const events: string[] = [];
    supervisor.subscribe((e) => events.push(e.type));

    // Generation 1 is spawned at start; it registers at CSeq 18 on Call-ID reg-a.
    supervisor.start();
    await beats[0]!.waitRegistered();
    const beat1 = beats[0]!;
    expect(beat1.calls).toBeGreaterThan(0);
    expect(beat1.latestCSeq).toBe(18);
    expect(beat1.callIds[0]).toBe('reg-a');

    // Advance to prompt the next heartbeat ping, then kill the worker before it
    // answers; advance past that ping's deadline so death is declared.
    clock.advance(HEARTBEAT_MS);
    beat1.kill();
    clock.advance(HEARTBEAT_MS + TIMEOUT_MS);
    expect(events).toEqual(['workerDied', 'workerRestarted']);
    expect(beats.length).toBe(2);
    expect(beats[0]!.terminated).toBe(true);

    // Generation 2 re-registers on the SAME Call-ID at the ADVANCED next CSeq (19):
    // the supervisor retained gen1's identity progress and the replacement resumes
    // it, so no REGISTER CSeq is reused.
    await beats[1]!.waitRegistered();
    const beat2 = beats[1]!;
    expect(beat2.calls).toBeGreaterThan(0);
    expect(beat2.latestCSeq).toBe(19);
    expect(beat2.callIds[0]).toBe('reg-a');
  });

  it('rejects the caller promise with WorkerRegistrationError when registration fails', async () => {
    const clock = new FakeClock();

    // A beat whose registrar never responds, so the REGISTER exchange times out
    // and the runtime emits registrationFailed end-to-end.
    class FailingBeat extends FakeWorkerBeat {
      constructor() {
        super(clock);
        // Stop the mock registrar from granting: silence it.
        this.server.stop();
        this.server.setResponding(false);
        this.server.start();
      }
    }

    const beats: FailingBeat[] = [];
    const factory: WorkerFactory = {
      spawn: () => {
        const beat = new FailingBeat();
        beats.push(beat);
        return { port: beat.port, terminate: () => beat.terminate() };
      },
    };

    const supervisor = new WorkerSupervisor({
      factory,
      clock,
      registration: snapshot,
      heartbeatIntervalMs: HEARTBEAT_MS,
      heartbeatTimeoutMs: TIMEOUT_MS,
    });
    const events: string[] = [];
    supervisor.subscribe((e) => events.push(e.type));

    supervisor.start();
    // Park a waiter on generation 1 before the registration settles.
    const registration = supervisor.register();
    // Drive the virtual clock far enough for the registrar's transaction timers
    // to fire the REGISTER timeout. Non-INVITE Timer F is 64*T1 = 32s; advance
    // past that horizon so the transaction layer fails the REGISTER exchange.
    // The runtime catches the failure and emits registrationFailed end-to-end.
    for (let i = 0; i < 80; i += 1) {
      clock.advance(500);
      // Yield microtasks between ticks so async settle progresses.
      await Promise.resolve();
    }
    // The registrationFailed event reached the supervisor's observers.
    expect(events).toContain('registrationFailed');
    // The caller's promise rejected with a typed WorkerRegistrationError.
    await expect(registration).rejects.toBeInstanceOf(WorkerRegistrationError);
    const failure = await registration.catch((e) => e);
    expect(failure.generation).toBe(1);
    // The beat's runtime also rejected ready().
    await expect(beats[0]!.runtime.ready()).rejects.toBeInstanceOf(Error);
  });

  it('checkpoints the advanced CSeq at send time so a replacement never reuses it', async () => {
    const clock = new FakeClock();

    // A beat whose registrar captures the REGISTER but never responds, opening a
    // window between send and 200 OK where the worker can die.
    let firstSendCSeq: number | undefined;
    class SilentBeat extends FakeWorkerBeat {
      constructor() {
        super(clock);
        // Silence the registrar so the REGISTER gets on the wire but no 200 OK.
        this.server.stop();
        this.server.setResponding(false);
        this.server.start();
      }
    }

    const beats: SilentBeat[] = [];
    const factory: WorkerFactory = {
      spawn: () => {
        const beat = new SilentBeat();
        beats.push(beat);
        return { port: beat.port, terminate: () => beat.terminate() };
      },
    };

    const supervisor = new WorkerSupervisor({
      factory,
      clock,
      registration: snapshot,
      heartbeatIntervalMs: HEARTBEAT_MS,
      heartbeatTimeoutMs: TIMEOUT_MS,
    });
    const events: string[] = [];
    supervisor.subscribe((e) => events.push(e.type));

    supervisor.start();
    // The runtime's performRegister calls ua.register() synchronously, which
    // advances nextCSeq from 18 to 19 and posts a pre-send registrationIdentity
    // checkpoint BEFORE the 200 OK arrives. Yield microtasks so the checkpoint
    // message reaches the supervisor.
    await Promise.resolve();
    await Promise.resolve();
    // The first beat sent REGISTER at CSeq 18 (the snapshot's nextCSeq); the
    // registrar advanced its counter to 19 and the runtime checkpointed that.
    firstSendCSeq = beats[0]!.latestCSeq;
    expect(firstSendCSeq).toBe(18);

    // Kill the worker in the send→200OK window: the register exchange is in
    // flight, no 200 OK has arrived, but the supervisor has already received
    // the pre-send identity checkpoint (nextCSeq 19).
    beats[0]!.kill();
    // Advance past the heartbeat deadline to declare generation 1 dead.
    clock.advance(HEARTBEAT_MS + TIMEOUT_MS);
    expect(events).toEqual(['workerDied', 'workerRestarted']);
    expect(beats.length).toBe(2);

    // The replacement bootstraps from the CHECKPOINTED CSeq (19), not the
    // pre-send value (18) — proving the pre-send identity checkpoint reached
    // the supervisor before the death window opened.
    const replaced = beats[1]!.runtime.bootstrapSnapshot;
    expect(replaced).toBeDefined();
    expect(replaced!.callId).toBe('reg-a');
    expect(replaced!.nextCSeq).toBe(19);

    // The replacement's first REGISTER carries CSeq 19 (not 18) on the wire.
    // Let the replacement register against a responding registrar.
    beats[1]!.server.setResponding(true);
    await beats[1]!.waitRegistered();
    expect(beats[1]!.latestCSeq).toBe(19);
    expect(beats[1]!.callIds[0]).toBe('reg-a');
  });
});
