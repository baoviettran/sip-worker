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
import type { BrowserLifecycleHost } from '../recovery/browser-lifecycle.js';
import type { BrowserMediaEnvironment } from '../media/types.js';
import type { MediaManagerClock } from '../media/media-manager.js';
import type { IdGenerator } from '@sip-worker/core';
import type { BrowserCall } from './browser-call.js';

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
    return this.runtime.connect();
  }

  register(): Promise<void> {
    // The recovered registration identity (if any) is owned by recovery.
    return this.runtime.register();
  }

  unregister(): Promise<void> {
    return this.runtime.unregister();
  }

  createCall(target: string): BrowserCall {
    return this.runtime.createCall(target);
  }

  dispose(): Promise<void> {
    return this.runtime.dispose();
  }
}

let phoneIdCounter = 0;
function genId(): string {
  phoneIdCounter += 1;
  return `phone-${String(phoneIdCounter)}`;
}
