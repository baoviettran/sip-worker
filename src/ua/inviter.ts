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

import { Headers, makeRequest, bodyText } from '../messages/index.js';
import type { SipRequestMessage, SipResponseMessage } from '../messages/message.js';
import { SipError } from '../errors.js';
import { makeBranch, extractTag } from '../dialogs/header-values.js';
import { Dialog, type IdGenerator } from '../dialogs/dialog.js';
import type { TransactionLayer } from '../transactions/coordinator.js';
import type { TransactionLayerEvent } from '../transactions/types.js';
import { sendOwnedRequest } from '../transactions/request-ownership.js';
import type { Clock } from '../transport/index.js';
import type { AuthManager, AuthFailure } from '../auth/manager.js';
import type { WorkerMediaController } from '../media/worker-controller.js';
import { Session } from './session.js';
import { DialogSet } from './dialog-set.js';

export interface InviterOptions {
  readonly to: string;
  readonly from: string;
  readonly contact: string;
  readonly viaAddress: string;
  readonly idGenerator: IdGenerator;
  readonly layer: TransactionLayer;
  readonly clock: Clock;
  readonly controller: WorkerMediaController;
  readonly authManager?: AuthManager;
  readonly credentials?: { readonly username: string; readonly password: string };
}

/** Extract the numeric CSeq from a message. */
function cseqNumber(msg: SipRequestMessage | SipResponseMessage): number {
  const cseq = msg.headers.get('CSeq');
  if (cseq === undefined) return 0;
  return Number.parseInt(cseq.trim().split(/\s+/)[0] ?? '', 10);
}

export class Inviter {
  readonly session: Session;
  private readonly to: string;
  private readonly from: string;
  private readonly contact: string;
  private readonly viaAddress: string;
  private readonly idGenerator: IdGenerator;
  private readonly layer: TransactionLayer;
  private readonly controller: WorkerMediaController;
  private readonly authManager?: AuthManager;
  private readonly credentials?: { readonly username: string; readonly password: string };

  private readonly sessionId: string;
  private readonly callId: string;
  private readonly fromTag: string;
  private localCSeq = 1;
  private branchCounter = 0;

  private invitePromise: Promise<void> | undefined;
  private inviteDeferred: { resolve: () => void; reject: (reason: unknown) => void } | undefined;
  private currentRequest: SipRequestMessage | undefined;
  private unsubscribe: (() => void) | undefined;
  private dialogSet: DialogSet | undefined;
  private hangingUp = false;
  private hangupDeferred: { resolve: () => void; reject: (reason: unknown) => void } | undefined;

  constructor(options: InviterOptions) {
    this.session = new Session();
    this.to = options.to;
    this.from = options.from;
    this.contact = options.contact;
    this.viaAddress = options.viaAddress;
    this.idGenerator = options.idGenerator;
    this.layer = options.layer;
    this.controller = options.controller;
    this.authManager = options.authManager;
    this.credentials = options.credentials;

    // Stable per-session identifiers
    this.sessionId = options.idGenerator.branch();
    this.callId = options.idGenerator.branch();
    this.fromTag = options.idGenerator.branch();
  }

  /**
   * Initiate the outgoing INVITE. Single-use: rejects if called twice.
   * Resolves when the call is confirmed (2xx received and ACK sent).
   * Rejects with SipError on non-2xx final, timeout, or transport error.
   */
  invite(): Promise<void> {
    if (this.invitePromise !== undefined) {
      return Promise.reject(new SipError(0, 'invite() already called'));
    }

    this.invitePromise = new Promise<void>((resolve, reject) => {
      this.inviteDeferred = { resolve, reject };
      this.startInvite();
    });

    return this.invitePromise;
  }

  /**
   * Terminate the confirmed call with a BYE. Only valid after invite() resolves.
   * Resolves when the BYE 2xx is received.
   */
  hangup(): Promise<void> {
    if (this.dialog === undefined) {
      return Promise.reject(new SipError(0, 'hangup() called before call was confirmed'));
    }
    if (this.hangingUp) {
      return Promise.reject(new SipError(0, 'hangup() already in progress'));
    }

    this.hangingUp = true;
    this.session.transition('terminating');

    return new Promise<void>((resolve, reject) => {
      this.hangupDeferred = { resolve, reject };
      this.sendBye(this.dialog!);
    });
  }

  /** The selected (application) dialog from the first 2xx response. */
  get dialog(): Dialog | undefined {
    return this.dialogSet?.selectedDialog;
  }

  private async startInvite(): Promise<void> {
    try {
      // Obtain SDP offer FIRST
      const sdp = await this.controller.createOffer(this.sessionId);
      const request = this.buildInviteRequest(sdp);
      this.currentRequest = request;
      this.session.transition('inviting');
      this.sendAttempt(request);
    } catch (err) {
      this.fail(err);
    }
  }

  private buildInviteRequest(sdp: string): SipRequestMessage {
    const headers = new Headers();
    const branch = makeBranch(`inv-${(this.branchCounter += 1)}`);
    headers.set('Via', `SIP/2.0/UDP ${this.viaAddress};branch=${branch}`);
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
    this.teardown();
    const unsubscribeStateless = this.layer.subscribe((event: TransactionLayerEvent) => {
      if (event.type !== 'statelessResponse') return;
      // Repeated or forked 2xx arrive after the INVITE client transaction has
      // terminated, so they have no transaction key. Keep this separate from
      // the exact-key listener and match the dialog-forming identity instead.
      const response = event.response;
      if (
        cseqNumber(response) === cseqNumber(request)
        && response.statusCode >= 200
        && response.statusCode < 300
      ) {
        const callId = response.headers.get('Call-ID');
        const fromTag = extractTag(response.headers.get('From'));
        if (callId === this.callId && fromTag === this.fromTag) {
          void this.onSuccess(response);
        }
      }
    });
    this.unsubscribe = unsubscribeStateless;

    sendOwnedRequest(
      this.layer,
      request,
      (unsubscribeOwned) => {
        this.unsubscribe = () => {
          unsubscribeOwned();
          unsubscribeStateless();
        };
      },
      (event: TransactionLayerEvent) => {
        if (event.type === 'response') {
          this.onResponse(request, event.response);
        } else if (event.type === 'timeout' || event.type === 'transportError') {
          this.fail(new SipError(0, `INVITE ${event.type}`));
        }
      },
    );
  }

  private onResponse(base: SipRequestMessage, response: SipResponseMessage): void {
    // Match responses to this attempt by CSeq
    if (cseqNumber(response) !== cseqNumber(base)) return;

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

    if (code >= 200 && code < 300) {
      this.onSuccess(response);
      return;
    }

    if (code === 401 || code === 407) {
      this.handleAuth(base, response);
      return;
    }

    // Any other 3xx-6xx: fail
    this.fail(new SipError(code, `INVITE rejected with ${code}`));
  }

  private async onSuccess(response: SipResponseMessage): Promise<void> {
    // Lazily create the DialogSet on the first 2xx
    if (this.dialogSet === undefined) {
      this.dialogSet = new DialogSet(
        this.currentRequest!,
        this.idGenerator,
        this.layer.getTransport(),
        (dialog) => this.sendByeForDialog(dialog),
      );
    }

    try {
      await this.dialogSet.handleSuccess(response);
    } catch (err) {
      // Malformed 2xx (missing To tag/Contact) - fail the invite if still pending
      this.fail(err);
      return;
    }

    // Set remote SDP from every 2xx (the selected dialog's answer)
    const sdp = DialogSet.sdpFromBody(response);
    if (sdp.length > 0) {
      void this.controller.setRemote(this.sessionId, sdp);
    }

    // Transition to confirmed and resolve the invite promise once, on the
    // first (selected) dialog. Repeated/forked 2xx produce no state change.
    if (this.session.state !== 'confirmed' && this.dialogSet.hasSelection) {
      this.session.transition('confirmed');
      const deferred = this.inviteDeferred;
      this.inviteDeferred = undefined;
      if (deferred !== undefined) deferred.resolve();
    }
  }

  private handleAuth(base: SipRequestMessage, response: SipResponseMessage): void {
    if (this.authManager === undefined || this.credentials === undefined) {
      this.fail(new SipError(response.statusCode, `${response.statusCode} received but no credentials configured`));
      return;
    }

    const result = this.authManager.retry({
      requestId: `${this.callId}:${cseqNumber(base)}`,
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
   * Send a BYE for the selected (application) dialog from hangup(). Replaces
   * the INVITE listener with a BYE listener, transitions to terminated on a
   * 2xx, and settles the hangup promise.
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
    const bye = dialog.createRequest('BYE');
    return new Promise<void>((resolve, reject) => {
      let unsubscribe = (): void => {};
      try {
        sendOwnedRequest(
          this.layer,
          bye,
          (next) => { unsubscribe = next; },
          (event: TransactionLayerEvent) => {
            if (event.type === 'response') {
              if (cseqNumber(event.response) === cseqNumber(bye)) {
                const code = event.response.statusCode;
                if (code >= 200 && code < 300) {
                  unsubscribe();
                  resolve();
                } else if (code >= 300) {
                  unsubscribe();
                  reject(new SipError(code, `BYE rejected with ${code}`));
                }
              }
            } else if (event.type === 'timeout' || event.type === 'transportError') {
              unsubscribe();
              reject(new SipError(0, `BYE ${event.type}`));
            }
          },
        );
      } catch (err) {
        unsubscribe();
        reject(err);
      }
    });
  }

  private attachByeListener(request: SipRequestMessage): void {
    this.teardown();
    sendOwnedRequest(
      this.layer,
      request,
      (unsubscribe) => {
        this.unsubscribe = unsubscribe;
      },
      (event: TransactionLayerEvent) => {
        if (event.type === 'response') {
          if (cseqNumber(event.response) === cseqNumber(request)) {
            const code = event.response.statusCode;
            if (code >= 200 && code < 300) {
              this.session.transition('terminated');
              this.settleHangup();
            } else if (code >= 300) {
              this.failHangup(new SipError(code, `BYE rejected with ${code}`));
            }
          }
        } else if (event.type === 'timeout' || event.type === 'transportError') {
          this.failHangup(new SipError(0, `BYE ${event.type}`));
        }
      },
    );
  }

  private fail(reason: unknown): void {
    this.teardown();
    this.session.transition('failed', reason instanceof Error ? reason : undefined);
    const deferred = this.inviteDeferred;
    this.inviteDeferred = undefined;
    if (deferred !== undefined) deferred.reject(reason);
  }

  private settleHangup(): void {
    this.teardown();
    const deferred = this.hangupDeferred;
    this.hangupDeferred = undefined;
    if (deferred !== undefined) deferred.resolve();
  }

  private failHangup(reason: unknown): void {
    this.teardown();
    const deferred = this.hangupDeferred;
    this.hangupDeferred = undefined;
    if (deferred !== undefined) deferred.reject(reason);
  }

  private teardown(): void {
    if (this.unsubscribe !== undefined) {
      this.unsubscribe();
      this.unsubscribe = undefined;
    }
  }
}

function isAuthFailure(result: SipRequestMessage | AuthFailure): result is AuthFailure {
  return (result as { type?: string }).type !== undefined;
}
