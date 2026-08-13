/**
 * Bridge core media commands to a single browser WebRTC session (v0.5).
 *
 * {@link WebRtcMediaManager} serializes the plain-data core media protocol
 * (`createOffer`/`createAnswer`/`setRemote`/`closeSession`) to and from a single
 * {@link WebRtcMediaSession}. It owns one active session per browser user-agent
 * and serializes every negotiation operation so commands cannot interleave.
 *
 * Every thrown value is mapped to a safe, coded `mediaError` reply carrying no
 * SDP, device, ICE, credential, or stack data. `INVALID_STATE` (which the Task-8
 * session emits for a duplicate/illegal negotiation but which is NOT in core's
 * 12-value `MediaErrorCode` union) is mapped to `INTERNAL_ERROR` at this
 * boundary — the structurally-safe, in-union choice — because core's controller
 * reconstructs any out-of-union code to `INTERNAL_ERROR` anyway.
 *
 * `closeSession` is fire-and-forget (no reply) and cancels every pending request
 * for that session; late tracks/streams are reclaimed on reclamation. Disposal
 * is idempotent: it closes the session, disposes the device manager (removing
 * the device-change listener), closes the port pair, and stops accepting work.
 */

import { MediaError } from '@sip-worker/core';
import type { MediaErrorCode } from '@sip-worker/core';
import type { MediaCommand, MediaMessage, MediaReply } from '@sip-worker/core';
import type { BrowserMediaEnvironment, BrowserMediaEventMap, BrowserMediaOptions } from './types.js';
import { MediaDeviceManager } from './device-manager.js';
import { WebRtcMediaSession } from './session.js';
import type { WebRtcMediaSessionDeps } from './session.js';
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

/** A queued, not-yet-dispatched media request awaiting a reply. */
interface PendingRequest {
  readonly requestId: string;
  readonly sessionId: string;
  readonly type: 'createOffer' | 'createAnswer' | 'setRemote';
  readonly iceRestart?: boolean;
  readonly remoteSdp?: string;
}

/** Core's valid media error codes, in canonical order (mirrors core). */
const MEDIA_ERROR_CODES: readonly string[] = [
  'PERMISSION_DENIED', 'DEVICE_NOT_FOUND', 'DEVICE_UNAVAILABLE', 'CONSTRAINT_UNSATISFIED',
  'NEGOTIATION_FAILED', 'REMOTE_DESCRIPTION_REJECTED', 'ICE_GATHERING_TIMEOUT',
  'ICE_CONNECTION_FAILED', 'OUTPUT_SELECTION_UNSUPPORTED', 'PLAYBACK_FAILED',
  'ABORTED', 'INTERNAL_ERROR',
];

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
  /**
   * Session ids whose resources were reclaimed via closeSession. A command for a
   * consumed id is a stale/reclaimed message and is ignored, preventing a ghost
   * session from resurrecting an ended call.
   */
  private readonly consumedSessionIds = new Set<string>();
  /** Serialized negotiation queue; exactly one command dispatched at a time. */
  private readonly queue: PendingRequest[] = [];
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
      case 'createAnswer':
      case 'setRemote':
        // A command for an already-reclaimed session is stale: ignore it.
        if (message.sessionId !== undefined && this.consumedSessionIds.has(message.sessionId)) {
          return;
        }
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
    if (this.owned !== null) {
      this.owned.close();
      this.owned = null;
    }
    this.reservedId = undefined;
    this.consumedSessionIds.clear();
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
      // A different active session: reject predictably without disturbing the
      // active one. The duplicate-operation rejection is INVALID_STATE per the
      // design, but INVALID_STATE is not in core's 12-code union, so it is
      // mapped at this boundary to INTERNAL_ERROR (structurally safe).
      this.emitErrorFromThrown(
        new MediaError('INVALID_STATE' as MediaError['code'], 'A media session is already active.'),
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
        if (this.reservedId === undefined) {
          this.reservedId = sessionId;
        }
        if (this.owned === null) {
          this.owned = this.createSession(sessionId);
        }
        try {
          const sdp = created || pending.iceRestart !== true
            ? await this.owned.createOffer()
            : await this.owned.restartIce();      // C4: restart an active session
          if (generation === this.generation && this.reservedId === sessionId) {
            this.emitResult(requestId, sessionId, sdp);
          }
        } catch (error) {
          const partial = this.owned;
          this.owned = null;
          this.reservedId = undefined;
          this.consumedSessionIds.add(sessionId);
          if (generation === this.generation) {
            // Close a partial session before sending the error reply so its
            // PC/track/listeners are reclaimed and no late state leaks.
            if (created) partial?.close();
            this.emitError(this.codeOf(error), requestId, sessionId);
          } else {
            // Reclaimed by a concurrent close: no late reply, no leak.
            partial?.close();
          }
        }
        return;
      }
      case 'createAnswer':
      case 'setRemote': {
        // `createAnswer` handles an incoming call, which may be the very first
        // media command (no prior offer): reserve the session and build it.
        // `setRemote` requires an existing, active session by contract.
        if (this.owned === null && type === 'createAnswer') {
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
            const sdp = await this.owned.createAnswer(pending.remoteSdp ?? '');
            if (generation === this.generation && this.reservedId === sessionId) {
              this.emitResult(requestId, sessionId, sdp);
            }
          } else {
            await this.owned.setRemote(pending.remoteSdp ?? '');
            if (generation === this.generation && this.reservedId === sessionId) {
              this.emitResult(requestId, sessionId);
            }
          }
        } catch (error) {
          this.owned = null;
          this.reservedId = undefined;
          if (generation === this.generation) {
            this.emitError(this.codeOf(error), requestId, sessionId);
          }
          this.consumedSessionIds.add(sessionId);
        }
        return;
      }
      default:
        return;
    }
  }

  /** Construct a fresh session bound to this manager's env/clock/emitter. */
  private createSession(sessionId: string): WebRtcMediaSession {
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
        emit: <K extends keyof BrowserMediaEventMap>(type: K, value: BrowserMediaEventMap[K]): void =>
          this.emitter.emit(type, value),
      },
      sessionId,
    };
    return new WebRtcMediaSession(deps);
  }

  // ------------------------------------------------------------------
  // close / reclaim
  // ------------------------------------------------------------------

  /** Fire-and-forget close: no reply, cancels pending, reclaims the session. */
  private handleClose(sessionId: string): void {
    if (this.disposed) return;
    if (this.owned !== null && this.owned.sessionId === sessionId) {
      this.owned.close();
      this.owned = null;
    }
    if (this.reservedId === sessionId) {
      this.reservedId = undefined;
    }
    // The session's resources are reclaimed; its id is consumed so a late
    // command cannot resurrect it.
    this.consumedSessionIds.add(sessionId);
    // Drop queued requests for the closed session without a reply.
    const kept: PendingRequest[] = [];
    for (const pending of this.queue) {
      if (pending.sessionId !== sessionId) kept.push(pending);
    }
    this.queue.length = 0;
    this.queue.push(...kept);
    // Invalidate any in-flight continuation so a late track/stream is reclaimed
    // and no late reply is emitted after reclamation.
    this.generation += 1;
    void this.drain();
  }

  // ------------------------------------------------------------------
  // Reply emission
  // ------------------------------------------------------------------

  private emitResult(requestId: string, sessionId: string, sdp?: string): void {
    this.postReply(sdp === undefined
      ? { type: 'mediaResult', requestId, sessionId }
      : { type: 'mediaResult', requestId, sessionId, sdp });
  }

  /** Emit a coded error from a thrown value, mapping INVALID_STATE → INTERNAL_ERROR. */
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

  /** Map an unknown thrown value to a valid in-union code. C1: INVALID_STATE → INTERNAL_ERROR. */
  private codeOf(error: unknown): MediaErrorCode {
    if (error instanceof MediaError) {
      // INVALID_STATE is not in core's union (C1); map to the structurally-safe
      // INTERNAL_ERROR so no out-of-union code ever crosses the wire.
      if ((MEDIA_ERROR_CODES as readonly string[]).includes(error.code)) {
        return error.code;
      }
    }
    return 'INTERNAL_ERROR';
  }
}