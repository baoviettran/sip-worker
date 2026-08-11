import { Dialog, type IdGenerator } from '../dialogs/dialog.js';
import type { ViaConfig } from '../dialogs/header-values.js';
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

/** Whether a handled 2xx selected a newly created application dialog. */
export interface DialogSuccessResult {
  readonly selected: boolean;
  readonly created: boolean;
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
  /** Whether the external dialog-routing owner has been released. */
  ownerReleased: boolean;
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
    private readonly viaConfig: ViaConfig,
    private readonly transport: DialogSetTransport,
    private readonly sendByeFn: SendByeFn,
    private readonly onDialogCreated: (dialog: Dialog) => void = () => {},
    private readonly onDialogReleased: (dialog: Dialog) => void = () => {},
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
  async handleSuccess(response: SipResponseMessage): Promise<DialogSuccessResult> {
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
      const selected = remoteTag === this.selectedTag;
      try {
        await this.transport.send(existing.ackBytes);
      } catch (error) {
        if (selected) throw error;
      }
      return { selected, created: false };
    }

    // New dialog from this 2xx. Each fork has a distinct To tag, so generate
    // ACK bytes specific to this dialog (its To header carries this tag).
    const dialog = Dialog.fromUac(this.request, response, this.idGenerator, this.viaConfig);
    const ack = dialog.createAck(response);
    const ackBytes = serializeMessage(ack);
    const record: DialogRecord = {
      dialog,
      ackBytes,
      cleanupStarted: false,
      ownerReleased: false,
    };

    // Publish every dialog and its owner before ACK I/O, which may synchronously
    // deliver an in-dialog request through the peer transport.
    const selected = this.selectedTag === undefined;
    this.dialogs.set(remoteTag, record);
    if (selected) this.selectedTag = remoteTag;
    this.onDialogCreated(dialog);

    try {
      await this.transport.send(ackBytes);
    } catch (error) {
      if (selected) throw error;
    }
    if (selected) return { selected: true, created: true };

    // Additional forked dialog - clean it up with BYE (but only once)
    if (!record.cleanupStarted) {
      record.cleanupStarted = true;
      try {
        await this.sendByeFn(dialog);
        this.releaseOwner(record);
      } catch {
        // Retain routing until a remote BYE or the accepted lifetime expires.
      }
    }
    return { selected: false, created: true };
  }

  /** Match and accept an in-dialog request across selected and extra forks. */
  receiveRequest(request: SipRequestMessage): { dialog: Dialog; selected: boolean } | undefined {
    for (const [tag, record] of this.dialogs) {
      if (!record.dialog.matchesRequest(request)) continue;
      if (!record.dialog.receiveRequest(request)) return undefined;
      if (request.method === 'BYE') {
        record.cleanupStarted = true;
        this.releaseOwner(record);
      }
      return { dialog: record.dialog, selected: tag === this.selectedTag };
    }
    return undefined;
  }

  /** Release retained extra-fork owners when the INVITE accepted lifetime ends. */
  expireExtraOwners(): void {
    for (const [tag, record] of this.dialogs) {
      if (tag !== this.selectedTag) this.releaseOwner(record);
    }
  }

  /** Release a published routing owner exactly once when its dialog ends. */
  private releaseOwner(record: DialogRecord): void {
    if (record.ownerReleased) return;
    record.ownerReleased = true;
    try {
      this.onDialogReleased(record.dialog);
    } catch {
      // Internal ownership cleanup must not affect SIP settlement.
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
