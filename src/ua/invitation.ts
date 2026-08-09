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
import { extractTag } from '../dialogs/header-values.js';
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
  readonly viaAddress: string;
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
  private readonly viaAddress: string;
  private readonly idGenerator: IdGenerator;
  private readonly layer: TransactionLayer;
  private readonly clock: Clock;
  private readonly controller: WorkerMediaController;
  private readonly T1: number;
  private readonly T2: number;
  private readonly onDialogCreated: ((dialog: Dialog) => void) | undefined;

  private state: 'pending' | 'answering' | 'accepted' | 'rejected' | 'cancelled' = 'pending';
  private readonly sessionId: string;
  private readonly remoteSdp: string;

  private answerDeferred: { resolve: () => void; reject: (reason: unknown) => void } | undefined;
  private dialogValue: Dialog | undefined;
  private acceptedResponse: SipResponseMessage | undefined;
  private retransmitter: InviteResponseRetransmitter | undefined;
  readonly toTag: string;

  get dialog(): Dialog | undefined {
    return this.dialogValue;
  }
  constructor(options: InvitationOptions) {
    this.session = new Session();
    this.request = options.request;
    this.transaction = options.transaction;
    this.contact = options.contact;
    this.viaAddress = options.viaAddress;
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
  }

  /**
   * Answer the INVITE with 200 OK and local SDP. Starts 2xx retransmission.
   * Resolves when the call is confirmed (ACK received).
   * Rejects on ACK timeout (64*T1) or transport error.
   */
  answer(localSdp: string): Promise<void> {
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
      this.dialogValue = Dialog.fromUas(this.request, response, this.idGenerator);
      this.state = 'accepted';
      this.onDialogCreated?.(this.dialogValue);

      // Send via transaction layer
      this.layer.sendResponse(this.transaction.key, response);

      // Start TU-owned 2xx retransmission; the UA routes dialog requests.
      this.startRetransmission(response);
    } catch (err) {
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
    headers.set('Via', this.request.headers.get('Via') ?? `SIP/2.0/UDP ${this.viaAddress}`);
    headers.set('From', this.request.headers.get('From') ?? '');
    headers.set('To', `${this.request.headers.get('To') ?? ''};tag=${this.toTag}`);
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
    headers.set('Via', this.request.headers.get('Via') ?? `SIP/2.0/UDP ${this.viaAddress}`);
    headers.set('From', this.request.headers.get('From') ?? '');
    headers.set('To', this.request.headers.get('To') ?? '');
    headers.set('Call-ID', this.request.headers.get('Call-ID') ?? '');
    headers.set('CSeq', this.request.headers.get('CSeq') ?? '');

    return makeResponse(statusCode, reason, headers);
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
    if (this.state !== 'accepted' || response === undefined) return;
    const headers = response.headers.clone();
    headers.set('Via', request.headers.get('Via') ?? '');
    this.layer.sendResponse(
      transaction.key,
      makeResponse(response.statusCode, response.reasonPhrase, headers, response.body),
    );
  }

  handleIncomingRequest(transaction: ServerTransaction, request: SipRequestMessage): void {
    if (request.method === 'ACK') {
      this.onAckRequest(request);
      return;
    }
    if (request.method === 'CANCEL') {
      if (!this.matchesCancel(request)) {
        this.layer.sendResponse(transaction.key, this.buildRequestResponse(request, 481, 'Call/Transaction Does Not Exist'));
        return;
      }
      this.layer.sendResponse(transaction.key, this.buildRequestResponse(request, 200, 'OK'));
      this.cancel();
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
    this.layer.sendResponse(transaction.key, this.buildRequestResponse(request, 200, 'OK'));
    this.settleHangup();
  }

  private buildRequestResponse(request: SipRequestMessage, statusCode: number, reason: string): SipResponseMessage {
    const headers = new Headers();
    headers.set('Via', request.headers.get('Via') ?? '');
    headers.set('From', request.headers.get('From') ?? '');
    headers.set('To', request.headers.get('To') ?? '');
    headers.set('Call-ID', request.headers.get('Call-ID') ?? '');
    headers.set('CSeq', request.headers.get('CSeq') ?? '');
    return makeResponse(statusCode, reason, headers);
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

  private cancel(): void {
    if (this.state !== 'pending' && this.state !== 'answering') return;
    this.state = 'cancelled';
    const error = new SipError(487, 'INVITE cancelled');
    try {
      this.layer.sendResponse(this.transaction.key, this.buildErrorResponse(487, 'Request Terminated'));
    } finally {
      this.teardown();
      this.session.transition('terminated');
      const deferred = this.answerDeferred;
      this.answerDeferred = undefined;
      if (deferred !== undefined) deferred.reject(error);
    }
  }

  private onAck(): void {
    if (this.retransmitter !== undefined) {
      this.retransmitter.stop();
      this.retransmitter = undefined;
    }

    this.session.transition('confirmed');
    const deferred = this.answerDeferred;
    this.answerDeferred = undefined;
    if (deferred !== undefined) deferred.resolve();
  }

  private onRetransmitTimeout(): void {
    this.fail(new SipError(0, 'ACK timeout'));
  }

  private fail(reason: unknown): void {
    this.teardown();
    this.session.transition('failed', reason instanceof Error ? reason : undefined);
    const deferred = this.answerDeferred;
    this.answerDeferred = undefined;
    if (deferred !== undefined) deferred.reject(reason);
  }

  private settleHangup(): void {
    this.teardown();
    this.session.transition('terminated');
  }

  private teardown(): void {
    if (this.retransmitter !== undefined) {
      this.retransmitter.stop();
      this.retransmitter = undefined;
    }
  }
}
