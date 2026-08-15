/**
 * BrowserCall: per-call ownership wrap over a single core call owner (v0.7).
 *
 * {@link OutgoingBrowserCall} wraps the core {@link @sip-worker/core#Inviter};
 * {@link IncomingBrowserCall} wraps the core {@link @sip-worker/core#Invitation}.
 * Each is direction-specific: only the outgoing subtype exposes `start()`/`cancel()`,
 * only the incoming subtype exposes `answer()`/`reject()`. The shared active
 * methods — `setMuted`, `hold`, `resume`, `sendDtmf`, `restartIce`, `hangup` —
 * live on the common {@link BrowserCall} and delegate to the same owner.
 *
 * Lifecycle settlement mirrors the brief: `start()`/`answer()` observe the core
 * invite operation (120 s default), then await the runtime's media-connected
 * settlement for the call's media session. Public state commits from the core
 * session BEFORE observers run; on a terminal session the owning runtime detaches
 * the call by object identity before the terminal state event is delivered.
 *
 * Direction-specific control that requires hold/direction signalling is staged
 * in later tasks (Task 10 mutes, Task 11 hold/sendDtmf, Task 12 restartIce);
 * this foundation exposes the method surface and resolves/rejects per the
 * shared-owner contract.
 */

import { TypedEventEmitter } from '@sip-worker/core';
import { observeOperation } from '@sip-worker/core';
import type { Inviter, Invitation, SessionEvent } from '@sip-worker/core';
import type { BrowserMediaEventMap, MediaSessionState } from '../media/types.js';
import type { DtmfOptions } from '../media/session.js';
import type { PhoneRuntime } from './runtime.js';
import type {
  BrowserCallEventMap,
  CallSignalingState,
  CallState,
  HoldState,
  RemoteIdentity,
} from './types.js';

/** RemoteIdentity is the core-owned immutable bounded type; re-exported shape. */
export type { RemoteIdentity } from './types.js';
/** DtmfOptions bounds one RFC 4733 DTMF sequence (duration/gap/signal/timeout). */
export type { DtmfOptions } from '../media/session.js';

const DEFAULT_CALL_ESTABLISH_TIMEOUT_MS = 120_000;

/** The default local-hold direction (RFC 3264) when `hold()` omits one. */
const DEFAULT_HOLD_DIRECTION = 'sendonly';

export class BrowserCall extends TypedEventEmitter<BrowserCallEventMap> {
  /** The owning runtime; supplies core/media/call facts and detach on terminal. */
  protected readonly runtime: PhoneRuntime;

  private readonly mediaSessionId: string;

  private stateValue: CallState = 'new';
  private signalingStateValue: CallSignalingState = 'stable';
  private holdValue: HoldState = Object.freeze({ local: false, remote: false });
  private mutedValue = false;

  /** Latest core session state (signaling truth). */
  private sessionState: string = 'initial';
  /** Whether the call's media session observed `connected`. */
  private mediaConnected = false;

  protected constructor(runtime: PhoneRuntime, mediaSessionId: string) {
    super();
    this.runtime = runtime;
    this.mediaSessionId = mediaSessionId;
  }

  /** Wrap the core {@link Inviter} as an outgoing call. */
  static outgoing(inviter: Inviter, runtime: PhoneRuntime): OutgoingBrowserCall {
    return new OutgoingBrowserCall(inviter, runtime);
  }

  /** Wrap the core {@link Invitation} as an incoming call. */
  static incoming(invitation: Invitation, runtime: PhoneRuntime): IncomingBrowserCall {
    return new IncomingBrowserCall(invitation, runtime);
  }

  // ------------------------------------------------------------------
  // Read-only per-call facts.
  // ------------------------------------------------------------------

  get state(): CallState {
    return this.stateValue;
  }

  get signalingState(): CallSignalingState {
    return this.signalingStateValue;
  }

  get holdState(): HoldState {
    return this.holdValue;
  }

  get muted(): boolean {
    return this.mutedValue;
  }

  get mediaState(): MediaSessionState | 'new' {
    return 'new';
  }

  /** Immutable, size-bounded remote participant identity (core-owned). */
  get remoteIdentity(): RemoteIdentity | undefined {
    return this.remoteIdentityValue();
  }

  /** Media session id used by the owning runtime to correlate media events. */
  get sessionId(): string {
    return this.mediaSessionId;
  }

  /** Overridden by each subtype to read the owner's parsed identity. */
  protected remoteIdentityValue(): RemoteIdentity | undefined {
    return undefined;
  }

  // ------------------------------------------------------------------
  // Shared active methods.
  // ------------------------------------------------------------------

  /**
   * Mute/unmute the local microphone for the active call. Routes synchronously
   * to the media session, which is the source of truth: the session flips
   * `localTrack.enabled` and emits `mutedChanged`, which
   * {@link notifyMediaEvent} commits + forwards immutably. A terminal call, or
   * a call with no owned media session, throws canonical `INVALID_STATE`
   * synchronously.
   */
  setMuted(muted: boolean): void {
    if (this.stateValue === 'terminated' || this.stateValue === 'failed') {
      throw this.invalidCallState();
    }
    this.runtime.manager.setMuted(muted);
  }

  /**
   * Place the call on local hold (RFC 3264 directional offer). Commits the
   * public hold state and emits `holdStateChanged` only AFTER the core
   * negotiation applies (2xx + ACK + local media direction). A terminal call,
   * or a call already on local hold, rejects canonical `INVALID_STATE`.
   */
  async hold(direction: 'sendonly' | 'inactive' = DEFAULT_HOLD_DIRECTION): Promise<void> {
    if (this.stateValue === 'terminated' || this.stateValue === 'failed') {
      throw this.invalidCallState();
    }
    if (this.holdValue.local) {
      throw this.invalidCallState();
    }
    const previous = this.holdValue;
    await this.ownerHold(direction);
    this.commitHoldState(previous, Object.freeze({ local: true, remote: this.ownerRemoteHold() }));
  }

  /**
   * Resume the call from local hold. Commits the public hold state and emits
   * `holdStateChanged` only AFTER the core negotiation applies. A terminal
   * call, or a call not currently on local hold, rejects canonical
   * `INVALID_STATE`.
   */
  async resume(): Promise<void> {
    if (this.stateValue === 'terminated' || this.stateValue === 'failed') {
      throw this.invalidCallState();
    }
    if (!this.holdValue.local) {
      throw this.invalidCallState();
    }
    const previous = this.holdValue;
    await this.ownerResume();
    this.commitHoldState(previous, Object.freeze({ local: false, remote: this.ownerRemoteHold() }));
  }

  private commitHoldState(previous: HoldState, state: HoldState): void {
    this.holdValue = state;
    this.emit('holdStateChanged', { type: 'holdStateChanged', previous, state });
  }

  /**
   * Commit a remote-hold change pushed from the owning core owner (fires after
   * the matching re-INVITE ACK commits). Independent of local hold: only the
   * `remote` flag changes. A terminal call ignores the push; an unchanged value
   * emits nothing.
   */
  notifyRemoteHold(held: boolean): void {
    if (this.stateValue === 'terminated' || this.stateValue === 'failed') return;
    if (this.holdValue.remote === held) return;
    const previous = this.holdValue;
    this.holdValue = Object.freeze({ ...this.holdValue, remote: held });
    this.emit('holdStateChanged', { type: 'holdStateChanged', previous, state: this.holdValue });
  }

  /**
   * Send an RFC 4733 DTMF digit sequence on the active call. Routes to the media
   * session, which validates the sequence, bounds it with a deadline, and
   * resolves only when the tone buffer drains. A terminal call throws canonical
   * `INVALID_STATE` synchronously.
   */
  sendDtmf(tones: string, options?: DtmfOptions): Promise<void> {
    if (this.stateValue === 'terminated' || this.stateValue === 'failed') {
      throw this.invalidCallState();
    }
    return this.runtime.manager.sendDtmf(tones, options);
  }

  /** Terminate the active call with BYE (shared). */
  hangup(): Promise<void> {
    return this.hangupInternal();
  }

  protected hangupInternal(): Promise<void> {
    return this.ownerHangup();
  }

  /** ICE restart on the confirmed dialog (staged in Task 12). */
  restartIce(): Promise<void> {
    return this.ownerRestartIce();
  }

  // ------------------------------------------------------------------
  // State helpers (runtime-driven).
  // ------------------------------------------------------------------

  /** Commit a public call state from a core session transition, gating
   * `established` on media-connected settlement. */
  _commitState(sessionState: string, error?: Error): void {
    this.sessionState = sessionState;
    if (this.sessionState === 'confirmed' && !this.mediaConnected) {
      // Signaling is confirmed but media is not yet connected; stay in
      // `establishing` (per the isolate-until-media-connected contract).
      if (this.stateValue === 'established') {
        // A media `connected` already advanced us; keep the committed state.
      } else {
        this.setStateValue('establishing');
      }
      return;
    }
    const mapped = mapCallState(sessionState);
    if (mapped === this.stateValue) return;
    this.setStateValue(mapped, error);
  }

  private setStateValue(mapped: CallState, error?: Error): void {
    const previous = this.stateValue;
    this.stateValue = mapped;
    if (mapped === 'terminated' || mapped === 'failed') {
      // Detach BEFORE observers run for the terminal change.
      this.runtime.releaseCall(this, mapped);
    }
    if (mapped === 'failed' && error !== undefined) {
      this.emit('failed', { type: 'failed', error });
    }
    this.emit('stateChanged', { type: 'stateChanged', previous, state: mapped });
  }

  /** Forward a media event onto this call's surface. */
  notifyMediaEvent(type: keyof BrowserMediaEventMap, value: unknown): void {
    if (type === 'mediaStateChanged') {
      const event = value as BrowserCallEventMap['mediaStateChanged'];
      if (event.state === 'connected') {
        this.mediaConnected = true;
        // A confirmed session plus connected media advances to `established`.
        if (this.sessionState === 'confirmed' && this.stateValue !== 'established') {
          this.setStateValue('established');
        }
      }
      this.emit('mediaStateChanged', value as BrowserCallEventMap['mediaStateChanged']);
    } else if (type === 'mediaFailed') {
      this.emit('mediaFailed', value as BrowserCallEventMap['mediaFailed']);
    } else if (type === 'remoteAudio') {
      this.emit('remoteAudio', value as BrowserCallEventMap['remoteAudio']);
    } else if (type === 'mutedChanged') {
      const event = value as BrowserMediaEventMap['mutedChanged'];
      if (event.sessionId !== this.mediaSessionId) return;
      // The session accepted the change; commit the boolean and forward the
      // event immutably (a fresh object per emission).
      this.mutedValue = event.muted;
      this.emit('mutedChanged', {
        type: 'mutedChanged',
        previous: event.previous,
        muted: event.muted,
      });
    }
  }

  /** The canonical synchronous error for a mute on a terminal/no-session call. */
  private invalidCallState(): Error {
    return Object.assign(new Error('The call is not active.'), { code: 'INVALID_STATE' });
  }

  protected observeOwnerOperation(
    source: Promise<void>,
    operation: string,
  ): Promise<void> {
    return observeOperation(source, {
      clock: this.runtime.clock,
      operation,
      defaultTimeoutMs: DEFAULT_CALL_ESTABLISH_TIMEOUT_MS,
    });
  }

  protected awaitMediaConnected(): Promise<void> {
    return this.runtime.waitForMediaConnected(this.mediaSessionId);
  }

  protected attachSessionListener(
    session: { on(listener: (event: SessionEvent) => void): void },
  ): void {
    session.on((event: SessionEvent) => {
      this._commitState(event.state, event.error);
    });
  }

  // ------------------------------------------------------------------
  // Subtype hook points (never exposed on the common base).
  // ------------------------------------------------------------------

  protected ownerHangup(): Promise<void> {
    return Promise.reject(new Error('call not active'));
  }

  protected ownerRestartIce(): Promise<void> {
    return Promise.reject(new Error('call not active'));
  }

  protected ownerHold(_direction: 'sendonly' | 'inactive'): Promise<void> {
    return Promise.reject(new Error('call not active'));
  }

  protected ownerResume(): Promise<void> {
    return Promise.reject(new Error('call not active'));
  }

  /** The owner's committed remote-hold flag (false for an inactive owner). */
  protected ownerRemoteHold(): boolean {
    return false;
  }
}

function mapCallState(sessionState: string): CallState {
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

/** Outgoing call owner: wraps the core {@link Inviter}. */
export class OutgoingBrowserCall extends BrowserCall {
  private readonly inviter: Inviter;

  constructor(inviter: Inviter, runtime: PhoneRuntime) {
    super(runtime, inviter.mediaSessionId);
    this.inviter = inviter;
    this.attachSessionListener(inviter.session);
  }

  protected remoteIdentityValue(): RemoteIdentity | undefined {
    return this.inviter.remoteIdentity;
  }

  /**
   * Send the INVITE (the `start()` path is single-use). Observes the core invite
   * operation with the 120 s default, then awaits media-connected settlement.
   */
  start(): Promise<void> {
    return this.runEstablish(() => this.inviter.invite());
  }

  /**
   * @internal
   * @deprecated Used by `BrowserUserAgent.invite()` (a deprecated v0.5 delegate)
   * for legacy confirm-only settlement. Settles on core confirm (2xx+ACK) and
   * does NOT await media-connected settlement. v0.7 consumers should call
   * `start()` (media-gated) instead.
   */
  startConfirmed(): Promise<void> {
    return this.observeOwnerOperation(this.inviter.invite(), 'outgoing call');
  }

  /** Cancel an in-flight outgoing INVITE. */
  cancel(): Promise<void> {
    return this.inviter.cancel();
  }

  protected override ownerHangup(): Promise<void> {
    return this.inviter.hangup();
  }

  protected override ownerRestartIce(): Promise<void> {
    // Fully supersedes the base stub (no discarded base rejection).
    return this.inviter.restartIce();
  }

  protected override ownerHold(direction: 'sendonly' | 'inactive'): Promise<void> {
    return this.inviter.hold(direction);
  }

  protected override ownerResume(): Promise<void> {
    return this.inviter.resume();
  }

  protected override ownerRemoteHold(): boolean {
    return this.inviter.remoteHold;
  }

  private async runEstablish(invite: () => Promise<void>): Promise<void> {
    const observed = this.observeOwnerOperation(invite(), 'outgoing call');
    await observed;
    await this.awaitMediaConnected();
  }
}

/** Incoming call owner: wraps the core {@link Invitation}. */
export class IncomingBrowserCall extends BrowserCall {
  private readonly invitation: Invitation;

  constructor(invitation: Invitation, runtime: PhoneRuntime) {
    super(runtime, invitation.mediaSessionId);
    this.invitation = invitation;
    this.attachSessionListener(invitation.session);
  }

  protected remoteIdentityValue(): RemoteIdentity | undefined {
    return this.invitation.remoteIdentity;
  }

  /** Answer the INVITE; settles only once media is connected. */
  answer(): Promise<void> {
    return this.runEstablish(() => this.invitation.answer());
  }

  /** Reject the INVITE with a 4xx/5xx/6xx status. */
  reject(statusCode: number, reason?: string): Promise<void> {
    return this.invitation.reject(statusCode, reason);
  }

  protected override ownerHangup(): Promise<void> {
    // An inbound call has no local BYE owner this task (UA.bye() targets the
    // outgoing inviter); staged with the shared-owner hangup in a later task.
    return Promise.reject(Object.assign(new Error('incoming call hangup not supported yet'), { code: 'INVALID_STATE' }));
  }

  protected override ownerRestartIce(): Promise<void> {
    return this.invitation.restartIce();
  }

  protected override ownerHold(direction: 'sendonly' | 'inactive'): Promise<void> {
    return this.invitation.hold(direction);
  }

  protected override ownerResume(): Promise<void> {
    return this.invitation.resume();
  }

  protected override ownerRemoteHold(): boolean {
    return this.invitation.remoteHold;
  }

  private async runEstablish(answer: () => Promise<void>): Promise<void> {
    const observed = this.observeOwnerOperation(answer(), 'incoming call');
    await observed;
    await this.awaitMediaConnected();
  }
}
