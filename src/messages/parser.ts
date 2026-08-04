import { ParseError } from '../errors.js';
import { Headers } from './headers.js';
import type { SipMessage, ParseResult } from './message.js';

/** Maximum header block size: start line + header lines only (RFC 3261, 4.1 / 20). */
export const MAX_HEADER_BLOCK = 65536;
/** Maximum message body size (plan constraint, 1 MiB). */
export const MAX_BODY = 1048576;
const HEADER_NAME_RE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const COMPACT: Record<string, string> = {
  v: 'Via', f: 'From', t: 'To', i: 'Call-ID', m: 'Contact', l: 'Content-Length', c: 'Content-Type',
};

const decoder = new TextDecoder('utf-8');
const HEADER_NAME_CHAR_RE = /[!#$%&'*+.^_`|~0-9A-Za-z-]/;

function fail<T>(offset: number, message: string): ParseResult<T> {
  return { ok: false, error: new ParseError(offset, message) };
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

  const rows: Array<{ name: string; value: string; offset: number; valueOffset: number }> = [];

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
    if (!HEADER_NAME_RE.test(rawName)) {
      for (let j = 0; j < rawName.length; j += 1) {
        if (!HEADER_NAME_CHAR_RE.test(rawName[j]!)) {
          return fail(line.offset + j, 'malformed header name');
        }
      }
      return fail(line.offset, 'malformed header name');
    }
    const lower = rawName.toLowerCase();
    const canonical = COMPACT[lower] ?? (lower === 'content-length' ? 'Content-Length' : rawName);
    const afterColon = line.text.slice(colon + 1);
    const leadingSpaces = afterColon.length - afterColon.trimStart().length;
    const value = afterColon.trim();
    const valueOffset = line.offset + colon + 1 + leadingSpaces;
    rows.push({ name: canonical, value, offset: line.offset, valueOffset });
  }

  let contentLength: number | undefined;
  let contentLengthOffset = startLine.offset;

  for (const row of rows) {
    if (row.name === 'Content-Length') {
      if (!/^\d+$/.test(row.value)) return fail(row.valueOffset, 'non-decimal Content-Length');
      const n = Number(row.value);
      if (contentLength !== undefined && contentLength !== n) {
        return fail(row.valueOffset, 'conflicting Content-Length');
      }
      contentLength = n;
      contentLengthOffset = row.valueOffset;
    }
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
    if (fields.length !== 3 || fields[2] !== 'SIP/2.0' || fields[0] === '' || fields[1] === '') {
      return fail(startLine.offset, 'malformed request start line');
    }
    if (!HEADER_NAME_RE.test(fields[0]!)) {
      return fail(startLine.offset, 'malformed request method');
    }
    if (/\s/.test(fields[1]!)) {
      return fail(startLine.offset, 'malformed request URI');
    }
    return { ok: true, value: { kind: 'request', method: fields[0]!, uri: fields[1]!, headers, body } };
  }
  const fields = startLine.text.split(' ');
  if (fields.length < 3 || fields[0] !== 'SIP/2.0') {
    return fail(startLine.offset, 'malformed response start line');
  }
  const codeField = fields[1]!;
  if (!/^\d{3}$/.test(codeField)) {
    const badByteOffset = startLine.offset + 8 + (/^\d{0,2}/.exec(codeField)?.[0].length ?? 0);
    return fail(badByteOffset, 'malformed response status code');
  }
  const code = Number(codeField);
  if (code < 100 || code > 699) return fail(startLine.offset + 8, 'response status code out of range');
  const reasonPhrase = fields.slice(2).join(' ');
  if (/[\r\n]/.test(reasonPhrase)) {
    return fail(startLine.offset, 'malformed response reason phrase');
  }
  return { ok: true, value: { kind: 'response', statusCode: code, reasonPhrase, headers, body } };
}

function startLineType(s: string): 'request' | 'response' | 'bad' {
  if (s === '') return 'bad';
  if (/^[!#$%&'*+.^_`|~0-9A-Za-z-]+\s/.test(s)) return 'request';
  if (/^SIP\/2\.0\s/.test(s)) return 'response';
  return 'bad';
}

/**
 * Finds the earliest header terminator (\r\n\r\n or \n\n) directly in bytes.
 * Returns true byte offsets, never decoded-string indices.
 */
function findHeaderEnd(bytes: Uint8Array): { index: number; len: number } | undefined {
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