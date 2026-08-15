/**
 * BrowserUserAgent: v0.5 composition root, now delegating through the same
 * {@link PhoneRuntime} owners the v0.7 {@link BrowserPhone} uses (v0.7 migration).
 *
 * This is COMPOSITION, not inheritance. It owns ONE media port pair → ONE
 * {@link WebRtcMediaManager} → ONE {@link @sip-worker/core#WorkerMediaController}
 * → ONE core {@link @sip-worker/core#UserAgent}, all composed by a
 * {@link PhoneRuntime}. The injected transport (`options.transport`) supplies its
 * advanced in-memory/controlled socket; automatic recovery is disabled unless
 * explicitly configured, matching the v0.7 compatibility contract.
 *
 * The global `invite`, `bye`, and `restartIce` helpers are DEPRECATED delegates
 * over the same owner internals; they create NO parallel call state. The
 * preferred v0.7 path is {@link BrowserPhone} with per-call owners.
 *
 * Global constraints honored: importing this module touches no `navigator`,
 * `RTCPeerConnection`, `document`, or `globalThis`. The browser media
 * environment is resolved in the constructor (never at import).
 */

import type { Listener, RegistrationIdentity } from '@sip-worker/core';
import type { RegisterState } from '@sip-worker/core';
import { TypedEventEmitter } from '@sip-worker/core';
import { BrowserMedia } from './media/browser-media.js';
import type { WebRtcMediaManager } from './media/media-manager.js';
import type { MediaManagerClock } from './media/media-manager.js';
import type { WorkerMediaController } from '@sip-worker/core';
import type {
  BrowserMediaEnvironment,
  BrowserMediaEventMap,
  BrowserMediaOptions,
} from './media/types.js';
import { validateBrowserMediaOptions } from './media/types.js';
import { createBrowserMediaEnvironment } from './media/error-mapper.js';
import { PhoneRuntime } from './phone/runtime.js';
import type { PhoneRuntimeCoreOptions } from './phone/runtime.js';
import type { BrowserCall } from './phone/browser-call.js';
import type { OutgoingBrowserCall } from './phone/browser-call.js';

/**
 * Core event surface forward onto the shared {@link BrowserUserAgentEventMap}.
 * Keyed to the phone runtime's own event map AFTER internal commit.
 */
/** The single typed event surface shared by core and browser media. */
export interface BrowserUserAgentEventMap extends BrowserMediaEventMap {
  registrationStateChanged: { type: 'registrationStateChanged'; state: RegisterState; identity: RegistrationIdentity };
  callStateChanged: never;
  incomingCall: { type: 'incomingCall'; call: BrowserCall };
  failed: { type: 'failed'; error: Error };
}

/** Composition options: core {@link @sip-worker/core#UserAgentOptions} minus its media controller. */
export type BrowserUserAgentOptions = {
  readonly transport: import('./transport/index.js').Transport;
  readonly clock: MediaManagerClock;
  readonly registrarUri: string;
  readonly aor: string;
  readonly contact: string;
  readonly credentials?: { readonly username: string; readonly password: string };
  readonly idGenerator: { branch(): string };
  readonly refreshFraction?: number;
  readonly media?: BrowserMediaOptions;
  /** Test/advanced injection; omitted in ordinary applications. */
  readonly mediaEnvironment?: BrowserMediaEnvironment;
  /** Explicit VIA address. */
  readonly viaAddress?: string;
  /** Override the RFC 3261 14.2 glare-retry random source (defaults to `Math.random`). */
  readonly random?: () => number;
};

export class BrowserUserAgent extends TypedEventEmitter<BrowserUserAgentEventMap> {
  private readonly runtime: PhoneRuntime;

  /** The media manager bridging core commands to one browser session. */
  readonly manager: WebRtcMediaManager;

  /** Controller bridge torn down on dispose. */
  readonly controller: WorkerMediaController;

  /** The media port pair, torn down on dispose. */
  readonly ports: ReturnType<typeof import('./media/port-pair.js').createMediaPortPair> extends infer P ? P : never;

  /** The media facade, exposed as `ua.media`. */
  private readonly mediaFacade: BrowserMedia;

  private disposed = false;
  private disposePromise: Promise<void> | undefined;

  constructor(options: BrowserUserAgentOptions) {
    super();
    const { mediaEnvironment, media: mediaOptions, ...coreOptions } = options;
    const normalizedMedia = validateBrowserMediaOptions(mediaOptions ?? {});
    const env = mediaEnvironment ?? createBrowserMediaEnvironment(normalizedMedia);

    const runtimeOptions: PhoneRuntimeCoreOptions = {
      transport: coreOptions.transport,
      clock: coreOptions.clock,
      registrarUri: coreOptions.registrarUri,
      aor: coreOptions.aor,
      contact: coreOptions.contact,
      ...(coreOptions.credentials === undefined
        ? {} : { credentials: coreOptions.credentials }),
      idGenerator: coreOptions.idGenerator,
      mediaEnvironment: env,
      mediaOptions: normalizedMedia,
      random: coreOptions.random,
    };
    this.runtime = new PhoneRuntime(runtimeOptions);
    this.manager = this.runtime.manager;
    this.controller = this.runtime.controllerInstance;
    this.ports = this.runtime.portsInstance;

    this.forwardRuntimeEvents();
    this.mediaFacade = new BrowserMedia(this.manager);
  }

  private forwardRuntimeEvents(): void {
    (this.runtime as unknown as TypedEventEmitter<BrowserUserAgentEventMap>).on(
      'registrationStateChanged',
      (value) => {
        this.emit('registrationStateChanged', {
          type: 'registrationStateChanged',
          state: value.state as RegisterState,
          identity: this.runtime.identity ?? { callId: '', nextCSeq: 1 },
        });
      },
    );
    (this.runtime as unknown as TypedEventEmitter<BrowserUserAgentEventMap>).on(
      'failed',
      (value) => {
        this.emit('failed', { type: 'failed', error: value.error });
      },
    );
    // Browser media events (device changes, media-state, remote-audio) forward
    // onto the shared surface. The runtime already routed them for settlement;
    // here we re-emit so legacy listeners observe them unchanged.
    for (const mediaEvent of ['deviceChanged', 'mediaStateChanged', 'mediaFailed', 'remoteAudio'] as const) {
      (this.runtime as unknown as TypedEventEmitter<BrowserUserAgentEventMap>).on(
        mediaEvent,
        (value) => {
          this.emit(mediaEvent, value as BrowserMediaEventMap[typeof mediaEvent]);
        },
      );
    }
  }

  // ------------------------------------------------------------------
  // v0.5 delegates.
  // ------------------------------------------------------------------

  get media(): BrowserMedia {
    return this.mediaFacade;
  }

  get registerState(): RegisterState {
    return this.runtime.registrationState as RegisterState;
  }

  get identity(): RegistrationIdentity | undefined {
    return this.runtime.identity;
  }

  get callState(): string {
    return this.runtime.activeCall?.state ?? 'idle';
  }

  connect(): Promise<void> {
    return this.runtime.connect();
  }

  register(): Promise<void> {
    return this.runtime.register();
  }

  unregister(): Promise<void> {
    return this.runtime.unregister();
  }

  /**
   * @deprecated Use `phone.createCall(target).start()` (v0.7 preferred). This
   * helper delegates to the same core owner without parallel call state. For
   * legacy compatibility it settles on core confirm only (not media), rejecting
   * (never throwing) when a second invite is attempted while one is active.
   */
  async invite(target: string): Promise<void> {
    const call = this.runtime.createCall(target) as OutgoingBrowserCall;
    return call.startConfirmed();
  }

  /**
   * @deprecated Use the active call's `hangup()` (v0.7 preferred).
   */
  bye(): Promise<void> {
    const call = this.runtime.activeCall;
    if (call === undefined) {
      return Promise.reject(new Error('No active call'));
    }
    return call.hangup();
  }

  /**
   * @deprecated Use the active call's `restartIce()` (v0.7 preferred).
   */
  restartIce(): Promise<void> {
    const call = this.runtime.activeCall;
    if (call === undefined) {
      return Promise.reject(Object.assign(new Error('no active call'), { code: 'INVALID_STATE' }));
    }
    return call.restartIce();
  }

  dispose(): Promise<void> {
    if (this.disposed) {
      return this.disposePromise ?? Promise.resolve();
    }
    this.disposed = true;
    this.disposePromise = this.shutdown();
    return this.disposePromise;
  }

  private async shutdown(): Promise<void> {
    try {
      this.mediaFacade.dispose();
    } finally {
      // Private `dispose` is a Promise.the whole runtime owner is released.
      await this.runtime.dispose().catch(() => {});
    }
  }
}

export type { BrowserMedia, BrowserMediaEventMap, MediaManagerClock };
export type { Listener };
