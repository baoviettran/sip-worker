/**
 * BrowserUserAgent: composition root tying the core SIP user agent to the
 * browser WebRTC media layer (v0.5).
 *
 * This is COMPOSITION, not inheritance of core {@link @sip-worker/core!UserAgent}.
 * It owns:
 *   - a media port pair joining two endpoints (core sees only serializable
 *     commands and replies);
 *   - a {@link WebRtcMediaManager} bridging those commands to one browser
 *     WebRTC session on a {@link BrowserMediaEnvironment};
 *   - a {@link @sip-worker/core!WorkerMediaController} the core UA drives;
 *   - a composed core {@link @sip-worker/core!UserAgent} for SIP signaling and
 *     session state;
 *   - a {@link BrowserMedia} facade exposed as `ua.media`.
 *
 * Core UA events and the four browser media events share one typed
 * {@link BrowserUserAgentEventMap} surface. User listeners are isolated (a
 * throwing listener cannot corrupt negotiation or cleanup).
 *
 * Global constraints honored: importing this module touches no `navigator`,
 * `RTCPeerConnection`, `document`, or `globalThis` — the browser media
 * environment is resolved lazily inside the constructor (or injected via
 * `mediaEnvironment`), so construction and `connect()`/`register()` never
 * capture the microphone. One media session per instance; concurrent attempts
 * settle predictably. No SDP, ICE credentials, device IDs, or raw constraints
 * ever reach a public event or error.
 */

import type {
  Listener,
  MediaMessage,
  RegistrationIdentity,
  RegisterState,
  UserAgentEventMap,
  UserAgentOptions,
} from '@sip-worker/core';
import { TypedEventEmitter, UserAgent as CoreUserAgent, WorkerMediaController } from '@sip-worker/core';
import { BrowserMedia } from './media/browser-media.js';
import { WebRtcMediaManager } from './media/media-manager.js';
import type { MediaManagerClock } from './media/media-manager.js';
import { createMediaPortPair } from './media/port-pair.js';
import { createBrowserMediaEnvironment } from './media/error-mapper.js';
import type {
  BrowserMediaEnvironment,
  BrowserMediaEventMap,
  BrowserMediaOptions,
} from './media/types.js';

/** Core event names forwarded onto the shared surface. */
const CORE_EVENTS: readonly (keyof UserAgentEventMap)[] = [
  'registrationStateChanged',
  'callStateChanged',
  'incomingCall',
  'failed',
];

/** The single typed event surface shared by core and browser media. */
export interface BrowserUserAgentEventMap extends UserAgentEventMap, BrowserMediaEventMap {}

/** Composition options: core {@link @sip-worker/core!UserAgentOptions} minus its media controller. */
export type BrowserUserAgentOptions = Omit<UserAgentOptions, 'mediaController'> & {
  readonly media?: BrowserMediaOptions;
  /** Test/advanced injection; omitted in ordinary applications. */
  readonly mediaEnvironment?: BrowserMediaEnvironment;
};

/**
 * The production WebRTC user agent. Compose media port pair → device manager
 * (owned by the manager) → media manager → controller → core UA → media facade.
 * Delegates every SIP method to the composed core UA and re-exposes its typed
 * events alongside the browser media events on one surface.
 */
export class BrowserUserAgent extends TypedEventEmitter<BrowserUserAgentEventMap> {
  /** The composed core SIP user agent (NOT inherited — delegated). */
  private readonly core: CoreUserAgent;

  /** The media manager bridging core commands to one browser session. */
  private readonly manager: WebRtcMediaManager;

  /** The media facade, exposed as `ua.media`. */
  private readonly mediaFacade: BrowserMedia;

  /** Controller bridge torn down on dispose. */
  private readonly controller: WorkerMediaController;

  /** The media port pair, torn down on dispose. */
  private readonly ports: ReturnType<typeof createMediaPortPair>;

  /** Unsubscribe functions owned by this composition root, run on dispose. */
  private readonly cleanup: Array<() => void> = [];

  private disposed = false;
  private disposePromise: Promise<void> | undefined;

  constructor(options: BrowserUserAgentOptions) {
    super();
    const { mediaEnvironment, media: mediaOptions, ...coreOptions } = options;

    // Resolve the browser media environment in the CONSTRUCTOR (never at
    // import). An injected environment (tests/advanced) replaces the default.
    const env = mediaEnvironment ?? createBrowserMediaEnvironment(mediaOptions);

    // In-memory media port pair. The core end is driven by the controller; the
    // browser end feeds commands into the manager. Core sees only serializable
    // commands and replies.
    const ports = createMediaPortPair();
    this.ports = ports;

    // A construction-time window-backed clock for ICE/media deadlines. Only
    // read here (constructor scope), never at module import.
    const clock = buildWindowClock();

    // The manager owns the device manager internally. Its narrowed emitter
    // forwards the four media events onto this UA's single event surface.
    const manager = new WebRtcMediaManager({
      env,
      options: mediaOptions ?? {},
      clock,
      emitter: {
        emit: <K extends Extract<keyof BrowserMediaEventMap, keyof BrowserUserAgentEventMap>>(
          type: K,
          value: BrowserMediaEventMap[K],
        ): void => {
          this.emit(type, value as BrowserUserAgentEventMap[K]);
        },
      },
    });
    this.manager = manager;

    // Bridge: commands posted on the core end are delivered into the manager,
    // and the manager posts replies back out its own (private) pair, which we
    // forward onto this UA's pair so the controller correlates them.
    this.cleanup.push(
      ports.browser.subscribe((message: MediaMessage): void => {
        manager.postMessage(message);
      }),
      manager.subscribeReplies((reply): void => {
        // Manager replies arrive on ITS browser half; re-post on this UA's
        // browser port so they reach the WorkerMediaController on the core end.
        ports.browser.postMessage(reply as MediaMessage);
      }),
    );

    const controller = new WorkerMediaController(ports.core);
    this.controller = controller;

    // Compose the core UA. mediaController is omitted from
    // BrowserUserAgentOptions (a second controller is forbidden); the UA
    // supplies our controller.
    const core = new CoreUserAgent({ ...coreOptions, mediaController: controller });
    this.core = core;

    // Forward every core UA event onto the shared surface.
    this.forwardCoreEvents(core);

    // Task-10 facade.
    this.mediaFacade = new BrowserMedia(manager);
  }

  // ------------------------------------------------------------------
  // SIP delegation to the composed core UA.
  // ------------------------------------------------------------------

  /** The browser media facade (devices, microphone selection, remote audio). */
  get media(): BrowserMedia {
    return this.mediaFacade;
  }

  /** Current registration state. */
  get registerState(): RegisterState {
    return this.core.registerState;
  }

  /** Registration identity snapshot for recovery. */
  get identity(): RegistrationIdentity | undefined {
    return this.core.identity;
  }

  /** Current call state (for outgoing calls). */
  get callState(): string {
    return this.core.callState;
  }

  /** Connect the transport and wire up the transaction stack. */
  connect(): Promise<void> {
    return this.core.connect();
  }

  /** Register against the registrar. */
  register(): Promise<void> {
    return this.core.register();
  }

  /** Unregister from the registrar. */
  unregister(): Promise<void> {
    return this.core.unregister();
  }

  /** Initiate an outgoing call. */
  invite(target: string): Promise<void> {
    return this.core.invite(target);
  }

  /** Terminate the active call with BYE. */
  bye(): Promise<void> {
    return this.core.bye();
  }

  /** Request an ICE restart on the sole confirmed active call. */
  restartIce(): Promise<void> {
    return this.core.restartIce();
  }

  /**
   * Dispose is idempotent and shares ONE promise. Marks closed, awaits the core
   * UA disconnect (settling every owner), then finally closes the manager,
   * controller, ports, media facade, and listeners. Result: zero sessions,
   * ports, devicechange listeners, pending requests, tracks, and peer
   * connections.
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
    try {
      await this.core.disconnect();
    } finally {
      // The facade releases its own session-end observer synchronously.
      this.mediaFacade.dispose();
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
    }
  }

  // ------------------------------------------------------------------
  // Wiring helpers.
  // ------------------------------------------------------------------

  /** Forward every core UA event onto this UA's typed surface. */
  private forwardCoreEvents(core: CoreUserAgent): void {
    for (const event of CORE_EVENTS) {
      core.on(event, (value) => {
        this.emit(event, value);
      });
    }
  }
}

/**
 * Build a window-backed {@link MediaManagerClock} at construction time. Reads
 * the page timer functions and `Date` lazily here (constructor scope), never at
 * module import, so importing this module touches no environment global.
 */
function buildWindowClock(): MediaManagerClock {
  return {
    now(): number {
      return Date.now();
    },
    setTimeout(callback: () => void, delayMs: number): number {
      return setTimeout(callback, delayMs) as unknown as number;
    },
    clearTimeout(id: number): void {
      clearTimeout(id);
    },
  };
}

export type { BrowserMedia, BrowserMediaEventMap, MediaManagerClock };
export type { Listener };