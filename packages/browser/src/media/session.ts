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

import { MediaError, validateOperationTimeout } from '@sip-worker/core';
import type { MediaDirection } from '@sip-worker/core';
import type { OperationOptions } from '@sip-worker/core';
import type { SipErrorCode } from '@sip-worker/core';
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

/**
 * Accepted RFC 4733 DTMF symbols: `0-9`, `A-D`, `*`, and `#`. Lowercase is
 * rejected (a browser DTMF sender expects upper-case tones).
 */
const DTMF_SYMBOLS = new Set('0123456789ABCD*#');
/** Maximum tones in a single insertDTMF sequence (RFC 4733 / browser limit). */
const DTMF_MAX_TONES = 255;
/** DTMF tone duration bounds (ms), per RFC 4733 and browser defaults. */
const DTMF_MIN_DURATION_MS = 40;
const DTMF_MAX_DURATION_MS = 6000;
const DTMF_DEFAULT_DURATION_MS = 100;
/** Inter-tone gap minimum (ms); below the browser's floor the sequence is invalid. */
const DTMF_MIN_GAP_MS = 30;
const DTMF_DEFAULT_GAP_MS = 70;
/** Default deadline (ms) for one DTMF sequence; never unbound. */
const DTMF_DEFAULT_TIMEOUT_MS = 30_000;

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
 * Options bounding one RFC 4733 DTMF sequence (sent through the browser's
 * `RTCDTMFSender`). Mirrors {@link OperationOptions}: `signal` aborts the
 * sequence early (clearing the tone buffer and settling `OPERATION_ABORTED`),
 * and `timeoutMs` bounds how long the sequence may run (default 30 s) before it
 * settles `OPERATION_TIMEOUT`.
 */
export interface DtmfOptions extends OperationOptions {
  /** Tone duration in ms (default 100, range 40-6000). */
  readonly durationMs?: number;
  /** Inter-tone gap in ms (default 70, minimum 30). */
  readonly interToneGapMs?: number;
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

  /**
   * The last confirmed negotiated direction. The transceiver always matches
   * this between direction transactions; a staged direction never survives a
   * commit/rollback/failure.
   */
  private confirmedDirection: MediaDirection = 'sendrecv';
  /**
   * A direction staged in a pending negotiation. Cleared on commit, rollback,
   * failure, or close — no half-staged direction survives.
   */
  private stagedDirection: MediaDirection | undefined;
  /** The direction the remote peer declared in its most recent description. */
  private remoteDirectionValue: MediaDirection | 'recvonly' | undefined;

  /**
   * The persisted microphone mute preference. Survives device replacement and
   * ICE restart; only {@link setMuted} writes it.
   */
  private mutedValue = false;
  /**
   * The local hold preference. Hold behaviour is a later control task; this
   * field exists so {@link applyTrackEnabled} is the single source of truth
   * both mute and hold share. `setMuted` only READS it, never writes it.
   */
  private localHoldValue = false;

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
  /**
   * The `opSeq` value stamped when the current negotiation acquired the lock.
   * The acquisition continuation compares against it so a `close()` that ran
   * while `getUserMedia` was pending can invalidate the late track; `close()`
   * bumps `opSeq`, so a mismatch here means the negotiation was superseded.
   */
  private acquisitionSeq = 0;
  /** True while a negotiation operation (offer/answer/setRemote/restart) holds the lock. */
  private negotiating = false;
  /** Cancellation hooks for in-flight ICE/deadline waiters; drained on teardown. */
  private readonly waiters = new Set<() => void>();
  /**
   * The single active DTMF tone-buffer operation's settle function, or null.
   * Exactly one tone-buffer op may be active at a time; a duplicate sequence is
   * rejected `OPERATION_IN_PROGRESS` and never queued. Cleared on every terminal
   * path (completion, abort, timeout, hangup, sender replacement, teardown).
   */
  private activeDtmfOp: ((error: Error | null) => void) | null = null;

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

  /**
   * The direction the remote peer declared in its most recent applied remote
   * description, when the SDP carries an explicit audio direction attribute.
   * `'recvonly'` (a remote that only receives) is observable but is not a
   * local offer direction, so it falls outside {@link MediaDirection}.
   */
  get remoteDirection(): MediaDirection | 'recvonly' | undefined {
    return this.remoteDirectionValue;
  }

  /** Whether the local microphone is muted (persisted, independent of hold). */
  get muted(): boolean {
    return this.mutedValue;
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
    this.stagedDirection = undefined; // no half-staged direction survives a failure
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
        return this.completeLocalSdp('offer');
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
        return this.completeLocalSdp('answer');
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
   * {@link @sip-worker/core#MediaErrorCode.REMOTE_DESCRIPTION_REJECTED}.
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
        return this.completeLocalSdp('offer');
      } catch (error) {
        this.releaseAfterFailure();
        throw error;
      }
    });
  }

  /**
   * Stage a directional re-negotiation on an ACTIVE session: set the
   * transceiver direction, create and apply the complete local offer, and wait
   * for ICE gathering before returning the SDP. The direction is STAGED, not
   * confirmed — {@link commitDirection} confirms it after the remote
   * description applies, and {@link rollbackDirection} reverts it. Publishing
   * hold state is deliberately out of scope here (hold is a later control
   * task). Any failure is terminal `NEGOTIATION_FAILED` with no staged
   * direction surviving.
   */
  async createDirectionalOffer(direction: MediaDirection): Promise<string> {
    return this.runNegotiation(async () => {
      if (this.pc === null || this.transceiver === null) {
        throw this.invalidState('no active session');
      }
      try {
        this.stagedDirection = direction;
        this.transceiver.direction = direction;
        this.applyCodecs();
        const offer = await this.pc!.createOffer();
        await this.setLocalAndWait(offer);
        return this.completeLocalSdp('offer');
      } catch (error) {
        this.stagedDirection = undefined;
        this.releaseAfterFailure();
        throw error;
      }
    });
  }

  /**
   * Confirm a staged direction transaction: the staged direction becomes the
   * confirmed direction and the stage clears. A commit with nothing staged is
   * a safe no-op (the confirmed direction stays as-is). Callers sequence this
   * AFTER the remote description for the negotiated offer is successfully
   * applied.
   */
  async commitDirection(): Promise<void> {
    return this.runNegotiation(async () => {
      if (this.pc === null) throw this.invalidState('no active session');
      if (this.stagedDirection === undefined) return;
      this.confirmedDirection = this.stagedDirection;
      this.stagedDirection = undefined;
      // A committed local hold (sendonly/inactive) is the persisted preference
      // {@link applyTrackEnabled} shares with mute; a sendrecv commit clears it.
      this.localHoldValue = this.confirmedDirection === 'sendonly' || this.confirmedDirection === 'inactive';
      this.applyTrackEnabled();
    });
  }

  /**
   * Abort a staged direction transaction: revert the local signaling state via
   * `setLocalDescription({type:'rollback'})`, restore the confirmed transceiver
   * direction, and clear the stage. A rollback with nothing staged is a safe
   * no-op. A rollback failure is terminal `NEGOTIATION_FAILED`; no
   * half-staged direction survives.
   */
  async rollbackDirection(): Promise<void> {
    return this.runNegotiation(async () => {
      if (this.pc === null || this.transceiver === null) {
        throw this.invalidState('no active session');
      }
      if (this.stagedDirection === undefined) return;
      try {
        this.transceiver.direction = this.confirmedDirection;
        await this.pc!.setLocalDescription({ type: 'rollback' });
        if (this.closed) throw this.aborted('rollback');
        this.stagedDirection = undefined;
      } catch (error) {
        this.stagedDirection = undefined;
        const err = this.toMediaError(error, 'NEGOTIATION_FAILED');
        this.fail(err);
        throw err;
      }
    });
  }

  /**
   * Set the persistent microphone mute preference synchronously and idempotently.
   * Only {@link applyTrackEnabled} is touched: this NEVER stops, replaces,
   * renegotiates, or modifies remote tracks. A repeated value emits nothing; a
   * changed value emits one fresh (immutable) `mutedChanged` event. A terminal
   * (failed/closed) session rejects canonical `INVALID_STATE`.
   */
  setMuted(muted: boolean): void {
    if (this.closed || this.state === 'failed') {
      throw this.invalidState('no active session');
    }
    if (muted === this.mutedValue) return;
    const previous = this.mutedValue;
    this.mutedValue = muted;
    this.applyTrackEnabled();
    this.emitter.emit('mutedChanged', {
      type: 'mutedChanged',
      sessionId: this.sessionId,
      previous,
      muted,
    });
  }

  /**
   * Apply the combined transmission formula to the attached local track. This is
   * the single source of truth both mute (Task 10) and hold (Task 11) share:
   * a track transmits only when it is neither muted nor locally held.
   */
  private applyTrackEnabled(): void {
    if (this.localTrack !== null) {
      this.localTrack.enabled = !this.mutedValue && !this.localHoldValue;
    }
  }

  /**
   * Transactionally replace the active microphone track: replace the attached
   * track, commit the new selection, then stop the old track. Any earlier failure
   * rolls back — the old track stays attached and the new track is stopped — and
   * the promise rejects. A muted (or held) call stages the new track's enabled
   * state BEFORE attach so no audio leaks between replaceTrack and commit, and
   * re-applies it at commit so the preference survives the swap.
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
    // A muted (or held) call must never transmit: stage the new track's enabled
    // state BEFORE attach so no audio leaks between replaceTrack and commit.
    newTrack.enabled = !this.mutedValue && !this.localHoldValue;
    try {
      await sender.replaceTrack(newTrack);
    } catch (error) {
      // Rollback: the old track stays attached and plays on; stop the rejected
      // new track. A replacement failure is NON-terminal — the existing media is
      // still usable — so the session stays in its current (connected) state, the
      // old track stays live, and no teardown runs. It is still observable via
      // mediaFailed, and a later ICE failure tears down normally.
      newTrack.stop();
      const err = this.toMediaError(error, 'INTERNAL_ERROR');
      this.emitter.emit('mediaFailed', {
        type: 'mediaFailed',
        sessionId: this.sessionId,
        error: err,
      });
      throw err;
    }
    // Commit.
    this.localTrack = newTrack;
    this.applyTrackEnabled();
    oldTrack.stop();
  }

  /**
   * Send an RFC 4733 DTMF digit sequence through the browser's `RTCDTMFSender`
   * and resolve only when the tone buffer fully drains (a final `tonechange`
   * event with an empty tone AND an empty tone buffer). The sequence is
   * validated BEFORE the sender is touched; a duplicate active sequence rejects
   * `OPERATION_IN_PROGRESS` and is never queued; a bounded deadline (default
   * 30 s) settles `OPERATION_TIMEOUT`; an abort signal clears the buffer with
   * `insertDTMF('')` and settles `OPERATION_ABORTED` exactly once. A terminal
   * session rejects canonical `INVALID_STATE` synchronously.
   *
   * Error shape: `ABORTED` (hangup/close/dispose/sender replacement) is a
   * `MediaError`; every other DTMF-path failure — `DTMF_FAILED`,
   * `DTMF_UNSUPPORTED`, `OPERATION_IN_PROGRESS`, `OPERATION_TIMEOUT`, and
   * `OPERATION_ABORTED` — is a plain `Error` carrying a `.code` from the
   * `SipErrorCode` set, the same shape as {@link BrowserCall}'s
   * `invalidCallState()`.
   */
  sendDtmf(tones: string, options?: DtmfOptions): Promise<void> {
    if (this.closed || this.state === 'failed' || this.pc === null || this.transceiver === null) {
      throw this.invalidState('no active session');
    }
    const durationMs = normalizeDtmfDuration(options?.durationMs);
    const interToneGapMs = normalizeDtmfGap(options?.interToneGapMs);
    if (durationMs === undefined || interToneGapMs === undefined) {
      return Promise.reject(dtmfOpError(
        'DTMF_FAILED',
        'The DTMF duration or inter-tone gap is outside the supported range.',
      ));
    }
    if (!validateDtmfSequence(tones)) {
      return Promise.reject(dtmfOpError(
        'DTMF_FAILED',
        'The DTMF sequence is empty, too long, or contains invalid symbols.',
      ));
    }
    const sender = this.transceiver.sender as RTCRtpSender & { dtmf?: RTCDTMFSender };
    const dtmf = sender.dtmf;
    if (!this.telephoneEventNegotiated() || dtmf === undefined || dtmf.canInsertDTMF !== true) {
      return Promise.reject(dtmfOpError(
        'DTMF_UNSUPPORTED',
        'DTMF (RFC 4733 telephone-event) is not available on this call.',
      ));
    }
    if (this.activeDtmfOp !== null) {
      return Promise.reject(dtmfOpError(
        'OPERATION_IN_PROGRESS',
        'A DTMF sequence is already in progress.',
      ));
    }

    const timeoutMs = validateOperationTimeout(options?.timeoutMs, DTMF_DEFAULT_TIMEOUT_MS);
    const signal = options?.signal;

    return new Promise<void>((resolve, reject) => {
      let settled = false;
      // True once insertDTMF(tones) has actually queued the sequence; an
      // already-aborted signal aborts before any clear is needed.
      let started = false;

      const finish = (error: Error | null): void => {
        if (settled) return;
        settled = true;
        this.clock.clearTimeout(deadline);
        if (this.activeDtmfOp === finish) this.activeDtmfOp = null;
        dtmf.removeEventListener('tonechange', onToneChange);
        if (signal !== undefined) signal.removeEventListener('abort', onAbort);
        if (error !== null) reject(error);
        else resolve();
      };

      const onToneChange = (event: { tone: string }): void => {
        if (settled) return;
        // A replaced sender means the sequence is no longer owned; abort rather
        // than wait for a completion event that can never arrive.
        if (this.transceiver?.sender?.dtmf !== dtmf) {
          finish(this.aborted('DTMF'));
          return;
        }
        if (event.tone === '' && dtmf.toneBuffer.length === 0) {
          finish(null);
        }
      };

      const onAbort = (): void => {
        if (settled) return;
        if (started) {
          // Clear the queued tones so no digits keep playing after the abort.
          try {
            dtmf.insertDTMF('', durationMs, interToneGapMs);
          } catch {
            // A browser may reject a mid-sequence clear; the operation still aborts.
          }
        }
        finish(dtmfOpError('OPERATION_ABORTED', 'The DTMF sequence was aborted.'));
      };

      const deadline = this.clock.setTimeout(() => {
        if (settled) return;
        finish(dtmfOpError('OPERATION_TIMEOUT', 'The DTMF sequence did not complete in time.'));
      }, timeoutMs);

      this.activeDtmfOp = finish;
      dtmf.addEventListener('tonechange', onToneChange);
      if (signal !== undefined) {
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener('abort', onAbort, { once: true });
      }
      started = true;
      try {
        dtmf.insertDTMF(tones, durationMs, interToneGapMs);
      } catch {
        // The browser rejected the insertion (e.g. an invalid sequence); the
        // operation settles DTMF_FAILED and no listener or timer survives.
        finish(dtmfOpError('DTMF_FAILED', 'The DTMF sequence could not be inserted.'));
      }
    });
  }

  /**
   * Whether RFC 4733 telephone-event is negotiated in the current LOCAL and
   * REMOTE audio SDP. Both sides must offer the payload for the browser's DTMF
   * sender to actually relay tones, so the capability check requires both.
   */
  private telephoneEventNegotiated(): boolean {
    const pc = this.pc;
    if (pc === null) return false;
    const local = typeof pc.localDescription?.sdp === 'string' ? pc.localDescription.sdp : '';
    const remote = typeof pc.remoteDescription?.sdp === 'string' ? pc.remoteDescription.sdp : '';
    return hasNegotiatedTelephoneEvent(local) && hasNegotiatedTelephoneEvent(remote);
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
    this.stagedDirection = undefined; // no half-staged direction survives close
    this.teardown();
    if (this.state !== 'failed') {
      this.transition('closed');
    }
  }

  /** Release PC listeners/resources without touching the lifecycle-closed flag. */
  private teardown(): void {
    // A terminal session invalidates any in-flight DTMF sequence: settle it with
    // ABORTED and clear the active op BEFORE releasing the peer connection so no
    // stale tonechange listener outlives teardown.
    const activeDtmf = this.activeDtmfOp;
    this.activeDtmfOp = null;
    if (activeDtmf !== null) {
      activeDtmf(this.aborted('DTMF'));
    }
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
    // `close()` may have run while acquisition was pending: it bumped `opSeq`,
    // set `closed`, and tore down. A late-delivered track must be stopped
    // immediately and no new peer connection created, or it would be leaked.
    if (this.closed || this.opSeq !== this.acquisitionSeq) {
      stopStream(stream);
      throw this.aborted('negotiation');
    }
    this.transition(target);
    this.ensurePeerConnection();
    const pc = this.pc!;
    const transceiver = pc.addTransceiver('audio', { direction: 'sendrecv' });
    this.transceiver = transceiver;
    const track = firstAudioTrack(stream);
    if (track !== undefined) {
      this.localTrack = track;
      this.applyTrackEnabled(); // a persisted mute/hold applies on acquisition
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
      // Expose the direction the remote peer declared. Read-only SDP parse —
      // no SDP text is ever edited. `recvonly` is observable but not a local
      // offer direction, so it falls outside the typed `MediaDirection` union.
      this.remoteDirectionValue = parseRemoteDirection(sdp);
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

  /** Read the complete gathered local SDP, never the pre-gather offer/answer. */
  private completeLocalSdp(expectedType: RTCSdpType): string {
    const local = this.pc?.localDescription;
    if (local?.type !== expectedType || typeof local.sdp !== 'string' || local.sdp.length === 0) {
      throw this.toMediaError(new Error('empty local SDP'), 'NEGOTIATION_FAILED');
    }
    return local.sdp;
  }

  /**
   * Apply the local description, then wait for ICE gathering to complete within
   * the deadline. The gather-completion observer is subscribed BEFORE
   * `setLocalDescription` (see {@link waitForIceComplete}), so a synchronous
   * completion cannot be missed.
   */
  private async setLocalAndWait(description: RTCSessionDescriptionInit): Promise<void> {
    const wait = this.waitForIceComplete();
    // Observe immediately so a synchronous teardown rejection is never orphaned.
    void wait.catch(() => undefined);
    try {
      await this.pc!.setLocalDescription(description);
    } catch (error) {
      for (const cancel of [...this.waiters]) {
        cancel();
      }
      await wait.catch(() => undefined);
      throw error;
    }
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
    this.acquisitionSeq = token;
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

  /** A duplicate or illegal negotiation operation. */
  private invalidState(message: string): MediaError {
    return new MediaError(
      'INVALID_STATE',
      message,
      this.sessionId,
      'negotiation',
    );
  }
}

/**
 * The audio direction a remote description declares, or undefined when the
 * first `m=audio` section carries no explicit direction attribute. Read-only:
 * the session never edits SDP text.
 */
function parseRemoteDirection(sdp: string): MediaDirection | 'recvonly' | undefined {
  let inAudio = false;
  for (const raw of sdp.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('m=')) {
      inAudio = /^m=audio(?:[ \t]|$)/.test(line);
      continue;
    }
    if (!inAudio) continue;
    if (
      line === 'a=sendrecv' || line === 'a=sendonly'
      || line === 'a=recvonly' || line === 'a=inactive'
    ) {
      return line.slice(2) as MediaDirection | 'recvonly';
    }
  }
  return undefined;
}

/** The first audio track of a directly-owned media stream, if any. */
function firstAudioTrack(stream: MediaStream): MediaStreamTrack | undefined {
  return stream.getAudioTracks()[0];
}

/** Stop every track of a stream that was delivered but then invalidated. */
function stopStream(stream: MediaStream): void {
  for (const track of stream.getTracks()) {
    track.stop();
  }
}

/** Validate a DTMF sequence: non-empty, at most 255 symbols, all RFC 4733. */
function validateDtmfSequence(tones: string): boolean {
  if (typeof tones !== 'string' || tones.length === 0 || tones.length > DTMF_MAX_TONES) {
    return false;
  }
  for (const symbol of tones) {
    if (!DTMF_SYMBOLS.has(symbol)) return false;
  }
  return true;
}

/** Normalize a tone duration, or undefined when out of the 40-6000 ms range. */
function normalizeDtmfDuration(value: number | undefined): number | undefined {
  if (value === undefined) return DTMF_DEFAULT_DURATION_MS;
  if (!Number.isFinite(value)) return undefined;
  if (value < DTMF_MIN_DURATION_MS || value > DTMF_MAX_DURATION_MS) return undefined;
  return value;
}

/** Normalize an inter-tone gap, or undefined when below the 30 ms minimum. */
function normalizeDtmfGap(value: number | undefined): number | undefined {
  if (value === undefined) return DTMF_DEFAULT_GAP_MS;
  if (!Number.isFinite(value)) return undefined;
  if (value < DTMF_MIN_GAP_MS) return undefined;
  return value;
}

/** Whether an SDP body negotiates the RFC 4733 telephone-event audio payload. */
function hasNegotiatedTelephoneEvent(sdp: string): boolean {
  return /a=rtpmap:\d+\s+telephone-event\//i.test(sdp);
}

/**
 * A plain error carrying the DTMF operation's public code. Only `SipErrorCode`
 * values that are NOT `MediaErrorCode` members reach this helper (the DTMF and
 * OPERATION_* codes); `ABORTED`/`INVALID_STATE` use the MediaError factories.
 */
function dtmfOpError(code: SipErrorCode, message: string): Error {
  return Object.assign(new Error(message), { code });
}
