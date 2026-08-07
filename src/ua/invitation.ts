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
import type { TransactionLayerEvent, ServerTransaction } from '../transactions/types.js';
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

  private readonly sessionId: string;
  private readonly remoteSdp: string;

  private answerDeferred: { resolve: () => void; reject: (reason: unknown) => void } | undefined;
  private unsubscribe: (() => void) | undefined;
  private dialog: Dialog | undefined;
  private retransmitter: InviteResponseRetransmitter | undefined;
  readonly toTag: string;

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
    return new Promise<void>((resolve, reject) => {
      this.answerDeferred = { resolve, reject };
      this.doAnswer(localSdp);
    });
  }

  private async doAnswer(localSdp: string): Promise<void> {
    try {
      // Set remote SDP
      await this.controller.setRemote(this.sessionId, this.remoteSdp);

      // Build 200 OK response
      const response = this.build200Ok(localSdp);

      // Send via transaction layer
      this.layer.sendResponse(this.transaction.key, response);

      // Create dialog from UAS perspective
      this.dialog = Dialog.fromUas(this.request, response, this.idGenerator);

      // Start 2xx retransmission and listen for ACK/BYE
      this.startListening(response);
    } catch (err) {
      this.fail(err);
    }
  }

  /**
   * Reject the INVITE with a 4xx/5xx/6xx response. No retransmission.
   */
  reject(statusCode: number, reason?: string): void {
    const response = this.buildErrorResponse(statusCode, reason ?? 'Rejected');
    this.layer.sendResponse(this.transaction.key, response);
    this.fail(new SipError(statusCode, `INVITE rejected with ${statusCode}`));
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

  private startListening(response: SipResponseMessage): void {
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

    // Listen for ACK (both stateless and matched to INVITE transaction) and BYE
    this.unsubscribe = this.layer.subscribe((event: TransactionLayerEvent) => {
      if (event.type === 'statelessRequest') {
        this.onStatelessRequest(event.request);
      } else if (event.type === 'request') {
        // ACK can arrive as a regular request if it matches the INVITE transaction
        if (event.request.method === 'ACK') {
          this.onAckRequest(event.request);
        } else {
          this.onInDialogRequest(event.transaction, event.request);
        }
      }
    });
  }

  private onAckRequest(request: SipRequestMessage): void {
    if (this.dialog === undefined) return;

    const callId = request.headers.get('Call-ID');
    const fromTag = extractTag(request.headers.get('From'));
    const toTag = extractTag(request.headers.get('To'));

    if (callId !== this.dialog.callId) return;
    if (fromTag !== this.dialog.remoteTag) return;
    if (toTag !== this.dialog.localTag) return;

    // ACK matches, stop retransmission and resolve
    this.onAck();
  }

  private onStatelessRequest(request: SipRequestMessage): void {
    if (request.method !== 'ACK') return;
    if (this.dialog === undefined) return;

    const callId = request.headers.get('Call-ID');
    const fromTag = extractTag(request.headers.get('From'));
    const toTag = extractTag(request.headers.get('To'));

    if (callId !== this.dialog.callId) return;
    if (fromTag !== this.dialog.remoteTag) return;
    if (toTag !== this.dialog.localTag) return;

    // ACK matches, stop retransmission and resolve
    this.onAck();
  }

  private onInDialogRequest(transaction: ServerTransaction, request: SipRequestMessage): void {
    if (this.dialog === undefined) return;

    const callId = request.headers.get('Call-ID');
    if (callId !== this.dialog.callId) return;

    if (request.method === 'BYE') {
      // Send 200 OK for BYE
      const response = this.buildByeResponse(request);
      this.layer.sendResponse(transaction.key, response);
      this.settleHangup();
    }
  }

  private buildByeResponse(request: SipRequestMessage): SipResponseMessage {
    const headers = new Headers();
    headers.set('Via', request.headers.get('Via') ?? '');
    headers.set('From', request.headers.get('From') ?? '');
    headers.set('To', request.headers.get('To') ?? '');
    headers.set('Call-ID', request.headers.get('Call-ID') ?? '');
    headers.set('CSeq', request.headers.get('CSeq') ?? '');

    return makeResponse(200, 'OK', headers);
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
    if (this.unsubscribe !== undefined) {
      this.unsubscribe();
      this.unsubscribe = undefined;
    }
  }
}
