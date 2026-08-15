/**
 * Bounded reconnect policy for a phone's signaling transport (v0.7).
 *
 * Owns one recovery cycle: an immediate first attempt, then exponential backoff
 * with full jitter, capped by one total deadline, `maxAttempts`, and
 * `maxDelayMs`. Browser online/offline hints pause only the creation of new
 * sockets — they never pause the total recovery deadline.
 *
 * The state machine uses only an injected {@link Clock} and an injected
 * `random`: no ambient timers or ambient randomness are ever constructed. One
 * retry timer, one total-deadline timer, and one attempt-generation token
 * exist at any time; every terminal path detaches lifecycle listeners and
 * clears timers exactly once.
 *
 * The connection surface is a narrow monitor: {@link ReconnectControllerDeps.connect}
 * registers success/failure callbacks for one attempt and returns a stop
 * handler. Callbacks may be driven synchronously (deterministic tests) or
 * bridged from an async socket by the production composition root.
 */

import { SipError } from '@sip-worker/core';
import type { Clock } from '@sip-worker/core/transport';
import type { ReconnectOptions } from '../phone/types.js';

/** Minimal online/offline hint surface the controller consumes. */
export interface ReconnectLifecycle {
  isOnline(): boolean;
  subscribeOnline(listener: () => void): () => void;
  subscribeOffline(listener: () => void): () => void;
}

/** Notification surface for one connection attempt, driven by the caller. */
export interface ConnectMonitor {
  onSuccess(): void;
  onFailure(reason: unknown): void;
}

/** Injected environment dependencies for deterministic control and testing. */
export interface ReconnectControllerDeps {
  readonly clock: Clock;
  readonly random: () => number;
  readonly lifecycle: ReconnectLifecycle;
  /**
   * Begin one connection attempt. Returns success/failure monitors and a stop
   * handler used on cancel/dispose. Implementations bridge the real async
   * socket by invoking the monitors when the socket opens or fails.
   */
  readonly connect: (monitor: ConnectMonitor) => () => void;
  /** Sink for safe diagnostics; a throwing sink must never break recovery. */
  readonly diagnostics: (message: string) => void;
}

const EXHAUSTED_CODE = 'CONNECTION_RECOVERY_EXHAUSTED' as const;
const ABORTED_CODE = 'OPERATION_ABORTED' as const;

export class ReconnectController {
  private readonly clock: Clock;
  private readonly random: () => number;
  private readonly lifecycle: ReconnectLifecycle;
  private readonly connectAttempt: (monitor: ConnectMonitor) => () => void;
  private readonly diagnostics: (message: string) => void;
  private readonly options: Readonly<ReconnectOptions>;

  private deferred: { promise: Promise<void>; resolve: () => void; reject: (error: SipError) => void } | undefined;
  private active = false;
  private attempt = 0;
  private retryTimerId: number | undefined;
  private deadlineTimerId: number | undefined;
  private generation = 0;
  private attemptInFlight = false;
  private disposed = false;
  private unsubscribes: Array<() => void> | undefined;
  private stopAttempt: (() => void) | undefined;

  constructor(options: Readonly<ReconnectOptions>, deps: ReconnectControllerDeps) {
    this.options = options;
    this.clock = deps.clock;
    this.random = deps.random;
    this.lifecycle = deps.lifecycle;
    this.connectAttempt = deps.connect;
    this.diagnostics = deps.diagnostics;
  }

  /**
   * Begin one bounded recovery cycle. Concurrent calls share the same returned
   * promise and drive exactly one cycle. Resolves when an attempt succeeds, or
   * rejects with {@link SipError} `CONNECTION_RECOVERY_EXHAUSTED` on deadline
   * or attempt exhaustion, or `OPERATION_ABORTED` on {@link cancel} or
   * {@link dispose}.
   */
  recover(): Promise<void> {
    const existing = this.deferred;
    if (existing !== undefined) return existing.promise;

    let resolveDeferred!: () => void;
    let rejectDeferred!: (error: SipError) => void;
    const promise = new Promise<void>((resolve, reject) => {
      resolveDeferred = resolve;
      rejectDeferred = reject;
    });
    this.deferred = { promise, resolve: resolveDeferred, reject: rejectDeferred };

    this.active = true;
    this.attempt = 0;
    this.generation += 1;
    this.attachLifecycle();

    // Arm the total deadline before the first attempt. Offline events never
    // cancel it.
    const { recoveryTimeoutMs } = this.options;
    this.deadlineTimerId = this.clock.setTimeout(() => {
      this.deadlineTimerId = undefined;
      this.fail(new SipError(0, `Connection recovery exhausted within ${String(recoveryTimeoutMs)} ms`, EXHAUSTED_CODE));
    }, recoveryTimeoutMs);

    void this.runAttempt();
    return promise;
  }

  /** Cancel an active cycle without emitting a terminal recovery failure. */
  cancel(): void {
    if (!this.active) return;
    this.fail(new SipError(0, 'Connection recovery cancelled', ABORTED_CODE));
  }

  /** Terminal teardown: detach lifecycle listeners, clear timers, stop the socket. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.active = false;
    this.generation += 1;
    this.cleanupNow();
    this.settleWith(new SipError(0, 'Connection recovery cancelled', ABORTED_CODE));
  }

  private runAttempt(): void {
    if (!this.active) return; // cycle no longer active (disposed/cancelled)
    if (this.attemptInFlight) return;

    const generation = this.generation;
    this.attempt += 1;
    this.attemptInFlight = true;
    const currentAttempt = this.attempt;
    const maxAttempts = this.options.maxAttempts;

    this.emitDiagnostics(`connection recovery attempt ${String(currentAttempt)}`);

    const monitor: ConnectMonitor = {
      onSuccess: () => {
        if (generation !== this.generation) return; // stale attempt completion
        this.attemptInFlight = false;
        this.stopAttempt = undefined;
        if (!this.active) return;
        this.succeed();
      },
      onFailure: () => {
        if (generation !== this.generation) return; // stale attempt completion
        this.attemptInFlight = false;
        this.stopAttempt = undefined;
        if (!this.active) return;
        if (currentAttempt >= maxAttempts) {
          this.fail(new SipError(0, `Connection recovery exhausted after ${String(maxAttempts)} attempts`, EXHAUSTED_CODE));
          return;
        }
        this.scheduleRetry(generation, currentAttempt);
      },
    };
    this.stopAttempt = this.connectAttempt(monitor);
  }

  private scheduleRetry(generation: number, lastAttempt: number): void {
    if (!this.active || generation !== this.generation) return;

    // Offline pauses creation of new sockets; leave only the total deadline
    // running. The retry is re-scheduled on online.
    if (!this.lifecycle.isOnline()) {
      this.clearRetryTimer();
      return;
    }

    const { initialDelayMs, maxDelayMs } = this.options;
    const next = lastAttempt + 1;
    // For attempt n > 1: ceiling = min(maxDelayMs, initialDelayMs * 2 ** (n - 2)).
    const ceiling = next <= 1
      ? 0
      : Math.min(maxDelayMs, initialDelayMs * 2 ** (next - 2));
    const delay = Math.floor(Math.max(0, Math.min(this.random(), 0.999999)) * ceiling);

    this.clearRetryTimer();
    this.retryTimerId = this.clock.setTimeout(() => {
      this.retryTimerId = undefined;
      this.runAttempt();
    }, delay);
  }

  private onOffline(): void {
    if (!this.active) return;
    // Offline cancels only the retry timer; it never cancels the total deadline.
    this.clearRetryTimer();
  }

  private onOnline(): void {
    if (!this.active) return;
    // Online schedules attempt-now only when a cycle is active and no attempt
    // is running.
    if (this.attemptInFlight) return;
    this.runAttempt();
  }

  private succeed(): void {
    if (!this.active) return;
    this.active = false;
    this.cleanupNow();
    this.settle();
  }

  private fail(error: SipError): void {
    if (!this.active) return;
    this.active = false;
    this.cleanupNow();
    this.settleWith(error);
  }

  private settle(): void {
    const deferred = this.deferred;
    if (deferred === undefined) return;
    this.deferred = undefined;
    deferred.resolve();
  }

  private settleWith(error: SipError): void {
    const deferred = this.deferred;
    if (deferred === undefined) return;
    this.deferred = undefined;
    deferred.reject(error);
  }

  private clearRetryTimer(): void {
    if (this.retryTimerId !== undefined) {
      this.clock.clearTimeout(this.retryTimerId);
      this.retryTimerId = undefined;
    }
  }

  private clearDeadlineTimer(): void {
    if (this.deadlineTimerId !== undefined) {
      this.clock.clearTimeout(this.deadlineTimerId);
      this.deadlineTimerId = undefined;
    }
  }

  private cleanupNow(): void {
    this.clearRetryTimer();
    this.clearDeadlineTimer();
    this.unsubscribeLifecycle();
    this.attemptInFlight = false;
    const stopAttempt = this.stopAttempt;
    this.stopAttempt = undefined;
    if (stopAttempt !== undefined) {
      try {
        stopAttempt();
      } catch {
        // A throwing stop handler cannot block terminal cleanup.
      }
    }
  }

  private attachLifecycle(): void {
    // Replace any listeners left over from a previous cycle before attaching.
    this.unsubscribeLifecycle();
    this.unsubscribes = [
      this.lifecycle.subscribeOnline(() => this.onOnline()),
      this.lifecycle.subscribeOffline(() => this.onOffline()),
    ];
  }

  private unsubscribeLifecycle(): void {
    const unsubscribes = this.unsubscribes;
    this.unsubscribes = undefined;
    if (unsubscribes === undefined) return;
    for (const unsubscribe of unsubscribes) {
      try {
        unsubscribe();
      } catch {
        // A throwing unsubscribe cannot block terminal cleanup.
      }
    }
  }

  private emitDiagnostics(message: string): void {
    try {
      this.diagnostics(message);
    } catch {
      // A throwing diagnostics sink must never break recovery.
    }
  }
}
