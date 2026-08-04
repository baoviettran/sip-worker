import { ParseError } from '../errors.js';
import type { ParseResult } from '../messages/message.js';
import { MAX_BODY, MAX_HEADER_BLOCK } from '../messages/parser.js';

const CRLFCRLF = '\r\n\r\n';
const LFLF = '\n\n';
const DIGITS_RE = /^\d+$/;
const decoder = new TextDecoder('utf-8');

function failAt<T>(offset: number, message: string): ParseResult<T> {
  return { ok: false, error: new ParseError(offset, message) };
}

/**
 * Frames a TCP byte stream into complete SIP messages.
 *
 * The decoder needs only a Content-Length to find message boundaries; it never
 * delegates to the full message parser for framing, but it reuses the parser's
 * header-block and body limits so oversized input fails fast. Bytes are
 * buffered across pushes; each emitted message is a copied slice, so the caller
 * owns it. Malformed or oversized input returns a ParseError and resets the
 * decoder, leaving it usable again.
 */
export class SipStreamDecoder {
  private rx: Uint8Array<ArrayBuffer> = new Uint8Array();
  /** Total length of the frame currently being received; undefined while the header is still incomplete. */
  private frameLen?: number;

  push(chunk: Uint8Array): ParseResult<Uint8Array[]> {
    const input = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
    if (this.rx.length + input.length > MAX_HEADER_BLOCK + MAX_BODY + 4) {
      return this.failAndReset(0, 'stream buffer too large');
    }
    this.rx = this.rx.length === 0 ? input.slice() : this.append(input);
    const out: Uint8Array[] = [];

    while (this.rx.length > 0) {
      if (this.frameLen === undefined) {
        const term = findTerminator(this.rx);
        if (term === undefined) {
          if (this.rx.length >= MAX_HEADER_BLOCK) {
            return this.failAndReset(0, 'header block too large');
          }
          break; // wait for more header bytes
        }
        const headerEnd = term.index + term.len;
        if (headerEnd > MAX_HEADER_BLOCK) {
          return this.failAndReset(0, 'header block too large');
        }
        const parsed = contentLength(this.rx.subarray(0, term.index));
        if (!parsed.ok) return this.failAndReset(parsed.error.offset, parsed.error.message);
        if (parsed.value.len > MAX_BODY) {
          return this.failAndReset(parsed.value.offset, 'body too large');
        }
        this.frameLen = headerEnd + parsed.value.len;
      }
      // Body accounting: count buffered octets against the declared length
      // without ever decoding body bytes.
      if (this.rx.length >= this.frameLen) {
        out.push(this.rx.slice(0, this.frameLen));
        this.rx = this.rx.subarray(this.frameLen);
        this.frameLen = undefined;
      } else {
        break; // wait for the remaining body octets
      }
    }
    return { ok: true, value: out };
  }

  reset(): void {
    this.rx = new Uint8Array();
    this.frameLen = undefined;
  }

  private append(extra: Uint8Array): Uint8Array<ArrayBuffer> {
    const out = new Uint8Array(this.rx.byteLength + extra.byteLength);
    out.set(this.rx, 0);
    out.set(extra, this.rx.byteLength);
    return out;
  }

  private failAndReset(offset: number, message: string): ParseResult<Uint8Array[]> {
    this.reset();
    return failAt(offset, message);
  }
}

function findTerminator(bytes: Uint8Array): { index: number; len: number } | undefined {
  const text = decoder.decode(bytes);
  const crlf = text.indexOf(CRLFCRLF);
  if (crlf >= 0) return { index: crlf, len: 4 };
  const lf = text.indexOf(LFLF);
  if (lf >= 0) return { index: lf, len: 2 };
  return undefined;
}

/**
 * Scans only the header prefix for a Content-Length. Repeats the parser's
 * rules for the length field alone: decimal token only, repeated values must
 * agree numerically. Returns the length and the byte offset of its header
 * line, mirroring the parser's error offsets. The start line and any field
 * other than Content-Length are skipped so framing needs no message grammar.
 */
function contentLength(header: Uint8Array): ParseResult<{ len: number; offset: number }> {
  const text = decoder.decode(header);
  let first: { len: number; offset: number } | undefined;

  const lines = splitLines(text);
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i]!;
    const raw = line.value;
    if (raw === '' || raw.startsWith(' ') || raw.startsWith('\t')) continue;
    const colon = raw.indexOf(':');
    if (colon <= 0) continue;
    const name = raw.slice(0, colon).trim();
    if (name === '') continue;
    const lower = name.toLowerCase();
    if (lower !== 'content-length' && lower !== 'l') continue;

    const value = raw.slice(colon + 1).trim();
    if (!DIGITS_RE.test(value)) return failAt(line.offset, 'non-decimal Content-Length');
    const len = Number(value);
    if (first !== undefined && first.len !== len) return failAt(line.offset, 'conflicting Content-Length');
    if (first === undefined) first = { len, offset: line.offset };
  }
  return { ok: true, value: first ?? { len: 0, offset: 0 } };
}

interface Line { value: string; offset: number }

function splitLines(text: string): Line[] {
  const out: Line[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    const at = text[i];
    if (at === '\r' || at === '\n') {
      out.push({ value: text.slice(start, i), offset: start });
      if (at === '\r' && i + 1 < text.length && text[i + 1] === '\n') i += 1;
      start = i + 1;
    }
  }
  if (start < text.length) out.push({ value: text.slice(start), offset: start });
  return out;
}
