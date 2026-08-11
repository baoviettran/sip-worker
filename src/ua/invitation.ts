/**
 * Incoming SIP call session (UAS INVITE server).
 *
 * Handles an incoming INVITE, extracts the remote SDP offer, provides methods
 * to answer with 200 OK (with local SDP) or reject with 4xx/5xx/6xx. After
 * answering, retransmits the 200 OK until ACK arrives or timeout.
 *
 * The 2xx retransmission is TU-owned (not transaction-owned) per RFC 3261.
 */

import { Headers, bodyText, makeResponse } from '../messages/index.js';
import type { SipRequestMessage, SipResponseMessage } from '../messages/message.js';
import { SipError } from '../errors.js';
import { extractTag, makeBranch, makeTopVia, type ViaConfig } from '../dialogs/header-values.js';
import { Dialog, type IdGenerator } from '../dialogs/dialog.js';
import type { TransactionLayer } from '../transactions/coordinator.js';
import type { ServerTransaction } from '../transactions/types.js';
import type { Clock } from '../transport/transport.js';
import type { WorkerMediaController } from '../media/worker-controller.js';
import { Session } from './session.js';
import { InviteResponseRetransmitter } from './invite-response-retransmitter.js';

export interface InvitationOptions {
  readonly request: SipRequestMessage;
  readonly transaction: ServerTransaction;
  readonly contact: string;
  /** Caller-supplied Via sent-by host:port (never inferred from a socket). */
  readonly viaAddress: string;
  /** Via transport token from the connected transport's capabilities. */
  readonly viaToken: string;
  readonly idGenerator: IdGenerator;
  readonly layer: TransactionLayer;
  readonly clock: Clock;
  readonly controller: WorkerMediaController;
  readonly T1: number;
  readonly T2: number;
  readonly onDialogCreated?: (dialog: Dialog) => void;
}

export class Invitation {
  readonly session: Session;
  private readonly request: SipRequestMessage;
  private readonly transaction: ServerTransaction;
  private readonly contact: string;
  private readonly viaConfig: ViaConfig;
  private readonly idGenerator: IdGenerator;
  private readonly layer: TransactionLayer;
  private readonly clock: Clock;
  private readonly controller: WorkerMediaController;
  private readonly T1: number;
  private readonly T2: number;
  private readonly onDialogCreated: ((dialog: Dialog) => void) | undefined;

  private state: 'pending' | 'answering' | 'accepted' | 'confirmed' | 'rejected' | 'cancelled' | 'terminated' = 'pending';
  private readonly sessionId: string;
  private readonly remoteSdp: string;

  private answerDeferred: { resolve: () => void; reject: (reason: unknown) => void } | undefined;
  private dialogValue: Dialog | undefined;
  private acceptedResponse: SipResponseMessage | undefined;
  private retransmitter: InviteResponseRetransmitter | undefined;
  private unsubscribeTransactionEvents: (() => void) | undefined;
  private disposed = false;
  readonly toTag: string;

  get dialog(): Dialog | undefined {
    return this.dialogValue;
  }
  constructor(options: InvitationOptions) {
    this.session = new Session();
    this.request = options.request;
    this.transaction = options.transaction;
    this.contact = options.contact;
    this.viaConfig = { token: options.viaToken, sentBy: options.viaAddress };
    this.idGenerator = options.idGenerator;
    this.layer = options.layer;
    this.clock = options.clock;
    this.controller = options.controller;
    this.T1 = options.T1;
    this.T2 = options.T2;
    this.onDialogCreated = options.onDialogCreated;

    this.sessionId = options.idGenerator.branch();
    this.remoteSdp = bodyText(options.request);
    this.toTag = options.idGenerator.branch();
    this.unsubscribeTransactionEvents = this.layer.subscribeServer(this.transaction.key, (event) => {
      if (event.type === 'transportError' && this.answerDeferred !== undefined) {
        this.fail(event.error);
      }
    });
  }

  /**
   * Answer the INVITE with 200 OK and local SDP. Starts 2xx retransmission.
   * Resolves when the call is confirmed (ACK received).
   * Rejects on ACK timeout (64*T1) or transport error.
   */
  answer(localSdp: string): Promise<void> {
    if (this.disposed) {
      return Promise.reject(new SipError(0, 'Invitation has been disposed'));
    }
    if (this.state !== 'pending') {
      return Promise.reject(new SipError(0, 'answer() already called'));
    }
    this.state = 'answering';
    return new Promise<void>((resolve, reject) => {
      this.answerDeferred = { resolve, reject };
      this.doAnswer(localSdp);
    });
  }

  private async doAnswer(localSdp: string): Promise<void> {
    try {
      // Set remote SDP
      await this.controller.setRemote(this.sessionId, this.remoteSdp);
      if (this.state !== 'answering') return;

      // Build 200 OK response
      const response = this.build200Ok(localSdp);
      this.acceptedResponse = response;

      // Create the dialog and claim acceptance before external I/O.
      this.dialogValue = Dialog.fromUas(this.request, response, this.idGenerator, this.viaConfig);
      this.state = 'accepted';
      this.onDialogCreated?.(this.dialogValue);

      // Send via transaction layer
      this.layer.sendResponse(this.transaction.key, response);
      if (this.state !== 'accepted') return;

      // Start TU-owned 2xx retransmission; the UA routes dialog requests.
      this.startRetransmission(response);
    } catch (err) {
      if (this.state === 'cancelled') return;
      this.fail(err);
    }
  }

  /**
   * Reject the INVITE with a 4xx/5xx/6xx response. No retransmission.
   */
  reject(statusCode: number, reason?: string): void {
    if (this.state !== 'pending') return;
    this.state = 'rejected';
    const error = new SipError(statusCode, `INVITE rejected with ${statusCode}`);
    const response = this.buildErrorResponse(statusCode, reason ?? 'Rejected');
    try {
      this.layer.sendResponse(this.transaction.key, response);
    } finally {
      this.fail(error);
    }
  }

  private build200Ok(localSdp: string): SipResponseMessage {
    const headers = new Headers();
    headers.set('Via', this.request.headers.get('Via') ?? makeTopVia(this.viaConfig, makeBranch(this.idGenerator.branch())));
    headers.set('From', this.request.headers.get('From') ?? '');
    headers.set('To', this.localToHeader(this.request));
    headers.set('Call-ID', this.request.headers.get('Call-ID') ?? '');
    headers.set('CSeq', this.request.headers.get('CSeq') ?? '');
    headers.set('Contact', this.contact);
    headers.set('Content-Type', 'application/sdp');

    const encoder = new TextEncoder();
    const body = encoder.encode(localSdp);

    return makeResponse(200, 'OK', headers, body);
  }

  private buildErrorResponse(statusCode: number, reason: string): SipResponseMessage {
    const headers = new Headers();
    headers.set('Via', this.request.headers.get('Via') ?? makeTopVia(this.viaConfig, makeBranch(this.idGenerator.branch())));
    headers.set('From', this.request.headers.get('From') ?? '');
    headers.set('To', this.localToHeader(this.request));
    headers.set('Call-ID', this.request.headers.get('Call-ID') ?? '');
    headers.set('CSeq', this.request.headers.get('CSeq') ?? '');

    return makeResponse(statusCode, reason, headers);
  }

  private localToHeader(request: SipRequestMessage): string {
    const to = request.headers.get('To') ?? '';
    return extractTag(to) === undefined ? `${to};tag=${this.toTag}` : to;
  }

  private startRetransmission(response: SipResponseMessage): void {
    const transport = this.layer.getTransport();

    this.retransmitter = new InviteResponseRetransmitter({
      response,
      transport,
      clock: this.clock,
      T1: this.T1,
      T2: this.T2,
      onTimeout: () => this.onRetransmitTimeout(),
      onError: (error) => this.fail(error),
    });

    this.retransmitter.start();
  }

  private onAckRequest(request: SipRequestMessage): void {
    if (this.dialogValue === undefined) return;

    const callId = request.headers.get('Call-ID');
    const fromTag = extractTag(request.headers.get('From'));
    const toTag = extractTag(request.headers.get('To'));

    if (callId !== this.dialogValue.callId) return;
    if (fromTag !== this.dialogValue.remoteTag) return;
    if (toTag !== this.dialogValue.localTag) return;
    if (!this.dialogValue.matchesRequest(request)) return;

    // ACK matches, stop retransmission and resolve
    this.onAck();
  }

  /** Handle an ACK that has no matching transaction. */
  handleStatelessRequest(request: SipRequestMessage): void {
    if (request.method !== 'ACK') return;
    if (this.dialogValue === undefined) return;

    const callId = request.headers.get('Call-ID');
    const fromTag = extractTag(request.headers.get('From'));
    const toTag = extractTag(request.headers.get('To'));

    if (callId !== this.dialogValue.callId) return;
    if (fromTag !== this.dialogValue.remoteTag) return;
    if (toTag !== this.dialogValue.localTag) return;
    if (!this.dialogValue.matchesRequest(request)) return;

    // ACK matches, stop retransmission and resolve
    this.onAck();
  }


  /** Whether a new server transaction is the same initial INVITE identity. */
  matchesInvite(request: SipRequestMessage): boolean {
    return this.matchesInitialRequest(request, 'INVITE');
  }

  /** Resend the accepted response without creating a second Invitation. */
  handleDuplicateInvite(transaction: ServerTransaction, request: SipRequestMessage): void {
    if (!this.matchesInvite(request)) {
      this.layer.sendResponse(transaction.key, this.buildRequestResponse(request, 481, 'Call/Transaction Does Not Exist'));
      return;
    }
    const response = this.acceptedResponse;
    if ((this.state !== 'accepted' && this.state !== 'confirmed') || response === undefined) return;
    const headers = response.headers.clone();
    headers.set('Via', request.headers.get('Via') ?? '');
    this.layer.sendResponse(
      transaction.key,
      makeResponse(response.statusCode, response.reasonPhrase, headers, response.body),
    );
  }

  handleIncomingRequest(transaction: ServerTransaction, request: SipRequestMessage): void {
    if (this.disposed) return;
    if (request.method === 'ACK') {
      this.onAckRequest(request);
      return;
    }
    if (request.method === 'CANCEL') {
      if (!this.matchesCancel(request)) {
        this.layer.sendResponse(transaction.key, this.buildRequestResponse(request, 481, 'Call/Transaction Does Not Exist'));
        return;
      }
      this.cancel(transaction, request);
      return;
    }
    if (this.dialogValue === undefined) return;
    if (request.method !== 'BYE') {
      this.layer.sendResponse(transaction.key, this.buildRequestResponse(request, 405, 'Method Not Allowed'));
      return;
    }
    if (!this.dialogValue.matchesRequest(request) || !this.dialogValue.receiveRequest(request)) {
      this.layer.sendResponse(transaction.key, this.buildRequestResponse(request, 481, 'Call/Transaction Does Not Exist'));
      return;
    }
    this.settleHangup();
    this.layer.sendResponse(transaction.key, this.buildRequestResponse(request, 200, 'OK'));
  }

  private buildRequestResponse(request: SipRequestMessage, statusCode: number, reason: string): SipResponseMessage {
    const headers = new Headers();
    headers.set('Via', request.headers.get('Via') ?? '');
    headers.set('From', request.headers.get('From') ?? '');
    headers.set('To', this.localToHeader(request));
    headers.set('Call-ID', request.headers.get('Call-ID') ?? '');
    headers.set('CSeq', request.headers.get('CSeq') ?? '');
    return makeResponse(statusCode, reason, headers);
  }

  /** Final shutdown: stop 2xx retransmission and reject a pending answer exactly once. */
  dispose(error: unknown): void {
    if (this.disposed) return;
    this.disposed = true;
    this.state = 'terminated';
    this.teardown();
    const deferred = this.takeAnswerDeferred();
    deferred?.reject(error);
    if (this.session.state !== 'terminated' && this.session.state !== 'failed') {
      this.session.transition('failed', error instanceof Error ? error : new Error(String(error)));
    }
  }

  private matchesCancel(request: SipRequestMessage): boolean {
    return this.matchesInitialRequest(request, 'CANCEL');
  }

  private matchesInitialRequest(request: SipRequestMessage, method: 'INVITE' | 'CANCEL'): boolean {
    if (request.method !== method) return false;
    const requestCSeq = request.headers.get('CSeq')?.trim().match(/^(\d+)\s+(\S+)$/);
    const inviteCSeq = this.request.headers.get('CSeq')?.trim().match(/^(\d+)\s+(\S+)$/);
    const callId = request.headers.get('Call-ID');
    const fromTag = extractTag(request.headers.get('From'));
    return requestCSeq !== undefined
      && requestCSeq !== null
      && inviteCSeq !== undefined
      && inviteCSeq !== null
      && requestCSeq[2] === method
      && inviteCSeq[2] === 'INVITE'
      && requestCSeq[1] === inviteCSeq[1]
      && callId !== undefined
      && callId === this.request.headers.get('Call-ID')
      && fromTag !== undefined
      && fromTag === extractTag(this.request.headers.get('From'))
      && extractTag(request.headers.get('To')) === extractTag(this.request.headers.get('To'));
  }

  private cancel(transaction: ServerTransaction, request: SipRequestMessage): void {
    const response = this.buildRequestResponse(request, 200, 'OK');
    if (this.state !== 'pending' && this.state !== 'answering') {
      this.layer.sendResponse(transaction.key, response);
      return;
    }

    this.state = 'cancelled';
    this.teardown();
    const error = new SipError(487, 'INVITE cancelled');
    const deferred = this.takeAnswerDeferred();
    deferred?.reject(error);

    try {
      this.layer.sendResponse(transaction.key, response);
    } finally {
      try {
        this.layer.sendResponse(this.transaction.key, this.buildErrorResponse(487, 'Request Terminated'));
      } finally {
        this.session.transition('terminated');
      }
    }
  }

  private onAck(): void {
    if (this.state !== 'accepted') return;
    this.state = 'confirmed';
    this.teardown();

    const deferred = this.takeAnswerDeferred();
    deferred?.resolve();
    this.session.transition('confirmed');
  }

  private onRetransmitTimeout(): void {
    this.fail(new SipError(0, 'ACK timeout'));
  }

  private fail(reason: unknown): void {
    this.state = 'terminated';
    this.teardown();
    const deferred = this.takeAnswerDeferred();
    deferred?.reject(reason);
    this.session.transition('failed', reason instanceof Error ? reason : undefined);
  }

  private settleHangup(): void {
    this.state = 'terminated';
    this.teardown();
    const deferred = this.takeAnswerDeferred();
    if (deferred !== undefined) {
      deferred.reject(new SipError(0, 'BYE received before ACK'));
    }
    this.session.transition('terminated');
  }

  private takeAnswerDeferred(): { resolve: () => void; reject: (reason: unknown) => void } | undefined {
    const deferred = this.answerDeferred;
    this.answerDeferred = undefined;
    return deferred;
  }

  private teardown(): void {
    if (this.retransmitter !== undefined) {
      this.retransmitter.stop();
      this.retransmitter = undefined;
    }
    if (this.unsubscribeTransactionEvents !== undefined) {
      this.unsubscribeTransactionEvents();
      this.unsubscribeTransactionEvents = undefined;
    }
  }
}
