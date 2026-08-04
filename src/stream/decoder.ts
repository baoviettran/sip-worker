import { ParseError } from '../errors.js';
import type { ParseResult } from '../messages/message.js';
import { MAX_BODY, MAX_HEADER_BLOCK } from '../messages/parser.js';

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
        // Check pending buffer size after consuming a complete frame
        if (this.rx.length > MAX_HEADER_BLOCK + MAX_BODY + 4) {
          return this.failAndReset(0, 'stream buffer too large');
        }
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

/**
 * Finds the earliest header terminator (\r\n\r\n or \n\n) directly in bytes.
 * Returns true byte offsets, never decoded-string indices.
 */
function findTerminator(bytes: Uint8Array): { index: number; len: number } | undefined {
  for (let i = 0; i + 1 < bytes.length; i += 1) {
    if (bytes[i] === 0x0d && i + 3 < bytes.length && bytes[i + 1] === 0x0a && bytes[i + 2] === 0x0d && bytes[i + 3] === 0x0a) {
      return { index: i, len: 4 };
    }
    if (bytes[i] === 0x0a && bytes[i + 1] === 0x0a) {
      return { index: i, len: 2 };
    }
  }
  return undefined;
}

/**
 * Scans only the header prefix for a Content-Length. Unfolds continuation lines
 * before interpreting the value, matching the parser's rules: decimal token only,
 * repeated values must agree numerically. All offsets are true byte offsets.
 */
function contentLength(header: Uint8Array): ParseResult<{ len: number; offset: number }> {
  const lines = splitHeaderLines(header);
  const unfolded = unfoldHeaderLines(lines);
  let first: { len: number; offset: number } | undefined;

  for (const line of unfolded) {
    if (line.value.length === 0) continue;
    const colon = line.value.indexOf(':');
    if (colon <= 0) continue;
    const name = line.value.slice(0, colon).trim();
    if (name === '') continue;
    const lower = name.toLowerCase();
    if (lower !== 'content-length' && lower !== 'l') continue;

    const value = line.value.slice(colon + 1).trim();
    if (!DIGITS_RE.test(value)) return failAt(line.byteOffset, 'non-decimal Content-Length');
    const len = Number(value);
    if (first !== undefined && first.len !== len) return failAt(line.byteOffset, 'conflicting Content-Length');
    if (first === undefined) first = { len, offset: line.byteOffset };
  }
  return { ok: true, value: first ?? { len: 0, offset: 0 } };
}

interface HeaderLine { value: string; byteOffset: number }

function splitHeaderLines(bytes: Uint8Array): HeaderLine[] {
  const out: HeaderLine[] = [];
  let start = 0;
  let pos = 0;
  while (pos < bytes.length) {
    const at = bytes[pos]!;
    if (at === 13 || at === 10) {
      out.push({ value: decoder.decode(bytes.slice(start, pos)), byteOffset: start });
      if (at === 13 && pos + 1 < bytes.length && bytes[pos + 1] === 10) pos += 1;
      pos += 1;
      start = pos;
    } else {
      pos += 1;
    }
  }
  if (start < pos) out.push({ value: decoder.decode(bytes.slice(start, pos)), byteOffset: start });
  return out;
}

function unfoldHeaderLines(lines: HeaderLine[]): HeaderLine[] {
  const out: HeaderLine[] = [];
  for (const line of lines) {
    if (line.value.startsWith(' ') || line.value.startsWith('\t')) {
      if (out.length === 0) continue;
      out[out.length - 1]!.value = out[out.length - 1]!.value.trimEnd() + ' ' + line.value.trimStart();
    } else {
      out.push(line);
    }
  }
  return out;
}
