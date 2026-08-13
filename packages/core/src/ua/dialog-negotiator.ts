import { Headers, makeResponse, bodyText, withTextBody } from '../messages/index.js';
import type { SipRequestMessage, SipResponseMessage } from '../messages/message.js';
import { SipError } from '../errors.js';
import type { Dialog, IdGenerator } from '../dialogs/dialog.js';
import type { ViaConfig } from '../dialogs/header-values.js';
import type { TransactionLayer } from '../transactions/coordinator.js';
import type { ServerTransaction, TransactionLayerEvent } from '../transactions/types.js';
import { sendOwnedRequest } from '../transactions/request-ownership.js';
import type { Clock } from '../transport/index.js';
import type { WorkerMediaController } from '../media/worker-controller.js';

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
}

/**
 * A per-dialog negotiator that serializes in-dialog negotiation for a
 * confirmed call. Exactly one operation owns the negotiator at a time: either
 * a local ICE-restart re-INVITE (restartIce) or an incoming in-dialog
 * re-INVITE being answered off the wire.
 *
 * The `busy` flag is set synchronously before any asynchronous media result so
 * an incoming request racing a local restart (or another incoming) sees it in
 * the same tick and is answered 491 rather than colliding with the in-flight
 * negotiation. The flag is cleared once the owning operation settles.
 *
 * Glare is never retried: a request that arrives while busy is answered 491
 * and dropped; the peer resolves the collision.
 */
export class DialogNegotiator {
  private readonly layer: TransactionLayer;
  private readonly controller: WorkerMediaController;
  private readonly contact: string;
  private disposed = false;
  private busyValue = false;
  private active: PendingOperation | undefined;

  constructor(private readonly options: {
    /** The confirmed dialog media negotiator sits on; undefined pre-dialog. */
    owner: { readonly dialog: Dialog | undefined; readonly mediaSessionId: string };
    layer: TransactionLayer;
    controller: WorkerMediaController;
    clock: Clock;
    idGenerator: IdGenerator;
    via: ViaConfig;
    contact: string;
  }) {
    this.layer = options.layer;
    this.controller = options.controller;
    this.contact = options.contact;
    // clock, idGenerator, and via are accepted for the contract but the
    // negotiator sends through the dialog request API, which owns Via/CSeq.
  }

  /** Whether a local or remote negotiation is in flight. */
  get busy(): boolean {
    return this.busyValue;
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
      };
      void this.runRestart(dialog, settle).catch((reason) => settle(false, reason));
    });
  }

  private release(): void {
    this.active = undefined;
    this.busyValue = false;
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
      () => {}, // disposal terminates the owned transaction
      (event: TransactionLayerEvent): void => {
        if (this.disposed) return;
        if (event.type === 'response') {
          const code = event.response.statusCode;
          if (code >= 200 && code < 300) {
            // Extract the remote answer SDP and apply it to media; only then is
            // the restart considered successful (Task 4 pattern).
            const answer = bodyText(event.response);
            if (this.disposed) {
              settle(false, new SipError(0, 'negotiation aborted', 'LIFECYCLE_ABORTED'));
              return;
            }
            this.controller
              .setRemote(this.options.owner.mediaSessionId, answer)
              .then(
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

  /**
   * Answer an in-dialog re-INVITE. Validates the dialog identity and fresh
   * CSeq (else 481), the bounded single-supported-audio SDP body (else 488),
   * and serializes with any other negotiation (busy → 491). On a supported
   * audio offer, calls `createAnswer` and replies 200 with the returned SDP.
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
    const remoteSdp = bodyText(request);
    const operation: PendingOperation = {};
    this.active = operation;
    const finish = (): void => {
      if (this.active === operation) this.active = undefined;
      this.busyValue = false;
    };

    this.controller
      .createAnswer(this.options.owner.mediaSessionId, remoteSdp)
      .then(
        (answer) => {
          if (this.disposed) return;
          this.layer.sendResponse(transaction.key, this.buildAnswerResponse(request, 200, 'OK', answer));
        },
        () => {
          // Unsupported-media failure → 488 (design); never retry glare.
          if (this.disposed) return;
          this.layer.sendResponse(transaction.key, this.buildAnswerResponse(request, 488, 'Not Acceptable Here', undefined));
        },
      )
      .finally(() => finish());
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
    active?.reject?.(reason);
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