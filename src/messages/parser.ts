import { ParseError } from '../errors.js';
import { Headers } from './headers.js';
import type { SipMessage, ParseResult } from './message.js';

/** Maximum header block size: start line + header lines only (RFC 3261, 4.1 / 20). */
const MAX_HEADER_BLOCK = 65536;
/** Maximum message body size (plan constraint, 1 MiB). */
const MAX_BODY = 1048576;
const HEADER_NAME_RE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const COMPACT: Record<string, string> = {
  v: 'Via', f: 'From', t: 'To', i: 'Call-ID', m: 'Contact', l: 'Content-Length', c: 'Content-Type',
};

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8');

function fail<T>(offset: number, message: string): ParseResult<T> {
  return { ok: false, error: new ParseError(offset, message) };
}

function bytesEquals(block: Uint8Array, i: number, seq: Uint8Array): boolean {
  if (i + seq.length > block.length) return false;
  for (let j = 0; j < seq.length; j += 1) if (block[i + j] !== seq[j]) return false;
  return true;
}

/**
 * Parses a single complete SIP message. Never throws: every malformed input
 * produces `{ ok: false, error: ParseError }` with the byte offset of the
 * first offending byte.
 */
export function parseMessage(input: Uint8Array): ParseResult<SipMessage> {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.length === 0) return fail(0, 'empty message');
  const term = findHeaderEnd(bytes);
  if (term === undefined) return fail(0, 'missing header terminator');
  const headerEnd = term.index;
  const termLen = term.len;
  if (headerEnd + termLen > MAX_HEADER_BLOCK) return fail(MAX_HEADER_BLOCK, 'header block too large');

  const headerSlice = bytes.subarray(0, headerEnd);
  const lines = splitLines(headerSlice);
  if (lines.length === 0) return fail(0, 'missing start line');

  const startLine = lines[0]!;
  const startField = startLineType(startLine.text);
  if (startField === 'bad') return fail(startLine.offset, 'malformed start line');

  const rows: Array<{ name: string; value: string }> = [];
  let contentLength: number | undefined;
  let contentLengthOffset = startLine.offset;

  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (line.type === 'blank') continue;
    if (line.type === 'continuation') {
      if (rows.length === 0) return fail(line.offset, 'continuation without a header');
      const unfurled = line.text.replace(/^[ \t]+/, '');
      rows[rows.length - 1]!.value = rows[rows.length - 1]!.value.trimEnd() + ' ' + unfurled.trimStart();
      continue;
    }
    if (line.type === 'invalid') return fail(line.offset, 'malformed header line');
    const colon = line.text.indexOf(':');
    if (colon <= 0) return fail(line.offset, 'malformed header line');
    const rawName = line.text.slice(0, colon);
    if (!HEADER_NAME_RE.test(rawName)) return fail(line.offset, 'malformed header name');
    const lower = rawName.toLowerCase();
    const canonical = COMPACT[lower] ?? (lower === 'content-length' ? 'Content-Length' : rawName);
    const value = line.text.slice(colon + 1).trim();

    if (canonical === 'Content-Length') {
      if (!/^\d+$/.test(value)) return fail(line.offset, 'non-decimal Content-Length');
      const n = Number(value);
      if (contentLength !== undefined && contentLength !== n) {
        return fail(line.offset, 'conflicting Content-Length');
      }
      contentLength = n;
      contentLengthOffset = line.offset;
      continue;
    }
    rows.push({ name: canonical, value });
  }

  const headers = new Headers();
  for (const row of rows) headers.append(row.name, row.value);

  const bodyStart = headerEnd + termLen;
  let bodyEnd = bodyStart;
  if (contentLength !== undefined) {
    if (contentLength > MAX_BODY) return fail(contentLengthOffset, 'body too large');
    if (bytes.length < bodyStart + contentLength) return fail(bytes.length, 'truncated body');
    bodyEnd = bodyStart + contentLength;
    if (bytes.length > bodyEnd) return fail(bodyEnd, 'trailing bytes after message');
  } else if (bytes.length > bodyStart) {
    return fail(bodyStart, 'trailing bytes without Content-Length');
  }
  const body = bytes.slice(bodyStart, bodyEnd);

  if (startField === 'request') {
    const fields = startLine.text.split(' ');
    if (fields.length < 3 || fields[2] !== 'SIP/2.0' || fields[0] === '' || fields[1] === '') {
      return fail(startLine.offset, 'malformed request start line');
    }
    return { ok: true, value: { kind: 'request', method: fields[0]!, uri: fields[1]!, headers, body } };
  }
  const fields = startLine.text.split(' ');
  if (fields.length < 3 || fields[0] !== 'SIP/2.0' || fields[1]!.length !== 3 || fields[1]! < '100') {
    return fail(startLine.offset, 'malformed response start line');
  }
  return { ok: true, value: { kind: 'response', statusCode: Number(fields[1]), reasonPhrase: fields.slice(2).join(' '), headers, body } };
}

function startLineType(s: string): 'request' | 'response' | 'bad' {
  if (s === '') return 'bad';
  if (/^[!#$%&'*+.^_`|~0-9A-Za-z-]+\s/.test(s)) return 'request';
  if (/^SIP\/2\.0\s/.test(s)) return 'response';
  return 'bad';
}

function findHeaderEnd(bytes: Uint8Array): { index: number; len: number } | undefined {
  const crlfcrlf = encoder.encode('\r\n\r\n');
  const lflf = encoder.encode('\n\n');
  for (let i = 0; i < bytes.length; i += 1) if (bytesEquals(bytes, i, crlfcrlf)) return { index: i, len: 4 };
  for (let i = 0; i < bytes.length; i += 1) if (bytesEquals(bytes, i, lflf)) return { index: i, len: 2 };
  return undefined;
}

interface Line { type: 'start' | 'header' | 'continuation' | 'blank' | 'invalid'; text: string; offset: number }

function splitLines(bytes: Uint8Array): Line[] {
  const out: Line[] = [];
  let start = 0;
  let pos = 0;
  while (pos < bytes.length) {
    const at = bytes[pos]!;
    if (at === 13 || at === 10) {
      out.push(classify(decoder.decode(bytes.slice(start, pos)), start));
      if (at === 13 && pos + 1 < bytes.length && bytes[pos + 1] === 10) pos += 1;
      pos += 1;
      start = pos;
    } else {
      pos += 1;
    }
  }
  if (start < pos) out.push(classify(decoder.decode(bytes.slice(start, pos)), start));
  return out;
}

function classify(text: string, byteStart: number): Line {
  if (text === '') return { type: 'blank', text, offset: byteStart };
  if (text.startsWith(' ') || text.startsWith('\t')) return { type: 'continuation', text, offset: byteStart };
  if (text.includes(':') || text.includes(' ')) return { type: 'header', text, offset: byteStart };
  return { type: 'invalid', text, offset: byteStart };
}