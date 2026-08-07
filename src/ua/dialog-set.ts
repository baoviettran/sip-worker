import { Dialog, type IdGenerator } from '../dialogs/dialog.js';
import type { SipRequestMessage, SipResponseMessage } from '../messages/message.js';
import { serializeMessage } from '../messages/serializer.js';
import { bodyText } from '../messages/message.js';
import { SipError } from '../errors.js';
import { extractTag } from '../dialogs/header-values.js';

/**
 * Callback the DialogSet uses to terminate an extra (forked) dialog with BYE.
 * Resolves when the BYE 2xx is received.
 */
export type SendByeFn = (dialog: Dialog) => Promise<void>;

/** A transport surface narrow enough for DialogSet to send ACK bytes directly. */
export interface DialogSetTransport {
  send(bytes: Uint8Array): Promise<void>;
}

/**
 * Record for a single dialog established from a forked 2xx response.
 *
 * Each forked dialog has a distinct To tag, so its ACK's To header differs.
 * The ACK bytes are serialized once and cached for byte-identical resend on
 * repeated 2xx responses for the same dialog.
 */
interface DialogRecord {
  readonly dialog: Dialog;
  readonly ackBytes: Uint8Array;
  /** Whether a BYE has already been sent for this (extra) dialog. */
  cleanupStarted: boolean;
}

/**
 * Manages multiple dialogs created from forked INVITE responses.
 *
 * Per RFC 3261, when an INVITE forks, multiple 2xx responses may arrive with
 * different To tags. The first 2xx selects the "application dialog" that the
 * application interacts with. Additional dialogs are ACKed (to stop
 * retransmissions) then immediately terminated with BYE.
 *
 * The DialogSet tracks:
 * - All dialogs keyed by their remote To tag, each with its own cached ACK
 * - Which dialog is "selected" (the first 2xx to arrive)
 * - Which additional dialogs have already been cleaned up (BYEd)
 *
 * Per-dialog ACK bytes are generated from each dialog's To tag, so a forked
 * dialog B receives an ACK whose To header matches dialog B, not dialog A.
 */
export class DialogSet {
  private readonly dialogs = new Map<string, DialogRecord>();
  private selectedTag: string | undefined;

  constructor(
    private readonly request: SipRequestMessage,
    private readonly idGenerator: IdGenerator,
    private readonly transport: DialogSetTransport,
    private readonly sendByeFn: SendByeFn,
  ) {}

  /**
   * Handle a 2xx response to the INVITE.
   *
   * - First 2xx: creates the dialog, sends ACK, marks it as selected
   * - Repeated 2xx with same tag: resends that dialog's cached ACK
   * - 2xx with a different tag: creates dialog, sends its ACK, sends BYE
   *
   * Rejects if the response lacks a To tag.
   */
  async handleSuccess(response: SipResponseMessage): Promise<void> {
    // Extract remote To tag
    const toHeader = response.headers.get('To');
    if (!toHeader) {
      throw new SipError(400, '2xx response missing To header');
    }
    const remoteTag = extractTag(toHeader);
    if (!remoteTag) {
      throw new SipError(400, '2xx response missing To tag');
    }

    // A 2xx INVITE response must carry a Contact (RFC 3261 12.1.1)
    const contact = response.headers.get('Contact');
    if (!contact) {
      throw new SipError(400, '2xx response missing Contact header');
    }

    // Repeated 2xx for an existing dialog - resend that dialog's cached ACK
    const existing = this.dialogs.get(remoteTag);
    if (existing !== undefined) {
      await this.transport.send(existing.ackBytes);
      return;
    }

    // New dialog from this 2xx. Each fork has a distinct To tag, so generate
    // ACK bytes specific to this dialog (its To header carries this tag).
    const dialog = Dialog.fromUac(this.request, response, this.idGenerator);
    const ack = dialog.createAck(response);
    const ackBytes = serializeMessage(ack);

    // Send the dialog-specific ACK
    await this.transport.send(ackBytes);

    const record: DialogRecord = { dialog, ackBytes, cleanupStarted: false };
    this.dialogs.set(remoteTag, record);

    // First dialog selects the application dialog
    if (this.selectedTag === undefined) {
      this.selectedTag = remoteTag;
      return;
    }

    // Additional forked dialog - clean it up with BYE (but only once)
    if (!record.cleanupStarted) {
      record.cleanupStarted = true;
      await this.sendByeFn(dialog);
    }
  }

  /** The selected dialog (the first 2xx that arrived), or undefined. */
  get selectedDialog(): Dialog | undefined {
    if (this.selectedTag === undefined) return undefined;
    return this.dialogs.get(this.selectedTag)?.dialog;
  }

  /** The remote To tag of the selected dialog, or undefined. */
  get selectedTagValue(): string | undefined {
    return this.selectedTag;
  }

  /** All dialogs in the set. */
  get allDialogs(): Dialog[] {
    return Array.from(this.dialogs.values()).map((r) => r.dialog);
  }

  /** Whether any dialog has been selected yet. */
  get hasSelection(): boolean {
    return this.selectedTag !== undefined;
  }

  /** The SDP body carried by a 2xx response (for media wiring). */
  static sdpFromBody(response: SipResponseMessage): string {
    return bodyText(response);
  }
}
