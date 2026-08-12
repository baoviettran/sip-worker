/**
 * WorkerSupervisor: the main-thread supervisor that owns worker heartbeat and
 * replacement for the worker bridge.
 *
 * It spawns a worker through the injected `WorkerFactory`, boots it with the
 * private recovery snapshot, and heartbeats it: each period it sends a
 * `heartbeatPing` with a fresh nonce and expects a matching `heartbeatPong`.
 * The next ping is scheduled only after a pong (or a restart), so a single
 * outstanding deadline deterministically marks a dead worker.
 *
 * On death the supervisor:
 *  1. rejects every deferred belonging to the dead generation with
 *     `WorkerRestartError`,
 *  2. emits `workerDied`,
 *  3. terminates/detaches that worker,
 *  4. spawns exactly one replacement generation bootstrapped with the retained
 *     snapshot (Call-ID + next CSeq updated only from `registrationIdentity`),
 *  5. emits `workerRestarted`.
 *
 * A registration failure (worker→supervisor `registrationFailed`) rejects the
 * caller's promise(s) with a typed `WorkerRegistrationError` carrying the
 * generation context and a redacted serialized cause, and emits a
 * `registrationFailed` event. The supervisor does NOT terminate the worker on a
 * registration failure — the worker may still be alive and heartbeating; the
 * failure is a registration outcome, not a heartbeat death.
 *
 * Identity checkpointing: the supervisor updates the retained snapshot's
 * `callId` and `nextCSeq` ONLY from a `registrationIdentity` message whose
 * generation matches the live worker, and ONLY when the reported `nextCSeq` is
 * strictly greater than the checkpointed value — the persisted CSeq never goes
 * backward. This guarantees a replacement never reuses a REGISTER CSeq even if a
 * stale/late identity report arrives.
 *
 * Bounded restart policy: the supervisor bounds the number of restarts within a
 * sliding window (`restartWindowMs`). When a death would exceed `maxRestarts`
 * within the window, the supervisor emits `restartLimitReached`, terminates the
 * dead worker, and stops restarting — a crash-looping worker cannot restart
 * forever.
 *
 * `close()` is terminal: it terminates the worker, releases all waiters with
 * `WorkerClosedError`, stops scheduling heartbeats, and rejects future
 * `register()` calls. `stop()` is non-terminal: it pauses heartbeating and
 * clears the live-worker reference so a subsequent `start()` spawns a fresh
 * generation.
 *
 * The supervisor never touches `Worker`, `UserAgent`, or registration wiring —
 * it tracks generation, heartbeat, deferred rejection, and snapshot continuity.
 * Re-registration is the WorkerRuntime's job inside the worker.
 */

import type { Clock } from '../transport/index.js';
import type {
  RegistrationSnapshot,
  SerializedError,
  SupervisorToWorker,
  SupervisorEvent,
  WorkerClosedError as WorkerClosedErrorType,
  WorkerRegistrationError as WorkerRegistrationErrorType,
  WorkerRestartError as WorkerRestartErrorType,
  WorkerSupervisorPort,
  WorkerToSupervisor,
} from './worker-protocol.js';
import { WorkerClosedError, WorkerRegistrationError, WorkerRestartError } from './worker-protocol.js';

/** A worker the supervisor can address and tear down. */
export interface SupervisedWorker {
  readonly port: WorkerSupervisorPort;
  /** Terminate/detach the underlying worker process. */
  terminate(): void;
}

/** Produces a fresh worker for each generation. */
export interface WorkerFactory {
  spawn(): SupervisedWorker;
}

export interface WorkerSupervisorOptions {
  readonly factory: WorkerFactory;
  readonly clock: Clock;
  /** The private recovery snapshot carried across replacement. */
  readonly registration: RegistrationSnapshot;
  readonly heartbeatIntervalMs: number;
  readonly heartbeatTimeoutMs: number;
  /**
   * Maximum number of restarts allowed within `restartWindowMs`. When the bound
   * is hit, the supervisor emits `restartLimitReached` and stops restarting.
   * Defaults to Infinity (no bound) for backwards compatibility.
   */
  readonly maxRestarts?: number;
  /** Sliding window for the restart bound. Defaults to Infinity ms. */
  readonly restartWindowMs?: number;
  /**
   * Optional sink for observer errors. When a subscribed observer throws during
   * event fan-out, the error is passed here so the environment can record or
   * surface it without the core depending on a global `console`. Defaults to a
   * no-op; diagnostics are opt-in.
   */
  readonly onObserverError?: (error: unknown) => void;
}

/** The supervisor's live worker reference. */
interface Current {
  readonly gen: number;
  readonly worker: SupervisedWorker;
  readonly detach: () => void;
}

/** A pending register() waiter parked on a generation. */
interface Waiter {
  readonly gen: number;
  readonly resolve: () => void;
  readonly reject: (reason: unknown) => void;
}

let nextNonceCounter = 0;

export class WorkerSupervisor {
  private readonly factory: WorkerFactory;
  private readonly clock: Clock;
  private readonly heartbeatIntervalMs: number;
  private readonly heartbeatTimeoutMs: number;
  private readonly maxRestarts: number;
  private readonly restartWindowMs: number;
  private readonly onObserverError: (error: unknown) => void;
  private readonly listeners = new Set<(event: SupervisorEvent) => void>();

  /** The private recovery snapshot; only Call-ID and next CSeq are ever updated. */
  private snapshot: RegistrationSnapshot;

  private nextGen = 1;
  private current?: Current;
  private pingTimer = -1;
  private deadlineTimer = -1;
  private outstandingNonce?: string;
  /** All pending register() waiters, keyed by generation they wait on. */
  private readonly waiters = new Set<Waiter>();
  private started = false;
  private closed = false;
  /** Timestamps (ms since epoch of the injected clock) of past restarts. */
  private readonly restartTimestamps: number[] = [];
  /** Generation whose registration failed; a retry on it rejects immediately. */
  private registrationFailedGen = -1;

  constructor(options: WorkerSupervisorOptions) {
    this.factory = options.factory;
    this.clock = options.clock;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs;
    this.heartbeatTimeoutMs = options.heartbeatTimeoutMs;
    this.snapshot = options.registration;
    this.maxRestarts = options.maxRestarts ?? Number.POSITIVE_INFINITY;
    this.restartWindowMs = options.restartWindowMs ?? Number.POSITIVE_INFINITY;
    this.onObserverError = options.onObserverError ?? (() => undefined);
  }

  /** The generation number of the live worker (0 before start or after stop/close). */
  get generation(): number {
    return this.current?.gen ?? 0;
  }

  /** Subscribe to supervisor lifecycle events. */
  subscribe(listener: (event: SupervisorEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Start the worker + heartbeat loop. A no-op if already started or closed. */
  start(): void {
    if (this.closed || this.started) return;
    this.started = true;
    this.spawn();
    this.schedulePing();
  }

  /**
   * Stop heartbeating, tear down the live generation, and reject its waiters.
   * Detaches and terminates the current generation exactly once, clears timers,
   * and drops the live-worker reference so a subsequent `start()` spawns a fresh
   * generation and resets the bounded-restart window — so a manual restart cycle
   * clears any prior crash-loop bound. Use `close()` for terminal teardown.
   */
  stop(): void {
    if (!this.started) return;
    this.started = false;
    this.clearPing();
    this.clearDeadline();
    this.outstandingNonce = undefined;

    const current = this.current;
    this.current = undefined;
    if (current !== undefined) {
      current.detach();
      current.worker.terminate();
      this.rejectGenerationWaiters(
        current.gen,
        new WorkerRestartError(current.gen, 'worker supervisor stopped'),
      );
    }
    this.restartTimestamps.length = 0;
  }

  /**
   * Terminal close: terminate the worker, reject all waiters with
   * `WorkerClosedError`, stop scheduling heartbeats, and reject future
   * `register()` calls. Idempotent.
   */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.started = false;
    this.clearPing();
    this.clearDeadline();
    this.outstandingNonce = undefined;
    // Terminate and detach the live worker.
    if (this.current !== undefined) {
      this.current.detach();
      this.current.worker.terminate();
      this.current = undefined;
    }
    // Release every pending waiter with a typed close error.
    this.rejectAllWaiters(new WorkerClosedError());
  }

  /**
   * Await the next `registered` from the current generation. Rejects with a
   * `WorkerRestartError` if that generation dies before it registers, with a
   * `WorkerRegistrationError` if the worker reports a registration failure, or
   * with a `WorkerClosedError` if the supervisor is closed. If the supervisor
   * has not started (or has stopped), rejects immediately with a
   * `WorkerRestartError` carrying generation 0.
   */
  register(): Promise<void> {
    if (this.closed) {
      return Promise.reject(new WorkerClosedError());
    }
    const gen = this.current?.gen ?? 0;
    if (!this.started || gen === 0) {
      return Promise.reject(new WorkerRestartError(gen, 'supervisor not started'));
    }
    if (gen === this.registrationFailedGen) {
      return Promise.reject(new WorkerRestartError(gen, `generation ${gen} already failed to register; stop()/start() to reset`));
    }
    return new Promise<void>((resolve, reject) => {
      this.waiters.add({ gen, resolve, reject });
    });
  }

  /** Spawn one new generation and boot it with the retained snapshot. */
  private spawn(): void {
    const gen = this.nextGen;
    this.nextGen += 1;
    const worker = this.factory.spawn();
    const detach = worker.port.subscribe((message) => this.onWorkerMessage(gen, message));
    this.current = { gen, worker, detach };
    const bootstrap: SupervisorToWorker = {
      type: 'bootstrap',
      generation: gen,
      registration: this.snapshot,
    };
    worker.port.postMessage(bootstrap);
  }

  private schedulePing(): void {
    if (!this.started || this.closed) return;
    this.pingTimer = this.clock.setTimeout(() => this.ping(), this.heartbeatIntervalMs);
  }

  private ping(): void {
    if (!this.started || this.closed || this.current === undefined) return;
    this.clearDeadline();
    nextNonceCounter += 1;
    const nonce = `hb-${nextNonceCounter}-${Math.random().toString(36).slice(2)}`;
    this.outstandingNonce = nonce;
    const ping: SupervisorToWorker = { type: 'heartbeatPing', generation: this.current.gen, nonce };
    this.current.worker.port.postMessage(ping);
    this.deadlineTimer = this.clock.setTimeout(() => this.onDeadline(), this.heartbeatTimeoutMs);
  }

  private onDeadline(): void {
    if (!this.started || this.closed || this.current === undefined || this.outstandingNonce === undefined) return;
    const current = this.current;
    this.death(current, new Error('heartbeat timeout'));
  }

  private onWorkerMessage(gen: number, message: WorkerToSupervisor): void {
    // Ignore messages carrying a stale generation (belonging to a dead/detached
    // worker). This is the guarded port/listener transition: a late message
    // from an old generation is never acted on.
    if (this.current === undefined || this.current.gen !== gen) return;
    switch (message.type) {
      case 'registrationIdentity':
        // Update ONLY Call-ID and next CSeq from the worker's own identity, and
        // NEVER lower the persisted CSeq: a stale/regressed report is dropped.
        // This is the pre-send identity checkpoint — the supervisor retains the
        // highest CSeq it has seen so a replacement never reuses one.
        if (message.nextCSeq > this.snapshot.nextCSeq) {
          this.snapshot = { ...this.snapshot, callId: message.callId, nextCSeq: message.nextCSeq };
        } else if (message.callId !== this.snapshot.callId) {
          // Call-ID may change even when CSeq does not advance.
          this.snapshot = { ...this.snapshot, callId: message.callId };
        }
        break;
      case 'heartbeatPong':
        // A stale nonce is ignored; only the exact outstanding nonce clears it.
        if (this.outstandingNonce === message.nonce) {
          this.clearDeadline();
          this.outstandingNonce = undefined;
          this.schedulePing();
        }
        break;
      case 'registered':
        // Resolve ALL waiters parked on this generation.
        this.resolveWaiters(gen);
        break;
      case 'registrationFailed':
        // Validate the message's own generation too: a stale `registrationFailed`
        // (carrying an old generation) arriving on the live worker's port must
        // not reject the current generation's waiters.
        if (message.generation === this.current.gen) {
          this.onRegistrationFailed(gen, message.error);
        }
        break;
      default:
        break;
    }
  }

  /** Handle a registration failure from the worker: reject waiters + emit. */
  private onRegistrationFailed(gen: number, cause: SerializedError): void {
    this.registrationFailedGen = gen;
    const error: WorkerRegistrationErrorType = new WorkerRegistrationError(gen, cause);
    // Reject every waiter parked on the failing generation (collect first to
    // avoid mutating the Set during iteration).
    const toReject: Waiter[] = [];
    for (const waiter of this.waiters) {
      if (waiter.gen === gen) toReject.push(waiter);
    }
    for (const waiter of toReject) {
      this.waiters.delete(waiter);
      waiter.reject(error);
    }
    this.emitRegistrationFailed(gen, error);
  }

  /** Handle a dead worker: reject deferreds, emit, teardown, maybe replace. */
  private death(current: Current, cause: unknown): void {
    const error: WorkerRestartErrorType = new WorkerRestartError(current.gen, `worker ${current.gen} died`, cause);

    // Reject every deferred belonging to the dead generation.
    this.rejectGenerationWaiters(current.gen, error);

    // Terminate/detach the dead worker so its messages stop arriving.
    current.detach();
    current.worker.terminate();

    this.emitError('workerDied', current.gen, error);

    // Drop the live reference so stale messages from the dead generation are
    // ignored by the guard at the top of onWorkerMessage.
    if (this.current === current) {
      this.current = undefined;
    }
    this.clearDeadline();
    this.outstandingNonce = undefined;

    // Bounded restart policy: if the bound is hit within the window, stop
    // restarting and emit restartLimitReached. Otherwise spawn one replacement.
    if (!this.mayRestart()) {
      this.emitRestartLimitReached(current.gen);
      // The dead worker is gone and no replacement is spawned; the supervisor is
      // still "started" but has no live worker. Heartbeat scheduling stops.
      return;
    }

    this.recordRestart();
    this.spawn();
    this.emit('workerRestarted', this.current?.gen ?? this.nextGen - 1);
    this.schedulePing();
  }

  /** True when a new restart is permitted within the bounded window. */
  private mayRestart(): boolean {
    if (!Number.isFinite(this.maxRestarts)) return true;
    const now = this.clock.now();
    // Drop timestamps outside the sliding window.
    while (this.restartTimestamps.length > 0 && this.restartTimestamps[0]! <= now - this.restartWindowMs) {
      this.restartTimestamps.shift();
    }
    return this.restartTimestamps.length < this.maxRestarts;
  }

  /** Record a restart timestamp for the sliding-window bound. */
  private recordRestart(): void {
    this.restartTimestamps.push(this.clock.now());
  }

  /** Resolve every waiter parked on `gen` (concurrent waiters share one registered). */
  private resolveWaiters(gen: number): void {
    const toResolve: Waiter[] = [];
    for (const waiter of this.waiters) {
      if (waiter.gen === gen) toResolve.push(waiter);
    }
    for (const waiter of toResolve) {
      this.waiters.delete(waiter);
      waiter.resolve();
    }
  }

  /** Reject every waiter parked on `gen` with the given error. */
  private rejectGenerationWaiters(gen: number, error: WorkerRestartErrorType): void {
    const toReject = [...this.waiters].filter((waiter) => waiter.gen === gen);
    for (const waiter of toReject) {
      this.waiters.delete(waiter);
      waiter.reject(error);
    }
  }

  /** Reject every waiter with the given error (used by close()). */
  private rejectAllWaiters(error: WorkerClosedErrorType): void {
    const toReject: Waiter[] = [];
    for (const waiter of this.waiters) toReject.push(waiter);
    for (const waiter of toReject) {
      this.waiters.delete(waiter);
      waiter.reject(error);
    }
  }

  private emitError(type: 'workerDied', generation: number, error: WorkerRestartErrorType): void {
    this.broadcast({ type, generation, error });
  }

  private emitRegistrationFailed(generation: number, error: WorkerRegistrationErrorType): void {
    this.broadcast({ type: 'registrationFailed', generation, error });
  }

  private emitRestartLimitReached(generation: number): void {
    this.broadcast({ type: 'restartLimitReached', generation });
  }

  private emit(type: 'workerRestarted', generation: number): void {
    this.broadcast({ type, generation });
  }

  /**
   * Broadcast an event to every subscriber. A throwing observer is isolated:
   * its error is reported through the injected `onObserverError` sink but does
   * not break the fan-out — remaining observers still receive the event.
   */
  private broadcast(event: SupervisorEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (error) {
        // Isolate the throwing observer: report and continue so a buggy listener
        // cannot silence the rest of the emit loop.
        this.onObserverError(error);
      }
    }
  }

  private clearPing(): void {
    if (this.pingTimer !== -1) {
      this.clock.clearTimeout(this.pingTimer);
      this.pingTimer = -1;
    }
  }

  private clearDeadline(): void {
    if (this.deadlineTimer !== -1) {
      this.clock.clearTimeout(this.deadlineTimer);
      this.deadlineTimer = -1;
    }
  }
}
