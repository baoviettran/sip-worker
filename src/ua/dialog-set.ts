import { Dialog } from '../dialogs/dialog.js';
import type { SipRequestMessage, SipResponseMessage } from '../messages/message.js';
import { SipError } from '../errors.js';
import { extractTag } from '../dialogs/header-values.js';

/**
 * Manages multiple dialogs created from forked INVITE responses.
 *
 * Per RFC 3261, when an INVITE forks, multiple 2xx responses may arrive with
 * different To tags. The first 2xx selects the "application dialog" that the
 * application interacts with. Additional dialogs are ACKed (to stop retransmissions)
 * then immediately terminated with BYE.
 *
 * The DialogSet tracks:
 * - All dialogs by their remote To tag
 * - Which dialog is "selected" (the first one)
 * - Which additional dialogs have already been cleaned up (BYEd)
 */
export class DialogSet {
  private readonly dialogs = new Map<string, Dialog>();
  private readonly cleanupStarted = new Set<string>();
  private selectedTag: string | undefined;

  constructor(
    private readonly inviter: {
      sendBye: (dialog: Dialog) => Promise<void>;
      cachedAckBytes: Uint8Array;
      layer: { getTransport: () => { send: (bytes: Uint8Array) => Promise<void> } };
    }
  ) {}

  /**
   * Handle a 2xx response to the INVITE.
   *
   * - First 2xx: creates the dialog, sends ACK, marks it as selected
   * - Repeated 2xx with same tag: resends cached ACK
   * - 2xx with different tag: creates dialog, sends ACK, sends BYE
   *
   * Rejects if the response lacks a To tag or Contact header.
   */
  async handleSuccess(request: SipRequestMessage, response: SipResponseMessage): Promise<void> {
    // Extract remote To tag
    const toHeader = response.headers.get('To');
    if (!toHeader) {
      throw new SipError(400, '2xx response missing To header');
    }
    const remoteTag = extractTag(toHeader);
    if (!remoteTag) {
      throw new SipError(400, '2xx response missing To tag');
    }

    // Extract Contact for dialog construction
    const contact = response.headers.get('Contact');
    if (!contact) {
      throw new SipError(400, '2xx response missing Contact header');
    }

    // Check if we already have this dialog
    const existing = this.dialogs.get(remoteTag);
    if (existing) {
      // Repeated 2xx for existing dialog - resend cached ACK
      const transport = this.inviter.layer.getTransport();
      await transport.send(this.inviter.cachedAckBytes);
      return;
    }

    // Create new dialog
    const dialog = Dialog.fromUac(request, response, {
      callId: () => request.headers.get('Call-ID') || '',
      localTag: () => extractTag(request.headers.get('From') || '') || '',
      remoteTag: () => remoteTag,
    });

    // Send ACK
    const transport = this.inviter.layer.getTransport();
    await transport.send(this.inviter.cachedAckBytes);

    // Store dialog
    this.dialogs.set(remoteTag, dialog);

    // If this is the first dialog, select it
    if (this.selectedTag === undefined) {
      this.selectedTag = remoteTag;
      return;
    }

    // Additional dialog - clean it up with BYE (but only once)
    if (!this.cleanupStarted.has(remoteTag)) {
      this.cleanupStarted.add(remoteTag);
      await this.inviter.sendBye(dialog);
    }
  }

  /**
   * Get the selected dialog (the first 2xx that arrived).
   */
  get selectedDialog(): Dialog | undefined {
    if (this.selectedTag === undefined) return undefined;
    return this.dialogs.get(this.selectedTag);
  }

  /**
   * Get the remote To tag of the selected dialog.
   */
  get selectedTagValue(): string | undefined {
    return this.selectedTag;
  }

  /**
   * Get all dialogs in the set.
   */
  get allDialogs(): Dialog[] {
    return Array.from(this.dialogs.values());
  }
}
