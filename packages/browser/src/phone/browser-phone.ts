/**
 * BrowserPhone: the production browser composition root (v0.7).
 *
 * Supplies the production WSS/recovery environment to a single
 * {@link PhoneRuntime}: one normalized config, a browser WebSocket transport
 * (via an injected {@link BrowserWebSocketFactory} — a browser global, so it
 * arrives through the seam per the architecture gate), a browser lifecycle
 * host, a media environment, a clock, an id generator, a reconnect controller,
 * and a diagnostics recorder. States are forwarded only after internal commit;
 * per-call ownership and media settlement live in the runtime.
 *
 * The {@link BrowserWebSocketFactory}, {@link BrowserLifecycleHost}, and
 * {@link BrowserMediaEnvironment} are **injected dependencies** chosen when the
 * phone is constructed (usually the real browser bindings). Nothing here reads
 * `navigator`, `RTCPeerConnection`, `window`, `globalThis`, or `WebSocket` at
 * import or in the constructor's wiring path.
 */

import { normalizeBrowserPhoneOptions } from './config.js';
import type { BrowserPhoneEventMap, BrowserPhoneOptions, ConnectionState, RegistrationState } from './types.js';
import { DiagnosticRecorder } from './diagnostics.js';
import { PhoneRuntime } from './runtime.js';
import type { PhoneRuntimeCoreOptions } from './runtime.js';
import type { BrowserWebSocketFactory } from '../transport/ws.js';
import { BrowserWebSocketTransport } from '../transport/ws.js';
import { ReconnectController } from '../recovery/reconnect-controller.js';
import type { ConnectMonitor } from '../recovery/reconnect-controller.js';
import { createBrowserLifecycleEnvironment } from '../recovery/browser-lifecycle.js';
import type { BrowserLifecycleHost } from '../recovery/browser-lifecycle.js';
import type { BrowserMediaEnvironment } from '../media/types.js';
import type { MediaManagerClock } from '../media/media-manager.js';
import type { IdGenerator } from '@sip-worker/core';
import type { BrowserCall } from './browser-call.js';
import type { TransportEvent } from '@sip-worker/core/transport';

/** Injected environment seams the phone needs (tests supply fakes). */
export interface PhoneEnvironment {
  readonly factory: BrowserWebSocketFactory;
  readonly lifecycle: BrowserLifecycleHost;
  readonly mediaEnvironment: BrowserMediaEnvironment;
  readonly clock: MediaManagerClock;
  readonly idGenerator: IdGenerator;
}

/** BrowserPhone constructor options: product config + injected environments. */
export interface BrowserPhoneInit {
  readonly options: BrowserPhoneOptions;
  readonly factory: BrowserWebSocketFactory;
  readonly lifecycle: BrowserLifecycleHost;
  readonly mediaEnvironment: BrowserMediaEnvironment;
  readonly clock?: MediaManagerClock;
  readonly idGenerator?: IdGenerator;
}

export class BrowserPhone {
  /** The single ownership runtime behind this phone. */
  private readonly runtime: PhoneRuntime;

  private readonly environment: PhoneEnvironment;
  private readonly diagnostics: DiagnosticRecorder;

  private readonly transport: BrowserWebSocketTransport;
  private readonly reconnect: ReconnectController;
  private readonly unsubscribeTransport: () => void;

  /** Lifetime guard: set after dispose; no continuation runs past it. */
  private disposed = false;

  /** Shared dispose promise (dispose is idempotent, like the runtime). */
  private disposePromise: Promise<void> | undefined;

  /** Whether the loss was a manual disconnect (suppresses automatic recovery). */
  private manualDisconnect = false;

  /** Monotonic recovery-generation token; bumped on every new recovery start. */
  private recoveryGeneration = 0;

  /**
   * Whether recovery is currently owed. Transport loss arms it only when the
   * loss is unexpected AND the registration was already registered (a
   * never-registered or manually-unregistered account must not re-register).
   */
  private recoveryPending = false;

  /** Recovery state mirrors that should never be double-forwarded by runtime. */
  private recovering = false;

  /** A user-initiated unregister has disabled automatic re-registration. */
  private manuallyUnregistered = false;

  constructor(init: BrowserPhoneInit) {
    const normalized = normalizeBrowserPhoneOptions(init.options);

    this.environment = {
      factory: init.factory,
      lifecycle: init.lifecycle,
      mediaEnvironment: init.mediaEnvironment,
      clock: init.clock ?? { now: () => Date.now(), setTimeout, clearTimeout },
      idGenerator: init.idGenerator ?? { branch: () => genId() },
    };

    this.diagnostics = new DiagnosticRecorder({
      logger: normalized.diagnostics?.logger ?? ((): void => {}),
    });

    const transport = new BrowserWebSocketTransport(
      normalized.signaling.url,
      this.environment.factory,
    );
    this.transport = transport;

    const runtimeOptions: PhoneRuntimeCoreOptions = {
      transport,
      clock: this.environment.clock,
      registrarUri: normalized.account.registrarUri,
      aor: normalized.account.aor,
      contact: normalized.account.contact,
      ...(normalized.account.username === undefined || normalized.account.password === undefined
        ? {}
        : { credentials: { username: normalized.account.username, password: normalized.account.password } }),
      idGenerator: this.environment.idGenerator,
      mediaEnvironment: this.environment.mediaEnvironment,
      mediaOptions: normalized.media ?? {},
      diagnostics: this.diagnostics,
    };

    this.runtime = new PhoneRuntime(runtimeOptions);

    const lifecycle = createBrowserLifecycleEnvironment(this.environment.lifecycle);
    this.reconnect = new ReconnectController(normalized.signaling.reconnect, {
      clock: this.environment.clock,
      random: Math.random,
      lifecycle,
      connect: (monitor): (() => void) => this.bridgeConnect(monitor),
      diagnostics: (message) => this.diagnostics.record('connection.recovery_failed', { reason: message }),
    });

    this.unsubscribeTransport = transport.subscribe((event) => {
      this.handleTransportEvent(event);
    });
  }

  get connectionState(): ConnectionState {
    return this.runtime.connectionState;
  }

  get registrationState(): RegistrationState {
    return this.runtime.registrationState;
  }

  /** The single live call, only when exactly one is live (else undefined). */
  get activeCall(): BrowserCall | undefined {
    return this.runtime.activeCall;
  }

  /** Subscribe to a phone event (delegates to the owning runtime). */
  on<K extends keyof BrowserPhoneEventMap>(
    event: K,
    listener: (value: BrowserPhoneEventMap[K]) => void,
  ): void {
    this.runtime.on(event, listener);
  }

  connect(): Promise<void> {
    // A fresh connect re-arms reconnection and clears a prior manual disconnect.
    this.manualDisconnect = false;
    return this.runtime.connect();
  }

  register(): Promise<void> {
    // A manual registration re-enables this registration and clears the flag
    // that previous unregister/recovery suppressed it.
    this.manuallyUnregistered = false;
    return this.runtime.register();
  }

  unregister(): Promise<void> {
    // Cancel any in-flight recovery: an explicit unregister wins over pending
    // automatic re-registration and DISABLES it for the life of this phone.
    this.manuallyUnregistered = true;
    this.cancelRecovery();
    // A recovery that was mid-flight leaves registration in `recovering`; the
    // explicit unregister resolves it to the unregistered fact.
    if (this.runtime.registrationState === 'recovering') {
      this.commitRegistration('unregistered');
    }
    return this.runtime.unregister();
  }

  createCall(target: string): BrowserCall {
    return this.runtime.createCall(target);
  }

  /**
   * Manually disconnect the signaling transport. This cancels any in-flight
   * recovery WITHOUT emitting a terminal failure and takes the connection back
   * to `disconnected`; automatic recovery is suppressed until the next
   * `connect()`. The registration is left as-is (an explicit unregister is a
   * separate, prior decision that also disables re-registration).
   */
  disconnect(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    this.manualDisconnect = true;
    this.cancelRecovery();
    this.transitionConnection('disconnected');
    return this.transport.disconnect();
  }

  dispose(): Promise<void> {
    if (this.disposed) return this.disposePromise ?? Promise.resolve();
    this.disposed = true;
    this.disposePromise = this.shutdown();
    return this.disposePromise;
  }

  private async shutdown(): Promise<void> {
    this.cancelRecovery();
    this.unsubscribeTransport();
    this.reconnect.dispose();
    await this.runtime.dispose();
  }

  // ------------------------------------------------------------------
  // Recovery orchestration.
  // ------------------------------------------------------------------

  /**
   * Bridge one bounded reconnect attempt to the real async transport connect.
   *
   * The {@link ReconnectController} drives attempts through a caller-driven
   * monitor: each `connect(monitor)` call must start a FRESH socket generation
   * and report success/failure when that generation settles. The returned stop
   * handler maps to `transport.disconnect()` so cancel/dispose tears down the
   * in-flight socket.
   *
   * The "detach between sequential attempts" carry is honored: a prior live-but-
   * idle socket generation is disconnected first so the next `connect()` builds
   * a brand-new generation instead of sharing {@link BrowserWebSocketTransport}'s
   * `this.current`. Because the prior attempt's connect promise settles exactly
   * once, the detach never double-drives the same attempt.
   */
  private bridgeConnect(monitor: ConnectMonitor): () => void {
    // Detach any live-but-idle current generation so the fresh connect below
    // opens a brand-new socket (a socket that never closes must not be reused).
    void this.transport.disconnect();
    void this.transport.connect().then(
      () => monitor.onSuccess(),
      (error) => monitor.onFailure(error),
    );
    return (): void => {
      void this.transport.disconnect();
    };
  }

  /**
   * Handle a transport `disconnected` event.
   *
   * Unexpected loss is a `disconnected` event that CARRIES an error (a non-clean
   * close code, e.g. 1006). It synchronously re-enters the phone into
   * `recovering` and starts the bounded pipeline, but only when the registration
   * was already registered and no manual unregister suppressed it. A clean
   * disconnect (a manual disconnect or the bridge's own detach) carries no error
   * and never triggers automatic recovery.
   */
  private handleTransportEvent(event: TransportEvent): void {
    if (this.disposed) return;
    if (event.type !== 'disconnected') return;
    // A clean (manual) disconnect or an explicit `disconnect()` carries no error
    // and never triggers automatic recovery. A manual disconnect also suppresses
    // recovery for any later close.
    if (this.manualDisconnect || event.error === undefined) {
      if (this.manualDisconnect) this.cancelRecovery();
      return;
    }
    // If a bounded recovery cycle is already running, this error-disconnect is a
    // failed recovery-ATTEMPT socket; the ReconnectController owns that failure
    // via the monitor and will schedule the next attempt. Starting a fresh cycle
    // here would strand/exhaust the pipeline, so it is ignored.
    if (this.recovering) return;

    // Otherwise this is the ORIGINAL unexpected loss. Arm a fresh cycle.
    this.recoveryGeneration += 1;
    const generation = this.recoveryGeneration;
    // Only an already-registered (and not manually-unregistered) registration is
    // owed re-registration. A never-registered account never enters `recovering`,
    // and a manually-unregistered account has re-registration disabled for life.
    const wasRegistered = !this.manuallyUnregistered
      && this.runtime.registrationState === 'registered';
    this.recoveryPending = wasRegistered;

    // Synchronous transition — observers read 'recovering' immediately.
    this.recovering = true;
    this.transitionConnection('recovering');
    if (wasRegistered) this.transitionRegistration('recovering');

    void this.runRecovery(generation);
  }

  /** Run the ordered bounded-recovery pipeline for a recovery generation. */
  private async runRecovery(generation: number): Promise<void> {
    try {
      await this.reconnect.recover();
    } catch (error) {
      if (!this.live(generation)) return;
      // Reconnect exhaustion/deadline is a genuine terminal failure.
      this.recovering = false;
      this.recoveryPending = false;
      this.finishConnectionRecovery(error);
      return;
    }
    if (!this.live(generation)) return;

    // Connection is healthy again. Restore registration only when it was owed.
    if (!this.recoveryPending) {
      this.recovering = false;
      this.transitionConnection('connected');
      return;
    }
    try {
      await this.runtime.coreInstance.recoverRegistration();
    } catch (error) {
      if (!this.live(generation)) return;
      this.recovering = false;
      this.recoveryPending = false;
      this.finishRegistrationRecovery();
      return;
    }
    if (!this.live(generation)) return;

    // Registration restored. Commit the recovered facts.
    this.recoveryPending = false;
    this.recovering = false;
    this.transitionRegistration('registered');
    this.transitionConnection('connected');
  }

  /** Guard: return false once the phone or this recovery generation ended. */
  private live(generation: number): boolean {
    return !this.disposed && generation === this.recoveryGeneration;
  }

  private finishConnectionRecovery(error: unknown): void {
    this.transitionConnection('failed');
    this.emitConnectionLost(error);
  }

  private finishRegistrationRecovery(): void {
    this.transitionConnection('failed');
    this.commitRegistration('failed');
    // Core's own recoverRegistration() already emits the canonical
    // REGISTRATION_RECOVERY_FAILED `failed` event (relayed through the runtime),
    // so the phone avoids an otherwise-duplicated event here.
  }

  /**
   * Surface the exhaustion of the bounded reconnect cycle. Core cannot produce
   * this code, so the phone owns the emission; other terminal `failed` events
   * (e.g. REGISTRATION_RECOVERY_FAILED) are relayed from core unchanged.
   */
  private emitConnectionLost(error: unknown): void {
    const err = error instanceof Error ? error : new Error(String(error));
    if ((err as Error & { code?: string }).code === undefined) {
      (err as Error & { code?: string }).code = 'CONNECTION_RECOVERY_EXHAUSTED';
    }
    this.transitionEmit('failed', { type: 'failed', error: err });
    this.diagnostics.record('connection.recovery_failed', { reason: 'exhausted' });
  }

  /** Cancel an active recovery cycle (manual disconnect / dispose). */
  private cancelRecovery(): void {
    this.recoveryGeneration += 1;
    this.recoveryPending = false;
    this.recovering = false;
    try {
      this.reconnect.cancel();
    } catch {
      // A throwing cancel cannot break the manual-disconnect/dispose path.
    }
  }

  // ------------------------------------------------------------------
  // Forward-after-commit transitions (phone-level; recovery intermediates are
  // silent, only committed terminal facts emit).
  // ------------------------------------------------------------------

  private transitionConnection(state: ConnectionState): void {
    (this.runtime as unknown as { commitConnection(s: ConnectionState): void }).commitConnection(state);
  }

  private transitionRegistration(state: RegistrationState): void {
    (this.runtime as unknown as { commitRegistrationFromCore(s: string): void }).commitRegistrationFromCore(state);
  }

  private commitRegistration(state: string): void {
    (this.runtime as unknown as { commitRegistrationFromCore(s: string): void }).commitRegistrationFromCore(state);
  }

  private transitionEmit(event: string, value: unknown): void {
    (this.runtime as unknown as { emit(e: string, v: unknown): void }).emit(event, value);
  }
}

let phoneIdCounter = 0;
function genId(): string {
  phoneIdCounter += 1;
  return `phone-${String(phoneIdCounter)}`;
}

