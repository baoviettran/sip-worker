/**
 * Outgoing SIP call session (UAC INVITE client).
 *
 * Drives a single INVITE transaction through its lifecycle: offer creation,
 * INVITE send, provisional/final response handling, authentication retry,
 * dialog establishment, 2xx ACK caching, and BYE-based termination.
 *
 * The 2xx ACK is sent DIRECTLY through the transport (not through the
 * transaction layer) because it is a new branch outside the INVITE transaction.
 * The ACK bytes are serialized once and cached for byte-identical resend on
 * repeated 2xx responses for the same dialog.
 */

import { Headers, makeRequest, makeResponse, bodyText } from '../messages/index.js';
import type { SipRequestMessage, SipResponseMessage } from '../messages/message.js';
import { SipError } from '../errors.js';
import { makeBranch, makeTopVia, type ViaConfig } from '../dialogs/header-values.js';
import { Dialog, type IdGenerator } from '../dialogs/dialog.js';
import { clientKey, type TransactionLayer } from '../transactions/coordinator.js';
import type { TransactionKey, TransactionLayerEvent, ServerTransaction } from '../transactions/types.js';
import { sendOwnedRequest } from '../transactions/request-ownership.js';
import type { Clock, TransportToken } from '../transport/index.js';
import type { AuthManager, AuthFailure } from '../auth/manager.js';
import type { WorkerMediaController } from '../media/worker-controller.js';
import { MediaError } from '../media/errors.js';
import { Session } from './session.js';
import { DialogSet, type DialogSuccessResult } from './dialog-set.js';
import { responseMatchesRequestIdentity } from './response-identity.js';
import { parseRemoteIdentity, type RemoteIdentity } from './remote-identity.js';
import { DialogNegotiator } from './dialog-negotiator.js';

export interface InviterOptions {
  readonly to: string;
  readonly from: string;
  readonly contact: string;
  /** Caller-supplied Via sent-by host:port (never inferred from a socket). */
  readonly viaAddress: string;
  /** Via transport token from the connected transport's capabilities. */
  readonly viaToken: TransportToken;
  readonly idGenerator: IdGenerator;
  readonly layer: TransactionLayer;
  readonly clock: Clock;
  readonly controller: WorkerMediaController;
  readonly authManager?: AuthManager;
  readonly credentials?: { readonly username: string; readonly password: string };
  readonly onDialogCreated?: (dialog: Dialog) => void;
  readonly onDialogReleased?: (dialog: Dialog) => void;
}

/** Extract the numeric CSeq from a message. */
function cseqNumber(msg: SipRequestMessage | SipResponseMessage): number {
  const cseq = msg.headers.get('CSeq');
  if (cseq === undefined) return 0;
  return Number.parseInt(cseq.trim().split(/\s+/)[0] ?? '', 10);
}

interface CleanupOperation {
  disposeRequest: () => void;
  reject: (reason: unknown) => void;
}

export class Inviter {
  readonly session: Session;
  private readonly to: string;
  private readonly from: string;
  private readonly contact: string;
  private readonly viaConfig: ViaConfig;
  private readonly idGenerator: IdGenerator;
  private readonly layer: TransactionLayer;
  private readonly clock: Clock;
  private readonly controller: WorkerMediaController;
  private readonly authManager?: AuthManager;
  private readonly credentials?: { readonly username: string; readonly password: string };
  private readonly onDialogCreated: ((dialog: Dialog) => void) | undefined;
  private readonly onDialogReleased: ((dialog: Dialog) => void) | undefined;

  private readonly sessionId: string;
  private readonly callId: string;
  private readonly fromTag: string;
  private readonly authExchangeId: string;
  private localCSeq = 1;

  private invitePromise: Promise<void> | undefined;
  private inviteDeferred: { resolve: () => void; reject: (reason: unknown) => void } | undefined;
  private currentRequest: SipRequestMessage | undefined;
  private unsubscribe: (() => void) | undefined;
  private dialogSet: DialogSet | undefined;
  private hangingUp = false;
  private hangupDeferred: { resolve: () => void; reject: (reason: unknown) => void } | undefined;
  private unsubscribeHangup: (() => void) | undefined;
  private disposed = false;
  private requestVersion = 0;
  private hangupVersion = 0;
  /** Outgoing CANCEL ownership: one owned non-INVITE transaction + retained INVITE listener. */
  private cancelling = false;
  private cancelPromise: Promise<void> | undefined;
  private cancelDeferred: { resolve: () => void; reject: (reason: unknown) => void } | undefined;
  private unsubscribeCancel: (() => void) | undefined;
  private readonly cancelSettlement = { cancelFinalSeen: false, inviteReconciled: false };
  private readonly cleanupOperations = new Set<CleanupOperation>();
  /**
   * The single in-flight negotiation (selected 2xx → setRemote) promise. While
   * it is pending, later repeated/forked 2xx must NOT start a second negotiation
   * or re-settle. Set to undefined once the selected negotiation settles.
   */
  private selectedNegotiation: Promise<void> | undefined;

  constructor(options: InviterOptions) {
    this.session = new Session();
    this.to = options.to;
    this.from = options.from;
    this.contact = options.contact;
    this.viaConfig = { token: options.viaToken, sentBy: options.viaAddress };
    this.idGenerator = options.idGenerator;
    this.layer = options.layer;
    this.clock = options.clock;
    this.controller = options.controller;
    this.authManager = options.authManager;
    this.credentials = options.credentials;
    this.onDialogCreated = options.onDialogCreated;
    this.onDialogReleased = options.onDialogReleased;

    // Stable per-session identifiers
    this.sessionId = options.idGenerator.branch();
    this.callId = options.idGenerator.branch();
    this.fromTag = options.idGenerator.branch();
    this.authExchangeId = `${this.callId}:INVITE`;
  }

  /**
   * Initiate the outgoing INVITE. Single-use: rejects if called twice.
   * Resolves when the call is confirmed (2xx received and ACK sent).
   * Rejects with SipError on non-2xx final, timeout, or transport error.
   */
  invite(): Promise<void> {
    if (this.disposed) {
      return Promise.reject(new SipError(0, 'Inviter has been disposed', 'LIFECYCLE_ABORTED'));
    }
    if (this.invitePromise !== undefined) {
      return Promise.reject(new SipError(0, 'invite() already called', 'INVALID_STATE'));
    }

    this.invitePromise = new Promise<void>((resolve, reject) => {
      this.inviteDeferred = { resolve, reject };
      this.startInvite();
    });

    return this.invitePromise;
  }

  /**
   * Cancel an in-flight outgoing INVITE (RFC 3261 9.1). Valid only before the
   * call is confirmed. A duplicate call shares the same promise. The returned
   * promise settles only after BOTH the CANCEL final response and the INVITE
   * final reconciliation (the ACK'd 487, or the ACK+BYE of a late 2xx). It
   * NEVER synthesizes success on transport loss — a lost CANCEL/INVITE settles
   * the invite with OPERATION_ABORTED and rejects cancel() with the transport
   * error. The pending `call.invite()` promise rejects with `OPERATION_ABORTED`
   * when the CANCEL wins.
   */
  cancel(): Promise<void> {
    if (this.disposed) {
      return Promise.reject(new SipError(0, 'Inviter has been disposed', 'LIFECYCLE_ABORTED'));
    }
    if (this.cancelPromise !== undefined) return this.cancelPromise;
    if (this.cancelling || this.session.state === 'confirmed' || this.session.state === 'terminating') {
      return Promise.reject(new SipError(0, 'cancel() after the call was confirmed', 'INVALID_STATE'));
    }
    if (this.currentRequest === undefined) {
      return Promise.reject(new SipError(0, 'cancel() before INVITE was initiated', 'INVALID_STATE'));
    }

    this.cancelling = true;
    const promise = new Promise<void>((resolve, reject) => {
      this.cancelDeferred = { resolve, reject };
      this.startCancel();
    });
    this.cancelPromise = promise;
    return promise;
  }

  /**
   * Send the CANCEL as one owned non-INVITE transaction, building its message
   * from the sent INVITE. Per RFC 3261 9.1 the CANCEL reuses the INVITE's
   * Request-URI, Call-ID, From/To, CSeq NUMBER, and top Via branch, differing
   * only in the CSeq method (CANCEL). The original INVITE listener is retained
   * until the INVITE's final response is reconciled.
   */
  private startCancel(): void {
    const invite = this.currentRequest;
    if (invite === undefined) {
      this.disposeCancel(new SipError(0, 'cancel() before INVITE was initiated', 'INVALID_STATE'));
      return;
    }
    const headers = new Headers();
    headers.set('Via', invite.headers.get('Via') ?? '');
    headers.set('Max-Forwards', '70');
    headers.set('From', invite.headers.get('From') ?? '');
    headers.set('To', invite.headers.get('To') ?? '');
    headers.set('Call-ID', invite.headers.get('Call-ID') ?? '');
    const inviteCSeq = cseqNumber(invite);
    headers.set('CSeq', `${inviteCSeq} CANCEL`);
    const cancel = makeRequest('CANCEL', invite.uri, headers);

    try {
      this.attachCancelListener(cancel, invite);
    } catch (err) {
      this.disposeCancel(err);
    }
  }

  /**
   * Own the CANCEL client transaction and keep a listener on the retained
   * INVITE transaction until its final response reconciles the cancel.
   */
  private attachCancelListener(cancel: SipRequestMessage, _invite: SipRequestMessage): void {
    this.teardownCancel();
    sendOwnedRequest(
      this.layer,
      cancel,
      (disposeRequest) => {
        if (this.disposed) {
          disposeRequest();
          return;
        }
        this.unsubscribeCancel = disposeRequest;
      },
      (event: TransactionLayerEvent) => {
        if (this.disposed) return;
        if (event.type === 'response') {
          if (!responseMatchesRequestIdentity(cancel, event.response)) return;
          const code = event.response.statusCode;
          if (code >= 200 && code < 300) {
            this.cancelSettlement.cancelFinalSeen = true;
            this.trySettleCancel();
          } else if (code >= 300) {
            this.abortPendingInvite(new SipError(0, 'INVITE cancelled', 'OPERATION_ABORTED'));
            this.disposeCancel(new SipError(code, `CANCEL rejected with ${code}`, 'CALL_FAILED'));
          }
        } else if (event.type === 'timeout' || event.type === 'transportError') {
          const error = new SipError(
            0,
            `CANCEL ${event.type}`,
            event.type === 'transportError' ? 'TRANSPORT_FAILED' : 'TIMEOUT',
          );
          // The CANCEL branch failed. We never synthesize a 487/ACK that did not
          // happen: the local call is aborted (OPERATION_ABORTED) and cancel()
          // rejects with the transport error.
          this.abortPendingInvite(new SipError(0, 'INVITE cancelled', 'OPERATION_ABORTED'));
          this.disposeCancel(error);
        }
      },
    );
    // The original INVITE listener (attachListener -> onResponse/onSuccess) is
    // RETAINED here; cancel() does not teardown the INVITE. It reconciles the
    // INVITE final through that same listener via the cancelling flags below.
  }

  /** The INVITE's non-2xx final (e.g. 487) arrived while a CANCEL was in flight. */
  private onInviteFinalAborted(response: SipResponseMessage): void {
    const error = new SipError(response.statusCode, 'INVITE cancelled', 'OPERATION_ABORTED');
    this.reconcileCancelledInvite(error);
  }

  /** A late 2xx arrived while a CANCEL was in flight: ACK, BYE-clean, abort. */
  private onCancelLate2xx(response: SipResponseMessage): void {
    // Run the normal dialog-formation path so the ACK is emitted and the dialog
    // is established, then immediately terminate it with a BYE (RFC semantics
    // for a 2xx that races a CANCEL: ACK it, then BYE). A media-negotiation
    // (or any) failure of the 2xx settlement still reconciles the cancelled
    // invite with OPERATION_ABORTED and ends the session 'terminated'.
    void this.onSuccess(response).then(
      () => {
        const dialog = this.dialog;
        if (dialog === undefined) {
          this.reconcileCancelledInvite(new SipError(0, 'INVITE cancelled', 'OPERATION_ABORTED'));
          return;
        }
        void this.sendByeForDialog(dialog)
          .then(() => {
            this.reconcileCancelledInvite(new SipError(0, 'INVITE cancelled', 'OPERATION_ABORTED'));
          })
          .catch(() => {
            // If the cleanup BYE fails, still abort the cancelled invite.
            this.reconcileCancelledInvite(new SipError(0, 'INVITE cancelled', 'OPERATION_ABORTED'));
          });
      },
      () => {
        // onSuccess failed (e.g. media negotiation rejected the late 2xx). The
        // invite must still reconcile with OPERATION_ABORTED and cancel() settle.
        this.reconcileCancelledInvite(new SipError(0, 'INVITE cancelled', 'OPERATION_ABORTED'));
      },
    );
  }

  /**
   * Mark the INVITE reconciled, settle the pending invite with OPERATION_ABORTED,
   * transition the session to terminated (never failed), and detach cancel state.
   */
  private reconcileCancelledInvite(error: SipError): void {
    if (this.cancelSettlement.inviteReconciled) return;
    this.cancelSettlement.inviteReconciled = true;
    const deferred = this.inviteDeferred;
    this.inviteDeferred = undefined;
    // The INVITE listener remains owned; dismiss it now that the final is handled.
    this.teardownInvite();
    this.settleAuthExchange();
    if (deferred !== undefined) deferred.reject(error);
    if (this.session.state !== 'terminated') this.session.transition('terminated');
    this.trySettleCancel();
  }

  /** Abort the still-pending invite when the CANCEL branch itself fails. */
  private abortPendingInvite(error: SipError): void {
    if (this.cancelSettlement.inviteReconciled) return;
    this.cancelSettlement.inviteReconciled = true;
    const deferred = this.inviteDeferred;
    this.inviteDeferred = undefined;
    this.teardownInvite();
    this.settleAuthExchange();
    if (deferred !== undefined) deferred.reject(error);
    if (this.session.state !== 'terminated') this.session.transition('terminated');
    this.trySettleCancel();
  }

  /** Settle cancel() exactly once once the CANCEL final AND the INVITE reconcile are both seen. */
  private trySettleCancel(): void {
    if (!this.cancelSettlement.cancelFinalSeen || !this.cancelSettlement.inviteReconciled) return;
    const deferred = this.cancelDeferred;
    this.cancelDeferred = undefined;
    this.teardownCancel();
    this.cancelling = false;
    deferred?.resolve();
  }

  /** Fail cancel() exactly once and detach its owned branch. Invite settlement is NOT
   *  performed here: callers must reconcile the INVITE (via abortPendingInvite)
   *  so the session ends in 'terminated' and the listener is torn down. */
  private disposeCancel(reason: unknown): void {
    if (this.cancelDeferred === undefined) return;
    const deferred = this.cancelDeferred;
    this.cancelDeferred = undefined;
    this.cancelSettlement.cancelFinalSeen = true;
    this.teardownCancel();
    this.cancelling = false;
    deferred.reject(reason);
  }

  /** Detach the owned CANCEL transaction. The INVITE listener is separate. */
  private teardownCancel(): void {
    if (this.unsubscribeCancel !== undefined) {
      const dispose = this.unsubscribeCancel;
      this.unsubscribeCancel = undefined;
      dispose();
    }
  }

  /**
   * Terminate the confirmed call with a BYE. Only valid after invite() resolves.
   * Resolves when the BYE 2xx is received.
   */
  hangup(): Promise<void> {
    if (this.disposed) {
      return Promise.reject(new SipError(0, 'Inviter has been disposed', 'LIFECYCLE_ABORTED'));
    }
    if (this.dialog === undefined) {
      return Promise.reject(new SipError(0, 'hangup() called before call was confirmed', 'INVALID_STATE'));
    }
    if (this.hangingUp) {
      return Promise.reject(new SipError(0, 'hangup() already in progress', 'INVALID_STATE'));
    }

    this.hangingUp = true;
    const dialog = this.dialog;
    return new Promise<void>((resolve, reject) => {
      const deferred = { resolve, reject };
      const hangupVersion = this.hangupVersion;
      this.hangupDeferred = deferred;
      this.session.transition('terminating');
      if (
        this.disposed
        || !this.hangingUp
        || this.hangupDeferred !== deferred
        || this.hangupVersion !== hangupVersion
        || this.session.state !== 'terminating'
      ) return;
      if (dialog === undefined) {
        this.failHangup(new SipError(0, 'hangup() called before call was confirmed', 'INVALID_STATE'));
        return;
      }
      this.sendBye(dialog);
    });
  }

  /** The selected (application) dialog from the first 2xx response. */
  get dialog(): Dialog | undefined {
    return this.dialogSet?.selectedDialog;
  }

  /** Immutable remote target identity parsed from the addressed To URI. */
  get remoteIdentity(): RemoteIdentity | undefined {
    const parsed = parseRemoteIdentity(`<${this.to}>`);
    return parsed;
  }

  /** Every dialog currently owned by this forked INVITE. */
  get dialogs(): readonly Dialog[] {
    return this.dialogSet?.allDialogs ?? [];
  }

  /** The media session id used for offer/answer on this call. */
  get mediaSessionId(): string {
    return this.sessionId;
  }

  private activeNegotiator: DialogNegotiator | undefined;

  /** Request an ICE restart on the confirmed dialog. */
  restartIce(): Promise<void> {
    if (this.disposed) {
      return Promise.reject(new SipError(0, 'Inviter has been disposed', 'LIFECYCLE_ABORTED'));
    }
    const negotiator = this.ensureNegotiator();
    if (negotiator === undefined) {
      return Promise.reject(new SipError(0, 'call not confirmed', 'INVALID_STATE'));
    }
    return negotiator.restartIce();
  }

  /** Build the negotiator once (and only once) the selected dialog exists. */
  private ensureNegotiator(): DialogNegotiator | undefined {
    if (this.activeNegotiator !== undefined) return this.activeNegotiator;
    const dialog = this.dialog;
    if (dialog === undefined) return undefined;
    this.activeNegotiator = new DialogNegotiator({
      owner: { dialog, mediaSessionId: this.sessionId },
      layer: this.layer,
      controller: this.controller,
      clock: this.clock,
      idGenerator: this.idGenerator,
      via: this.viaConfig,
      contact: this.contact,
    });
    return this.activeNegotiator;
  }

  /** Dispose the negotiator before media closes so late re-INVITEs can't fire. */
  private disposeNegotiator(reason: unknown): void {
    const negotiator = this.activeNegotiator;
    this.activeNegotiator = undefined;
    negotiator?.dispose(reason);
  }

  private async startInvite(): Promise<void> {
    try {
      // Obtain SDP offer FIRST
      const sdp = await this.controller.createOffer(this.sessionId);
      if (this.disposed) return;
      const request = this.buildInviteRequest(sdp);
      this.currentRequest = request;
      this.session.transition('inviting');
      if (this.disposed) return;
      this.sendAttempt(request);
    } catch (err) {
      if (this.disposed) return;
      this.fail(err);
    }
  }

  private buildInviteRequest(sdp: string): SipRequestMessage {
    const headers = new Headers();
    const branch = makeBranch(this.idGenerator.branch());
    headers.set('Via', makeTopVia(this.viaConfig, branch));
    headers.set('Max-Forwards', '70');
    headers.set('From', `<${this.from}>;tag=${this.fromTag}`);
    headers.set('To', `<${this.to}>`);
    headers.set('Call-ID', this.callId);
    headers.set('CSeq', `${this.localCSeq} INVITE`);
    headers.set('Contact', this.contact);
    headers.set('Content-Type', 'application/sdp');

    const encoder = new TextEncoder();
    const body = encoder.encode(sdp);

    return makeRequest('INVITE', this.to, headers, body);
  }

  private sendAttempt(request: SipRequestMessage): void {
    try {
      this.attachListener(request);
    } catch (err) {
      this.fail(err);
    }
  }

  private attachListener(request: SipRequestMessage): void {
    this.teardownInvite();
    const requestVersion = this.requestVersion;
    let inviteKey: TransactionKey | undefined;
    const unsubscribeStateless = this.layer.subscribe((event: TransactionLayerEvent) => {
      if (event.type !== 'statelessResponse') return;
      // Repeated or forked 2xx arrive after the INVITE client transaction has
      // terminated, so they have no transaction key. Keep this separate from
      // the exact-key listener and match the dialog-forming identity instead.
      const response = event.response;
      if (
        clientKey(response) === inviteKey
        && responseMatchesRequestIdentity(request, response)
        && response.statusCode >= 200
        && response.statusCode < 300
      ) {
        void this.onSuccess(response);
      }
    });
    this.unsubscribe = unsubscribeStateless;

    sendOwnedRequest(
      this.layer,
      request,
      (disposeOwned, key) => {
        inviteKey = key;
        const disposeRequest = () => {
          disposeOwned();
          unsubscribeStateless();
        };
        if (this.disposed || requestVersion !== this.requestVersion) {
          disposeRequest();
          return;
        }
        this.unsubscribe = disposeRequest;
      },
      (event: TransactionLayerEvent) => {
        if (event.type === 'response') {
          this.onResponse(request, event.response);
        } else if (event.type === 'timeout' || event.type === 'transportError') {
          this.fail(new SipError(0, `INVITE ${event.type}`, event.type === 'transportError' ? 'TRANSPORT_FAILED' : 'TIMEOUT'));
        } else if (event.type === 'terminated') {
          this.dialogSet?.expireExtraOwners();
          this.teardownInvite();
          // The INVITE client branch reached its final reconciliation while a
          // CANCEL was in flight; settle cancel().
          if (this.cancelling) this.trySettleCancel();
        }
      },
    );
  }

  private onResponse(base: SipRequestMessage, response: SipResponseMessage): void {
    if (!responseMatchesRequestIdentity(base, response)) return;

    const code = response.statusCode;

    if (code === 100) {
      // Trying: stay in 'inviting'
      return;
    }

    if (code === 180) {
      this.session.transition('ringing');
      return;
    }

    if (code === 183) {
      const sdp = bodyText(response);
      if (sdp.length > 0) {
        void this.controller.setRemote(this.sessionId, sdp);
        this.session.transition('early');
      }
      return;
    }

    // A CANCEL was in flight: reconcile the INVITE final before normal handling.
    if (this.cancelling) {
      if (code >= 200 && code < 300) {
        // Late 2xx after CANCEL: ACK (via normal dialog handling), then BYE-clean.
        const result = this.onCancelLate2xx(response);
        if (result === undefined) return;
        return;
      }
      if (code >= 300) {
        // Non-2xx final (our 487): reconcile the cancelled invite.
        this.onInviteFinalAborted(response);
        return;
      }
      return;
    }

    if (code >= 200 && code < 300) {
      this.onSuccess(response);
      return;
    }

    if (code === 401 || code === 407) {
      this.handleAuth(base, response);
      return;
    }

    // Any other 3xx-6xx: fail
    this.fail(new SipError(code, `INVITE rejected with ${code}`, 'CALL_FAILED'));
  }

  private async onSuccess(response: SipResponseMessage): Promise<void> {
    if (this.disposed) return;
    // Lazily create the DialogSet on the first 2xx
    if (this.dialogSet === undefined) {
      this.dialogSet = new DialogSet(
        this.currentRequest!,
        this.idGenerator,
        this.viaConfig,
        this.layer.getTransport(),
        (dialog) => this.sendByeForDialog(dialog),
        (dialog) => this.onDialogCreated?.(dialog),
        (dialog) => this.onDialogReleased?.(dialog),
      );
    }

    let result: DialogSuccessResult;
    try {
      result = await this.dialogSet.handleSuccess(response);
    } catch (err) {
      // Malformed 2xx (missing To tag/Contact) - fail the invite if still pending
      if (this.disposed) return;
      if (this.inviteDeferred !== undefined) this.fail(err);
      return;
    }
    if (this.disposed) return;

    // Only the selected created dialog owns the application media answer. Require
    // a non-empty SDP and settle invite ONLY after the remote description has
    // been successfully applied to the media layer. A single selected-negotiation
    // promise guards against asynchronous repeated/forked 2xx (same or different
    // To tag) re-negotiating or re-settling while a setRemote is still pending.
    if (result.selected) {
      if (result.created && this.selectedNegotiation === undefined) {
        this.ensureSelectedNegotiation(response);
      }
      // While a selected negotiation is in flight (or just settled), every
      // subsequent selected-tag 2xx awaits the SAME promise so the invite settles
      // exactly once and never re-negotiates.
      if (this.selectedNegotiation !== undefined) {
        await this.selectedNegotiation;
        return;
      }
      this.confirmInvite();
    }
  }

  /**
   * Start the single selected-negotiation for the first (created) 2xx: require a
   * non-empty SDP, apply it to the media layer, then settle exactly once. Sets
   * `selectedNegotiation` to the in-flight promise and clears it on completion so
   * a late repeated 2xx no longer awaits (or rejects) a stale negotiation.
   */
  private ensureSelectedNegotiation(response: SipResponseMessage): void {
    const sdp = DialogSet.sdpFromBody(response);
    const dialog = this.dialogSet?.selectedDialog;
    if (sdp.length === 0) {
      const error = new MediaError('NEGOTIATION_FAILED', '2xx response carried no SDP', this.sessionId, 'setRemote');
      this.selectedNegotiation = undefined;
      // The dialog has already been created and ACKed by handleSuccess. Close it
      // with a BYE when possible (unless the hangup path owns it) so the remote
      // does not hold a dangling established dialog after we fail and close media.
      if (dialog !== undefined && !this.hangingUp) {
        void this.sendByeForDialog(dialog).catch(() => {});
      }
      if (this.cancelling) {
        // A late 2xx racing a CANCEL carried no SDP: reconcile the cancelled invite.
        this.reconcileCancelledInvite(new SipError(0, 'INVITE cancelled', 'OPERATION_ABORTED'));
        return;
      }
      if (this.inviteDeferred !== undefined) this.fail(error);
      return;
    }
    const negotiation = this.controller
      .setRemote(this.sessionId, sdp)
      .then(
        () => {
          this.selectedNegotiation = undefined;
          if (this.disposed) return;
          // The selected call is confirmed only once the remote description has
          // been applied and the invite promise settles.
          this.confirmInvite();
        },
        (reason: unknown) => {
          this.selectedNegotiation = undefined;
          if (this.disposed) return;
          // A media-negotiation failure of a late 2xx racing a CANCEL must reconcile
          // the cancelled invite (OPERATION_ABORTED, 'terminated') rather than fail
          // the call, so cancel() still settles and no listener/timer leaks.
          if (this.cancelling) {
            this.reconcileCancelledInvite(new SipError(0, 'INVITE cancelled', 'OPERATION_ABORTED'));
            return;
          }
          // On a rejected remote description for the created dialog, send a BYE
          // when possible (unless the hangup path already owns it), then fail the
          // call. Media closure is left to UA terminal ownership so it happens
          // exactly once.
          if (dialog !== undefined && !this.hangingUp) {
            void this.sendByeForDialog(dialog).catch(() => {});
          }
          this.fail(reason);
        },
      );
    this.selectedNegotiation = negotiation;
  }

  /** Settle the invite promise and transition to confirmed, exactly once. */
  private confirmInvite(): void {
    // A late 2xx racing a CANCEL (RFC 3261 9.2) must NOT confirm or settle the
    // call: the negative-response and operation settlement are owned by the
    // cancel path. It still ACKs and BYE-cleans via onSuccess's dialog handling.
    if (this.cancelling) return;
    const deferred = this.inviteDeferred;
    if (deferred !== undefined) {
      this.inviteDeferred = undefined;
      this.settleAuthExchange();
      deferred.resolve();
      this.session.transition('confirmed');
    }
  }

  private handleAuth(base: SipRequestMessage, response: SipResponseMessage): void {
    if (this.authManager === undefined || this.credentials === undefined) {
      this.fail(new SipError(response.statusCode, `${response.statusCode} received but no credentials configured`, 'AUTHENTICATION_FAILED'));
      return;
    }

    const result = this.authManager.retry({
      requestId: this.authExchangeId,
      request: base,
      response,
      credentials: this.credentials,
    });

    if (isAuthFailure(result)) {
      this.fail(result.error);
      return;
    }

    // Auth manager incremented CSeq internally; track it
    this.localCSeq = cseqNumber(result);
    this.currentRequest = result;
    this.sendAttempt(result);
  }

  /**
   * Send a BYE for the selected (application) dialog from hangup(). Its owned
   * listener is independent of the retained fork-response listener. A 2xx
   * transitions the selected session to terminated and settles hangup().
   */
  private sendBye(dialog: Dialog): void {
    const bye = dialog.createRequest('BYE');

    try {
      this.attachByeListener(bye);
    } catch (err) {
      this.failHangup(err);
    }
  }

  /**
   * Send a BYE for an extra (forked) dialog from the DialogSet. Self-contained:
   * uses a temporary subscription that does not disturb the main INVITE
   * listener or session state. Resolves on a 2xx (or rejects on a non-2xx
   * final / timeout / transport error), then unsubscribes.
   */
  private sendByeForDialog(dialog: Dialog): Promise<void> {
    if (this.disposed) {
      return Promise.reject(new SipError(0, 'Inviter has been disposed'));
    }
    const bye = dialog.createRequest('BYE');
    return new Promise<void>((resolve, reject) => {
      let active = true;
      const operation: CleanupOperation = {
        disposeRequest: () => {},
        reject: () => {},
      };
      const settle = (succeeded: boolean, reason?: unknown): void => {
        if (!active) return;
        active = false;
        operation.disposeRequest();
        this.cleanupOperations.delete(operation);
        if (succeeded) resolve();
        else reject(reason);
      };
      operation.reject = (reason) => settle(false, reason);
      this.cleanupOperations.add(operation);
      try {
        sendOwnedRequest(
          this.layer,
          bye,
          (next) => {
            if (active) operation.disposeRequest = next;
            else next();
          },
          (event: TransactionLayerEvent) => {
            if (event.type === 'response') {
              if (responseMatchesRequestIdentity(bye, event.response)) {
                const code = event.response.statusCode;
                if (code >= 200 && code < 300) {
                  settle(true);
                } else if (code >= 300) {
                  settle(false, new SipError(code, `BYE rejected with ${code}`, 'CALL_FAILED'));
                }
              }
            } else if (event.type === 'timeout' || event.type === 'transportError') {
              settle(false, new SipError(0, `BYE ${event.type}`, event.type === 'transportError' ? 'TRANSPORT_FAILED' : 'TIMEOUT'));
            }
          },
        );
      } catch (err) {
        settle(false, err);
      }
    });
  }

  private attachByeListener(request: SipRequestMessage): void {
    this.teardownHangup();
    const hangupVersion = this.hangupVersion;
    sendOwnedRequest(
      this.layer,
      request,
      (disposeRequest) => {
        if (this.disposed || hangupVersion !== this.hangupVersion) {
          disposeRequest();
          return;
        }
        this.unsubscribeHangup = disposeRequest;
      },
      (event: TransactionLayerEvent) => {
        if (event.type === 'response') {
          if (responseMatchesRequestIdentity(request, event.response)) {
            const code = event.response.statusCode;
            if (code >= 200 && code < 300) {
              this.settleHangup();
              this.session.transition('terminated');
            } else if (code >= 300) {
              this.failHangup(new SipError(code, `BYE rejected with ${code}`, 'CALL_FAILED'));
            }
          }
        } else if (event.type === 'timeout' || event.type === 'transportError') {
          this.failHangup(new SipError(0, `BYE ${event.type}`, event.type === 'transportError' ? 'TRANSPORT_FAILED' : 'TIMEOUT'));
        }
      },
    );
  }

  /** Handle a request addressed to the confirmed dialog. */
  handleIncomingRequest(transaction: ServerTransaction, request: SipRequestMessage): void {
    if (this.disposed) return;
    // An in-dialog re-INVITE is answered through the serialized negotiator.
    if (request.method === 'INVITE') {
      const negotiator = this.ensureNegotiator();
      if (negotiator === undefined) {
        this.layer.sendResponse(transaction.key, this.requestResponse(request, 481, 'Call/Transaction Does Not Exist'));
        return;
      }
      negotiator.handleIncoming(transaction, request);
      return;
    }
    if (request.method !== 'BYE') {
      this.layer.sendResponse(transaction.key, this.requestResponse(request, 481, 'Call/Transaction Does Not Exist'));
      return;
    }
    const match = this.dialogSet?.receiveRequest(request);
    if (match === undefined) {
      this.layer.sendResponse(transaction.key, this.requestResponse(request, 481, 'Call/Transaction Does Not Exist'));
      return;
    }
    this.layer.sendResponse(transaction.key, this.requestResponse(request, 200, 'OK'));
    if (this.disposed || !match.selected) return;
    const inviteDeferred = this.inviteDeferred;
    this.inviteDeferred = undefined;
    if (inviteDeferred !== undefined) {
      this.settleAuthExchange();
      inviteDeferred.resolve();
      this.session.transition('confirmed');
      if (this.disposed) return;
    }
    this.settleHangup();
    this.session.transition('terminated');
  }

  private requestResponse(request: SipRequestMessage, statusCode: number, reason: string): SipResponseMessage {
    const headers = new Headers();
    headers.set('Via', request.headers.get('Via') ?? '');
    headers.set('From', request.headers.get('From') ?? '');
    headers.set('To', request.headers.get('To') ?? '');
    headers.set('Call-ID', request.headers.get('Call-ID') ?? '');
    headers.set('CSeq', request.headers.get('CSeq') ?? '');
    return makeResponse(statusCode, reason, headers);
  }

  /** Final shutdown: detach operation listeners and reject pending public operations exactly once. */
  dispose(error: unknown): void {
    if (this.disposed) return;
    this.disposed = true;
    this.disposeNegotiator(error);
    this.teardown();
    this.settleAuthExchange();

    const inviteDeferred = this.inviteDeferred;
    this.inviteDeferred = undefined;
    const hangupDeferred = this.hangupDeferred;
    this.hangupDeferred = undefined;
    const cancelDeferred = this.cancelDeferred;
    this.cancelDeferred = undefined;
    this.cancelSettlement.cancelFinalSeen = true;
    this.cancelSettlement.inviteReconciled = true;

    for (const operation of [...this.cleanupOperations]) operation.reject(error);
    this.cleanupOperations.clear();

    if (this.session.state !== 'terminated' && this.session.state !== 'failed') {
      this.session.transition('failed', error instanceof Error ? error : new Error(String(error)));
    }
    inviteDeferred?.reject(error);
    hangupDeferred?.reject(error);
    cancelDeferred?.reject(error);
  }

  private fail(reason: unknown): void {
    this.disposeNegotiator(reason);
    this.teardown();
    this.settleAuthExchange();
    const deferred = this.inviteDeferred;
    this.inviteDeferred = undefined;
    if (deferred !== undefined) deferred.reject(reason);
    this.session.transition('failed', reason instanceof Error ? reason : undefined);
  }

  private settleAuthExchange(): void {
    this.authManager?.settle(this.authExchangeId);
  }

  private settleHangup(): void {
    this.disposeNegotiator(new SipError(0, 'call terminated', 'LIFECYCLE_ABORTED'));
    this.teardownHangup();
    const deferred = this.hangupDeferred;
    this.hangupDeferred = undefined;
    this.hangingUp = false;
    if (deferred !== undefined) deferred.resolve();
  }

  private failHangup(reason: unknown): void {
    this.teardownHangup();
    const deferred = this.hangupDeferred;
    this.hangupDeferred = undefined;
    this.hangingUp = false;
    if (deferred !== undefined) deferred.reject(reason);
    if (!this.disposed && this.session.state === 'terminating') this.session.transition('confirmed');
  }

  private teardown(): void {
    this.teardownInvite();
    this.teardownHangup();
    this.teardownCancel();
  }

  private teardownInvite(): void {
    this.requestVersion += 1;
    if (this.unsubscribe !== undefined) {
      this.unsubscribe();
      this.unsubscribe = undefined;
    }
  }

  private teardownHangup(): void {
    this.hangupVersion += 1;
    if (this.unsubscribeHangup !== undefined) {
      this.unsubscribeHangup();
      this.unsubscribeHangup = undefined;
    }
  }
}

function isAuthFailure(result: SipRequestMessage | AuthFailure): result is AuthFailure {
  return (result as { type?: string }).type !== undefined;
}
