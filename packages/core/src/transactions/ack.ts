import { Headers } from '../messages/headers.js';
import type { SipRequestMessage, SipResponseMessage } from '../messages/message.js';

/** The RFC 3261 magic cookie that must appear in the top Via branch. */
export const MAGIC_COOKIE = 'z9hG4bK';

/** Last whitespace-separated token of CSeq is the method; undefined if absent. */
export function cseqMethod(response: SipResponseMessage): string | undefined {
  const cseq = response.headers.get('CSeq');
  if (cseq === undefined) return undefined;
  const parts = cseq.trim().split(/\s+/);
  return parts[parts.length - 1];
}

/**
 * Build a non-2xx ACK for a client INVITE transaction (RFC 3261 17.1.1.3).
 *
 * Copies the request URI, the top Via (the whole Via header), Route, From,
 * Call-ID, Max-Forwards and the numeric CSeq; replaces To from the final
 * response; drops the body and content headers and any other request headers;
 * sets method/CSeq method to ACK. The ACK carries only this RFC-required set.
 */
export function buildNon2xxAck(request: SipRequestMessage, response: SipResponseMessage): SipRequestMessage {
  const headers = new Headers();
  const copy = (name: string): void => {
    const v = request.headers.get(name);
    if (v !== undefined) headers.append(name, v);
  };
  for (const name of ['Route', 'From', 'Call-ID', 'Max-Forwards', 'Via']) copy(name);
  headers.set('To', response.headers.get('To') ?? '');
  const cseq = request.headers.get('CSeq');
  const number = cseq === undefined ? '' : cseq.trim().split(/\s+/)[0] ?? '';
  headers.set('CSeq', `${number} ACK`);
  return { kind: 'request', method: 'ACK', uri: request.uri, headers, body: new Uint8Array() };
}
