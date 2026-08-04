import type { SipMessage } from './message.js';

const HEADER_NAME_RE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const INJECT_RE = /[\r\n]/;
const METHOD_RE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const CRLF = '\r\n';
const encoder = new TextEncoder();

/**
 * Serializes a message to wire bytes. This is the one codec operation allowed
 * to throw: a message with CR/LF in a start-line or header field is a
 * programmer error (header injection), not malformed input.
 */
export function serializeMessage(message: SipMessage): Uint8Array {
  let startLine: string;

  if (message.kind === 'request') {
    if (!METHOD_RE.test(message.method)) {
      throw new Error(`invalid method: must be a token without whitespace or CR/LF: ${JSON.stringify(message.method)}`);
    }
    if (message.uri === '' || /\s/.test(message.uri)) {
      throw new Error(`invalid URI: must be non-empty with no whitespace: ${JSON.stringify(message.uri)}`);
    }
    if (INJECT_RE.test(message.uri)) {
      throw new Error('header injection: CR/LF in URI');
    }
    startLine = `${message.method} ${message.uri} SIP/2.0`;
  } else {
    if (!Number.isInteger(message.statusCode) || message.statusCode < 100 || message.statusCode > 699) {
      throw new Error(`invalid status code: must be integer 100-699: ${message.statusCode}`);
    }
    if (INJECT_RE.test(message.reasonPhrase)) {
      throw new Error('header injection: CR/LF in reason phrase');
    }
    startLine = `SIP/2.0 ${message.statusCode} ${message.reasonPhrase}`;
  }

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
