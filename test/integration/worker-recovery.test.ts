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
  readonly transport = new FakeTransport({ reliable: true, framing: 'stream' });
  readonly clock: FakeClock;
  readonly server: MockRegistrar;
  readonly runtime: WorkerRuntime;
  terminated = false;

  constructor(clock: FakeClock) {
    this.clock = clock;
    this.pair = new LinkedPortPair();
    this.port = this.pair.supervisor;
    const idGenerator = makeIdGenerator();
    this.transport = new FakeTransport({ reliable: true, framing: 'stream' });
    this.server = new MockRegistrar({ transport: this.transport });
    this.runtime = new WorkerRuntime({
      port: this.pair.worker,
      clock,
      buildUserAgent: () =>
        new UserAgent({
          transport: this.transport,
          clock,
          registrarUri: snapshot.registrar,
          aor: snapshot.aor,
          contact: snapshot.contactUri,
          credentials: snapshot.credentials,
          idGenerator,
          authManager: new AuthManager(idGenerator),
          initialIdentity: { callId: snapshot.callId, nextCSeq: snapshot.nextCSeq },
        }),
    });
  }

  /** Boot the runtime from the snapshot and wire the mock registrar. */
  async boot(): Promise<void> {
    this.server.start();
    await this.runtime.bootstrapAndRegister(snapshot);
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
    const boots: Promise<void>[] = [];
    const factory: WorkerFactory = {
      spawn: () => {
        const beat = new FakeWorkerBeat(clock);
        beats.push(beat);
        boots.push(beat.boot());
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

    // Generation 1 is spawned at start; it bootstraps and registers at CSeq 18.
    supervisor.start();
    await boots[0]!;
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

    // Generation 2 re-registers on the SAME Call-ID with the SAME next CSeq (18),
    // proving the snapshot was carried forward and no REGISTER CSeq was reused.
    await boots[1]!;
    const beat2 = beats[1]!;
    expect(beat2.calls).toBeGreaterThan(0);
    expect(beat2.latestCSeq).toBe(18);
    expect(beat2.callIds[0]).toBe('reg-a');
  });
});
