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
  SerializedError,
  SupervisorToWorker,
  WorkerRuntimePort,
  WorkerToSupervisor,
} from '../../src/bridge/worker-protocol.js';
import {
  WorkerClosedError,
  WorkerRegistrationError,
  WorkerRestartError,
} from '../../src/bridge/worker-protocol.js';
import { WorkerSupervisor } from '../../src/bridge/worker-supervisor.js';
import type {
  SupervisedWorker,
  WorkerFactory,
  WorkerSupervisorOptions,
} from '../../src/bridge/worker-supervisor.js';
import { WorkerRuntime } from '../../src/bridge/worker-runtime.js';

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

function setup(
  over: Partial<RegistrationSnapshot> = {},
  options: Partial<Pick<WorkerSupervisorOptions, 'maxRestarts' | 'restartWindowMs'>> = {},
): Harness {
  const clock = new FakeClock();
  const factory = new FakeWorkerFactory();
  const supervisor = new WorkerSupervisor({
    factory,
    clock,
    registration: snapshot(over),
    heartbeatIntervalMs: HEARTBEAT_MS,
    heartbeatTimeoutMs: TIMEOUT_MS,
    ...options,
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

/** Drive a full death+restart cycle on the current generation. */
function killAndAdvance(h: Harness): void {
  h.clock.advance(HEARTBEAT_MS);
  h.clock.advance(TIMEOUT_MS);
}

describe('WorkerSupervisor start-before-register', () => {
  it('rejects register() called before start with a typed WorkerRestartError', async () => {
    const clock = new FakeClock();
    const factory = new FakeWorkerFactory();
    const supervisor = new WorkerSupervisor({
      factory,
      clock,
      registration: snapshot(),
      heartbeatIntervalMs: HEARTBEAT_MS,
      heartbeatTimeoutMs: TIMEOUT_MS,
    });
    // Not started: register must reject immediately with generation 0 context.
    const result = supervisor.register();
    await expect(result).rejects.toBeInstanceOf(WorkerRestartError);
    await expect(result).rejects.toMatchObject({ generation: 0 });
  });

  it('rejects register() after stop() with a typed WorkerRestartError', async () => {
    const h = setup();
    boot(h);
    h.supervisor.stop();
    const result = h.supervisor.register();
    await expect(result).rejects.toBeInstanceOf(WorkerRestartError);
    // The stopped supervisor reports generation 0 (no live worker to register against).
    await expect(result).rejects.toMatchObject({ generation: 0 });
  });
});

describe('WorkerSupervisor registration failure', () => {
  it('rejects the pending register() with WorkerRegistrationError carrying generation context', async () => {
    const h = setup();
    // Bootstrap delivered, but not yet `registered`: a registrationFailed arrives.
    const gen = h.factory.current.bootstrap?.generation;
    expect(gen).toBe(1);
    const registration = h.supervisor.register();
    await expectPending(registration);
    const failure: SerializedError = {
      name: 'Error',
      message: 'authentication failed for [redacted]',
      stack: 'Error: authentication failed for [redacted]',
    };
    h.factory.current.port.deliver({ type: 'registrationFailed', generation: gen!, error: failure });
    await expect(registration).rejects.toBeInstanceOf(WorkerRegistrationError);
    await expect(registration).rejects.toMatchObject({ generation: gen });
    // The supervisor emits a registrationFailed event for observers.
    const failed = h.events.find((e) => e.type === 'registrationFailed');
    expect(failed?.generation).toBe(gen);
  });

  it('ignores a registrationFailed carrying a stale generation', async () => {
    const h = setup();
    boot(h);
    // Move to generation 2 so generation 1 is stale.
    killAndAdvance(h);
    expect(h.supervisor.generation).toBe(2);
    const preEvents = h.events.length;
    h.factory.current.port.deliver({
      type: 'registrationFailed',
      generation: 1,
      error: { name: 'Error', message: 'stale' },
    });
    expect(h.events.length).toBe(preEvents);
  });

  it('rejects a second register() on the same generation after registrationFailed', async () => {
    const h = setup();
    const gen = h.factory.current.bootstrap?.generation;
    expect(gen).toBe(1);
    const first = h.supervisor.register();
    await expectPending(first);
    h.factory.current.port.deliver({
      type: 'registrationFailed',
      generation: gen!,
      error: { name: 'Error', message: 'authentication failed for [redacted]' },
    });
    await expect(first).rejects.toBeInstanceOf(WorkerRegistrationError);
    // The worker is still alive and heartbeating — but a retry on the same
    // generation must fail loudly, not park a waiter that only resolves on death.
    const second = h.supervisor.register();
    await expect(second).rejects.toBeInstanceOf(WorkerRestartError);
    await expect(second).rejects.toMatchObject({ generation: gen });
  });

  it('allows register() on a fresh generation after stop/start even if the previous one failed', async () => {
    const h = setup();
    const gen = h.factory.current.bootstrap?.generation;
    expect(gen).toBe(1);
    const first = h.supervisor.register();
    await expectPending(first);
    h.factory.current.port.deliver({
      type: 'registrationFailed',
      generation: gen!,
      error: { name: 'Error', message: 'authentication failed for [redacted]' },
    });
    await expect(first).rejects.toBeInstanceOf(WorkerRegistrationError);
    // stop() then start() spawns a fresh generation (nextGen increments).
    h.supervisor.stop();
    h.supervisor.start();
    expect(h.supervisor.generation).toBeGreaterThan(gen!);
    // A register() on the new generation proceeds normally: parks, then resolves
    // on the new generation's `registered`.
    const retry = h.supervisor.register();
    await expectPending(retry);
    h.factory.current.port.deliver({ type: 'registered', generation: h.supervisor.generation });
    await expect(retry).resolves.toBeUndefined();
  });
});

describe('WorkerSupervisor death after send (pre-send identity checkpoint)', () => {
  it('retains the identity-report checkpoint so death after a full register never reuses a CSeq', () => {
    const h = setup({ callId: 'reg-a', nextCSeq: 18 });
    boot(h); // identity report advances snapshot to nextCSeq 19
    // Worker dies after a full register cycle; the supervisor must already have
    // checkpointed the advanced identity from the registrationIdentity report, so
    // the replacement never reuses CSeq 18. (The pre-send checkpoint — death
    // between send and 200 OK — is covered end-to-end by the integration test
    // "checkpoints the advanced CSeq at send time so a replacement never reuses
    // it".)
    killAndAdvance(h);
    const replaced = h.factory.worker(2).bootstrap;
    expect(replaced).toBeDefined();
    if (replaced?.type === 'bootstrap') {
      expect(replaced.registration.callId).toBe('reg-a');
      // Checkpointed at 19 — the replacement resumes from 19, not 18.
      expect(replaced.registration.nextCSeq).toBe(19);
    }
  });

  it('checkpoints a pre-send registrationIdentity before the worker dies mid-exchange', () => {
    const h = setup({ callId: 'reg-a', nextCSeq: 18 });
    // Bootstrap delivered but NO `registered` yet: simulate the pre-send
    // checkpoint by delivering a registrationIdentity (as the runtime now does at
    // send time, before the 200 OK). Then kill the worker mid-exchange.
    const gen = h.factory.current.bootstrap?.generation;
    h.factory.current.port.deliver({
      type: 'registrationIdentity',
      generation: gen!,
      callId: 'reg-a',
      nextCSeq: 19,
    });
    // No `registered` has arrived — the exchange is in flight. Kill the worker.
    killAndAdvance(h);
    const replaced = h.factory.worker(2).bootstrap;
    expect(replaced).toBeDefined();
    if (replaced?.type === 'bootstrap') {
      // The pre-send checkpoint (19) reached the supervisor before death, so the
      // replacement resumes from 19 even though no 200 OK ever arrived.
      expect(replaced.registration.callId).toBe('reg-a');
      expect(replaced.registration.nextCSeq).toBe(19);
    }
  });

  it('never lowers the persisted CSeq across replacement', () => {
    const h = setup({ callId: 'reg-a', nextCSeq: 18 });
    boot(h); // identity report advances snapshot to nextCSeq 19
    // A late registrationIdentity from the dead generation reports a LOWER CSeq
    // (5) than the checkpointed one (19); the supervisor must not lower the
    // persisted value. Since the dead gen's port is detached at death, this
    // message arrives via the stale-generation guard and is dropped — but even
    // if it had arrived before death, the never-lower rule would reject it.
    const deadGen = h.factory.worker(1).bootstrap?.generation;
    h.factory.worker(1).port.deliver({
      type: 'registrationIdentity',
      generation: deadGen!,
      callId: 'reg-a',
      nextCSeq: 5,
    });
    killAndAdvance(h);
    const replaced = h.factory.worker(2).bootstrap;
    expect(replaced).toBeDefined();
    if (replaced?.type === 'bootstrap') {
      // The checkpointed value (19 from boot's identity report) wins; 5 is rejected.
      expect(replaced.registration.nextCSeq).toBe(19);
    }
  });
});

describe('WorkerSupervisor concurrent waiters', () => {
  it('resolves all concurrent register() waiters on a single registered', async () => {
    const h = setup();
    // Bootstrap delivered but no `registered` yet: park multiple waiters.
    const gen = h.factory.current.bootstrap?.generation;
    expect(gen).toBe(1);
    const a = h.supervisor.register();
    const b = h.supervisor.register();
    const c = h.supervisor.register();
    await expectPending(a);
    await expectPending(b);
    await expectPending(c);
    // A single `registered` for the current generation resolves ALL of them.
    h.factory.current.port.deliver({ type: 'registered', generation: gen! });
    await expect(a).resolves.toBeUndefined();
    await expect(b).resolves.toBeUndefined();
    await expect(c).resolves.toBeUndefined();
  });

  it('rejects all concurrent waiters when the generation dies', async () => {
    const h = setup();
    boot(h);
    const a = h.supervisor.register();
    const b = h.supervisor.register();
    await expectPending(a);
    await expectPending(b);
    killAndAdvance(h);
    await expect(a).rejects.toBeInstanceOf(WorkerRestartError);
    await expect(b).rejects.toBeInstanceOf(WorkerRestartError);
  });
});

describe('WorkerSupervisor stop/start', () => {
  it('restarts the heartbeat loop and spawns a fresh generation after stop then start', () => {
    const h = setup();
    boot(h);
    const firstGen = h.supervisor.generation;
    expect(firstGen).toBe(1);
    h.supervisor.stop();
    // After stop, no new pings fire.
    h.clock.advance(HEARTBEAT_MS * 5);
    const pingsAfterStop = h.factory.current.port.delivered.filter((m) => m.type === 'heartbeatPing').length;
    expect(pingsAfterStop).toBe(0);
    // Start again: a new generation is spawned and heartbeats resume.
    h.supervisor.start();
    expect(h.supervisor.generation).toBeGreaterThan(firstGen);
    expect(h.factory.count).toBe(2);
    h.clock.advance(HEARTBEAT_MS);
    expect(h.factory.current.latestPing).toBeDefined();
  });
});

describe('WorkerSupervisor observer throw isolation', () => {
  it('keeps heartbeating and emitting events when one observer throws', () => {
    const h = setup();
    boot(h);
    // A throwing observer must not break the supervisor's emit loop.
    const thrower = (): void => {
      throw new Error('observer blew up');
    };
    h.supervisor.subscribe(thrower);
    // Suppress the expected console error noise from the throwing observer.
    const consoleError = console.error;
    console.error = () => undefined;
    try {
      killAndAdvance(h);
    } finally {
      console.error = consoleError;
    }
    // Both events were still emitted despite the thrower.
    expect(h.events.map((e) => e.type)).toContain('workerDied');
    expect(h.events.map((e) => e.type)).toContain('workerRestarted');
    expect(h.supervisor.generation).toBe(2);
    // The replacement keeps heartbeating.
    h.clock.advance(HEARTBEAT_MS);
    expect(h.factory.current.latestPing).toBeDefined();
  });
});

describe('WorkerSupervisor stale generations', () => {
  it('ignores registered from a dead generation and does not resolve new waiters', async () => {
    const h = setup();
    boot(h);
    killAndAdvance(h);
    expect(h.supervisor.generation).toBe(2);
    // Park a waiter on the live generation 2.
    const registration = h.supervisor.register();
    await expectPending(registration);
    // A late `registered` from the dead generation 1 must be ignored.
    h.factory.worker(1).port.deliver({ type: 'registered', generation: 1 });
    await expectPending(registration);
    // The live generation's `registered` resolves the waiter.
    h.factory.current.port.deliver({ type: 'registered', generation: 2 });
    await expect(registration).resolves.toBeUndefined();
  });

  it('ignores heartbeatPong from a dead generation', () => {
    const h = setup();
    boot(h);
    const deadGen = h.factory.worker(1).bootstrap?.generation;
    killAndAdvance(h);
    expect(h.supervisor.generation).toBe(2);
    // Advance to arm a deadline on the live generation 2.
    h.clock.advance(HEARTBEAT_MS);
    const livePing = h.factory.current.latestPing;
    expect(livePing).toBeDefined();
    // A late pong from the dead generation must not clear the live deadline.
    h.factory.worker(1).port.deliver({
      type: 'heartbeatPong',
      generation: deadGen!,
      nonce: 'irrelevant',
    });
    // The live deadline is still armed: answering the live ping clears it.
    h.factory.current.port.deliver({
      type: 'heartbeatPong',
      generation: livePing!.generation,
      nonce: livePing!.nonce,
    });
    expect(h.events).not.toContainEqual({ type: 'workerDied', generation: 2 });
  });
});

describe('WorkerSupervisor close', () => {
  it('terminates the worker and rejects all waiters with WorkerClosedError', async () => {
    const h = setup();
    boot(h);
    const a = h.supervisor.register();
    const b = h.supervisor.register();
    await expectPending(a);
    await expectPending(b);
    h.supervisor.close();
    await expect(a).rejects.toBeInstanceOf(WorkerClosedError);
    await expect(b).rejects.toBeInstanceOf(WorkerClosedError);
    // The worker is terminated.
    expect(h.factory.current.terminated).toBe(true);
  });

  it('stops scheduling heartbeats after close', () => {
    const h = setup();
    boot(h);
    h.supervisor.close();
    const beforePings = h.factory.workers
      .flatMap((w) => w.port.delivered)
      .filter((m) => m.type === 'heartbeatPing').length;
    h.clock.advance(HEARTBEAT_MS * 10);
    const afterPings = h.factory.workers
      .flatMap((w) => w.port.delivered)
      .filter((m) => m.type === 'heartbeatPing').length;
    expect(afterPings).toBe(beforePings);
  });

  it('register() after close rejects with WorkerClosedError', async () => {
    const h = setup();
    boot(h);
    h.supervisor.close();
    const result = h.supervisor.register();
    await expect(result).rejects.toBeInstanceOf(WorkerClosedError);
  });

  it('close is idempotent', () => {
    const h = setup();
    boot(h);
    expect(() => {
      h.supervisor.close();
      h.supervisor.close();
    }).not.toThrow();
  });
});

describe('WorkerSupervisor bounded restart policy', () => {
  it('emits restartLimitReached and stops restarting past the bound within the window', () => {
    // maxRestarts=2 within a 10s window: generations 1, 2, 3 are spawned; the
    // 3rd death (would-be gen 4) hits the bound and restart stops.
    const h = setup({}, { maxRestarts: 2, restartWindowMs: 10000 });
    boot(h);
    // Death 1 -> gen 2 (restart 1)
    killAndAdvance(h);
    expect(h.supervisor.generation).toBe(2);
    // Death 2 -> gen 3 (restart 2)
    killAndAdvance(h);
    expect(h.supervisor.generation).toBe(3);
    // Death 3 -> bound hit: no gen 4, restartLimitReached emitted.
    killAndAdvance(h);
    expect(h.events.map((e) => e.type)).toContain('restartLimitReached');
    expect(h.factory.count).toBe(3);
    // The last worker is terminated and no new one spawned.
    expect(h.factory.current.terminated).toBe(true);
  });

  it('rejects register() after the bound is hit, and stop/start resets the window', async () => {
    const h = setup({}, { maxRestarts: 1, restartWindowMs: 10000 });
    boot(h);
    // Death 1 -> gen 2 (restart 1, the only allowed restart).
    killAndAdvance(h);
    expect(h.supervisor.generation).toBe(2);
    // Death 2 -> bound hit.
    killAndAdvance(h);
    expect(h.events.map((e) => e.type)).toContain('restartLimitReached');
    // The supervisor has no live worker (generation 0); register() rejects.
    expect(h.supervisor.generation).toBe(0);
    const result = h.supervisor.register();
    // gen===0 path rejects with WorkerRestartError (supervisor not started
    // shape), pinning the post-limit behavior.
    await expect(result).rejects.toBeInstanceOf(WorkerRestartError);

    // Operator intervention: stop() resets the restart window, start() spawns
    // a fresh generation, and the supervisor can restart again.
    h.supervisor.stop();
    h.supervisor.start();
    expect(h.supervisor.generation).toBeGreaterThan(0);
    const freshGen = h.supervisor.generation;
    boot(h);
    expect(h.supervisor.generation).toBe(freshGen);
    // After reset, a death spawns a replacement (restart allowed again).
    killAndAdvance(h);
    expect(h.supervisor.generation).toBe(freshGen + 1);
    expect(h.events.map((e) => e.type)).toContain('workerRestarted');
  });

  it('clears the restart window via stop/start so restarting resumes after the bound', () => {
    // maxRestarts=1 within a 5s window: one restart allowed per 5s. After the
    // bound is hit, stop/start resets the window (operator intervention) so a
    // fresh generation can restart again.
    const h = setup({}, { maxRestarts: 1, restartWindowMs: 5000 });
    boot(h);
    // Death 1 -> gen 2 (restart 1).
    killAndAdvance(h);
    expect(h.supervisor.generation).toBe(2);
    // Death 2 -> bound hit (only 1 restart in the window).
    killAndAdvance(h);
    expect(h.events.map((e) => e.type).filter((t) => t === 'restartLimitReached').length).toBe(1);
    // Advance the clock past the window so the old restart timestamp evicts.
    // The supervisor is in the post-limit "started but no live worker" state;
    // stop/start clears the window and spawns a fresh generation.
    h.clock.advance(6000);
    h.supervisor.stop();
    h.supervisor.start();
    const freshGen = h.supervisor.generation;
    boot(h);
    expect(h.supervisor.generation).toBe(freshGen);
    // After the window evicted, a death spawns a replacement again.
    killAndAdvance(h);
    expect(h.supervisor.generation).toBe(freshGen + 1);
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
    // No outbound event echoes the credential. The runtime emits a
    // `registrationFailed` message on failure, which must also be redacted.
    const serialized = port.sent.map((m) => JSON.stringify(m)).join('\n');
    expect(serialized).not.toContain('SuperSecret123');
    runtime.close();
  });

  it('emits registrationFailed with a serialized, redacted error and rejects ready()', async () => {
    const port = new WorkerRuntimePortCapture();
    const clock = new FakeClock();
    const ua = new UserAgent({
      transport: new FakeTransport({ reliable: true, framing: 'stream' }),
      clock,
      registrarUri: 'sip:r.example.com',
      aor: 'sip:a@example.com',
      contact: '<sip:a@192.0.2.1:5060>',
      credentials: { username: 'alice', password: 'SuperSecret123' },
      idGenerator: makeIdGen(),
    });
    const failingCause = new Error('inner: password SuperSecret123 leaked');
    failingCause.stack = 'Error: inner: password SuperSecret123 leaked\n  at row';
    const uaShim = new Proxy(ua, {
      get(target, prop) {
        if (prop === 'register') {
          return () => Promise.reject(new Error('auth failed for password SuperSecret123', { cause: failingCause }));
        }
        const value = Reflect.get(target, prop);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const runtime = new WorkerRuntime({
      port,
      buildUserAgent: () => uaShim as unknown as UserAgent,
    });
    port.push({ type: 'bootstrap', generation: 7, registration: snapshot() });
    let error: unknown;
    try {
      await runtime.ready();
    } catch (e) {
      error = e;
    }
    // ready() rejects with the redacted top-level error.
    expect(error instanceof Error).toBe(true);
    expect((error as Error).message).toContain('[redacted]');
    expect((error as Error).message).not.toContain('SuperSecret123');

    // Exactly one registrationFailed message, carrying generation 7 + serialized cause.
    const failures = port.sent.filter((m) => m.type === 'registrationFailed');
    expect(failures).toHaveLength(1);
    const failure = failures[0]!;
    if (failure.type !== 'registrationFailed') throw new Error('expected registrationFailed');
    expect(failure.generation).toBe(7);
    expect(failure.error.message).not.toContain('SuperSecret123');
    expect(failure.error.message).toContain('[redacted]');
    // The stack is sanitized too.
    expect(failure.error.stack).not.toContain('SuperSecret123');
    // The cause chain is sanitized.
    expect(failure.error.cause?.message).not.toContain('SuperSecret123');
    expect(failure.error.cause?.stack).not.toContain('SuperSecret123');
    // No `registered` or `registrationIdentity` was emitted (registration failed).
    expect(port.sent.some((m) => m.type === 'registered')).toBe(false);
    runtime.close();
  });

  it('does not emit registrationFailed when registration succeeds', async () => {
    const port = new WorkerRuntimePortCapture();
    const clock = new FakeClock();
    const transport = new FakeTransport({ reliable: true, framing: 'stream' });
    const ua = new UserAgent({
      transport,
      clock,
      registrarUri: 'sip:r.example.com',
      aor: 'sip:a@example.com',
      contact: '<sip:a@192.0.2.1:5060>',
      credentials: { username: 'alice', password: 'pw' },
      idGenerator: makeIdGen(),
    });
    // Wire a mock registrar that grants 200 OK synchronously.
    const { MockRegistrar } = await import('../support/mock-registrar.js');
    const server = new MockRegistrar({ transport });
    server.start();
    const runtime = new WorkerRuntime({
      port,
      buildUserAgent: () => ua,
    });
    port.push({ type: 'bootstrap', generation: 1, registration: snapshot() });
    await runtime.ready();
    await Promise.resolve();
    await Promise.resolve();
    expect(port.sent.some((m) => m.type === 'registrationFailed')).toBe(false);
    expect(port.sent.some((m) => m.type === 'registered')).toBe(true);
    server.stop();
    runtime.close();
  });

  it('redacts a password value that follows a colon separator', async () => {
    const port = new WorkerRuntimePortCapture();
    const clock = new FakeClock();
    const ua = new UserAgent({
      transport: new FakeTransport({ reliable: true, framing: 'stream' }),
      clock,
      registrarUri: 'sip:r.example.com',
      aor: 'sip:a@example.com',
      contact: '<sip:a@192.0.2.1:5060>',
      credentials: { username: 'alice', password: 'hunter2' },
      idGenerator: makeIdGen(),
    });
    const uaShim = new Proxy(ua, {
      get(target, prop) {
        if (prop === 'register') {
          return () => Promise.reject(new Error('authentication failed for password: hunter2'));
        }
        const value = Reflect.get(target, prop);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const runtime = new WorkerRuntime({ port, buildUserAgent: () => uaShim as unknown as UserAgent });
    const snapshotWithSecret: RegistrationSnapshot = {
      aor: 'sip:a@example.com',
      registrar: 'sip:r.example.com',
      credentials: { username: 'alice', password: 'hunter2' },
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
    const message = (error as Error).message;
    // The colon-separated secret must be gone, not just the keyword.
    expect(message).not.toContain('hunter2');
    expect(message).toContain('[redacted]');
    runtime.close();
  });

  it('redacts a credentials value with an internal colon (bob:secret)', async () => {
    const port = new WorkerRuntimePortCapture();
    const clock = new FakeClock();
    const ua = new UserAgent({
      transport: new FakeTransport({ reliable: true, framing: 'stream' }),
      clock,
      registrarUri: 'sip:r.example.com',
      aor: 'sip:a@example.com',
      contact: '<sip:a@192.0.2.1:5060>',
      credentials: { username: 'alice', password: 'x' },
      idGenerator: makeIdGen(),
    });
    const uaShim = new Proxy(ua, {
      get(target, prop) {
        if (prop === 'register') {
          return () => Promise.reject(new Error('stored credentials=bob:secret'));
        }
        const value = Reflect.get(target, prop);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const runtime = new WorkerRuntime({ port, buildUserAgent: () => uaShim as unknown as UserAgent });
    const snapshotWithSecret: RegistrationSnapshot = {
      aor: 'sip:a@example.com',
      registrar: 'sip:r.example.com',
      credentials: { username: 'alice', password: 'x' },
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
    const message = (error as Error).message;
    expect(message).not.toContain('bob:secret');
    expect(message).not.toContain('secret');
    expect(message).toContain('[redacted]');
    runtime.close();
  });
});

function makeIdGen() {
  let n = 0;
  return { branch: () => `id-${(n += 1)}` };
}

