/**
 * Bridge core media commands to a single browser WebRTC session (v0.5).
 *
 * {@link WebRtcMediaManager} serializes the plain-data core media protocol
 * (`createOffer`/`createAnswer`/`setRemote`/`closeSession`) to and from a single
 * {@link WebRtcMediaSession}. It owns one active session per browser user-agent
 * and serializes every negotiation operation so commands cannot interleave.
 * Every thrown value is mapped to a safe, coded `mediaError` reply carrying no
 * SDP, device, ICE, credential, or stack data. Known `MediaErrorCode` values,
 * including `INVALID_STATE`, cross the boundary unchanged. Unknown codes map
 * to `INTERNAL_ERROR` when core reconstructs the reply.
 *
 * `closeSession` is fire-and-forget (no reply) and cancels every pending request
 * for that session; late tracks/streams are reclaimed on reclamation. Disposal
 * is idempotent: it closes the session, disposes the device manager (removing
 * the device-change listener), closes the port pair, and stops accepting work.
 */

import { MediaError } from '@sip-worker/core';
import type { MediaErrorCode } from '@sip-worker/core';
import type { MediaCommand, MediaDirection, MediaMessage, MediaReply } from '@sip-worker/core';
import type { BrowserMediaEnvironment, BrowserMediaEventMap, BrowserMediaOptions } from './types.js';
import { DEFAULT_MEDIA_OPERATION_TIMEOUT_MS, copyIceServers } from './types.js';
import { MediaDeviceManager } from './device-manager.js';
import { WebRtcMediaSession } from './session.js';
import type { DtmfOptions, WebRtcMediaSessionDeps } from './session.js';
import { createMediaPortPair } from './port-pair.js';

/** Clock surface shared by the manager and the sessions it builds. */
export interface MediaManagerClock {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): number;
  clearTimeout(id: number): void;
}

/** Constructor dependencies, injected so the manager stays Node-free/testable. */
export interface WebRtcMediaManagerDeps {
  readonly env: BrowserMediaEnvironment;
  readonly options: BrowserMediaOptions;
  /** Clock shared by constructed sessions for the ICE-gathering deadline. */
  readonly clock: MediaManagerClock;
  /** Narrowed emitter shared with the sessions (mediaState/remoteAudio/mediaFailed). */
  readonly emitter: {
    emit<K extends keyof BrowserMediaEventMap>(type: K, value: BrowserMediaEventMap[K]): void;
  };
}

/** Options bounding a {@link WebRtcMediaManager.waitForConnected} wait. */
export interface WaitForConnectedOptions {
  /** Deadline (ms); settles with `MEDIA_OPERATION_TIMEOUT` when it elapses. */
  readonly timeoutMs?: number;
  /** Abort the wait with `ABORTED`. */
  readonly signal?: AbortSignal;
}

/** A media-state event the manager routes to internal connected waiters. */
type SessionStateEvent =
  | BrowserMediaEventMap['mediaStateChanged']
  | BrowserMediaEventMap['mediaFailed'];

/** A queued, not-yet-dispatched media request awaiting a reply. */
interface PendingRequest {
  readonly requestId: string;
  readonly sessionId: string;
  readonly type: 'createOffer' | 'createAnswer' | 'setRemote' | 'commitDirection' | 'rollbackDirection';
  readonly iceRestart?: boolean;
  readonly direction?: MediaDirection;
  readonly remoteSdp?: string;
}

/** Core's valid media error codes, in canonical order (mirrors core). */
const MEDIA_ERROR_CODES: readonly string[] = [
  'PERMISSION_DENIED', 'DEVICE_NOT_FOUND', 'DEVICE_UNAVAILABLE', 'CONSTRAINT_UNSATISFIED',
  'NEGOTIATION_FAILED', 'REMOTE_DESCRIPTION_REJECTED', 'ICE_GATHERING_TIMEOUT',
  'ICE_CONNECTION_FAILED', 'OUTPUT_SELECTION_UNSUPPORTED', 'PLAYBACK_FAILED',
  'ABORTED', 'INVALID_STATE', 'MEDIA_OPERATION_TIMEOUT', 'INTERNAL_ERROR',
];

/** Valid transceiver directions a directional offer may stage, in canonical order. */
const VALID_DIRECTIONS: readonly MediaDirection[] = ['sendrecv', 'sendonly', 'inactive'];

/** Narrow a runtime direction value to the typed union, or reject it. */
function isValidDirection(value: string): value is MediaDirection {
  return (VALID_DIRECTIONS as readonly string[]).includes(value);
}

/** Fixed safe messages; never interpolate exception content into these. */
const SAFE_MESSAGES: Readonly<Record<MediaErrorCode, string>> = {
  PERMISSION_DENIED: 'Microphone or media permission was denied.',
  DEVICE_NOT_FOUND: 'No matching media device was found.',
  DEVICE_UNAVAILABLE: 'The media device is unavailable or in use by another application.',
  CONSTRAINT_UNSATISFIED: 'The requested audio constraints could not be satisfied.',
  NEGOTIATION_FAILED: 'The media negotiation failed.',
  REMOTE_DESCRIPTION_REJECTED: 'The remote session description was rejected.',
  ICE_GATHERING_TIMEOUT: 'ICE gathering did not complete in time.',
  ICE_CONNECTION_FAILED: 'The media connection could not be established.',
  OUTPUT_SELECTION_UNSUPPORTED: 'Output selection is not supported on this device.',
  PLAYBACK_FAILED: 'Remote audio playback failed.',
  ABORTED: 'The media operation was aborted.',
  INVALID_STATE: 'The media operation is not valid in the current state.',
  MEDIA_OPERATION_TIMEOUT: 'The media operation exceeded its configured deadline.',
  INTERNAL_ERROR: 'An internal browser media error occurred.',
};

/**
 * Bridge core media commands to one browser WebRTC session.
 *
 * Guards on a single active session: a command for a different session while one
 * is active rejects predictably without disturbing the active session, and
 * negotiation operations are serialized one at a time. `closeSession` is
 * fire-and-forget, cancels pending requests, and reclaims the session. Disposal
 * is idempotent.
 *
 * @internal Not a public API surface: `BrowserUserAgent` constructs the media
 * bridge for you; the type appears in the `BrowserMedia` constructor signature
 * only because the facade is composition-rooted on it.
 */
export class WebRtcMediaManager {
  private readonly env: BrowserMediaEnvironment;
  private readonly options: BrowserMediaOptions;
  private readonly clock: MediaManagerClock;
  private readonly emitter: WebRtcMediaManagerDeps['emitter'];

  private readonly devices: MediaDeviceManager;
  /** The port pair whose browser half carries outgoing replies to subscribers. */
  private readonly ports = createMediaPortPair();
  private readonly replyUnsubscribers: Array<() => void> = [];

  /** The sole active session. */
  private owned: WebRtcMediaSession | null = null;
  /** The session id reserved before acquisition; removed on reclamation. */
  private reservedId: string | undefined;
  /** The most recently reclaimed id; sufficient for the ordered in-process port. */
  private lastClosedSessionId: string | undefined;
  /** Retained view of the active session's surfaced remote stream (set on `remoteAudio`). */
  private retainedRemoteStream: MediaStream | null = null;
  /** Session-lifecycle observers for the facade's remote-audio cleanup. */
  private readonly sessionEndListeners = new Set<(sessionId: string) => void>();
  /** Serialized negotiation queue; exactly one command dispatched at a time. */
  private readonly queue: PendingRequest[] = [];
  /** Cancellation hooks for the sole serialized browser operation deadline. */
  private readonly boundedCancels = new Set<() => void>();
  /** Internal observers of session media-state events (drives waitForConnected). */
  private readonly sessionStateListeners = new Set<(event: SessionStateEvent) => void>();
  /** Cancellation hooks for in-flight connected waiters; drained on dispose. */
  private readonly connectedWaiters = new Set<() => void>();
  /** Terminal media failures per session id (drives the waitForConnected fast-path). */
  private readonly sessionErrors = new Map<string, MediaError>();
  /** Shared in-flight ICE-server provider fetch; concurrent dispatches share it. */
  private providerInFlight: Promise<readonly RTCIceServer[]> | undefined;
  /** The abort controller for the in-flight provider fetch (aborted on dispose). */
  private providerAbort: AbortController | undefined;
  private processing = false;
  private disposed = false;
  /** Bumped on close/dispose so late tracks/streams and stale continuations drop. */
  private generation = 0;

  constructor(deps: WebRtcMediaManagerDeps) {
    this.env = deps.env;
    this.options = deps.options;
    this.clock = deps.clock;
    this.emitter = deps.emitter;
    this.devices = new MediaDeviceManager(this.env, this.options);
    // Device-change events are surfaced to the application (notification only).
    this.devices.onDeviceChange(() => {
      this.emitter.emit('deviceChanged', { type: 'deviceChanged' });
    });
  }

  /** The reserved (active or acquiring) session id, or undefined. */
  get activeSessionId(): string | undefined {
    return this.reservedId;
  }

  /**
   * Register a listener for outgoing {@link MediaReply}s. Returns an idempotent
   * unsubscribe. The Task-10 facade subscribes here to hand replies to core.
   */
  subscribeReplies(listener: (message: MediaReply) => void): () => void {
    const unsubscribe = this.ports.browser.subscribe((message: MediaMessage) => {
      if (message.type === 'mediaResult' || message.type === 'mediaError') {
        listener(message);
      }
    });
    this.replyUnsubscribers.push(unsubscribe);
    return (): void => {
      const index = this.replyUnsubscribers.indexOf(unsubscribe);
      if (index !== -1) this.replyUnsubscribers.splice(index, 1);
      unsubscribe();
    };
  }

  /**
   * Accept a {@link MediaCommand} from core. Commands are validated, serialized,
   * and routed to the session; every reply is emitted as plain data. Unknown or
   * stale messages are ignored. `closeSession` is handled fire-and-forget.
   */
  postMessage(message: MediaMessage): void {
    if (this.disposed || message === null || typeof message !== 'object') return;
    switch (message.type) {
      case 'createOffer':
        // The ordered bridge may deliver work queued immediately before close.
        if (message.sessionId === this.lastClosedSessionId) return;
        if (message.direction !== undefined && !isValidDirection(message.direction)) {
          // A malformed direction must not create or disturb a session.
          this.emitError('INVALID_STATE', message.requestId, message.sessionId);
          return;
        }
        this.enqueueRequest(message);
        return;
      case 'createAnswer':
      case 'setRemote':
      case 'commitDirection':
      case 'rollbackDirection':
        // The ordered bridge may deliver work queued immediately before close.
        if (message.sessionId === this.lastClosedSessionId) return;
        this.enqueueRequest(message);
        return;
      case 'closeSession':
        this.handleClose(message.sessionId);
        return;
      default:
        // Unknown inbound message (incl. unsolicited replies): ignore safely.
        return;
    }
  }

  /**
   * Idempotently release every resource: close the session (reclaiming its
   * tracks/PC/listeners/streams), dispose the device manager (removing the
   * device-change listener and cancelling pending probes), close the ports, and
   * stop accepting further work.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.generation += 1;
    this.cancelBoundedOperations();
    // Settle every pending connected waiter with ABORTED; the waiters below
    // are drained after their sessions close.
    for (const cancel of [...this.connectedWaiters]) {
      cancel();
    }
    this.connectedWaiters.clear();
    this.sessionErrors.clear();
    if (this.owned !== null) {
      this.owned.close();
      this.owned = null;
    }
    this.reservedId = undefined;
    this.reclaimSession('');
    this.lastClosedSessionId = undefined;
    this.devices.dispose();
    this.queue.length = 0;
    for (const unsubscribe of this.replyUnsubscribers) {
      unsubscribe();
    }
    this.replyUnsubscribers.length = 0;
    this.ports.close();
  }

  // ------------------------------------------------------------------
  // Serialization and dispatch
  // ------------------------------------------------------------------

  private enqueueRequest(command: PendingRequest): void {
    if (this.disposed) return;
    if (this.reservedId !== undefined && this.reservedId !== command.sessionId) {
      // A second active session is a valid, typed state error and must not
      // be flattened into an internal implementation failure.
      this.emitErrorFromThrown(
        new MediaError('INVALID_STATE', 'A media session is already active.'),
        command.requestId,
        command.sessionId,
      );
      return;
    }
    this.queue.push(command);
    void this.drain();
  }

  /** Dispatch queued requests one at a time through the serialization lock. */
  private async drain(): Promise<void> {
    if (this.processing || this.disposed) return;
    this.processing = true;
    while (this.queue.length > 0 && !this.disposed) {
      const pending = this.queue.shift()!;
      await this.dispatch(pending);
    }
    this.processing = false;
  }

  private async dispatch(pending: PendingRequest): Promise<void> {
    const { requestId, sessionId, type } = pending;
    // Captured so a closeSession that reclaims this session mid-operation makes
    // any late result/error reply a no-op (generation is bumped on close).
    const generation = this.generation;

    switch (type) {
      case 'createOffer': {
        const created = this.owned === null;
        if (created && pending.direction !== undefined) {
          // A directional offer requires an ESTABLISHED session: the initial
          // offer is always sendrecv. Reject rather than silently dropping the
          // requested direction.
          this.emitError('INVALID_STATE', requestId, sessionId);
          return;
        }
        if (this.reservedId === undefined) {
          this.reservedId = sessionId;
        }
        if (this.owned === null) {
          this.owned = this.createSession(sessionId);
        }
        try {
          // C13: refresh ICE servers ONLY before a new-session negotiation and
          // before an ICE restart. A plain directional (hold/resume) or other
          // renegotiation must NOT fetch, so a transient provider rejection
          // cannot reclaim the media session of an established call. A provider
          // failure rejects BEFORE the peer connection is configured, so no
          // partially-configured PC ever exists.
          if (created || pending.iceRestart === true) {
            const servers = await this.fetchIceServers();
            if (servers !== undefined) {
              this.owned!.applyIceConfiguration(servers);
            }
          }
          const operation = created
            ? this.owned!.createOffer()
            : pending.iceRestart === true
              ? this.owned!.restartIce()     // C4: restart an active session
              : pending.direction !== undefined
                ? this.owned!.createDirectionalOffer(pending.direction)
                : this.owned!.createOffer();
          const sdp = await this.runBounded(operation);
          if (generation === this.generation && this.reservedId === sessionId) {
            this.emitResult(requestId, sessionId, sdp);
          }
        } catch (error) {
          // Generation-guarded exactly like the success path. If a closeSession
          // (or dispose) invalidated this request while it was in flight, we must
          // NOT touch `this.owned`/`this.reservedId`: the close already reclaimed
          // the session, and a newer session may now be active. Acting on the
          // stale failure could tear down the wrong (live) session and its
          // PC/tracks, or leave a phantom no-session state. Reclaim + emit only
          // while this generation is still current.
          if (generation === this.generation) {
            const partial = this.owned;
            this.owned = null;
            this.reservedId = undefined;
            this.lastClosedSessionId = sessionId;
            // Reclaim the session this request operated on (idempotent after a
            // self-fail) so no PC/mic track leaks.
            if (partial !== null) {
              partial.close();
              this.reclaimSession(sessionId);
            }
            this.emitError(this.codeOf(error), requestId, sessionId);
          }
        }
        return;
      }
      case 'createAnswer':
      case 'setRemote': {
        // `createAnswer` handles an incoming call, which may be the very first
        // media command (no prior offer): reserve the session and build it.
        // `setRemote` requires an existing, active session by contract.
        // Read the ownership state BEFORE any session is created/assigned: it
        // distinguishes a FRESH incoming call (new-session answer) from a remote
        // re-INVITE on an EXISTING session (remote hold/resume), which only the
        // provider fetch below must not treat as a new-session negotiation.
        const ownedWasNull = this.owned === null;
        if (ownedWasNull && type === 'createAnswer') {
          if (this.reservedId === undefined) {
            this.reservedId = sessionId;
          }
          this.owned = this.createSession(sessionId);
        }
        if (this.owned === null || this.owned.sessionId !== sessionId) {
          this.emitError('INTERNAL_ERROR', requestId, sessionId);
          return;
        }
        try {
          if (type === 'createAnswer') {
            // C13: refresh ICE servers before answering a FRESH incoming call
            // too; a provider failure rejects before the PC is configured.
            // `ownedWasNull` (captured above, before session creation) is the
            // discriminator: a new-session answer fetches, while a remote
            // re-INVITE on an EXISTING session (remote hold/resume) must NOT —
            // a transient provider rejection there would fail a live
            // negotiation and reclaim the established call's media session.
            if (ownedWasNull) {
              const servers = await this.fetchIceServers();
              if (servers !== undefined) {
                this.owned!.applyIceConfiguration(servers);
              }
            }
            const sdp = await this.runBounded(this.owned!.createAnswer(pending.remoteSdp ?? ''));
            if (generation === this.generation && this.reservedId === sessionId) {
              this.emitResult(requestId, sessionId, sdp);
            }
          } else {
            await this.runBounded(this.owned!.setRemote(pending.remoteSdp ?? ''));
            if (generation === this.generation && this.reservedId === sessionId) {
              this.emitResult(requestId, sessionId);
            }
          }
        } catch (error) {
          // Generation-guarded like the success path: never mutate owned state
          // from a stale failure. A concurrent close already reclaimed the
          // session; a newer session may now be active, and nulling `this.owned`
          // here would orphan/leak its PC/mic track or tear it down.
          if (generation === this.generation) {
            const partial = this.owned;
            this.owned = null;
            this.reservedId = undefined;
            this.lastClosedSessionId = sessionId;
            if (partial !== null) {
              partial.close();
              this.reclaimSession(sessionId);
            }
            this.emitError(this.codeOf(error), requestId, sessionId);
          }
        }
        return;
      }
      case 'commitDirection':
      case 'rollbackDirection': {
        // Direction transactions require an existing, active session.
        if (this.owned === null || this.owned.sessionId !== sessionId) {
          this.emitError('INTERNAL_ERROR', requestId, sessionId);
          return;
        }
        try {
          const operation = type === 'commitDirection'
            ? this.owned.commitDirection()
            : this.owned.rollbackDirection();
          await this.runBounded(operation);
          if (generation === this.generation && this.reservedId === sessionId) {
            this.emitResult(requestId, sessionId);
          }
        } catch (error) {
          // A direction-transaction failure is terminal in the session (it
          // fails itself with NEGOTIATION_FAILED), so reclaim like the other
          // terminal paths. Generation-guarded like every failure path so a
          // stale continuation can never clobber a newer live session.
          if (generation === this.generation) {
            const partial = this.owned;
            this.owned = null;
            this.reservedId = undefined;
            this.lastClosedSessionId = sessionId;
            if (partial !== null) {
              partial.close();
              this.reclaimSession(sessionId);
            }
            this.emitError(this.codeOf(error), requestId, sessionId);
          }
        }
        return;
      }
      default:
        return;
    }
  }

  /** Race one browser operation against its configured deadline and observe both branches. */
  private runBounded<T>(operation: Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      let timer = -1;
      let cancel = (): void => {};
      const finish = (action: () => void): void => {
        if (settled) return;
        settled = true;
        if (timer !== -1) {
          this.clock.clearTimeout(timer);
        }
        action();
        this.boundedCancels.delete(cancel);
      };

      cancel = (): void => finish(() => reject(new MediaError(
        'ABORTED',
        SAFE_MESSAGES.ABORTED,
      )));
      this.boundedCancels.add(cancel);
      timer = this.clock.setTimeout(() => {
        finish(() => reject(new MediaError(
          'MEDIA_OPERATION_TIMEOUT',
          SAFE_MESSAGES.MEDIA_OPERATION_TIMEOUT,
        )));
      }, this.options.mediaOperationTimeoutMs ?? DEFAULT_MEDIA_OPERATION_TIMEOUT_MS);

      operation.then(
        (value) => finish(() => resolve(value)),
        (error: unknown) => finish(() => reject(error)),
      );
    });
  }
  /** Cancel and clear the active bounded operation during close or disposal. */
  private cancelBoundedOperations(): void {
    for (const cancel of [...this.boundedCancels]) {
      cancel();
    }
    this.boundedCancels.clear();
  }

  /**
   * Fetch refreshed ICE servers from the configured provider (v0.7). Returns
   * `undefined` when no provider is configured. The fetch is bounded by the
   * media-operation deadline (aborting the provider's signal on timeout), and
   * concurrent requests share one result (`providerInFlight`). The dedupe is a
   * defensive guard: the serialized negotiation queue means overlapping fetches
   * are unreachable through the public path, but a direct call must never
   * double-invoke the provider. On success the servers are validated and
   * defensively copied; on a provider rejection or malformed output the error
   * maps to a safe coded `MediaError` that never carries credentials.
   */
  private fetchIceServers(): Promise<readonly RTCIceServer[]> | undefined {
    const provider = this.options.iceServerProvider;
    if (provider === undefined) return undefined;
    if (this.providerInFlight !== undefined) return this.providerInFlight;

    const controller = new AbortController();
    this.providerAbort = controller;
    const deadlineMs = this.options.mediaOperationTimeoutMs ?? DEFAULT_MEDIA_OPERATION_TIMEOUT_MS;

    const bounded = new Promise<readonly RTCIceServer[]>((resolve, reject) => {
      let settled = false;
      let timer = -1;
      const cancel = (): void => {
        controller.abort();
        finish(() => reject(new MediaError('ABORTED', SAFE_MESSAGES.ABORTED)));
      };
      const finish = (action: () => void): void => {
        if (settled) return;
        settled = true;
        if (timer !== -1) this.clock.clearTimeout(timer);
        this.boundedCancels.delete(cancel);
        if (this.providerInFlight === bounded) this.providerInFlight = undefined;
        if (this.providerAbort === controller) this.providerAbort = undefined;
        action();
      };
      this.boundedCancels.add(cancel);
      timer = this.clock.setTimeout(() => {
        controller.abort();
        finish(() => reject(new MediaError('MEDIA_OPERATION_TIMEOUT', SAFE_MESSAGES.MEDIA_OPERATION_TIMEOUT)));
      }, deadlineMs);

      Promise.resolve()
        .then(() => provider({ signal: controller.signal }))
        .then(
          (servers: readonly RTCIceServer[]) => {
            // Validate BEFORE settling so a malformed result rejects the shared
            // fetch instead of throwing out of the success handler (which would
            // never settle the bounded promise).
            let copied: readonly RTCIceServer[];
            try {
              copied = validateAndCopyIceServers(servers);
            } catch (error) {
              finish(() => reject(mapProviderError(error)));
              return;
            }
            finish(() => resolve(copied));
          },
          (error: unknown) => finish(() => reject(mapProviderError(error))),
        );
    });

    this.providerInFlight = bounded;
    return bounded;
  }

  /**
   * Whether the active media session with the given id reports ICE connected
   * (or completed). Drives the established-call recovery decision branch.
   */
  isMediaConnected(sessionId: string): boolean {
    const session = this.owned;
    if (session === null || session.sessionId !== sessionId) return false;
    const state = session.iceConnectionState;
    return state === 'connected' || state === 'completed';
  }

  /** Construct a fresh session bound to this manager's env/clock/emitter. */
  private createSession(sessionId: string): WebRtcMediaSession {
    // A reused session id must not inherit a prior terminal failure.
    this.sessionErrors.delete(sessionId);
    let session: WebRtcMediaSession;
    const deps: WebRtcMediaSessionDeps = {
      env: this.env,
      options: this.options,
      acquireTrack: async (): Promise<MediaStream> => {
        const stream = await this.devices.acquireMicrophone();
        // C3: a legal browser outcome is a stream with no audio track. The
        // manager FAILS that case rather than offering/answering with no send
        // track: reclaim the stream and signal DEVICE_UNAVAILABLE.
        if (stream.getAudioTracks().length === 0) {
          for (const track of stream.getTracks()) track.stop();
          throw new MediaError('DEVICE_UNAVAILABLE', 'No usable microphone track was available.');
        }
        return stream;
      },
      clock: this.clock,
      emitter: {
        emit: <K extends keyof BrowserMediaEventMap>(type: K, value: BrowserMediaEventMap[K]): void => {
          // Retain the active session's remote stream so the facade can assign
          // it synchronously without racing the event stream.
          if (
            type === 'remoteAudio'
            && (value as { stream?: MediaStream }).stream !== undefined
          ) {
            this.retainedRemoteStream = (value as { stream: MediaStream }).stream;
          }
          if (type === 'mediaFailed' && session.currentState === 'failed') {
            // Record only TERMINAL failures. A non-terminal mediaFailed (e.g. a
            // replaceMicrophone rollback) leaves the session usable and must
            // not pin the session id to an error.
            this.sessionErrors.set(sessionId, (value as { error: MediaError }).error);
          }
          if (type === 'mediaStateChanged' || type === 'mediaFailed') {
            for (const listener of [...this.sessionStateListeners]) {
              listener(value as SessionStateEvent);
            }
          }
          this.emitter.emit(type, value);
        },
      },
      sessionId,
    };
    session = new WebRtcMediaSession(deps);
    return session;
  }

  // ------------------------------------------------------------------
  // Facade support: device passthrough, remote-stream view, session-end
  // observer, and active-call microphone replacement. The device-change
  // notification stays the manager's single `devices.onDeviceChange` listener;
  // these add no second `devicechange` listener.
  // ------------------------------------------------------------------

  /** List audio devices through the internal device manager. */
  listDevices(): Promise<readonly import('./types.js').BrowserAudioDevice[]> {
    return this.devices.listDevices();
  }

  /** Probe/validate the selected microphone through the internal device manager. */
  prepare(options?: import('./types.js').PrepareMediaOptions): Promise<void> {
    return this.devices.prepare(options);
  }

  /** Commit an in-memory idle microphone preference (validated on next use). */
  selectMicrophone(deviceId: string | undefined): void {
    this.devices.selectMicrophone(deviceId);
  }

  /**
   * Mute/unmute the active session's microphone. Synchronous and idempotent:
   * routes to the sole active session, which flips `localTrack.enabled` and
   * emits a fresh `mutedChanged` only when the value changes. A disposed
   * manager rejects `ABORTED`; no active session rejects canonical
   * `INVALID_STATE` synchronously.
   */
  setMuted(muted: boolean): void {
    if (this.disposed) {
      throw new MediaError('ABORTED', 'The media operation was aborted.');
    }
    const session = this.owned;
    if (session === null || this.reservedId === undefined) {
      throw new MediaError('INVALID_STATE', 'No active media session is available.');
    }
    session.setMuted(muted);
  }

  /**
   * Send an RFC 4733 DTMF digit sequence through the sole active session's
   * browser DTMF sender. Routes to {@link WebRtcMediaSession.sendDtmf}, which
   * validates before touching the sender, bounds the sequence with a deadline,
   * and resolves only when the tone buffer drains. A disposed manager rejects
   * `ABORTED`; no active session rejects canonical `INVALID_STATE` synchronously.
   */
  sendDtmf(tones: string, options?: DtmfOptions): Promise<void> {
    if (this.disposed) {
      throw new MediaError('ABORTED', 'The media operation was aborted.');
    }
    const session = this.owned;
    if (session === null || this.reservedId === undefined) {
      throw new MediaError('INVALID_STATE', 'No active media session is available.');
    }
    return session.sendDtmf(tones, options);
  }

  /**
   * Transactionally replace the microphone during an ACTIVE call. Resolves the
   * current active session and delegates the acquire→replaceTrack→commit→stop
   * order (with rollback) to {@link WebRtcMediaSession.replaceMicrophone}, then
   * commits the in-memory preference after the swap succeeds. Any earlier
   * failure stops the new track, preserves the old track AND the old preference,
   * and rejects.
   */
  async replaceActiveMicrophone(deviceId: string | undefined): Promise<void> {
    if (this.disposed) {
      throw new MediaError('ABORTED', 'The media operation was aborted.');
    }
    const session = this.owned;
    if (session === null || this.reservedId === undefined) {
      throw new MediaError('INTERNAL_ERROR', 'No active media session is available.');
    }
    const stream = await this.devices.acquireMicrophone(deviceId === undefined ? undefined : { microphoneDeviceId: deviceId });
    const track = firstAudioTrackOf(stream);
    if (track === undefined) {
      for (const t of stream.getTracks()) t.stop();
      throw new MediaError('DEVICE_UNAVAILABLE', 'No usable microphone track was available.');
    }
    try {
      await session.replaceMicrophone(track);
      this.devices.selectMicrophone(deviceId);
    } catch (error) {
      // The caller owns the freshly acquired track until replacement commits.
      // replaceMicrophone stops it on its replaceTrack-failure path, but on its
      // pre-call guards (closed/null transceiver/missing replaceTrack) it throws
      // without stopping it. Stop it here on ANY rejection so a guard-path
      // throw cannot leak a device-holding track. track.stop() is idempotent,
      // so a double-stop alongside the session's rollback is safe. Precisely
      // because the caller may have failed BEFORE the session ever attached the
      // track, the caller must own stopping it; session teardown never sees it.
      track.stop();
      if (error instanceof MediaError) throw error;
      throw new MediaError('INTERNAL_ERROR', 'The microphone replacement failed.');
    }
  }

  /**
   * The active session's retained remote stream, if surfaced. Used by the facade
   * to assign `attachRemoteAudio` without racing the `remoteAudio` event stream.
   */
  get activeRemoteStream(): MediaStream | null {
    return this.retainedRemoteStream;
  }

  /**
   * Observe session-end (stream reclamation), for remote-audio cleanup. Returns
   * an idempotent unsubscribe. This is a lifecycle observer, unrelated to the
   * browser `devicechange` listener.
   */
  onSessionEnd(listener: (sessionId: string) => void): () => void {
    this.sessionEndListeners.add(listener);
    return (): void => {
      this.sessionEndListeners.delete(listener);
    };
  }

  /**
   * Resolve when the media session with the given id reaches `connected`.
   * Observes the manager's EXISTING media-state events under the injected clock
   * (this is a manager concern, not a worker-protocol command). Settles on:
   * `connected` (resolve), `mediaFailed` (reject with the media error), session
   * close (reject `ABORTED`), `options.signal` abort (reject `ABORTED`), or
   * `options.timeoutMs` elapsing (reject `MEDIA_OPERATION_TIMEOUT`). A session
   * already connected resolves immediately.
   */
  async waitForConnected(sessionId: string, options?: WaitForConnectedOptions): Promise<void> {
    const current = this.owned;
    if (current !== null && current.sessionId === sessionId) {
      if (current.currentState === 'connected') return;
      if (current.currentState === 'failed') {
        // The failure already fired before the wait started; settle on it
        // rather than hanging to the deadline.
        throw this.sessionErrors.get(sessionId)
          ?? new MediaError('NEGOTIATION_FAILED', SAFE_MESSAGES.NEGOTIATION_FAILED);
      }
      if (current.currentState === 'closed') {
        throw this.sessionErrors.get(sessionId)
          ?? new MediaError('ABORTED', SAFE_MESSAGES.ABORTED);
      }
    } else if (this.sessionErrors.has(sessionId)) {
      // The session already failed and was reclaimed; settle on its error.
      throw this.sessionErrors.get(sessionId)!;
    }
    const timeoutMs = options?.timeoutMs ?? DEFAULT_MEDIA_OPERATION_TIMEOUT_MS;
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      let timer = -1;
      let onAbort: () => void = () => undefined;

      const listener = (event: SessionStateEvent): void => {
        if (event.sessionId !== sessionId) return;
        if (event.type === 'mediaStateChanged') {
          if (event.state === 'connected') {
            finish(() => resolve());
          } else if (event.state === 'closed') {
            finish(() => reject(new MediaError('ABORTED', SAFE_MESSAGES.ABORTED)));
          }
        } else {
          finish(() => reject(event.error));
        }
      };

      const cleanup = (): void => {
        if (timer !== -1) this.clock.clearTimeout(timer);
        this.sessionStateListeners.delete(listener);
        this.connectedWaiters.delete(cancel);
        options?.signal?.removeEventListener('abort', onAbort);
      };

      const finish = (action: () => void): void => {
        if (settled) return;
        settled = true;
        cleanup();
        action();
      };

      const cancel = (): void => finish(() => reject(new MediaError('ABORTED', SAFE_MESSAGES.ABORTED)));

      this.sessionStateListeners.add(listener);
      this.connectedWaiters.add(cancel);
      onAbort = (): void => finish(() => reject(new MediaError('ABORTED', SAFE_MESSAGES.ABORTED)));
      if (options?.signal !== undefined) {
        if (options.signal.aborted) {
          onAbort();
          return;
        }
        options.signal.addEventListener('abort', onAbort, { once: true });
      }
      timer = this.clock.setTimeout(() => {
        finish(() => reject(new MediaError('MEDIA_OPERATION_TIMEOUT', SAFE_MESSAGES.MEDIA_OPERATION_TIMEOUT)));
      }, timeoutMs);
    });
  }

  // ------------------------------------------------------------------
  // close / reclaim
  // ------------------------------------------------------------------

  /** Fire-and-forget close: no reply, cancels pending, reclaims the session. */
  private handleClose(sessionId: string): void {
    if (this.disposed) return;
    if (this.owned !== null && this.owned.sessionId === sessionId) {
      this.generation += 1;
      this.cancelBoundedOperations();
      this.owned.close();
      this.owned = null;
    }
    if (this.reservedId === sessionId) {
      this.reservedId = undefined;
    }
    // Retain one ordered-bridge tombstone, never lifetime call history.
    this.lastClosedSessionId = sessionId;
    this.reclaimSession(sessionId);
    // Drop queued requests for the closed session without a reply.
    const kept: PendingRequest[] = [];
    for (const pending of this.queue) {
      if (pending.sessionId !== sessionId) kept.push(pending);
    }
    this.queue.length = 0;
    this.queue.push(...kept);
    // The generation above prevents any cancelled continuation from replying.
    void this.drain();
  }

  /** Drop the retained remote stream and notify facade session-end observers. */
  private reclaimSession(clearedSessionId: string): void {
    this.retainedRemoteStream = null;
    if (clearedSessionId !== '') {
      for (const listener of [...this.sessionEndListeners]) {
        listener(clearedSessionId);
      }
    }
  }

  // ------------------------------------------------------------------
  // Reply emission
  // ------------------------------------------------------------------

  private emitResult(requestId: string, sessionId: string, sdp?: string): void {
    this.postReply(sdp === undefined
      ? { type: 'mediaResult', requestId, sessionId }
      : { type: 'mediaResult', requestId, sessionId, sdp });
  }

  /** Emit a coded error from a thrown value. */
  private emitErrorFromThrown(error: unknown, requestId: string, sessionId: string): void {
    this.emitError(this.codeOf(error), requestId, sessionId);
  }

  /** Emit a coded error with a safe message (never secrets/stack/SDP). */
  private emitError(code: MediaErrorCode, requestId: string, sessionId: string): void {
    const valid: MediaErrorCode = (MEDIA_ERROR_CODES as readonly string[]).includes(code)
      ? code
      : 'INTERNAL_ERROR';
    this.postReply({
      type: 'mediaError',
      requestId,
      sessionId,
      message: SAFE_MESSAGES[valid] ?? SAFE_MESSAGES.INTERNAL_ERROR,
      code: valid,
    });
  }

  private postReply(reply: MediaReply): void {
    if (this.disposed) return;
    try {
      this.ports.core.postMessage(reply);
    } catch {
      // A reply write must never throw into the dispatch loop.
    }
  }

  /** Map an unknown thrown value to a valid in-union code. */
  private codeOf(error: unknown): MediaErrorCode {
    if (error instanceof MediaError) {
      // Known media errors cross the bridge unchanged; only malformed or
      // externally supplied unknown values become INTERNAL_ERROR.
      if ((MEDIA_ERROR_CODES as readonly string[]).includes(error.code)) {
        return error.code;
      }
    }
    return 'INTERNAL_ERROR';
  }
}

/**
 * Validate a provider result and return a defensive copy, or fail INTERNAL_ERROR.
 * Every server must be an object whose `urls` is a string or an array of strings,
 * whose `username` (when present) is a string, and whose `credential` (when
 * present) is a string or an RTCOAuthCredential object. Anything else — e.g.
 * `{ urls: [42] }` — rejects so the "validated defensive copies" claim holds.
 */
function validateAndCopyIceServers(
  servers: readonly RTCIceServer[],
): readonly RTCIceServer[] {
  if (!Array.isArray(servers)) {
    throw new MediaError('INTERNAL_ERROR', SAFE_MESSAGES.INTERNAL_ERROR);
  }
  for (const server of servers) {
    if (server === null || typeof server !== 'object') {
      throw new MediaError('INTERNAL_ERROR', SAFE_MESSAGES.INTERNAL_ERROR);
    }
    const { urls, username, credential } = server as RTCIceServer;
    if (typeof urls !== 'string') {
      if (!Array.isArray(urls) || urls.some((u) => typeof u !== 'string')) {
        throw new MediaError('INTERNAL_ERROR', SAFE_MESSAGES.INTERNAL_ERROR);
      }
    }
    if (username !== undefined && typeof username !== 'string') {
      throw new MediaError('INTERNAL_ERROR', SAFE_MESSAGES.INTERNAL_ERROR);
    }
    if (
      credential !== undefined
      && typeof credential !== 'string'
      && (credential === null || typeof credential !== 'object')
    ) {
      throw new MediaError('INTERNAL_ERROR', SAFE_MESSAGES.INTERNAL_ERROR);
    }
  }
  return copyIceServers(servers) ?? [];
}

/** Map a provider rejection to a safe coded error (never leaks message/secrets). */
function mapProviderError(_error: unknown): MediaError {
  return new MediaError('INTERNAL_ERROR', SAFE_MESSAGES.INTERNAL_ERROR);
}

/** The first audio track of a directly-owned microphone stream, if any. */
function firstAudioTrackOf(stream: MediaStream): MediaStreamTrack | undefined {
  return stream.getAudioTracks()[0];
}
