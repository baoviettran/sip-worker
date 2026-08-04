import { describe, it, expect } from 'vitest';
import { serializeMessage } from '../../src/messages/serializer.js';
import { makeRequest, makeResponse } from '../../src/messages/message.js';
import { Headers } from '../../src/messages/headers.js';

const decoder = new TextDecoder('utf-8');

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
});