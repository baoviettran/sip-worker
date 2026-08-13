/**
 * Browser WebRTC media session (v0.5).
 *
 * One `WebRtcMediaSession` exclusively owns one `RTCPeerConnection`, one local
 * microphone track while active, one remote `MediaStream` assembled from
 * received audio tracks, its peer-connection and negotiation listeners, its
 * ICE-gathering and negotiation waiters, and its single current negotiation
 * operation. Disposal is idempotent: it invalidates pending operations,
 * detaches listeners, stops every locally and remotely owned track, closes the
 * peer connection, clears waiters, and emits no later state transition from
 * stale callbacks.
 *
 * Initial offer/answer and restart use complete non-trickle SDP after bounded
 * ICE gathering. Codec preferences come from browser capabilities through
 * {@link applyAudioCodecPolicy} — no SDP text is ever edited. SDP, ICE
 * candidates, credentials, and device identifiers are never logged.
 */

import { MediaError } from '@sip-worker/core';
import type { BrowserMediaEventMap, MediaSessionState } from './types.js';
import { DEFAULT_ICE_GATHERING_TIMEOUT_MS } from './types.js';
import type { BrowserMediaEnvironment, BrowserMediaOptions } from './types.js';
import { applyAudioCodecPolicy } from './codec-policy.js';

/** A narrowed emit surface the session drives typed media events through. */
interface SessionEmitter {
  emit<K extends keyof BrowserMediaEventMap>(type: K, value: BrowserMediaEventMap[K]): void;
}

/** Reason carried on a state transition; mirrors the safe {@link MediaError} codes. */
type StateReason = MediaError['code'];

/** Upper bound (bytes) for a remote SDP body the session will pass to the browser. */
const MAX_REMOTE_SDP_BYTES = 512_000;

/** Constructor dependencies, resolved by the owning media manager. */
export interface WebRtcMediaSessionDeps {
  readonly env: BrowserMediaEnvironment;
  readonly options: BrowserMediaOptions;
  /** Acquire a fresh microphone stream for a new call (session never asks permission itself). */
  readonly acquireTrack: () => Promise<MediaStream>;
  /** Injectable clock for the ICE-gathering deadline; keeps the session Node-free and testable. */
  readonly clock: {
    now(): number;
    setTimeout(callback: () => void, delayMs: number): number;
    clearTimeout(id: number): void;
  };
  readonly emitter: SessionEmitter;
  readonly sessionId: string;
}

/**
 * A single-call WebRTC audio session.
 *
 * Public operations are serialized through a single-negotiation lock:
 * `createOffer`, `createAnswer`, `setRemote`, and `restartIce` each take it, and
 * a duplicate concurrent operation rejects `INVALID_STATE` (never merged).
 * `close()` wins every race and invalidates every pending operation.
 */
export class WebRtcMediaSession {
  private readonly env: BrowserMediaEnvironment;
  private readonly options: BrowserMediaOptions;
  private readonly acquireTrack: () => Promise<MediaStream>;
  private readonly clock: WebRtcMediaSessionDeps['clock'];
  private readonly emitter: SessionEmitter;
  readonly sessionId: string;

  private state: MediaSessionState = 'new';
  private closed = false;

  /** The single peer connection this session owns for its whole life. */
  private pc: RTCPeerConnection | null = null;
  private transceiver: RTCRtpTransceiver | null = null;
  /** The local microphone track while active; owned and stopped by this session. */
  private localTrack: MediaStreamTrack | null = null;
  /** The session-owned remote stream assembled from received audio tracks. */
  private remoteStream: MediaStream | null = null;
  private readonly remoteTracks = new Set<MediaStreamTrack>();

  /**
   * Operation tokens: every asynchronous waiter captures a token at start and
   * honours its result only while the token and the session are still current.
   * `close()` bumps the sequence to invalidate all in-flight operations at once.
   */
  /**
   * The current negotiation generation. `runNegotiation` stamps its token here
   * and releases the lock only when its token is still current; `close()` bumps
   * the sequence to invalidate every in-flight operation at once.
   */
  private opSeq = 0;
  /**
   * Serial epoch for ICE/deadline waiters. Kept separate from `opSeq` so a
   * waiter's freshness check can never disturb lock release. `close()` also
   * bumps it so pending waiters are invalidated. Both reset on the same teardown.
   */
  private waitSeq = 0;
  /** True while a negotiation operation (offer/answer/setRemote/restart) holds the lock. */
  private negotiating = false;
  /** Cancellation hooks for in-flight ICE/deadline waiters; drained on teardown. */
  private readonly waiters = new Set<() => void>();

  constructor(deps: WebRtcMediaSessionDeps) {
    this.env = deps.env;
    this.options = deps.options;
    this.acquireTrack = deps.acquireTrack;
    this.clock = deps.clock;
    this.emitter = deps.emitter;
    this.sessionId = deps.sessionId;
  }

  /** The lifetime (ms) allowed for ICE gathering on one negotiation. */
  private get iceGatheringTimeoutMs(): number {
    return this.options.iceGatheringTimeoutMs ?? DEFAULT_ICE_GATHERING_TIMEOUT_MS;
  }

  /** Read the current state (for the manager/port-pair bridge). */
  get currentState(): MediaSessionState {
    return this.state;
  }

  private transition(next: MediaSessionState, reason?: StateReason): void {
    if (this.state === next) return;
    const previous = this.state;
    this.state = next;
    this.emitter.emit('mediaStateChanged', {
      type: 'mediaStateChanged',
      sessionId: this.sessionId,
      previous,
      state: next,
      ...(reason === undefined ? {} : { reason }),
    });
  }

  private fail(error: MediaError): void {
    if (this.state === 'failed' || this.state === 'closed') return;
    this.transition('failed', error.code);
    this.emitter.emit('mediaFailed', {
      type: 'mediaFailed',
      sessionId: this.sessionId,
      error,
    });
    this.teardown();
  }

  /**
   * Create a complete non-trickle SDP offer for an outgoing call. Acquires a
   * fresh microphone track, wires one audio `sendrecv` transceiver, applies codec
   * preferences, creates and applies the local offer, and waits for ICE gathering
   * to complete within the deadline before returning the complete SDP.
   */
  async createOffer(): Promise<string> {
    return this.runNegotiation(async () => {
      await this.aquireTrackAndWire('negotiating');
      try {
        this.applyCodecs();
        const offer = await this.pc!.createOffer();
        await this.setLocalAndWait(offer);
        if (offer.sdp === undefined) {
          throw this.toMediaError(new Error('empty SDP'), 'NEGOTIATION_FAILED');
        }
        return offer.sdp;
      } catch (error) {
        this.releaseAfterFailure();
        throw error;
      }
    });
  }

  /**
   * Create a complete non-trickle SDP answer for an incoming call. Acquires a
   * fresh microphone track, validates and applies the remote offer, creates and
   * applies the local answer, and waits for ICE gathering before returning.
   */
  async createAnswer(remoteSdp: string): Promise<string> {
    return this.runNegotiation(async () => {
      await this.aquireTrackAndWire('negotiating');
      try {
        this.applyCodecs();
        await this.applyRemoteDescription(remoteSdp, 'offer');
        const answer = await this.pc!.createAnswer();
        await this.setLocalAndWait(answer);
        if (answer.sdp === undefined) {
          throw this.toMediaError(new Error('empty SDP'), 'NEGOTIATION_FAILED');
        }
        return answer.sdp;
      } catch (error) {
        this.releaseAfterFailure();
        throw error;
      }
    });
  }

  /**
   * Apply a remote description to the active peer connection. For an outgoing
   * call this is the eventual answer; for an incoming re-INVITE it is the offer.
   * A rejected remote description maps to
   * {@link @sip-worker/core!MediaErrorCode.REMOTE_DESCRIPTION_REJECTED}.
   */
  async setRemote(remoteSdp: string, type?: RTCSdpType): Promise<void> {
    return this.runNegotiation(async () => {
      if (this.pc === null) throw this.invalidState('no active session');
      try {
        await this.applyRemoteDescription(remoteSdp, type ?? 'answer');
      } catch (error) {
        const err = error instanceof MediaError
          ? error
          : this.toMediaError(error, 'REMOTE_DESCRIPTION_REJECTED');
        this.fail(err);
        throw err;
      }
    });
  }

  /**
   * Restart ICE on a confirmed active call. Reserves the negotiation lock, calls
   * `pc.restartIce()` when available and otherwise uses `createOffer({ iceRestart:
   * true })`, applies the fresh local offer, and waits for ICE gathering before
   * returning the complete SDP.
   */
  async restartIce(): Promise<string> {
    return this.runNegotiation(async () => {
      if (this.pc === null || this.transceiver === null) {
        throw this.invalidState('no active session');
      }
      try {
        const restart = (this.pc as RTCPeerConnection & { restartIce?: () => void }).restartIce;
        if (typeof restart === 'function') {
          restart.call(this.pc);
        }
        const offer = await this.pc.createOffer({ iceRestart: true });
        await this.setLocalAndWait(offer);
        if (offer.sdp === undefined) {
          throw this.toMediaError(new Error('empty SDP'), 'NEGOTIATION_FAILED');
        }
        return offer.sdp;
      } catch (error) {
        this.releaseAfterFailure();
        throw error;
      }
    });
  }

  /**
   * Transactionally replace the active microphone track: replace the attached
   * track, commit the new selection, then stop the old track. Any earlier failure
   * rolls back — the old track stays attached and the new track is stopped — and
   * the promise rejects.
   */
  async replaceMicrophone(newTrack: MediaStreamTrack): Promise<void> {
    if (this.closed) throw this.aborted('replaceMicrophone');
    if (this.pc === null || this.transceiver === null || this.localTrack === null) {
      throw this.invalidState('no active session');
    }
    const oldTrack = this.localTrack;
    const sender = this.transceiver.sender as RTCRtpSender & {
      replaceTrack?(track: MediaStreamTrack | null): Promise<void>;
    };
    if (typeof sender.replaceTrack !== 'function') {
      throw this.invalidState('microphone replacement unavailable');
    }
    try {
      await sender.replaceTrack(newTrack);
    } catch (error) {
      // Rollback: the old track stays attached and plays on; stop the rejected
      // new track. Failures are observable (tyed) but do not tear down the
      // still-usable existing media.
      newTrack.stop();
      const err = this.toMediaError(error, 'INTERNAL_ERROR');
      this.transition('failed', err.code);
      this.emitter.emit('mediaFailed', {
        type: 'mediaFailed',
        sessionId: this.sessionId,
        error: err,
      });
      throw err;
    }
    // Commit.
    this.localTrack = newTrack;
    oldTrack.stop();
  }

  /**
   * Idempotently release every resource this session owns. Bumps the operation
   * sequence (invalidating pending operations), detaches listeners, stops local
   * and remote tracks, closes the peer connection, clears waiters, and emits no
   * further state transition after the terminal state.
   */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.opSeq += 1; // invalidate every in-flight operation
    this.waitSeq += 1; // invalidate every in-flight waiter
    this.negotiating = false;
    this.teardown();
    if (this.state !== 'failed') {
      this.transition('closed');
    }
  }

  /** Release PC listeners/resources without touching the lifecycle-closed flag. */
  private teardown(): void {
    for (const cancel of this.waiters) {
      cancel();
    }
    this.waiters.clear();
    if (this.pc !== null) {
      this.pc.onicegatheringstatechange = null;
      this.pc.oniceconnectionstatechange = null;
      this.pc.onconnectionstatechange = null;
      this.pc.ontrack = null;
      try {
        this.pc.close();
      } catch {
        // Already closed by the browser; teardown remains idempotent.
      }
    }
    this.pc = null;
    this.transceiver = null;
    if (this.localTrack !== null) {
      this.localTrack.stop();
      this.localTrack = null;
    }
    for (const track of this.remoteTracks) {
      track.stop();
    }
    this.remoteTracks.clear();
    this.remoteStream = null;
  }

  /**
   * Acquire a fresh microphone track and wire one audio `sendrecv` transceiver
   * to the peer connection. Reaching `target` state happens only after capture
   * succeeds.
   */
  private async aquireTrackAndWire(target: MediaSessionState): Promise<void> {
    this.transition('acquiring');
    const stream = await this.acquireTrack();
    this.transition(target);
    this.ensurePeerConnection();
    const pc = this.pc!;
    const transceiver = pc.addTransceiver('audio', { direction: 'sendrecv' });
    this.transceiver = transceiver;
    const track = firstAudioTrack(stream);
    if (track !== undefined) {
      this.localTrack = track;
      if (typeof transceiver.sender.replaceTrack === 'function') {
        await transceiver.sender.replaceTrack(track);
      }
    }
  }

  private ensurePeerConnection(): void {
    if (this.pc !== null) return;
    const config: RTCConfiguration = {
      iceServers: [...(this.options.iceServers ?? [])],
      ...(this.options.iceTransportPolicy === undefined
        ? {}
        : { iceTransportPolicy: this.options.iceTransportPolicy }),
    };
    this.pc = this.env.createPeerConnection(config);
    this.pc.oniceconnectionstatechange = (): void => this.onIceConnectionChange(this.pc!);
    this.pc.onconnectionstatechange = (): void => this.onConnectionChange(this.pc!);
    this.pc.ontrack = (event): void => this.onTrack(event);
  }

  private onIceConnectionChange(pc: RTCPeerConnection): void {
    if (this.closed) return;
    const state = pc.iceConnectionState;
    if (state === 'connected' || state === 'completed') {
      if (this.state !== 'closed') this.transition('connected');
    } else if (state === 'checking') {
      if (this.state === 'connected') this.transition('connecting');
    } else if (state === 'failed') {
      this.fail(this.iceFailed());
    }
  }

  private onConnectionChange(pc: RTCPeerConnection): void {
    if (this.closed || pc.connectionState !== 'failed') return;
    this.fail(this.iceFailed());
  }

  private iceFailed(): MediaError {
    return new MediaError(
      'ICE_CONNECTION_FAILED',
      'The media connection could not be established.',
      this.sessionId,
      'media connection',
    );
  }

  /** Assemble the session's single remote stream and surface `remoteAudio`. */
  private onTrack(event: RTCTrackEvent): void {
    if (this.closed || event.track.kind !== 'audio') return;
    this.remoteTracks.add(event.track);
    if (this.remoteStream === null) {
      // Prefer the browser-provided stream for this track; the tracks are owned
      // by the session for teardown regardless.
      this.remoteStream = event.streams[0] ?? this.env.createMediaStream();
    } else if (event.streams[0] !== undefined && event.streams[0] !== this.remoteStream) {
      // Additional audio tracks for the same session are incorporated
      // deterministically without replacing the surfaced stream.
      const track = event.track;
      if (typeof (this.remoteStream as MediaStream).addTrack === 'function') {
        this.remoteStream.addTrack(track);
      }
    }
    this.emitter.emit('remoteAudio', {
      type: 'remoteAudio',
      sessionId: this.sessionId,
      stream: this.remoteStream,
    });
  }

  /** Apply codec preferences from browser audio capabilities to the transceiver. */
  private applyCodecs(): void {
    if (this.transceiver === null) return;
    const caps = this.env.getAudioCapabilities();
    if (caps === null) return; // browser keeps its defaults
    applyAudioCodecPolicy(
      {
        setCodecPreferences: (codecs: RTCRtpCodec[]): void => {
          this.transceiver!.setCodecPreferences(codecs);
        },
      },
      caps,
      this.options.codecPreference,
    );
  }

  /**
   * Validate (size-bounded, never logged) and apply the remote description. Any
   * rejection maps to `REMOTE_DESCRIPTION_REJECTED`.
   */
  private async applyRemoteDescription(sdp: string, type: RTCSdpType): Promise<void> {
    if (typeof sdp !== 'string' || sdp.length === 0 || sdp.length > MAX_REMOTE_SDP_BYTES) {
      throw this.remoteRejected();
    }
    try {
      await this.pc!.setRemoteDescription({ type, sdp });
    } catch {
      throw this.remoteRejected();
    }
  }

  private remoteRejected(): MediaError {
    return new MediaError(
      'REMOTE_DESCRIPTION_REJECTED',
      'The remote session description was rejected.',
      this.sessionId,
      'remote description',
    );
  }

  /**
   * Apply the local description, then wait for ICE gathering to complete within
   * the deadline. The gather-completion observer is subscribed BEFORE
   * `setLocalDescription` (see {@link waitForIceComplete}), so a synchronous
   * completion cannot be missed.
   */
  private async setLocalAndWait(description: RTCSessionDescriptionInit): Promise<void> {
    const wait = this.waitForIceComplete();
    await this.pc!.setLocalDescription(description);
    await wait;
  }

  /**
   * Resolve when `iceGatheringState === 'complete'` (immediately when already
   * complete), or fail closed with `ICE_GATHERING_TIMEOUT` on the deadline. The
   * observer and its deadline timer are always cleared.
   */
  private waitForIceComplete(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const pc = this.pc;
      if (this.closed || pc === null) {
        reject(this.aborted('negotiation'));
        return;
      }
      const waiterEpoch = ++this.waitSeq;
      let settled = false;

      const finish = (error: null | MediaError, result?: () => void): void => {
        if (settled) return;
        settled = true;
        this.clock.clearTimeout(deadline);
        this.waiters.delete(cancel);
        if (pc.onicegatheringstatechange === onState) {
          pc.onicegatheringstatechange = null;
        }
        if (error !== null) reject(error);
        else resolve();
        result?.();
      };

      const onState = (): void => {
        if (settled || pc.iceGatheringState !== 'complete') return;
        finish(null);
      };

      const cancel = (): void => {
        finish(this.aborted('negotiation'));
      };

      const deadline = this.clock.setTimeout(() => {
        if (settled) return;
        const error = new MediaError(
          'ICE_GATHERING_TIMEOUT',
          'ICE gathering did not complete in time.',
          this.sessionId,
          'negotiation',
        );
        // Settle the waiter with the typed timeout BEFORE tearing down; teardown
        // drains waiters and would otherwise reject with ABORTED.
        finish(error);
        if (waiterEpoch === this.waitSeq && !this.closed) {
          this.fail(error);
        }
      }, this.iceGatheringTimeoutMs);

      this.waiters.add(cancel);
      // Subscribe BEFORE setLocalDescription runs, so the observer catches a
      // synchronous completion; a connection already complete resolves at once.
      pc.onicegatheringstatechange = onState;
      if (pc.iceGatheringState === 'complete') {
        onState();
      }
    });
  }

  /**
   * Serialize negotiation operations through the single-negotiation lock. A
   * duplicate concurrent or closed operation rejects; the lock is released when
   * the current operation settles unless `close()` already invalidated it.
   */
  private async runNegotiation<R>(op: () => Promise<R>): Promise<R> {
    if (this.closed) throw this.aborted('negotiation');
    if (this.negotiating) throw this.invalidState('negotiation already in progress');
    this.negotiating = true;
    const token = ++this.opSeq;
    try {
      return await op();
    } finally {
      if (token === this.opSeq && !this.closed) {
        this.negotiating = false;
      }
    }
  }

  /**
   * On a negotiation failure, stop the freshly acquired local track and surface a
   * typed failure unless a specific code already won.
   */
  private releaseAfterFailure(): void {
    if (this.localTrack !== null) {
      this.localTrack.stop();
      this.localTrack = null;
    }
    if (this.state === 'failed' || this.state === 'closed') return;
    this.fail(new MediaError(
      'NEGOTIATION_FAILED',
      'The media negotiation failed.',
      this.sessionId,
      'negotiation',
    ));
  }

  private toMediaError(error: unknown, fallback: StateReason): MediaError {
    if (error instanceof MediaError) return error;
    return new MediaError(fallback, 'The media negotiation failed.', this.sessionId, 'negotiation');
  }

  private aborted(operation: string): MediaError {
    return new MediaError('ABORTED', 'The media operation was aborted.', this.sessionId, operation);
  }

  /**
   * A duplicate/illegal negotiation operation. `INVALID_STATE` is a local
   * protocol-level rejection (not a media *failure*), and is not in core's
   * {@link MediaErrorCode} union; the value is correct per the v0.5 design even
   * though the type must cast it.
   */
  private invalidState(message: string): MediaError {
    return new MediaError(
      /* v8-on-ts */ 'INVALID_STATE' as MediaError['code'],
      message,
      this.sessionId,
      'negotiation',
    );
  }
}

/** The first audio track of a directly-owned media stream, if any. */
function firstAudioTrack(stream: MediaStream): MediaStreamTrack | undefined {
  return stream.getAudioTracks()[0];
}