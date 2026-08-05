/**
 * Mock registrar for integration tests.
 *
 * Delivers responses SYNCHRONOUSLY from the transport `onSend` hook so the
 * response reaches the registrar before `transport.send` resolves. This proves
 * branch tracking and ingress are installed BEFORE the first byte goes out.
 *
 * Supports: 401 challenge → 2xx, 423 (Min-Expires), arbitrary status codes,
 * and unregister (Contact `*`).
 *
 * Tracks challenged requests by Call-ID so retries (which carry new branches
 * but incremented CSeqs) aren't re-challenged, breaking the recursion.
 */

import { Headers } from '../../src/messages/index.js';
import { parseMessage } from '../../src/messages/parser.js';
import { serializeMessage } from '../../src/messages/serializer.js';
import type { SipRequestMessage, SipResponseMessage } from '../../src/messages/message.js';
import { makeResponse } from '../../src/messages/message.js';
import type { FakeTransport } from '../support/fake-transport.js';

const REALM = 'example.com';
const NONCE = 'dcd98b7102dd2f0e8b11d0f600bfb0c093';

export interface MockRegistrarOptions {
  readonly transport: FakeTransport;
  /** Challenge the first request per (Call-ID, CSeq) with 401 before granting. */
  readonly challenge?: boolean;
  /** Response-level Expires for 2xx grants. */
  readonly expires?: number;
  /** 423 Min-Expires value (sent instead of the challenge when set). */
  readonly minExpires?: number;
}

type RequestKey = string; // Call-ID only

function requestKey(request: SipRequestMessage): RequestKey {
  return request.headers.get('Call-ID') ?? '';
}

export class MockRegistrar {
  readonly requests: SipRequestMessage[] = [];
  private readonly transport: FakeTransport;
  private readonly challenge: boolean;
  private readonly expires?: number;
  private readonly minExpires?: number;
  private readonly challengedKeys = new Set<RequestKey>();
  private readonly minExpiredKeys = new Set<RequestKey>();
  private respond = true;
  private previousOnSend?: (bytes: Uint8Array) => void;

  constructor(options: MockRegistrarOptions) {
    this.transport = options.transport;
    this.challenge = options.challenge ?? false;
    this.expires = options.expires;
    this.minExpires = options.minExpires;
  }

  /** Wire the onSend hook. Must be called after the UA's ingress is started. */
  start(): void {
    this.previousOnSend = this.transport.onSend;
    this.transport.onSend = (bytes) => {
      this.previousOnSend?.(bytes);
      this.handleSend(bytes);
    };
  }

  /** Silence the mock: subsequent sends receive no response. */
  setResponding(value: boolean): void {
    this.respond = value;
  }

  stop(): void {
    this.transport.onSend = this.previousOnSend;
    this.previousOnSend = undefined;
  }

  private handleSend(bytes: Uint8Array): void {
    const parsed = parseMessage(bytes);
    if (!parsed.ok) return;
    const message = parsed.value;
    if (message.kind !== 'request' || message.method !== 'REGISTER') return;
    this.requests.push(message);
    if (!this.respond) return;

    const key = requestKey(message);
    const isUnregister = message.headers.get('Contact') === '*';

    if (this.minExpires !== undefined && !this.minExpiredKeys.has(key)) {
      this.minExpiredKeys.add(key);
      this.deliver(this.buildResponse(message, 423, 'Interval Too Brief', isUnregister, { minExpires: this.minExpires }));
      return;
    }
    if (this.challenge && !this.challengedKeys.has(key) && !isUnregister) {
      this.challengedKeys.add(key);
      this.deliver(this.buildResponse(message, 401, 'Unauthorized', isUnregister, { challenge: true }));
      return;
    }
    this.deliver(this.buildResponse(message, 200, 'OK', isUnregister));
  }

  private buildResponse(
    request: SipRequestMessage,
    status: number,
    reason: string,
    isUnregister: boolean,
    over: { challenge?: boolean; minExpires?: number } = {},
  ): SipResponseMessage {
    const headers = new Headers();
    headers.set('Via', request.headers.get('Via') ?? '');
    headers.set('From', request.headers.get('From') ?? '');
    headers.set('To', request.headers.get('To') ?? '');
    headers.set('Call-ID', request.headers.get('Call-ID') ?? '');
    headers.set('CSeq', request.headers.get('CSeq') ?? '');
    if (isUnregister) {
      headers.set('Contact', '*');
    } else {
      let contact = '<sip:alice@192.0.2.1:5060>';
      if (this.expires !== undefined) contact += `;expires=${this.expires}`;
      headers.set('Contact', contact);
      if (this.expires !== undefined) headers.set('Expires', String(this.expires));
    }
    if (over.challenge === true) {
      headers.set('WWW-Authenticate', `Digest realm="${REALM}", nonce="${NONCE}", qop="auth", algorithm=SHA-256`);
    }
    if (over.minExpires !== undefined) headers.set('Min-Expires', String(over.minExpires));
    return makeResponse(status, reason, headers);
  }

  private deliver(response: SipResponseMessage): void {
    const bytes = serializeMessage(response);
    // Deliver synchronously to prove branch tracking and ingress are installed
    // BEFORE the first byte goes out.
    this.transport.emitData(bytes);
  }
}
