/**
 * PhoneRuntime: the single core/media/call ownership graph for the browser
 * phone (v0.7).
 *
 * This is COMPOSITION, not inheritance. {@link PhoneRuntime} owns exactly one
 * core SIP {@link @sip-worker/core#UserAgent}, one media bridge (port pair →
 * {@link WebRtcMediaManager} → {@link @sip-worker/core#WorkerMediaController}),
 * and the identity-indexed set of live {@link BrowserCall} owners. Producers
 * ({@link BrowserPhone} with a real WSS/recovery environment, or the advanced
 * injected-transport {@link BrowserUserAgent}) supply the environment seams and
 * read the phone/call facts; neither ever builds a second, parallel call graph.
 *
 * Global constraints honored: importing this module touches no `navigator`,
 * `RTCPeerConnection`, `window`, `globalThis`, or `WebSocket`. All browser
 * globals arrive through injected seams (a {@link BrowserMediaEnvironment}, a
 * {@link BrowserLifecycleHost}, a {@link BrowserWebSocketFactory}, a `Clock`,
 * an `IdGenerator`), so construction and every public mutation stay Node-safe.
 * No SDP, ICE candidate, credential, device id, or raw browser text is ever
 * copied into a shared error or public record.
 */

import type { Invitation } from '@sip-worker/core';
import { SipError, TypedEventEmitter } from '@sip-worker/core';
import { UserAgent as CoreUserAgent, WorkerMediaController } from '@sip-worker/core';
import type {
  RegistrationIdentity,
  UserAgentEventMap,
} from '@sip-worker/core';
import { WebRtcMediaManager } from '../media/media-manager.js';
import type { MediaManagerClock, WaitForConnectedOptions } from '../media/media-manager.js';
import { createMediaPortPair } from '../media/port-pair.js';
import type {
  BrowserMediaEnvironment,
  BrowserMediaEventMap,
  BrowserMediaOptions,
} from '../media/types.js';
import type { Transport } from '../transport/index.js';
import { BrowserCall, OutgoingBrowserCall, IncomingBrowserCall } from './browser-call.js';
import type {
  BrowserPhoneEventMap,
  CallState,
  ConnectionState,
  MediaError,
  RegistrationState,
} from './types.js';
import type { DiagnosticRecorder } from './diagnostics.js';

/** Core UA options PhoneRuntime composes, minus its owned media controller. */
export interface PhoneRuntimeCoreOptions {
  readonly transport: Transport;
  readonly clock: MediaManagerClock;
  readonly registrarUri: string;
  readonly aor: string;
  readonly contact: string;
  readonly credentials?: { readonly username: string; readonly password: string };
  readonly idGenerator: { branch(): string };
  readonly mediaEnvironment: BrowserMediaEnvironment;
  readonly mediaOptions: BrowserMediaOptions;
  /** Debug sink for the phone's lifecycle diagnostics. */
  readonly diagnostics?: DiagnosticRecorder;
  /** Recovery identity (Call-ID + next CSeq) to resume a registration. */
  readonly initialIdentity?: RegistrationIdentity;
  /**
   * Injected uniform random in [0,1) for the RFC 3261 14.2 glare-retry window.
   * Defaults to the real source (`Math.random`); tests inject a fixed value.
   */
  readonly random?: () => number;
}

/** Map a core session state to the public call state. */
export function callStateOf(sessionState: string): CallState {
  switch (sessionState) {
    case 'confirmed':
      return 'established';
    case 'terminating':
      return 'terminating';
    case 'terminated':
      return 'terminated';
    case 'failed':
      return 'failed';
    default:
      return 'establishing';
  }
}

function mapRegisterState(state: string): RegistrationState {
  switch (state) {
    case 'registered':
    case 'registering':
      return state;
    case 'recovering':
    case 'failed':
      return state;
    case 'unregistering':
    default:
      return 'unregistered';
  }
}

/** A single pending media-connected waiter for a session. */
interface MediaWaiter {
  resolve: () => void;
  reject: (error: unknown) => void;
  timer: number;
  settled: boolean;
}

const MEDIA_CONNECT_TIMEOUT_MS = 120_000;

export class PhoneRuntime extends TypedEventEmitter<BrowserPhoneEventMap & BrowserMediaEventMap> {
  /** The composed core SIP user agent (delegated, not inherited). */
  private readonly core: CoreUserAgent;

  /** The media manager bridging core commands to one browser session. */
  readonly manager: WebRtcMediaManager;

  /** The media port pair, torn down on dispose. */
  private readonly ports: ReturnType<typeof createMediaPortPair>;

  /** Controller bridge between core and the manager. */
  private readonly controller: WorkerMediaController;

  /** Clock shared by every owner in this runtime. */
  private readonly clockValue: MediaManagerClock;

  /** Diagnostic recorder for this runtime's lifecycle events. */
  private readonly diagnostics?: DiagnosticRecorder;

  /** Live calls, indexed BY OBJECT IDENTITY. */
  private readonly calls = new Set<BrowserCall>();

  /** Remote-hold unsubscribers per live call (owner push → call surface). */
  private readonly remoteHoldUnsubscribers = new Map<BrowserCall, () => void>();

  /** Media-connected waiters keyed by media session id. */
  private readonly mediaWaiters = new Map<string, Set<MediaWaiter>>();

  /** Sessions already observed at `connected`, per media session id. */
  private readonly connectedSessions = new Set<string>();

  /** Unsubscribe functions owned by this runtime, run on dispose. */
  private readonly cleanup: Array<() => void> = [];

  private connectionStateValue: ConnectionState = 'disconnected';
  private registrationStateValue: RegistrationState = 'unregistered';
  private disposed = false;
  private disposePromise: Promise<void> | undefined;

  constructor(options: PhoneRuntimeCoreOptions) {
    super();
    this.clockValue = options.clock;
    this.diagnostics = options.diagnostics;

    const coreOptions = {
      transport: options.transport,
      clock: options.clock,
      registrarUri: options.registrarUri,
      aor: options.aor,
      contact: options.contact,
      ...(options.credentials === undefined
        ? {} : { credentials: options.credentials }),
      idGenerator: options.idGenerator,
      ...(options.initialIdentity === undefined
        ? {} : { initialIdentity: options.initialIdentity }),
      random: options.random ?? Math.random,
    };

    // One in-memory media port pair. The core end is driven by the controller;
    // the browser end feeds commands into the manager.
    const ports = createMediaPortPair();
    this.ports = ports;

    const manager = new WebRtcMediaManager({
      env: options.mediaEnvironment,
      options: options.mediaOptions,
      clock: this.clock,
      emitter: {
        emit: (type: string, value: unknown): void => {
          this.onManagerEvent(type as keyof BrowserMediaEventMap, value);
        },
      },
    });
    this.manager = manager;

    this.cleanup.push(
      ports.browser.subscribe((message): void => {
        manager.postMessage(message);
      }),
      manager.subscribeReplies((reply): void => {
        // Posting to the BROWSER half fans out to the CORE half's listeners,
        // where the controller is subscribed.
        ports.browser.postMessage(reply);
      }),
    );

    this.controller = new WorkerMediaController(ports.core, {
      clock: this.clock,
      deadlineMs: (options.mediaOptions.mediaOperationTimeoutMs ?? 30_000) + 1_000,
    });

    this.core = new CoreUserAgent({ ...coreOptions, mediaController: this.controller });

    // Forward core UA events after internal commit only.
    const coreEmitter = this.core as unknown as TypedEventEmitter<UserAgentEventMap>;
    coreEmitter.on('registrationStateChanged', (value) => {
      this.commitRegistrationFromCore((value as { state: string }).state);
    });
    coreEmitter.on('failed', (value) => {
      this.emit('failed', {
        type: 'failed',
        error: (value as { error: Error }).error,
      });
    });
    // Wrap each incoming core Invitation as an IncomingBrowserCall exactly once.
    coreEmitter.on('incomingCall', (value) => {
      this.wrapIncoming((value as { invitation: Invitation }).invitation);
    });
  }

  // ------------------------------------------------------------------
  // Public state.
  // ------------------------------------------------------------------

  get connectionState(): ConnectionState {
    return this.connectionStateValue;
  }

  get registrationState(): RegistrationState {
    return this.registrationStateValue;
  }

  get identity(): RegistrationIdentity | undefined {
    return this.core.identity;
  }

  /** The single active call, only when exactly one is live. */
  get activeCall(): BrowserCall | undefined {
    // Exactly-one contract: 0 or 2+ live calls yield undefined (no arbitrary
    // owner for the media router / UA.bye / UA.restartIce to target).
    return this.calls.size === 1
      ? this.calls.values().next().value as BrowserCall | undefined
      : undefined;
  }

  /** Shared clock (superset of the core Clock). */
  get clock(): MediaManagerClock {
    return this.clockValue;
  }

  /** The composed core UA (internal owner surface for v0.5 delegates). */
  get coreInstance(): CoreUserAgent {
    return this.core;
  }

  /** The bridge controller (internal owner surface for v0.5 delegates). */
  get controllerInstance(): WorkerMediaController {
    return this.controller;
  }

  /** The media port pair (internal owner surface for v0.5 delegates). */
  get portsInstance(): ReturnType<typeof createMediaPortPair> {
    return this.ports;
  }

  // ------------------------------------------------------------------
  // Lifecycle.
  // ------------------------------------------------------------------

  connect(): Promise<void> {
    if (this.disposed) return Promise.reject(this.disposedError());
    if (this.connectionStateValue === 'connected') return Promise.resolve();
    // The transitional `connecting` updates the live fact but is not emitted
    // as an event (observers see only the final committed state).
    this.connectionStateValue = 'connecting';
    return this.core.connect().then(
      () => {
        if (this.disposed) return;
        this.commitConnection('connected');
        this.diagnostics?.record('connection.connected');
      },
      (error: unknown) => {
        if (!this.disposed) this.connectionStateValue = 'disconnected';
        throw error;
      },
    );
  }

  register(): Promise<void> {
    if (this.disposed) return Promise.reject(this.disposedError());
    return this.core.register().then(() => {
      if (this.disposed) return;
      this.commitRegistrationFromCore(this.core.registerState);
    });
  }

  unregister(): Promise<void> {
    if (this.disposed) return Promise.reject(this.disposedError());
    return this.core.unregister().then(() => {
      if (this.disposed) return;
      this.commitRegistrationFromCore(this.core.registerState);
    });
  }

  /**
   * Create an outgoing call owner WITHOUT sending. Asks core for the
   * {@link @sip-worker/core#Inviter}, wraps it once as an
   * {@link OutgoingBrowserCall}, and rejects a second simultaneous in-flight call
   * with `SipError INVALID_STATE` BEFORE any media is touched (core throws
   * synchronously while an active inviter exists).
   */
  createCall(target: string): BrowserCall {
    if (this.disposed) throw this.disposedError();
    const inviter = this.core.createOutgoingCall(target);
    // Note: core rejects a second active inviter synchronously with
    // SipError INVALID_STATE, so no second media session is ever contended.
    const call: BrowserCall = new OutgoingBrowserCall(inviter, this);
    // Live remote-hold push: the owner's committed remote hold (after the
    // re-INVITE ACK) is routed onto the call surface.
    this.remoteHoldUnsubscribers.set(
      call,
      inviter.subscribeRemoteHold((held): void => call.notifyRemoteHold(held)),
    );
    this.track(call);
    return call;
  }

  /**
   * Dispose is idempotent and shares ONE promise. Awaits core disconnect, then
   * finally closes the manager, controller, ports, and listeners.
   */
  dispose(): Promise<void> {
    if (this.disposed) {
      return this.disposePromise ?? Promise.resolve();
    }
    this.disposed = true;
    this.disposePromise = this.shutdown();
    return this.disposePromise;
  }

  private async shutdown(): Promise<void> {
    this.connectionStateValue = 'disposed';
    this.registrationStateValue = 'failed';
    for (const waiters of this.mediaWaiters.values()) {
      for (const waiter of waiters) {
        if (waiter.settled) continue;
        waiter.settled = true;
        this.clock.clearTimeout(waiter.timer);
        waiter.reject(this.disposedError());
      }
    }
    this.mediaWaiters.clear();
    try {
      await this.core.disconnect();
    } catch {
      // Terminal either way.
    } finally {
      this.manager.dispose();
      this.controller.close();
      this.ports.close();
      for (const cleanup of this.cleanup) {
        try {
          cleanup();
        } catch {
          // A teardown callback must never break the shared dispose promise.
        }
      }
      this.cleanup.length = 0;
      for (const unsubscribe of this.remoteHoldUnsubscribers.values()) {
        try {
          unsubscribe();
        } catch {
          // A remote-hold unsubscribe must never break the shared dispose promise.
        }
      }
      this.remoteHoldUnsubscribers.clear();
      this.calls.clear();
      this.diagnostics?.record('lifecycle.disposed');
    }
  }

  // ------------------------------------------------------------------
  // Call ownership (indexed by object identity).
  // ------------------------------------------------------------------

  private track(call: BrowserCall): void {
    this.calls.add(call);
  }

  /** Detach a call by object identity on terminal state, before observers. */
  releaseCall(call: BrowserCall, terminalState: CallState): void {
    const removed = this.calls.delete(call);
    this.remoteHoldUnsubscribers.get(call)?.();
    this.remoteHoldUnsubscribers.delete(call);
    if (removed) {
      this.diagnostics?.record(
        terminalState === 'failed' ? 'call.failed' : 'call.terminated',
      );
    }
  }

  // ------------------------------------------------------------------
  // Established-call signaling recovery (Task 13).
  // ------------------------------------------------------------------

  /**
   * Mark every live established call `recovering` when the phone arms
   * connection recovery. Unconfirmed/terminal calls are untouched (an
   * unconfirmed call fails immediately on transport loss, never through the
   * recovery branch).
   */
  markCallsRecovering(): void {
    for (const call of this.calls) {
      call.markRecovering();
    }
  }

  /**
   * Run the established-call recovery decision branch for every live call.
   * Individual call failures are contained with `Promise.allSettled`: the phone
   * commits its connection/registration recovery regardless of per-call
   * outcomes, and a call that raced to a terminal state is simply skipped.
   */
  async recoverEstablishedCalls(
    networkChanged: boolean,
    recoveryOptions: WaitForConnectedOptions,
  ): Promise<void> {
    const calls = [...this.calls].filter((call) => call.state === 'established');
    await Promise.allSettled(
      calls.map((call) => call.recoverSignaling(networkChanged, recoveryOptions)),
    );
  }

  /**
   * Terminate every live established call with `SIGNALING_RECOVERY_FAILED`
   * (connection/registration recovery failed after transport loss). The phone
   * calls this on the terminal recovery paths; the runtime never throws from it.
   */
  failEstablishedCalls(): void {
    const error = new SipError(0, 'Signaling recovery failed.', 'SIGNALING_RECOVERY_FAILED');
    for (const call of [...this.calls]) {
      if (call.state === 'established') {
        call.failRecovery(error);
      }
    }
  }

  private wrapIncoming(invitation: Invitation): void {
    const call = new IncomingBrowserCall(invitation, this);
    // Live remote-hold push for the incoming owner (same channel as outgoing).
    this.remoteHoldUnsubscribers.set(
      call,
      invitation.subscribeRemoteHold((held): void => call.notifyRemoteHold(held)),
    );
    this.track(call);
    this.emit('incomingCall', { type: 'incomingCall', call });
  }

  // ------------------------------------------------------------------
  // Media-connected settlement (Task-9 contract; observed here on the manager
  // surface so no second media graph is created).
  // ------------------------------------------------------------------

  waitForMediaConnected(sessionId: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (this.disposed) return reject(this.disposedError());
      if (this.connectedSessions.has(sessionId)) {
        resolve();
        return;
      }
      const waiter: MediaWaiter = {
        resolve,
        reject,
        settled: false,
        timer: -1,
      };
      let set = this.mediaWaiters.get(sessionId);
      if (set === undefined) {
        set = new Set();
        this.mediaWaiters.set(sessionId, set);
      }
      set.add(waiter);
      waiter.timer = this.clock.setTimeout(() => {
        if (waiter.settled) return;
        waiter.settled = true;
        this.removeWaiter(sessionId, waiter);
        reject(mediaError('TIMEOUT', 'Media connection did not establish in time.'));
      }, MEDIA_CONNECT_TIMEOUT_MS);
    });
  }

  private removeWaiter(sessionId: string, waiter: MediaWaiter): void {
    const set = this.mediaWaiters.get(sessionId);
    if (set === undefined) return;
    set.delete(waiter);
    if (set.size === 0) this.mediaWaiters.delete(sessionId);
  }

  /** Route manager media events to active call surface + connected waiters. */
  private onManagerEvent(type: keyof BrowserMediaEventMap, value: unknown): void {
    if (this.disposed) return;
    // Forward media events onto the runtime surface too, so the legacy
    // BrowserUserAgent delegate can re-emit them (e.g. `deviceChanged`).
    this.emit(type as keyof BrowserMediaEventMap, value as never);
    if (type === 'mediaStateChanged') {
      const event = value as BrowserMediaEventMap['mediaStateChanged'];
      if (event.state === 'connected') this.connectedSessions.add(event.sessionId);
      const set = this.mediaWaiters.get(event.sessionId);
      if (set !== undefined) {
        for (const waiter of [...set]) {
          if (waiter.settled) continue;
          waiter.settled = true;
          this.removeWaiter(event.sessionId, waiter);
          this.clock.clearTimeout(waiter.timer);
          if (event.state === 'connected') {
            waiter.resolve();
          } else {
            waiter.reject(mediaError(
              (event.reason as MediaError['code']) ?? 'ICE_CONNECTION_FAILED',
              'Media connection did not establish.',
            ));
          }
        }
      }
    }
    const active = this.activeCall;
    if (active !== undefined) {
      active.notifyMediaEvent(type, value as BrowserMediaEventMap[keyof BrowserMediaEventMap]);
    }
  }

  // ------------------------------------------------------------------
  // Forward-after-commit transitions.
  // ------------------------------------------------------------------

  private commitConnection(state: ConnectionState): void {
    if (this.connectionStateValue === state) return;
    const previous = this.connectionStateValue;
    this.connectionStateValue = state;
    this.emit('connectionStateChanged', {
      type: 'connectionStateChanged',
      previous,
      state,
    });
  }

  private commitRegistrationFromCore(state: string): void {
    const mapped = mapRegisterState(state);
    if (this.registrationStateValue === mapped) return;
    const previous = this.registrationStateValue;
    // Forward only committed terminal-or-active facts; intermediate signalling
    // states update the live value without an observable event.
    const observable = mapped === 'registered' || mapped === 'failed';
    this.registrationStateValue = mapped;
    if (mapped === 'registered') this.diagnostics?.record('registration.registered');
    if (!observable) return;
    this.emit('registrationStateChanged', {
      type: 'registrationStateChanged',
      previous,
      state: mapped,
    });
  }

  private disposedError(): Error {
    const error = new Error('PhoneRuntime has been disposed');
    (error as Error & { code?: string }).code = 'ABORTED';
    return error;
  }
}

function mediaError(code: string, message: string): Error {
  const error = new Error(message);
  (error as Error & { code?: string }).code = code;
  return error;
}
