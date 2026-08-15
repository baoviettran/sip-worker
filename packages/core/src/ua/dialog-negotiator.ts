import { Headers, makeResponse, bodyText, withTextBody } from '../messages/index.js';
import { serializeMessage } from '../messages/serializer.js';
import type { SipRequestMessage, SipResponseMessage } from '../messages/message.js';
import { SipError } from '../errors.js';
import type { Dialog, IdGenerator } from '../dialogs/dialog.js';
import { extractTag, type ViaConfig } from '../dialogs/header-values.js';
import type { TransactionLayer } from '../transactions/coordinator.js';
import type { ServerTransaction, TransactionLayerEvent } from '../transactions/types.js';
import { sendOwnedRequest } from '../transactions/request-ownership.js';
import { cancel, schedule } from '../transactions/timers.js';
import type { Clock } from '../transport/index.js';
import type { WorkerMediaController } from '../media/worker-controller.js';
import type { MediaDirection } from '../media/protocol.js';
import { InviteResponseRetransmitter } from './invite-response-retransmitter.js';

/**
 * Upper bound on a remote SDP carried by an in-dialog re-INVITE (design:
 * "Remote SDP is size-bounded before being passed to the browser"). Anything
 * larger is unsupported and rejected with 488; it is never forwarded to media.
 */
const MAX_REMOTE_SDP_BYTES = 64 * 1024;

/** The single negotiated SDP media type this milestone supports. */
const SUPPORTED_MEDIA = 'audio';

/** A pending negotiation operation that owns the negotiator while in flight. */
interface PendingOperation {
  /** Reject/settle the owning operation's promise. */
  reject?: (reason: unknown) => void;
  /** Terminate the owned client transaction for the in-flight re-INVITE. */
  terminate?: () => void;
}

/** A pending remote-hold re-INVITE whose 2xx is awaiting its ACK. */
interface PendingRemoteHold {
  /** The re-INVITE CSeq number whose ACK commits the remote hold. */
  readonly cseq: number;
  /** The derived remote-hold value committed on the matching ACK. */
  readonly held: boolean;
  /** TU-owned 2xx retransmission; stopped on ACK or 64*T1 timeout. */
  readonly retransmitter: InviteResponseRetransmitter;
}

/**
 * A per-dialog negotiator that serializes in-dialog negotiation for a
 * confirmed call. Exactly one operation owns the negotiator at a time: a local
 * hold/resume or ICE-restart re-INVITE (hold/resume/restartIce), a dialog
 * validation (validateDialog), or an incoming in-dialog re-INVITE being
 * answered off the wire.
 *
 * The `busy` flag is set synchronously before any asynchronous media result so
 * an incoming request racing a local restart (or another incoming) sees it in
 * the same tick and is answered 491 rather than colliding with the in-flight
 * negotiation. The flag is cleared once the owning operation settles.
 *
 * A local re-INVITE rejected with 491 (glare) is retried exactly once using
 * the RFC 3261 14.2 timing windows: the Call-ID owner retries after
 * `2100 + floor(random*1901)` ms, the other endpoint after
 * `floor(random*2001)` ms. A second 491 (or any other failure) rolls the
 * staged media direction back and rejects `HOLD_NEGOTIATION_FAILED`.
 *
 * Every incoming in-dialog re-INVITE derives remote hold (sendonly/inactive →
 * held, sendrecv → not held): the derived state is staged while the answer's ACK
 * is awaited and commits (via `onRemoteHoldChanged`) only on the matching ACK or
 * is dropped on the 2xx retransmission timeout.
 */
export class DialogNegotiator {
  private readonly layer: TransactionLayer;
  private readonly controller: WorkerMediaController;
  private readonly clock: Clock;
  private readonly contact: string;
  private readonly random: () => number;
  private readonly isCallIdOwner: boolean;
  private readonly T1: number;
  private readonly T2: number;
  private readonly onRemoteHoldChanged: ((held: boolean) => void) | undefined;
  private disposed = false;
  private busyValue = false;
  private active: PendingOperation | undefined;
  /** Terminates the owned re-INVITE client transaction (set while a restart is in flight). */
  private transactionDisposer: (() => void) | undefined;
  /** Whether the remote peer is currently holding (independent of local hold). */
  private remoteHoldValue = false;
  /** The remote-hold re-INVITE awaiting its ACK, if any. */
  private pendingRemote: PendingRemoteHold | undefined;
  /** The pending RFC 3261 14.2 glare-retry timer id, if armed. */
  private retryTimerId: number | undefined;

  constructor(private readonly options: {
    /** The confirmed dialog media negotiator sits on; undefined pre-dialog. */
    owner: { readonly dialog: Dialog | undefined; readonly mediaSessionId: string };
    layer: TransactionLayer;
    controller: WorkerMediaController;
    clock: Clock;
    idGenerator: IdGenerator;
    via: ViaConfig;
    contact: string;
    /** Uniform random in [0,1) used for the RFC 3261 14.2 glare-retry window. */
    random?: () => number;
    /** Whether this endpoint is the Call-ID owner (the INVITE's originator). */
    isCallIdOwner: boolean;
    T1?: number;
    T2?: number;
    /** Called when the derived remote-hold state commits on a matching ACK. */
    onRemoteHoldChanged?: (held: boolean) => void;
  }) {
    this.layer = options.layer;
    this.controller = options.controller;
    this.clock = options.clock;
    this.contact = options.contact;
    this.random = options.random ?? (() => 0);
    this.isCallIdOwner = options.isCallIdOwner;
    this.T1 = options.T1 ?? 500;
    this.T2 = options.T2 ?? 4000;
    this.onRemoteHoldChanged = options.onRemoteHoldChanged;
    // clock, idGenerator, and via are accepted for the contract but the
    // negotiator sends through the dialog request API, which owns Via/CSeq.
  }

  /** Whether a local or remote negotiation is in flight. */
  get busy(): boolean {
    return this.busyValue;
  }

  /** Whether the remote peer is currently holding (committed on ACK). */
  get remoteHold(): boolean {
    return this.remoteHoldValue;
  }

  /**
   * Request an ICE restart on the confirmed dialog. Posts `createOffer` with
   * `{ iceRestart: true }`, sends an incremented in-dialog INVITE, and only
   * after a 2xx AND a successful `setRemote` of the remote answer resolves.
   * Rejects `INVALID_STATE` when already negotiated or disposed, a SipError
   * with the status on 491/488/non-2xx, or a typed media/timeout error.
   */
  restartIce(): Promise<void> {
    if (this.disposed) {
      return Promise.reject(new SipError(0, 'Negotiator disposed', 'LIFECYCLE_ABORTED'));
    }
    const dialog = this.options.owner.dialog;
    if (dialog === undefined || this.busyValue) {
      return Promise.reject(new SipError(0, 'no available confirmation for ICE restart', 'INVALID_STATE'));
    }
    this.busyValue = true;

    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const settle = (success: boolean, reason?: unknown): void => {
        if (settled) return;
        settled = true;
        this.release();
        if (success) resolve();
        else reject(reason ?? new SipError(0, 'ICE restart failed', 'CALL_FAILED'));
      };
      this.active = {
        reject: (reason): void => settle(false, reason ?? new SipError(0, 'ICE restart aborted', 'LIFECYCLE_ABORTED')),
        terminate: (): void => this.terminateOwned(),
      };
      void this.runRestart(dialog, settle).catch((reason) => settle(false, reason));
    });
  }

  /**
   * Place the call on local hold. Posts a directional `createOffer` (sendonly
   * or inactive), sends an incremented in-dialog INVITE, and resolves only
   * after the 2xx is ACKed, the remote answer is applied, and the staged
   * direction commits. On any failure the staged direction is rolled back and
   * the promise rejects `HOLD_NEGOTIATION_FAILED`. A 491 glare is retried
   * exactly once per RFC 3261 14.2.
   */
  hold(direction: 'sendonly' | 'inactive'): Promise<void> {
    if (this.disposed) {
      return Promise.reject(new SipError(0, 'Negotiator disposed', 'LIFECYCLE_ABORTED'));
    }
    const dialog = this.options.owner.dialog;
    if (dialog === undefined || this.busyValue) {
      return Promise.reject(new SipError(0, 'no available dialog for hold', 'INVALID_STATE'));
    }
    this.busyValue = true;

    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const settle = (success: boolean, reason?: unknown): void => {
        if (settled) return;
        settled = true;
        this.release();
        if (success) resolve();
        else reject(reason ?? new SipError(0, 'hold failed', 'HOLD_NEGOTIATION_FAILED'));
      };
      this.active = {
        reject: (reason): void => settle(false, reason ?? new SipError(0, 'hold aborted', 'LIFECYCLE_ABORTED')),
        terminate: (): void => this.terminateOwned(),
      };
      void this.sendDirectionalAttempt(dialog, direction, settle, 0).catch((reason) => settle(false, reason));
    });
  }

  /**
   * Resume the call from local hold: a directional `createOffer` with
   * `sendrecv`. Settlement and failure semantics mirror {@link hold}.
   */
  resume(): Promise<void> {
    if (this.disposed) {
      return Promise.reject(new SipError(0, 'Negotiator disposed', 'LIFECYCLE_ABORTED'));
    }
    const dialog = this.options.owner.dialog;
    if (dialog === undefined || this.busyValue) {
      return Promise.reject(new SipError(0, 'no available dialog for resume', 'INVALID_STATE'));
    }
    this.busyValue = true;

    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const settle = (success: boolean, reason?: unknown): void => {
        if (settled) return;
        settled = true;
        this.release();
        if (success) resolve();
        else reject(reason ?? new SipError(0, 'resume failed', 'HOLD_NEGOTIATION_FAILED'));
      };
      this.active = {
        reject: (reason): void => settle(false, reason ?? new SipError(0, 'resume aborted', 'LIFECYCLE_ABORTED')),
        terminate: (): void => this.terminateOwned(),
      };
      void this.sendDirectionalAttempt(dialog, 'sendrecv', settle, 0).catch((reason) => settle(false, reason));
    });
  }

  /**
   * Probe the confirmed dialog with an in-dialog OPTIONS. Resolves on any final
   * that proves the dialog exists (2xx, 405, 501, or any non-481 final);
   * rejects on a 481 or a transaction timeout (`SIGNALING_RECOVERY_FAILED`).
   */
  validateDialog(): Promise<void> {
    if (this.disposed) {
      return Promise.reject(new SipError(0, 'Negotiator disposed', 'LIFECYCLE_ABORTED'));
    }
    const dialog = this.options.owner.dialog;
    if (dialog === undefined || this.busyValue) {
      return Promise.reject(new SipError(0, 'no available dialog for validation', 'INVALID_STATE'));
    }
    this.busyValue = true;

    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const settle = (success: boolean, reason?: unknown): void => {
        if (settled) return;
        settled = true;
        this.release();
        if (success) resolve();
        else reject(reason ?? new SipError(0, 'dialog validation failed', 'SIGNALING_RECOVERY_FAILED'));
      };
      this.active = {
        reject: (reason): void => settle(false, reason ?? new SipError(0, 'validation aborted', 'LIFECYCLE_ABORTED')),
        terminate: (): void => this.terminateOwned(),
      };
      void this.runValidateDialog(dialog, settle).catch((reason) => settle(false, reason));
    });
  }

  /** Terminate the owned client transaction for the in-flight re-INVITE. */
  private terminateOwned(): void {
    const disposer = this.transactionDisposer;
    this.transactionDisposer = undefined;
    disposer?.();
  }

  private release(): void {
    this.active = undefined;
    this.transactionDisposer = undefined;
    this.busyValue = false;
    this.clearRetryTimer();
  }

  private async runRestart(
    dialog: Dialog,
    settle: (success: boolean, reason?: unknown) => void,
  ): Promise<void> {
    const sdp = await this.controller.createOffer(this.options.owner.mediaSessionId, { iceRestart: true });
    if (this.disposed) {
      settle(false, new SipError(0, 'negotiation aborted', 'LIFECYCLE_ABORTED'));
      return;
    }

    const request = withTextBody(dialog.createRequest('INVITE'), sdp, 'application/sdp') as SipRequestMessage;

    sendOwnedRequest(
      this.layer,
      request,
      (disposeOwned) => {
        this.transactionDisposer = disposeOwned;
        if (this.disposed) disposeOwned();
      },
      (event: TransactionLayerEvent): void => {
        if (this.disposed) return;
        if (event.type === 'response') {
          const code = event.response.statusCode;
          if (code >= 200 && code < 300) {
            this.terminateOwned();
            void this.completeRestart(dialog, request, event.response).then(
              () => settle(true),
              (reason: unknown) => settle(false, reason),
            );
          } else {
            settle(false, new SipError(code, `re-INVITE rejected with ${code}`, 'CALL_FAILED'));
          }
        } else if (event.type === 'timeout') {
          settle(false, new SipError(0, 're-INVITE timeout', 'TIMEOUT'));
        } else if (event.type === 'transportError') {
          settle(false, new SipError(0, 're-INVITE transport error', 'TRANSPORT_FAILED'));
        }
      },
    );
  }

  /** Complete a successful re-INVITE only after its ACK is delivered and SDP applied. */
  private async completeRestart(
    dialog: Dialog,
    request: SipRequestMessage,
    response: SipResponseMessage,
  ): Promise<void> {
    const answer = bodyText(response);
    const validAnswer = response.headers.get('Content-Type')?.trim().toLowerCase() === 'application/sdp'
      && isValidAnswerSdp(answer);
    if (this.disposed) {
      throw new SipError(0, 'negotiation aborted', 'LIFECYCLE_ABORTED');
    }
    const cseq = Number(request.headers.get('CSeq')?.trim().split(/\s+/)[0] ?? NaN);
    try {
      await this.layer.getTransport().send(serializeMessage(dialog.createAck(response, cseq)));
    } catch {
      throw new SipError(0, 're-INVITE ACK transport error', 'TRANSPORT_FAILED');
    }
    if (this.disposed) {
      throw new SipError(0, 'negotiation aborted', 'LIFECYCLE_ABORTED');
    }
    if (!validAnswer) {
      throw new SipError(0, 're-INVITE answer SDP invalid or too large', 'CALL_FAILED');
    }
    await this.controller.setRemote(this.options.owner.mediaSessionId, answer);
    if (this.disposed) {
      throw new SipError(0, 'negotiation aborted', 'LIFECYCLE_ABORTED');
    }
  }

  /**
   * Send one directional re-INVITE attempt for a hold/resume operation. A 491
   * on the first attempt arms the single RFC 3261 14.2 glare retry; a 491 on
   * the retry (or any other failure) rolls the staged direction back and
   * rejects `HOLD_NEGOTIATION_FAILED`.
   */
  private async sendDirectionalAttempt(
    dialog: Dialog,
    direction: MediaDirection,
    settle: (success: boolean, reason?: unknown) => void,
    attempt: number,
  ): Promise<void> {
    const sdp = await this.controller.createOffer(this.options.owner.mediaSessionId, { direction });
    if (this.disposed) {
      settle(false, new SipError(0, 'negotiation aborted', 'LIFECYCLE_ABORTED'));
      return;
    }

    const request = withTextBody(dialog.createRequest('INVITE'), sdp, 'application/sdp') as SipRequestMessage;

    sendOwnedRequest(
      this.layer,
      request,
      (disposeOwned) => {
        this.transactionDisposer = disposeOwned;
        if (this.disposed) disposeOwned();
      },
      (event: TransactionLayerEvent): void => {
        if (this.disposed) return;
        if (event.type === 'response') {
          const code = event.response.statusCode;
          if (code >= 200 && code < 300) {
            this.terminateOwned();
            void this.completeDirectional(dialog, request, event.response).then(
              () => settle(true),
              (reason: unknown) => void this.rollbackAndReject(settle, reason),
            );
          } else if (code === 491) {
            this.terminateOwned();
            if (attempt === 0) {
              this.armGlareRetry(dialog, direction, settle);
            } else {
              void this.rollbackAndReject(settle, new SipError(491, 'Request Pending', 'HOLD_NEGOTIATION_FAILED'));
            }
          } else {
            void this.rollbackAndReject(settle, new SipError(code, `re-INVITE rejected with ${code}`, 'HOLD_NEGOTIATION_FAILED'));
          }
        } else if (event.type === 'timeout') {
          void this.rollbackAndReject(settle, new SipError(0, 're-INVITE timeout', 'HOLD_NEGOTIATION_FAILED'));
        } else if (event.type === 'transportError') {
          void this.rollbackAndReject(settle, new SipError(0, 're-INVITE transport error', 'HOLD_NEGOTIATION_FAILED'));
        }
      },
    );
  }

  /**
   * Complete a successful directional re-INVITE: ACK the 2xx, apply the remote
   * answer, then commit the staged direction. Any failure rolls the direction
   * back (via the caller) and rejects `HOLD_NEGOTIATION_FAILED`.
   */
  private async completeDirectional(
    dialog: Dialog,
    request: SipRequestMessage,
    response: SipResponseMessage,
  ): Promise<void> {
    const answer = bodyText(response);
    const validAnswer = response.headers.get('Content-Type')?.trim().toLowerCase() === 'application/sdp'
      && isValidAnswerSdp(answer);
    if (this.disposed) {
      throw new SipError(0, 'negotiation aborted', 'LIFECYCLE_ABORTED');
    }
    const cseq = Number(request.headers.get('CSeq')?.trim().split(/\s+/)[0] ?? NaN);
    try {
      await this.layer.getTransport().send(serializeMessage(dialog.createAck(response, cseq)));
    } catch {
      throw new SipError(0, 're-INVITE ACK transport error', 'HOLD_NEGOTIATION_FAILED');
    }
    if (this.disposed) {
      throw new SipError(0, 'negotiation aborted', 'LIFECYCLE_ABORTED');
    }
    if (!validAnswer) {
      throw new SipError(0, 're-INVITE answer SDP invalid or too large', 'HOLD_NEGOTIATION_FAILED');
    }
    await this.controller.setRemote(this.options.owner.mediaSessionId, answer);
    if (this.disposed) {
      throw new SipError(0, 'negotiation aborted', 'LIFECYCLE_ABORTED');
    }
    await this.controller.commitDirection(this.options.owner.mediaSessionId);
  }

  /**
   * Roll the staged direction back (swallowing a rollback failure) and reject
   * the owning operation. Used for every failed local hold/resume.
   */
  private async rollbackAndReject(settle: (success: boolean, reason?: unknown) => void, reason: unknown): Promise<void> {
    try {
      await this.controller.rollbackDirection(this.options.owner.mediaSessionId);
    } catch {
      // A rollback failure must not mask the negotiation failure it accompanies.
    }
    settle(false, reason);
  }

  /** Arm the single RFC 3261 14.2 glare retry for a local hold/resume. */
  private armGlareRetry(
    dialog: Dialog,
    direction: MediaDirection,
    settle: (success: boolean, reason?: unknown) => void,
  ): void {
    this.clearRetryTimer();
    const random = this.random();
    const delayMs = this.isCallIdOwner
      ? 2100 + Math.floor(random * 1901)
      : Math.floor(random * 2001);
    this.retryTimerId = schedule(this.clock, delayMs, () => {
      this.retryTimerId = undefined;
      void this.sendDirectionalAttempt(dialog, direction, settle, 1).catch((reason) => settle(false, reason));
    });
  }

  private clearRetryTimer(): void {
    if (this.retryTimerId === undefined) return;
    cancel(this.clock, this.retryTimerId);
    this.retryTimerId = undefined;
  }

  /** Commit a staged remote-hold state and notify the owner. */
  private commitRemoteHold(held: boolean): void {
    const pending = this.pendingRemote;
    this.pendingRemote = undefined;
    pending?.retransmitter.stop();
    if (this.remoteHoldValue === held) return;
    this.remoteHoldValue = held;
    this.onRemoteHoldChanged?.(held);
  }

  /** Drop a staged remote-hold without committing (new offer supersedes / ACK timeout). */
  private clearPendingRemote(): void {
    const pending = this.pendingRemote;
    this.pendingRemote = undefined;
    pending?.retransmitter.stop();
  }

  /**
   * Handle the stateless ACK that completes a remote re-INVITE whose 2xx we
   * answered. The ACK is matched by dialog identity (Call-ID + From/To tags)
   * and by the pending re-INVITE's CSeq number; the initial INVITE ACK (CSeq
   * matching the INVITE) is deliberately NOT matched here. On the matching ACK
   * the derived remote-hold state commits.
   */
  handleIncomingAck(request: SipRequestMessage): void {
    if (this.disposed) return;
    const pending = this.pendingRemote;
    if (pending === undefined) return;
    if (request.method !== 'ACK') return;
    const dialog = this.options.owner.dialog;
    if (dialog === undefined) return;
    if (request.headers.get('Call-ID') !== dialog.callId) return;
    if (extractTag(request.headers.get('From')) !== dialog.remoteTag) return;
    if (extractTag(request.headers.get('To')) !== dialog.localTag) return;
    if (requestCSeqNumber(request) !== pending.cseq) return;
    this.commitRemoteHold(pending.held);
  }

  private async runValidateDialog(
    dialog: Dialog,
    settle: (success: boolean, reason?: unknown) => void,
  ): Promise<void> {
    const request = dialog.createRequest('OPTIONS');
    sendOwnedRequest(
      this.layer,
      request,
      (disposeOwned) => {
        this.transactionDisposer = disposeOwned;
        if (this.disposed) disposeOwned();
      },
      (event: TransactionLayerEvent): void => {
        if (this.disposed) return;
        if (event.type === 'response') {
          const code = event.response.statusCode;
          // 2xx, 405/501, or any non-481 final proves the dialog exists.
          if (code === 481) {
            settle(false, new SipError(481, 'Call/Transaction Does Not Exist', 'SIGNALING_RECOVERY_FAILED'));
          } else {
            settle(true);
          }
        } else if (event.type === 'timeout' || event.type === 'transportError') {
          settle(false, new SipError(0, `OPTIONS ${event.type}`, 'SIGNALING_RECOVERY_FAILED'));
        }
      },
    );
  }

  /**
   * Answer an in-dialog re-INVITE. Validates the dialog identity and fresh
   * CSeq (else 481), the bounded single-supported-audio SDP body (else 488),
   * and serializes with any other negotiation (busy → 491). On a supported
   * audio offer, calls `createAnswer` and replies 200 with the returned SDP.
   * A sendonly/inactive offer additionally stages remote hold, committed on
   * the matching ACK.
   */
  handleIncoming(transaction: ServerTransaction, request: SipRequestMessage): void {
    if (this.disposed) return;
    if (this.busyValue) {
      this.sendResponse(transaction, request, 491, 'Request Pending');
      return;
    }

    const dialog = this.options.owner.dialog;
    if (dialog === undefined || request.method !== 'INVITE') {
      this.sendResponse(transaction, request, 481, 'Call/Transaction Does Not Exist');
      return;
    }
    // Dialog identity (dialog id + CSeq method match) and fresh remote CSeq.
    if (!dialog.matchesRequest(request) || !dialog.receiveRequest(request)) {
      this.sendResponse(transaction, request, 481, 'Call/Transaction Does Not Exist');
      return;
    }
    if (!isSupportedAudioOffer(request)) {
      this.sendResponse(transaction, request, 488, 'Not Acceptable Here');
      return;
    }

    // Claim the negotiator synchronously so a second incoming in the same tick
    // (or a racing restartIce) collides with this operation and is answered 491.
    this.busyValue = true;
    // A fresh re-INVITE supersedes any earlier remote-hold ACK still pending.
    this.clearPendingRemote();
    const remoteSdp = bodyText(request);
    const operation: PendingOperation = {};
    this.active = operation;
    const finish = (): void => {
      if (this.active === operation) this.active = undefined;
      this.busyValue = false;
    };

    void this.controller
      .createAnswer(this.options.owner.mediaSessionId, remoteSdp)
      .then(
        (answer) => this.sendAnswerResponse(transaction, request, answer),
        () => this.sendResponse(transaction, request, 488, 'Not Acceptable Here'),
      )
      .catch(() => undefined)
      .finally(finish);
  }

  /**
   * Dispose the negotiator: settle any pending local restart rejected as
   * aborted, release the busy lock, and stop accepting further negotiation.
   */
  dispose(reason: unknown): void {
    if (this.disposed) return;
    this.disposed = true;
    const active = this.active;
    this.active = undefined;
    this.busyValue = false;
    this.terminateOwned();
    this.clearRetryTimer();
    this.clearPendingRemote();
    active?.reject?.(reason);
  }

  private sendAnswerResponse(
    transaction: ServerTransaction,
    request: SipRequestMessage,
    answer: string,
  ): void {
    if (this.disposed) return;
    try {
      const response = this.buildAnswerResponse(request, 200, 'OK', answer);
      this.layer.sendResponse(transaction.key, response);
      // Every answered re-INVITE stages its derived remote-hold value (true for
      // sendonly/inactive, false for sendrecv); the matching ACK commits it.
      this.startPendingRemote(request, response);
    } catch {
      // The server transaction may terminate while media creates the answer.
    }
  }

  /** Start TU-owned 2xx retransmission for the answered re-INVITE, staging remote hold. */
  private startPendingRemote(request: SipRequestMessage, response: SipResponseMessage): void {
    this.clearPendingRemote();
    const retransmitter = new InviteResponseRetransmitter({
      response,
      transport: this.layer.getTransport(),
      clock: this.clock,
      T1: this.T1,
      T2: this.T2,
      onTimeout: (): void => this.clearPendingRemote(),
      onError: (): void => this.clearPendingRemote(),
    });
    this.pendingRemote = { cseq: requestCSeqNumber(request), held: offerIsHold(request), retransmitter };
    retransmitter.start();
  }

  private sendResponse(transaction: ServerTransaction, request: SipRequestMessage, statusCode: number, reason: string): void {
    try {
      this.layer.sendResponse(transaction.key, this.buildAnswerResponse(request, statusCode, reason, undefined));
    } catch {
      // A teardown race may close the transaction; never throw into the caller.
    }
  }

  private buildAnswerResponse(
    request: SipRequestMessage,
    statusCode: number,
    reason: string,
    answer: string | undefined,
  ): SipResponseMessage {
    const headers = new Headers();
    headers.set('Via', request.headers.get('Via') ?? '');
    headers.set('From', request.headers.get('From') ?? '');
    // The re-INVITE's To already carries our local tag; echo it verbatim.
    headers.set('To', request.headers.get('To') ?? '');
    headers.set('Call-ID', request.headers.get('Call-ID') ?? '');
    headers.set('CSeq', request.headers.get('CSeq') ?? '');
    headers.set('Contact', this.contact);
    headers.set('Content-Type', 'application/sdp');
    return makeResponse(statusCode, reason, headers, new TextEncoder().encode(answer ?? ''));
  }
}

/**
 * Validate that a re-INVITE body is a bounded, non-empty `application/sdp`
 * with exactly one active supported audio section (an `m=audio` line) and no
 * video/data or other media sections. Media sections are the `m=` lines.
 */
function isSupportedAudioOffer(request: SipRequestMessage): boolean {
  if (request.headers.get('Content-Type')?.trim().toLowerCase() !== 'application/sdp') return false;
  if (request.body.length === 0 || request.body.length > MAX_REMOTE_SDP_BYTES) return false;
  const text = new TextDecoder('utf-8').decode(request.body);
  const mediaLines = text.split(/\r?\n/).filter((line) => /^m=/.test(line.trim()));
  return mediaLines.length === 1 && mediaLines[0]!.trim().startsWith(`m=${SUPPORTED_MEDIA} `);
}

/**
 * Validate a 2xx answer body for a local re-INVITE before it is applied to
 * media: bounded, non-empty, `application/sdp`, with exactly one supported
 * audio section (mirrors the incoming-offer policy). Rejects video/data or
 * malformed/oversized answers with a typed failure rather than forwarding them
 * to the browser.
 */
function isValidAnswerSdp(answer: string): boolean {
  const bytes = new TextEncoder().encode(answer);
  if (answer.length === 0 || bytes.length > MAX_REMOTE_SDP_BYTES) return false;
  const mediaLines = answer.split(/\r?\n/).filter((line) => /^m=/.test(line.trim()));
  return mediaLines.length === 1 && mediaLines[0]!.trim().startsWith(`m=${SUPPORTED_MEDIA} `);
}

/** Whether a re-INVITE body offers a remote hold (sendonly/inactive). */
function offerIsHold(request: SipRequestMessage): boolean {
  const sdp = bodyText(request);
  return /^a=(sendonly|inactive)\s*$/m.test(sdp);
}

/** The numeric CSeq of a request, or NaN when absent/malformed. */
function requestCSeqNumber(request: SipRequestMessage): number {
  const cseq = request.headers.get('CSeq')?.trim().match(/^(\d+)\s+\S+$/);
  return cseq === undefined || cseq === null ? NaN : Number.parseInt(cseq[1]!, 10);
}
