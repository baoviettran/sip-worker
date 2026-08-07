import { describe, it, expect, beforeEach } from 'vitest';
import { DialogSet } from '../../src/ua/dialog-set.js';
import { Dialog } from '../../src/dialogs/dialog.js';
import { Headers } from '../../src/messages/headers.js';
import { makeRequest, makeResponse } from '../../src/messages/message.js';
import { parseMessage } from '../../src/messages/parser.js';
import { SipError } from '../../src/errors.js';

describe('DialogSet', () => {
  let sentBytes: Uint8Array[] = [];
  let transport: { send: (bytes: Uint8Array) => Promise<void> };
  let sendByeCalls: Dialog[] = [];
  let idGenerator: { branch: () => string };
  let dialogSet: DialogSet;

  beforeEach(() => {
    sentBytes = [];
    transport = {
      send: async (bytes: Uint8Array) => {
        sentBytes.push(bytes.slice());
      },
    };
    sendByeCalls = [];
    let n = 0;
    idGenerator = { branch: () => `ack-${(n += 1)}` };
    dialogSet = new DialogSet(
      createInviteRequest(),
      idGenerator,
      transport,
      async (dialog: Dialog) => {
        sendByeCalls.push(dialog);
      },
    );
  });

  function createInviteRequest() {
    const headers = new Headers();
    headers.set('Call-ID', 'test-call-id');
    headers.set('From', '<sip:alice@example.com>;tag=local-tag');
    headers.set('To', '<sip:bob@example.com>');
    headers.set('CSeq', '1 INVITE');
    headers.set('Max-Forwards', '70');
    return makeRequest('INVITE', 'sip:bob@example.com', headers);
  }

  function createResponse(toTag: string | undefined, hasContact = true) {
    const headers = new Headers();
    headers.set('Call-ID', 'test-call-id');
    headers.set('From', '<sip:alice@example.com>;tag=local-tag');
    if (toTag !== undefined) {
      headers.set('To', `<sip:bob@example.com>;tag=${toTag}`);
    } else {
      headers.set('To', '<sip:bob@example.com>');
    }
    headers.set('CSeq', '1 INVITE');
    if (hasContact) {
      headers.set('Contact', '<sip:bob@192.0.2.1>');
    }
    return makeResponse(200, 'OK', headers);
  }

  /** Parse a sent ACK's To header tag. */
  function ackToTag(bytes: Uint8Array): string | undefined {
    const parsed = parseMessage(bytes);
    if (!parsed.ok || parsed.value.kind !== 'request' || parsed.value.method !== 'ACK') return undefined;
    const to = parsed.value.headers.get('To');
    if (!to) return undefined;
    const match = to.match(/;tag=([^;,\s]+)/);
    return match?.[1];
  }

  describe('handleSuccess', () => {
    it('should reject 2xx without To tag', async () => {
      const response = createResponse(undefined);
      await expect(dialogSet.handleSuccess(response)).rejects.toThrow(SipError);
    });

    it('should reject 2xx without Contact', async () => {
      const response = createResponse('tag-a', false);
      await expect(dialogSet.handleSuccess(response)).rejects.toThrow(SipError);
    });

    it('should select first dialog and send ACK with that dialog To tag', async () => {
      const response = createResponse('tag-a');
      await dialogSet.handleSuccess(response);

      expect(sentBytes.length).toBe(1);
      expect(ackToTag(sentBytes[0]!)).toBe('tag-a');
      expect(dialogSet.selectedTagValue).toBe('tag-a');
      expect(dialogSet.allDialogs.length).toBe(1);
      expect(dialogSet.hasSelection).toBe(true);
    });

    it('should resend the same dialog cached ACK for repeated 2xx with same tag', async () => {
      const response = createResponse('tag-a');
      await dialogSet.handleSuccess(response);
      await dialogSet.handleSuccess(response);

      expect(sentBytes.length).toBe(2);
      // Both ACKs are byte-identical (cached resend for the same dialog)
      expect(Buffer.from(sentBytes[0]!).equals(Buffer.from(sentBytes[1]!))).toBe(true);
      expect(ackToTag(sentBytes[1]!)).toBe('tag-a');
      expect(dialogSet.allDialogs.length).toBe(1);
    });

    it('should ACK and BYE additional dialogs with different To tags', async () => {
      const responseA = createResponse('tag-a');
      const responseB = createResponse('tag-b');

      await dialogSet.handleSuccess(responseA);
      await dialogSet.handleSuccess(responseB);

      // Two ACKs sent: one per dialog, each with its own To tag
      expect(sentBytes.length).toBe(2);
      expect(ackToTag(sentBytes[0]!)).toBe('tag-a');
      expect(ackToTag(sentBytes[1]!)).toBe('tag-b');
      // The two ACK bytes differ (different To headers)
      expect(Buffer.from(sentBytes[0]!).equals(Buffer.from(sentBytes[1]!))).toBe(false);

      // BYE was called for the second (extra) dialog, not the first
      expect(sendByeCalls.length).toBe(1);
      expect(sendByeCalls[0]!.remoteTag).toBe('tag-b');
      expect(dialogSet.selectedTagValue).toBe('tag-a');
      expect(dialogSet.allDialogs.length).toBe(2);
    });

    it('should only BYE each additional dialog once', async () => {
      const responseA = createResponse('tag-a');
      const responseB = createResponse('tag-b');

      await dialogSet.handleSuccess(responseA);
      await dialogSet.handleSuccess(responseB);
      await dialogSet.handleSuccess(responseB);

      // Repeated 2xx for tag-b resends its cached ACK, no second BYE
      expect(sendByeCalls.length).toBe(1);
      expect(sentBytes.length).toBe(3);
      expect(ackToTag(sentBytes[2]!)).toBe('tag-b');
    });

    it('should handle three forks: first selected, rest ACKed and BYEd', async () => {
      const responseA = createResponse('tag-a');
      const responseB = createResponse('tag-b');
      const responseC = createResponse('tag-c');

      await dialogSet.handleSuccess(responseA);
      await dialogSet.handleSuccess(responseB);
      await dialogSet.handleSuccess(responseC);

      expect(sentBytes.length).toBe(3);
      expect(ackToTag(sentBytes[0]!)).toBe('tag-a');
      expect(ackToTag(sentBytes[1]!)).toBe('tag-b');
      expect(ackToTag(sentBytes[2]!)).toBe('tag-c');
      expect(sendByeCalls.length).toBe(2);
      expect(sendByeCalls[0]!.remoteTag).toBe('tag-b');
      expect(sendByeCalls[1]!.remoteTag).toBe('tag-c');
      expect(dialogSet.selectedTagValue).toBe('tag-a');
      expect(dialogSet.allDialogs.length).toBe(3);
    });
  });

  describe('selectedDialog', () => {
    it('should return undefined when no dialog is selected', () => {
      expect(dialogSet.selectedDialog).toBeUndefined();
      expect(dialogSet.hasSelection).toBe(false);
    });

    it('should return the selected dialog', async () => {
      const response = createResponse('tag-a');
      await dialogSet.handleSuccess(response);

      expect(dialogSet.selectedDialog).toBeDefined();
      expect(dialogSet.selectedDialog?.remoteTag).toBe('tag-a');
    });
  });

  describe('per-dialog ACK bytes (bug fix)', () => {
    it('should generate ACK bytes specific to each dialog To tag', async () => {
      const responseA = createResponse('tag-a');
      const responseB = createResponse('tag-b');

      await dialogSet.handleSuccess(responseA);
      await dialogSet.handleSuccess(responseB);

      // Each ACK carries the matching To tag - not a single shared byte set
      expect(ackToTag(sentBytes[0]!)).toBe('tag-a');
      expect(ackToTag(sentBytes[1]!)).toBe('tag-b');
    });

    it('should produce a syntactically valid ACK request', async () => {
      const response = createResponse('tag-a');
      await dialogSet.handleSuccess(response);

      const parsed = parseMessage(sentBytes[0]!);
      expect(parsed.ok).toBe(true);
      if (parsed.ok && parsed.value.kind === 'request') {
        expect(parsed.value.method).toBe('ACK');
        expect(parsed.value.headers.get('Call-ID')).toBe('test-call-id');
        expect(parsed.value.headers.get('CSeq')).toBe('1 ACK');
      }
    });
  });
});
