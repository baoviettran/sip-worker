import type { SipRequestMessage, SipResponseMessage } from '../messages/message.js';

/** The RFC 3261 magic cookie that must appear in the top Via branch. */
export const MAGIC_COOKIE = 'z9hG4bK';

/**
 * Build a non-2xx ACK for a client INVITE transaction (RFC 3261 17.1.1.3).
 *
 * Copies the request URI, the top Via (the whole Via header), Route, From,
 * Call-ID, Max-Forwards and the numeric CSeq; replaces To from the final
 * response; drops the body and content headers; sets method/CSeq method to ACK.
 */
export function buildNon2xxAck(request: SipRequestMessage, response: SipResponseMessage): SipRequestMessage {
  const headers = request.headers.clone();
  headers.set('To', response.headers.get('To') ?? '');
  headers.delete('Content-Type');
  headers.delete('Content-Length');
  const cseq = request.headers.get('CSeq');
  const number = cseq === undefined ? '' : cseq.trim().split(/\s+/)[0] ?? '';
  headers.set('CSeq', `${number} ACK`);
  return { kind: 'request', method: 'ACK', uri: request.uri, headers, body: new Uint8Array() };
}