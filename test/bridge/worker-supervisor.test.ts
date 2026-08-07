/**
 * Unit tests for WorkerSupervisor + WorkerRuntime (virtual clock, fake worker).
 *
 * The fake worker is a single two-sided in-memory port (mirroring the FakePort
 * in test/media/bridge.test.ts): the supervisor writes outbound messages via
 * `postMessage` (observed on `delivered`), and the test injects inbound worker
 * messages via `deliver`. This keeps the heartbeat loop fully scripted under
 * the injected FakeClock — no real time, no real Worker global.
 */

import { describe, expect, it } from 'vitest';
import { FakeClock } from '../support/fake-clock.js';
import { FakeTransport } from '../support/fake-transport.js';
import { UserAgent } from '../../src/ua/user-agent.js';
import type {
  RegistrationSnapshot,
  SupervisorToWorker,
  WorkerRuntimePort,
  WorkerToSupervisor,
} from '../../src/bridge/worker-protocol.js';
import { WorkerSupervisor } from '../../src/bridge/worker-supervisor.js';
import { WorkerRuntime } from '../../src/bridge/worker-runtime.js';
import type {
  SupervisedWorker,
  WorkerFactory,
} from '../../src/bridge/worker-supervisor.js';

const HEARTBEAT_MS = 1000;
const TIMEOUT_MS = 3000;

/** Asserts a promise has not settled yet. */
const PENDING = Symbol('pending');
function expectPending<T>(promise: Promise<T>): Promise<void> {
  return expect(Promise.race([promise, PENDING])).resolves.toBe(PENDING);
}

function snapshot(over: Partial<RegistrationSnapshot> = {}): RegistrationSnapshot {
  const base = {
    aor: 'sip:alice@example.com',
    registrar: 'sip:registrar.example.com',
    credentials: { username: 'alice', password: 'Circle Of Life' },
    registerExpires: 600,
    contactUri: '<sip:alice@192.0.2.1:5060>',
    callId: 'reg-a',
    nextCSeq: 18,
  };
  return {
    ...base,
    ...over,
    callId: over.callId ?? base.callId,
    nextCSeq: over.nextCSeq ?? base.nextCSeq,
  };
}

/** A single two-sided in-memory worker port, mirroring the media FakePort. */
class FakePort {
  readonly delivered: SupervisorToWorker[] = [];
  private listeners = new Set<(message: WorkerToSupervisor) => void>();
  private closed = false;

  postMessage(message: SupervisorToWorker): void {
    if (this.closed) return;
    this.delivered.push(message);
  }

  subscribe(listener: (message: WorkerToSupervisor) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Inject an inbound worker message, as if across a structured-clone boundary. */
  deliver(message: WorkerToSupervisor): void {
    for (const listener of this.listeners) listener(message);
  }

  get listenerCount(): number {
    return this.listeners.size;
  }

  terminate(): void {
    this.closed = true;
    this.listeners.clear();
  }

  /** Last outbound supervisor→worker message. */
  get last(): SupervisorToWorker | undefined {
    return this.delivered[this.delivered.length - 1];
  }
}

/** A fake spawned worker beat. */
class FakeWorker {
  readonly port = new FakePort();
  terminated = false;

  constructor(readonly spawnIndex: number) {}

  get bootstrap(): SupervisorToWorker | undefined {
    return this.port.delivered.find((m) => m.type === 'bootstrap');
  }

  /** The latest heartbeatPing delivered to this port (undefined if none yet). */
  get latestPing(): { nonce: string; generation: number } | undefined {
    for (let i = this.port.delivered.length - 1; i >= 0; i -= 1) {
      const m = this.port.delivered[i]!;
      if (m.type === 'heartbeatPing') return { nonce: m.nonce, generation: m.generation };
    }
    return undefined;
  }
}

/** A fake worker factory: each spawn() creates the next beat in sequence. */
class FakeWorkerFactory implements WorkerFactory {
  readonly workers: FakeWorker[] = [];
  terminated = 0;

  spawn(): SupervisedWorker {
    const worker = new FakeWorker(this.workers.length + 1);
    this.workers.push(worker);
    return {
      port: worker.port,
      terminate: () => {
        worker.terminated = true;
        this.terminated += 1;
        worker.port.terminate();
      },
    };
  }

  get count(): number {
    return this.workers.length;
  }

  get current(): FakeWorker {
    const last = this.workers[this.workers.length - 1];
    if (last === undefined) throw new Error('no worker spawned');
    return last;
  }

  worker(spawnIndex: number): FakeWorker {
    const found = this.workers.find((w) => w.spawnIndex === spawnIndex);
    if (found === undefined) throw new Error(`no worker with spawnIndex ${spawnIndex}`);
    return found;
  }
}

interface Harness {
  clock: FakeClock;
  factory: FakeWorkerFactory;
  supervisor: WorkerSupervisor;
  events: { type: string; generation: number }[];
}

function setup(over: Partial<RegistrationSnapshot> = {}): Harness {
  const clock = new FakeClock();
  const factory = new FakeWorkerFactory();
  const supervisor = new WorkerSupervisor({
    factory,
    clock,
    registration: snapshot(over),
    heartbeatIntervalMs: HEARTBEAT_MS,
    heartbeatTimeoutMs: TIMEOUT_MS,
  });
  const events: { type: string; generation: number }[] = [];
  supervisor.subscribe((event) => {
    events.push({ type: event.type, generation: event.generation });
  });
  supervisor.start();
  return { clock, factory, supervisor, events };
}

/** Deliver `ready`, a progressed identity (past the boot's nextCSeq), then `registered`. */
function boot(h: Harness): { generation: number; callId: string; nextCSeq: number } {
  const worker = h.factory.current;
  const bootstrap = worker.bootstrap;
  expect(bootstrap).toBeDefined();
  const gen = bootstrap!.generation;
  // The identity reports progress past the boot snapshot (nextCSeq advances 18→19),
  // exercising the supervisor's snapshot-update branch.
  worker.port.deliver({ type: 'ready', generation: gen });
  worker.port.deliver({ type: 'registrationIdentity', generation: gen, callId: 'reg-a', nextCSeq: 19 });
  worker.port.deliver({ type: 'registered', generation: gen });
  return { generation: gen, callId: 'reg-a', nextCSeq: 19 };
}

/** Advance one heartbeat: fires the ping, then answer it with the real nonce. */
function heartbeat(h: Harness): string {
  // Advance just enough to emit the ping for the current worker.
  h.clock.advance(HEARTBEAT_MS);
  const ping = h.factory.current.latestPing;
  expect(ping).toBeDefined();
  h.factory.current.port.deliver({ type: 'heartbeatPong', generation: ping!.generation, nonce: ping!.nonce });
  return ping!.nonce;
}

describe('WorkerSupervisor heartbeat', () => {
  it('bootstraps generation 1 with the registration snapshot', () => {
    const h = setup({ callId: 'reg-a', nextCSeq: 18 });
    expect(h.supervisor.generation).toBe(1);
    const worker = h.factory.current;
    const bootstrap = worker.bootstrap;
    expect(bootstrap).toBeDefined();
    if (bootstrap?.type === 'bootstrap') {
      expect(bootstrap.generation).toBe(1);
      const reg = bootstrap.registration;
      expect(reg.callId).toBe('reg-a');
      expect(reg.nextCSeq).toBe(18);
      expect(reg.credentials).toEqual({ username: 'alice', password: 'Circle Of Life' });
    } else {
      throw new Error('expected bootstrap');
    }
    // Snapshot is structured-clone safe (plain data).
    expect(() => structuredClone(bootstrap)).not.toThrow();
  });

  it('pings with a fresh nonce and clears the deadline on a matching pong', () => {
    const h = setup();
    boot(h);
    const nonce = heartbeat(h);
    expect(nonce.length).toBeGreaterThan(0);
    // Still alive, no events.
    expect(h.events).toEqual([]);
    expect(h.factory.current.terminated).toBe(false);
  });

  it('ignores a stale nonce while waiting for the real one', () => {
    const h = setup();
    boot(h);
    h.clock.advance(HEARTBEAT_MS);
    const ping = h.factory.current.latestPing;
    expect(ping).toBeDefined();
    // A pong with the wrong nonce must not clear the outstanding deadline.
    h.factory.current.port.deliver({ type: 'heartbeatPong', generation: ping!.generation, nonce: 'stale-nonce' });
    expect(h.events).toEqual([]);
    // The real pong still clears it.
    h.factory.current.port.deliver({ type: 'heartbeatPong', generation: ping!.generation, nonce: ping!.nonce });
    expect(h.events).toEqual([]);
  });

  it('declares the worker dead and replaces it when the deadline is missed', () => {
    const h = setup();
    boot(h);
    h.clock.advance(HEARTBEAT_MS); // ping sent
    // Do not answer; advance past the pong deadline.
    h.clock.advance(TIMEOUT_MS);
    // Deterministic order: workerDied then workerRestarted.
    expect(h.events.map((e) => e.type)).toEqual(['workerDied', 'workerRestarted']);
    expect(h.events[0]?.generation).toBe(1);
    expect(h.events[1]?.generation).toBe(2);
    expect(h.supervisor.generation).toBe(2);
    // Exactly one replacement spawned.
    expect(h.factory.count).toBe(2);
    expect(h.factory.worker(1).terminated).toBe(true);
    expect(h.factory.worker(2).terminated).toBe(false);
  });
});

describe('WorkerSupervisor replacement + pending commands', () => {
  it('rejects pending commands from the dead generation with WorkerRestartError', async () => {
    const h = setup();
    boot(h);
    const registration = h.supervisor.register();
    await expectPending(registration);
    h.clock.advance(HEARTBEAT_MS);
    h.clock.advance(TIMEOUT_MS); // worker 1 dies
    await expect(registration).rejects.toThrow(/worker 1 died/);
    // The replacement can be registered again and resolves on its own `registered`.
    const replacement = h.supervisor.register();
    const gen = h.factory.current.bootstrap?.generation;
    h.factory.current.port.deliver({ type: 'registered', generation: gen! });
    await expect(replacement).resolves.toBeUndefined();
  });

  it('tears down the old worker listener after death', () => {
    const h = setup();
    boot(h);
    const oldWorker = h.factory.current;
    expect(oldWorker.port.listenerCount).toBeGreaterThan(0);
    h.clock.advance(HEARTBEAT_MS);
    h.clock.advance(TIMEOUT_MS);
    // Old worker port has no subscribers left (detached + terminated).
    expect(oldWorker.terminated).toBe(true);
    expect(oldWorker.port.listenerCount).toBe(0);
    // A late message on the old port must not reach the supervisor.
    const preCount = h.events.length;
    oldWorker.port.deliver({ type: 'heartbeatPong', generation: 1, nonce: 'late' });
    oldWorker.port.deliver({ type: 'registered', generation: 1 });
    expect(h.events.length).toBe(preCount);
    // The replacement generation continues heartbeating independently.
    h.clock.advance(HEARTBEAT_MS);
    expect(h.factory.worker(2).latestPing).toBeDefined();
  });

  it('bootstraps the replacement with the retained snapshot and emits workerRestarted', () => {
    const h = setup({ callId: 'reg-a', nextCSeq: 18 });
    boot(h);
    h.clock.advance(HEARTBEAT_MS);
    h.clock.advance(TIMEOUT_MS);
    const replaced = h.factory.worker(2).bootstrap;
    expect(replaced).toBeDefined();
    if (replaced?.type === 'bootstrap') {
      expect(replaced.registration.callId).toBe('reg-a');
      // The retained/advanced snapshot (identity reported 19) reaches the replacement.
      expect(replaced.registration.nextCSeq).toBe(19);
    }
    // workerRestarted carries the new generation.
    const restarted = h.events.find((e) => e.type === 'workerRestarted');
    expect(restarted?.generation).toBe(2);
  });
});

describe('WorkerSupervisor stop', () => {
  it('stops scheduling heartbeats after stop()', () => {
    const h = setup();
    boot(h);
    h.supervisor.stop();
    h.clock.advance(HEARTBEAT_MS * 10);
    // No new pings emitted on the current worker after stop.
    const pings = h.factory.current.port.delivered.filter((m) => m.type === 'heartbeatPing').length;
    expect(pings).toBe(0);
    expect(h.events).toEqual([]);
  });
});

describe('WorkerRuntime credential redaction', () => {
  /** A worker-half port capturing what the runtime posts out. */
  class WorkerRuntimePortCapture implements WorkerRuntimePort {
    readonly sent: WorkerToSupervisor[] = [];
    private listeners = new Set<(m: SupervisorToWorker) => void>();
    postMessage(message: WorkerToSupervisor): void {
      this.sent.push(message);
    }
    subscribe(listener: (m: SupervisorToWorker) => void): () => void {
      this.listeners.add(listener);
      return () => this.listeners.delete(listener);
    }
    push(message: SupervisorToWorker): void {
      for (const l of this.listeners) l(message);
    }
    get readySeen(): string[] {
      return this.sent.map((m) => JSON.stringify(m));
    }
  }

  it('raises a redacted error when registration fails inside register', async () => {
    const port = new WorkerRuntimePortCapture();
    const clock = new FakeClock();
    // The UA's register fails with a message carrying the password.
    const ua = new UserAgent({
      transport: new FakeTransport({ reliable: true, framing: 'stream' }),
      clock,
      registrarUri: 'sip:r.example.com',
      aor: 'sip:a@example.com',
      contact: '<sip:a@192.0.2.1:5060>',
      credentials: { username: 'alice', password: 'SuperSecret123' },
      idGenerator: makeIdGen(),
    });
    const uaShim = new Proxy(ua, {
      get(target, prop) {
        if (prop === 'register') {
          return () => Promise.reject(new Error('authentication failed for password SuperSecret123'));
        }
        const value = Reflect.get(target, prop);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const runtime = new WorkerRuntime({
      port,
      buildUserAgent: () => uaShim as unknown as UserAgent,
    });
    const snapshotWithSecret: RegistrationSnapshot = {
      aor: 'sip:a@example.com',
      registrar: 'sip:r.example.com',
      credentials: { username: 'alice', password: 'SuperSecret123' },
      registerExpires: 600,
      contactUri: '<sip:a@192.0.2.1:5060>',
      callId: 'reg-a',
      nextCSeq: 18,
    };
    port.push({ type: 'bootstrap', generation: 1, registration: snapshotWithSecret });
    let error: unknown;
    try {
      await runtime.ready();
    } catch (e) {
      error = e;
    }
    expect(error instanceof Error).toBe(true);
    const message = (error as Error).message;
    // The password must not appear in the surfaced error.
    expect(message).not.toContain('SuperSecret123');
    // The redaction token is present.
    expect(message).toContain('[redacted]');
    // No outbound event echoes the credential (register failed before any report).
    expect(port.sent).toHaveLength(0);
    runtime.close();
  });
});

function makeIdGen() {
  let n = 0;
  return { branch: () => `id-${(n += 1)}` };
}

