import { extractAddressUri, extractTag } from '../dialogs/header-values.js';
import type { SipRequestMessage, SipResponseMessage } from '../messages/message.js';

interface CSeqIdentity {
  readonly number: number;
  readonly method: string;
}

function parseCSeq(value: string | undefined): CSeqIdentity | undefined {
  if (value === undefined) return undefined;
  const match = value.trim().match(/^(\d+)\s+(\S+)$/);
  if (match === null) return undefined;
  const number = Number(match[1]);
  if (!Number.isSafeInteger(number)) return undefined;
  return { number, method: match[2]! };
}

/**
 * Validate a response against the full identity of its originating request.
 * Transaction-key routing is necessary but not sufficient: callers must use
 * this guard before any response-driven retry, settlement, or state mutation.
 */
export function responseMatchesRequestIdentity(
  request: SipRequestMessage,
  response: SipResponseMessage,
): boolean {
  const requestCallId = request.headers.get('Call-ID');
  const responseCallId = response.headers.get('Call-ID');
  if (
    requestCallId === undefined
    || requestCallId.trim() === ''
    || responseCallId === undefined
    || responseCallId.trim() === ''
    || responseCallId !== requestCallId
  ) return false;

  const requestFromTag = extractTag(request.headers.get('From'));
  const responseFromTag = extractTag(response.headers.get('From'));
  if (requestFromTag === undefined || responseFromTag !== requestFromTag) return false;

  const requestToUri = extractAddressUri(request.headers.get('To'));
  const responseToUri = extractAddressUri(response.headers.get('To'));
  if (requestToUri === undefined || responseToUri !== requestToUri) return false;

  const requestToTag = extractTag(request.headers.get('To'));
  const responseToTag = extractTag(response.headers.get('To'));
  if (responseToTag === undefined) {
    // A 100 Trying for an initial request legitimately has no To tag. Treat
    // the shared absence as the validated identity; all later responses tag it.
    if (response.statusCode !== 100 || requestToTag !== undefined) return false;
  } else if (requestToTag !== undefined && responseToTag !== requestToTag) {
    return false;
  }

  const requestCSeq = parseCSeq(request.headers.get('CSeq'));
  const responseCSeq = parseCSeq(response.headers.get('CSeq'));
  return requestCSeq !== undefined
    && responseCSeq !== undefined
    && requestCSeq.number === responseCSeq.number
    && requestCSeq.method === request.method
    && responseCSeq.method === request.method;
}
