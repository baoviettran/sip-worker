import { describe, it, expect } from 'vitest';
import { serializeMessage } from '../../src/messages/serializer.js';
import { parseMessage } from '../../src/messages/parser.js';
import { makeRequest, makeResponse } from '../../src/messages/message.js';
import { Headers } from '../../src/messages/headers.js';

const decoder = new TextDecoder('utf-8');
const encoder = new TextEncoder();

describe('serializeMessage', () => {
  it('serializes one Content-Length', () => {
    const h = new Headers(); h.append('Content-Length', '99'); h.append('l', '88');
    const wire = decoder.decode(serializeMessage(makeRequest('OPTIONS', 'sip:b', h)));
    expect(wire.match(/content-length/gi)).toHaveLength(1);
  });

  it('emits a canonical Content-Length from body bytes', () => {
    const h = new Headers(); h.append('Content-Length', '99'); h.append('l', '88');
    const wire = decoder.decode(serializeMessage(makeRequest('OPTIONS', 'sip:b', h)));
    expect(wire).toMatch('Content-Length: 0\r\n');
  });

  it('uses strict CRLF on output', () => {
    const wire = decoder.decode(serializeMessage(makeRequest('OPTIONS', 'sip:b', new Headers())));
    expect(wire).not.toMatch(/(^|[^\r])\n/);
    expect(wire).toMatch(/^OPTIONS sip:b SIP\/2\.0\r\n/);
  });

  it('omits every existing Content-Length, long and compact', () => {
    const h = new Headers();
    h.append('Content-Length', '12');
    h.append('l', '8');
    const wire = decoder.decode(serializeMessage(makeRequest('OPTIONS', 'sip:b', h)));
    expect(wire.split('\r\n').filter((l) => /^l:/i.test(l))).toHaveLength(0);
    expect(wire.match(/content-length/gi)).toHaveLength(1);
  });

  it('serializes a response with a body', () => {
    const h = new Headers();
    h.append('Content-Type', 'text/plain');
    const wire = decoder.decode(serializeMessage(makeResponse(200, 'OK', h, new TextEncoder().encode('café'))));
    expect(wire).toMatch('SIP/2.0 200 OK\r\n');
    expect(wire).toMatch('Content-Length: 5\r\n');
    expect(wire.endsWith('café')).toBe(true);
  });

  it('rejects CR/LF injection in a header value', () => {
    const h = new Headers();
    h.append('X-Evil', 'a\r\nInjected: yes');
    expect(() => serializeMessage(makeRequest('OPTIONS', 'sip:b', h))).toThrow();
  });

  it('rejects CR/LF injection in a header name', () => {
    const h = new Headers();
    h.append('X-Evil\r\nInjected', 'v');
    expect(() => serializeMessage(makeRequest('OPTIONS', 'sip:b', h))).toThrow();
  });

  it('rejects CR/LF injection in the start line', () => {
    expect(() => serializeMessage(makeRequest('OPTIONS\r\nX: y', 'sip:b', new Headers()))).toThrow();
    expect(() => serializeMessage(makeRequest('OPTIONS', 'sip:b\r\nX: y', new Headers()))).toThrow();
  });

  // P2-3: Serializer does not validate start-line grammar
  it('rejects method with whitespace', () => {
    expect(() => serializeMessage(makeRequest('BAD METHOD', 'sip:b', new Headers()))).toThrow(/invalid method/i);
  });

  it('rejects empty URI', () => {
    expect(() => serializeMessage(makeRequest('OPTIONS', '', new Headers()))).toThrow(/invalid URI/i);
  });

  it('rejects URI with whitespace', () => {
    expect(() => serializeMessage(makeRequest('OPTIONS', 'sip: b', new Headers()))).toThrow(/invalid URI/i);
  });

  it('rejects non-integer status code', () => {
    expect(() => serializeMessage(makeResponse(1000, 'OK', new Headers()))).toThrow(/invalid status code/i);
  });

  it('rejects status code outside 100-699 range', () => {
    expect(() => serializeMessage(makeResponse(99, 'OK', new Headers()))).toThrow(/invalid status code/i);
    expect(() => serializeMessage(makeResponse(700, 'OK', new Headers()))).toThrow(/invalid status code/i);
  });

  it('round-trips parsed messages through serialize/parse', () => {
    const h = new Headers();
    h.append('Via', 'SIP/2.0/UDP host');
    h.append('Contact', '<sip:user@host>');
    const original = makeRequest('INVITE', 'sip:b@example.com', h, encoder.encode('body'));
    const wire = serializeMessage(original);
    const parsed = parseMessage(wire);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error(parsed.error.message);
    expect(parsed.value.kind).toBe('request');
    if (parsed.value.kind === 'request') {
      expect(parsed.value.method).toBe('INVITE');
      expect(parsed.value.uri).toBe('sip:b@example.com');
      expect(parsed.value.headers.get('Via')).toBe('SIP/2.0/UDP host');
      expect(decoder.decode(parsed.value.body)).toBe('body');
    }
  });
});