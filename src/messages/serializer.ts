import type { SipMessage } from './message.js';

const HEADER_NAME_RE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const INJECT_RE = /[\r\n]/;
const CRLF = '\r\n';
const encoder = new TextEncoder();

/**
 * Serializes a message to wire bytes. This is the one codec operation allowed
 * to throw: a message with CR/LF in a start-line or header field is a
 * programmer error (header injection), not malformed input.
 */
export function serializeMessage(message: SipMessage): Uint8Array {
  const startLine =
    message.kind === 'request'
      ? `${message.method} ${message.uri} SIP/2.0`
      : `SIP/2.0 ${message.statusCode} ${message.reasonPhrase}`;
  if (INJECT_RE.test(startLine)) throw new Error('header injection: CR/LF in start line');

  let res = startLine + CRLF;
  for (const [name, value] of message.headers.entries()) {
    if (!HEADER_NAME_RE.test(name)) throw new Error(`invalid header name: ${JSON.stringify(name)}`);
    if (INJECT_RE.test(value)) throw new Error('header injection: CR/LF in header value');
    const lower = name.toLowerCase();
    if (lower === 'content-length' || lower === 'l') continue; // canonical length replaces any existing
    res += name + ': ' + value + CRLF;
  }
  res += 'Content-Length: ' + message.body.length + CRLF + CRLF;

  const head = encoder.encode(res);
  const out = new Uint8Array(head.length + message.body.length);
  out.set(head, 0);
  out.set(message.body, head.length);
  return out;
}
