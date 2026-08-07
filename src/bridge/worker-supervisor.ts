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
 * The supervisor never touches `Worker`, `UserAgent`, or registration wiring —
 * it tracks generation, heartbeat, deferred rejection, and snapshot continuity.
 * Re-registration is the WorkerRuntime's job inside the worker.
 */

import type { Clock } from '../transport/index.js';
import type {
  RegistrationSnapshot,
  SupervisorToWorker,
  SupervisorEvent,
  WorkerRestartError as WorkerRestartErrorType,
  WorkerSupervisorPort,
  WorkerToSupervisor,
} from './worker-protocol.js';
import { WorkerRestartError } from './worker-protocol.js';

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
}

/** The supervisor's live worker reference. */
interface Current {
  readonly gen: number;
  readonly worker: SupervisedWorker;
  readonly detach: () => void;
}

let nextNonceCounter = 0;

export class WorkerSupervisor {
  private readonly factory: WorkerFactory;
  private readonly clock: Clock;
  private readonly heartbeatIntervalMs: number;
  private readonly heartbeatTimeoutMs: number;
  private readonly listeners = new Set<(event: SupervisorEvent) => void>();

  /** The private recovery snapshot; only Call-ID and next CSeq are ever updated. */
  private snapshot: RegistrationSnapshot;

  private nextGen = 1;
  private current?: Current;
  private pingTimer = -1;
  private deadlineTimer = -1;
  private outstandingNonce?: string;
  private pending?: { readonly gen: number; resolve: () => void; reject: (reason: unknown) => void };
  private started = false;

  constructor(options: WorkerSupervisorOptions) {
    this.factory = options.factory;
    this.clock = options.clock;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs;
    this.heartbeatTimeoutMs = options.heartbeatTimeoutMs;
    this.snapshot = options.registration;
  }

  /** The generation number of the live worker (0 before start). */
  get generation(): number {
    return this.current?.gen ?? 0;
  }

  /** Subscribe to supervisor lifecycle events. */
  subscribe(listener: (event: SupervisorEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Start the worker + heartbeat loop. */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.spawn();
    this.schedulePing();
  }

  /** Stop heartbeating and drop timers (does not terminate the worker). */
  stop(): void {
    this.started = false;
    this.clearPing();
    this.clearDeadline();
  }

  /** Await the next `registered` from the current generation. Rejects with a
   * `WorkerRestartError` if that generation dies before it registers. If the
   * supervisor has not started, the promise rejects immediately. */
  register(): Promise<void> {
    const gen = this.current?.gen ?? 0;
    if (!this.started || gen === 0) {
      return Promise.reject(new WorkerRestartError(gen, 'supervisor not started'));
    }
    return new Promise<void>((resolve, reject) => {
      this.pending = { gen, resolve, reject };
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
    if (!this.started) return;
    this.pingTimer = this.clock.setTimeout(() => this.ping(), this.heartbeatIntervalMs);
  }

  private ping(): void {
    if (!this.started || this.current === undefined) return;
    this.clearDeadline();
    nextNonceCounter += 1;
    const nonce = `hb-${nextNonceCounter}-${Math.random().toString(36).slice(2)}`;
    this.outstandingNonce = nonce;
    const ping: SupervisorToWorker = { type: 'heartbeatPing', generation: this.current.gen, nonce };
    this.current.worker.port.postMessage(ping);
    this.deadlineTimer = this.clock.setTimeout(() => this.onDeadline(), this.heartbeatTimeoutMs);
  }

  private onDeadline(): void {
    if (!this.started || this.current === undefined || this.outstandingNonce === undefined) return;
    const current = this.current;
    this.death(current, new Error('heartbeat timeout'));
  }

  private onWorkerMessage(gen: number, message: WorkerToSupervisor): void {
    // Ignore messages carrying a stale generation (belonging to a dead worker).
    if (this.current === undefined || this.current.gen !== gen) return;
    switch (message.type) {
      case 'registrationIdentity':
        // Update ONLY Call-ID and next CSeq from the worker's own identity.
        this.snapshot = { ...this.snapshot, callId: message.callId, nextCSeq: message.nextCSeq };
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
        if (this.pending !== undefined && this.pending.gen === gen) {
          const pending = this.pending;
          this.pending = undefined;
          pending.resolve();
        }
        break;
      default:
        break;
    }
  }

  /** Handle a dead worker: reject deferreds, emit, teardown, replace. */
  private death(current: Current, cause: unknown): void {
    const error: WorkerRestartErrorType = new WorkerRestartError(current.gen, `worker ${current.gen} died`, cause);

    // Reject every deferred belonging to the dead generation.
    if (this.pending !== undefined && this.pending.gen === current.gen) {
      const pending = this.pending;
      this.pending = undefined;
      pending.reject(error);
    }

    // Terminate/detach the dead worker so its messages stop arriving.
    current.detach();
    current.worker.terminate();

    this.emitError('workerDied', current.gen, error);

    // Create exactly one new generation.
    this.clearDeadline();
    this.outstandingNonce = undefined;
    this.spawn();
    this.emit('workerRestarted', this.current?.gen ?? this.nextGen - 1);
    this.schedulePing();
  }

  private emitError(type: 'workerDied', generation: number, error: WorkerRestartErrorType): void {
    for (const listener of this.listeners) listener({ type, generation, error });
  }

  private emit(type: 'workerRestarted', generation: number): void {
    for (const listener of this.listeners) listener({ type, generation });
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
