/**
 * Pure control-state derivation for the FreeSWITCH pilot UI.
 *
 * `deriveControls` reads a snapshot of phone/call facts and returns an
 * immutable boolean record with one key per actionable button. Every
 * mutation is disabled while an operation is in flight, except `dispose`
 * which remains enabled whenever a phone exists.
 *
 * The incoming established hangup limitation is surfaced as
 * `incomingHangupUnsupported: true` so the UI can render the explanation
 * without a redundant error.
 */

// ---------------------------------------------------------------------------
// Facts
// ---------------------------------------------------------------------------

/** Snapshot of phone/call state consumed by the derivation. */
export interface PilotFacts {
  /** True when a BrowserPhone instance exists (even if disposed). */
  readonly hasPhone: boolean;
  /** Orthogonal connection state of the phone. */
  readonly connectionState: string;
  /** Orthogonal registration state of the phone. */
  readonly registrationState: string;
  /** Lifecycle state of the active call, if any. */
  readonly callState: string | undefined;
  /** Signaling health of the active call. */
  readonly callSignalingState: string;
  /** 'outgoing' | 'incoming' | undefined when no call is active. */
  readonly callDirection: 'outgoing' | 'incoming' | undefined;
  /** Whether the active call's microphone is muted. */
  readonly callMuted: boolean;
  /** Whether the active call is locally held. */
  readonly callLocallyHeld: boolean;
  /** True when a remote audio MediaStream has been received. */
  readonly hasRemoteAudioStream: boolean;
  /** True when an async operation (connect, register, call, ...) is in flight. */
  readonly operationInFlight: boolean;
}

// ---------------------------------------------------------------------------
// ControlState
// ---------------------------------------------------------------------------

/** Boolean flags for every actionable UI control. */
export interface ControlState {
  readonly createPhone: boolean;
  readonly connect: boolean;
  readonly register: boolean;
  readonly call: boolean;
  readonly cancel: boolean;
  readonly hangup: boolean;
  readonly answer: boolean;
  readonly reject: boolean;
  readonly mute: boolean;
  readonly hold: boolean;
  readonly resume: boolean;
  readonly restartIce: boolean;
  readonly dtmf: boolean;
  readonly unregister: boolean;
  readonly disconnect: boolean;
  readonly dispose: boolean;
  readonly reset: boolean;
  /** True when the call is established incoming and local hangup is unsupported. */
  readonly incomingHangupUnsupported: boolean;
}

// ---------------------------------------------------------------------------
// Derivation
// ---------------------------------------------------------------------------

/**
 * Compute the enabled/disabled state of every UI control from the current
 * phone and call facts.
 *
 * Rules:
 * - `createPhone` is enabled only when no phone exists or the phone is disposed.
 * - `connect` is enabled when a phone exists and is not connected/disposed.
 * - `register` is enabled when connected but not registered.
 * - `call` requires registered + no active call.
 * - `cancel` requires an establishing outgoing call.
 * - `hangup` requires an established outgoing call (incoming uses the flag).
 * - `answer`/`reject` require an incoming call in `new` or `establishing` state.
 * - `mute`, `dtmf`, `restartIce` require an established call.
 * - `hold` requires an established, not-held call.
 * - `resume` requires an established, locally-held call.
 * - `unregister` requires a registered phone.
 * - `disconnect` requires a connected/recovering phone.
 * - `dispose` requires a phone that is not disposed.
 * - `reset` is enabled when the phone is disposed.
 * - Every mutation (all except `dispose` and `reset`) is disabled while
 *   `operationInFlight` is true.
 */
export function deriveControls(facts: PilotFacts): ControlState {
  const {
    hasPhone,
    connectionState,
    registrationState,
    callState,
    callDirection,
    callLocallyHeld,
    operationInFlight,
  } = facts;

  const isDisposed = connectionState === 'disposed';
  const isFailed = connectionState === 'failed';
  const isRecovering = connectionState === 'recovering';
  const isConnected = connectionState === 'connected' || isRecovering;
  const isRegistered = registrationState === 'registered';
  const hasCall = callState !== undefined;
  const isEstablishing = callState === 'establishing';
  const isEstablished = callState === 'established';
  const isOutgoing = callDirection === 'outgoing';
  const isIncoming = callDirection === 'incoming';

  // --- Base control availability (before operation-in-flight gate) ---

  // createPhone: only when no phone exists (not disposed — use reset for that)
  const createPhone = !hasPhone;
  // connect: phone exists, not disposed, and either disconnected (needs connect)
  // or failed (can retry) — recovering is already connecting via reconnect.
  const connect = hasPhone && !isDisposed && !isConnected && !isFailed;
  const register = isConnected && isRegistered === false && registrationState !== 'recovering';
  const call = isConnected && isRegistered && !hasCall;
  const cancel = hasCall && isEstablishing && isOutgoing;
  const hangup = hasCall && isEstablished && isOutgoing;
  const answer = hasCall && (callState === 'new' || isEstablishing) && isIncoming;
  const reject = hasCall && (callState === 'new' || isEstablishing) && isIncoming;
  const mute = hasCall && isEstablished;
  const hold = hasCall && isEstablished && !callLocallyHeld;
  const resume = hasCall && isEstablished && callLocallyHeld;
  const restartIce = hasCall && isEstablished;
  const dtmf = hasCall && isEstablished;
  const unregister = isConnected && isRegistered;
  const disconnect = isConnected && !isDisposed;
  const dispose = hasPhone && !isDisposed;
  const reset = hasPhone && isDisposed;

  // Incoming established hangup limitation flag
  const incomingHangupUnsupported = hasCall && isEstablished && isIncoming;

  // --- Apply operation-in-flight gate ---
  // All mutations are disabled except dispose (always available when phone exists)
  if (operationInFlight) {
    return Object.freeze({
      createPhone: false,
      connect: false,
      register: false,
      call: false,
      cancel: false,
      hangup: false,
      answer: false,
      reject: false,
      mute: false,
      hold: false,
      resume: false,
      restartIce: false,
      dtmf: false,
      unregister: false,
      disconnect: false,
      dispose,
      reset: false,
      incomingHangupUnsupported: false,
    });
  }

  return Object.freeze({
    createPhone,
    connect,
    register,
    call,
    cancel,
    hangup,
    answer,
    reject,
    mute,
    hold,
    resume,
    restartIce,
    dtmf,
    unregister,
    disconnect,
    dispose,
    reset,
    incomingHangupUnsupported: !!incomingHangupUnsupported,
  });
}
