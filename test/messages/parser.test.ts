import { describe, it, expect } from 'vitest';
import { parseMessage } from '../../src/messages/parser.js';
import { isRequest, isResponse } from '../../src/messages/message.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8');

function okBody(bytes: Uint8Array): Uint8Array {
  const r = parseMessage(bytes);
  if (!r.ok) throw new Error(`expected ok, got ${r.error.message} at ${r.error.offset}`);
  return r.value.body;
}

describe('parseMessage', () => {
  it('parses a minimal request with CRLF', () => {
    const r = parseMessage(encoder.encode('OPTIONS sip:b SIP/2.0\r\n\r\n'));
    if (!r.ok) throw new Error(r.error.message);
    expect(isRequest(r.value)).toBe(true);
    if (isRequest(r.value)) {
      expect(r.value.method).toBe('OPTIONS');
      expect(r.value.uri).toBe('sip:b');
      expect(r.value.body.byteLength).toBe(0);
    }
  });

  it('tolerates lone LF line endings', () => {
    const r = parseMessage(encoder.encode('OPTIONS sip:b SIP/2.0\n\n'));
    if (!r.ok) throw new Error(r.error.message);
    expect(isRequest(r.value)).toBe(true);
  });

  it('parses a response', () => {
    const r = parseMessage(encoder.encode('SIP/2.0 200 OK\r\n\r\n'));
    if (!r.ok) throw new Error(r.error.message);
    expect(isResponse(r.value)).toBe(true);
    if (isResponse(r.value)) {
      expect(r.value.statusCode).toBe(200);
      expect(r.value.reasonPhrase).toBe('OK');
    }
  });

  it('unfolds folded (continuation) headers', () => {
    const r = parseMessage(encoder.encode('SIP/2.0 200 OK\r\nVia: SIP/2.0/UDP host\r\n\tfirst\r\n second\r\n\r\n'));
    if (!r.ok) throw new Error(r.error.message);
    expect(r.value.headers.get('Via')).toBe('SIP/2.0/UDP host first second');
  });

  it('normalizes compact form headers', () => {
    const r = parseMessage(encoder.encode('INVITE sip:b SIP/2.0\r\nv: x\r\nf: a\r\nt: b\r\ni: 1\r\nm: c\r\nl: 0\r\nc: d\r\n\r\n'));
    if (!r.ok) throw new Error(r.error.message);
    expect(r.value.headers.get('Via')).toBe('x');
    expect(r.value.headers.get('From')).toBe('a');
    expect(r.value.headers.get('To')).toBe('b');
    expect(r.value.headers.get('Call-ID')).toBe('1');
    expect(r.value.headers.get('Contact')).toBe('c');
    expect(r.value.headers.get('Content-Type')).toBe('d');
  });

  it('parses IPv6 bracket hosts in the URI', () => {
    const r = parseMessage(encoder.encode('INVITE sip:b@[2001:db8::1]:5060 SIP/2.0\r\n\r\n'));
    if (!r.ok) throw new Error(r.error.message);
    if (isRequest(r.value)) expect(r.value.uri).toBe('sip:b@[2001:db8::1]:5060');
  });

  it('keeps quoted commas inside a header value', () => {
    const r = parseMessage(encoder.encode('SIP/2.0 200 OK\r\nContact: <sip:a@x>, <sip:b@y>;tag="a,b"\r\n\r\n'));
    if (!r.ok) throw new Error(r.error.message);
    expect(r.value.headers.get('Contact')).toBe('<sip:a@x>, <sip:b@y>;tag="a,b"');
  });

  it('accepts repeated equal Content-Length values', () => {
    const r = parseMessage(encoder.encode('MESSAGE sip:b SIP/2.0\r\nContent-Length: 5\r\nContent-Length: 5\r\n\r\nhello'));
    if (!r.ok) throw new Error(r.error.message);
    expect(decoder.decode(r.value.body)).toBe('hello');
  });

  it('rejects conflicting Content-Length values', () => {
    const r = parseMessage(encoder.encode('MESSAGE sip:b SIP/2.0\r\nContent-Length: 5\r\nContent-Length: 6\r\n\r\nhello'));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.offset).toBeGreaterThanOrEqual(0);
  });

  it('uses body octets rather than decoded string length', () => {
    const wire = encoder.encode('MESSAGE sip:b SIP/2.0\r\nContent-Length: 5\r\n\r\ncafé');
    const result = parseMessage(wire);
    expect(result.ok && result.value.body.byteLength).toBe(5);
  });

  it('copies exactly the declared body bytes', () => {
    const body = okBody(encoder.encode('MESSAGE sip:b SIP/2.0\r\nContent-Length: 11\r\n\r\nhello world'));
    expect(decoder.decode(body)).toBe('hello world');
  });

  it('rejects a truncated body shorter than declared', () => {
    const r = parseMessage(encoder.encode('MESSAGE sip:b SIP/2.0\r\nContent-Length: 11\r\n\r\nhello'));
    expect(r.ok).toBe(false);
  });

  it('rejects a declared body above the maximum', () => {
    const r = parseMessage(encoder.encode(`MESSAGE sip:b SIP/2.0\r\nContent-Length: 1048577\r\n\r\nx`));
    expect(r.ok).toBe(false);
  });

  it('rejects an oversized header block (65,537 bytes)', () => {
    const pad = 'a'.repeat(65537);
    const r = parseMessage(encoder.encode(`OPTIONS sip:b SIP/2.0\r\nX-Filler: ${pad}\r\n\r\n`));
    expect(r.ok).toBe(false);
  });

  it('rejects a malformed request start line', () => {
    const r = parseMessage(encoder.encode('NOTAVALID\r\n\r\n'));
    expect(r.ok).toBe(false);
  });

  it('rejects a malformed response start line', () => {
    const r = parseMessage(encoder.encode('SIP/2.0 NOCODE\r\n\r\n'));
    expect(r.ok).toBe(false);
  });

  it('rejects a response with a non-numeric 3-digit status code', () => {
    const r = parseMessage(encoder.encode('SIP/2.0 1a0 OK\r\n\r\n'));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.offset).toBe(0);
      expect(Number.isInteger(r.error.offset)).toBe(true);
    }
  });

  it('rejects a response status code outside the 100-699 range', () => {
    expect(parseMessage(encoder.encode('SIP/2.0 099 OK\r\n\r\n')).ok).toBe(false);
    expect(parseMessage(encoder.encode('SIP/2.0 700 OK\r\n\r\n')).ok).toBe(false);
  });

  it('rejects a non-decimal Content-Length token', () => {
    const r = parseMessage(encoder.encode('MESSAGE sip:b SIP/2.0\r\nContent-Length: abc\r\n\r\n'));
    expect(r.ok).toBe(false);
  });

  it('returns a trailing-byte error for a single message with extra bytes', () => {
    const r = parseMessage(encoder.encode('OPTIONS sip:b SIP/2.0\r\n\r\njunk'));
    expect(r.ok).toBe(false);
  });

  it('never throws across 10,000 malformed byte inputs', () => {
    const bytes = new Uint8Array(64);
    for (let i = 0; i < 10000; i += 1) {
      for (let j = 0; j < bytes.length; j += 1) bytes[j] = Math.floor(Math.random() * 256);
      expect(() => parseMessage(bytes)).not.toThrow();
    }
  });
});