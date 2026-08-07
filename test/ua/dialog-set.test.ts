import { describe, it, expect, beforeEach } from 'vitest';
import { DialogSet } from '../../src/ua/dialog-set.js';
import { Dialog } from '../../src/dialogs/dialog.js';
import { Headers } from '../../src/messages/headers.js';
import { makeRequest, makeResponse } from '../../src/messages/message.js';
import { SipError } from '../../src/errors.js';

describe('DialogSet', () => {
  let dialogSet: DialogSet;
  let mockInviter: any;

  beforeEach(() => {
    mockInviter = {
      sendBye: async () => {},
      cachedAckBytes: new Uint8Array([1, 2, 3]),
      transport: {
        send: async () => {},
      },
      layer: {
        getTransport: () => mockInviter.transport,
      },
    };
    dialogSet = new DialogSet(mockInviter);
  });

  function createInviteRequest() {
    const headers = new Headers();
    headers.set('Call-ID', 'test-call-id');
    headers.set('From', '<sip:alice@example.com>;tag=local-tag');
    headers.set('To', '<sip:bob@example.com>');
    headers.set('CSeq', '1 INVITE');
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

  describe('handleSuccess', () => {
    it('should reject 2xx without To tag', async () => {
      const request = createInviteRequest();
      const response = createResponse(undefined);

      await expect(dialogSet.handleSuccess(request, response)).rejects.toThrow(SipError);
    });

    it('should reject 2xx without Contact', async () => {
      const request = createInviteRequest();
      const response = createResponse('tag-a', false);

      await expect(dialogSet.handleSuccess(request, response)).rejects.toThrow(SipError);
    });

    it('should select first dialog and send ACK', async () => {
      const request = createInviteRequest();
      const response = createResponse('tag-a');

      let ackSent = false;
      mockInviter.transport.send = async (bytes: Uint8Array) => {
        ackSent = true;
        expect(bytes).toEqual(mockInviter.cachedAckBytes);
      };

      await dialogSet.handleSuccess(request, response);

      expect(ackSent).toBe(true);
      expect(dialogSet.selectedTag).toBe('tag-a');
      expect(dialogSet.dialogs.size).toBe(1);
    });

    it('should resend cached ACK for repeated 2xx with same tag', async () => {
      const request = createInviteRequest();
      const response = createResponse('tag-a');

      let sendCount = 0;
      mockInviter.transport.send = async () => {
        sendCount++;
      };

      await dialogSet.handleSuccess(request, response);
      await dialogSet.handleSuccess(request, response);

      expect(sendCount).toBe(2);
      expect(dialogSet.selectedTag).toBe('tag-a');
      expect(dialogSet.dialogs.size).toBe(1);
    });

    it('should ACK and BYE additional dialogs with different tags', async () => {
      const request = createInviteRequest();
      const responseA = createResponse('tag-a');
      const responseB = createResponse('tag-b');

      let byeCalled = false;
      mockInviter.sendBye = async (dialog: Dialog) => {
        byeCalled = true;
        expect(dialog.remoteTag).toBe('tag-b');
      };

      await dialogSet.handleSuccess(request, responseA);
      await dialogSet.handleSuccess(request, responseB);

      expect(byeCalled).toBe(true);
      expect(dialogSet.selectedTag).toBe('tag-a');
      expect(dialogSet.dialogs.size).toBe(2);
    });

    it('should only BYE each additional dialog once', async () => {
      const request = createInviteRequest();
      const responseA = createResponse('tag-a');
      const responseB = createResponse('tag-b');

      let byeCount = 0;
      mockInviter.sendBye = async () => {
        byeCount++;
      };

      await dialogSet.handleSuccess(request, responseA);
      await dialogSet.handleSuccess(request, responseB);
      await dialogSet.handleSuccess(request, responseB);

      expect(byeCount).toBe(1);
    });
  });

  describe('selectedDialog', () => {
    it('should return undefined when no dialog is selected', () => {
      expect(dialogSet.selectedDialog).toBeUndefined();
    });

    it('should return the selected dialog', async () => {
      const request = createInviteRequest();
      const response = createResponse('tag-a');

      await dialogSet.handleSuccess(request, response);

      expect(dialogSet.selectedDialog).toBeDefined();
      expect(dialogSet.selectedDialog?.remoteTag).toBe('tag-a');
    });
  });
});
