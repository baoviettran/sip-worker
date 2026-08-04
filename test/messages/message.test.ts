import { describe, it, expect } from 'vitest';
import {
  makeRequest,
  makeResponse,
  bodyText,
  withTextBody,
  isRequest,
  isResponse,
} from '../../src/messages/message.js';
import { Headers } from '../../src/messages/headers.js';

describe('message model', () => {
  it('constructs a request and sets a text body', () => {
    const h = new Headers();
    const m = makeRequest('INVITE', 'sip:b@host', h);
    const m2 = withTextBody(m, 'v=0\r\n...', 'application/sdp');
    expect(isRequest(m2)).toBe(true);
    expect(isResponse(m2)).toBe(false);
    expect(bodyText(m2)).toBe('v=0\r\n...');
    expect(m2.headers.get('Content-Type')).toBe('application/sdp');
  });

  it('constructs a response', () => {
    const m = makeResponse(200, 'OK', new Headers());
    expect(isResponse(m)).toBe(true);
    expect(m.statusCode).toBe(200);
    expect(m.reasonPhrase).toBe('OK');
  });

  it('stores UTF-8 bodies as bytes', () => {
    const request = withTextBody(
      makeRequest('INVITE', 'sip:b@example.com'),
      'café',
      'application/sdp',
    );
    expect(request.body.byteLength).toBe(5);
    expect(bodyText(request)).toBe('café');
  });

  it('defaults headers and body for requests', () => {
    const m = makeRequest('INVITE', 'sip:b@example.com');
    expect(m.kind).toBe('request');
    expect(m.headers instanceof Headers).toBe(true);
    expect(m.body.byteLength).toBe(0);
  });

  it('defaults headers and body for responses', () => {
    const m = makeResponse(200, 'OK');
    expect(m.kind).toBe('response');
    expect(m.headers instanceof Headers).toBe(true);
    expect(m.body.byteLength).toBe(0);
  });

  it('withTextBody does not mutate the original message', () => {
    const h = new Headers();
    h.append('Via', 'one');
    const m = makeRequest('INVITE', 'sip:b@host', h);
    const m2 = withTextBody(m, 'hello', 'text/plain');
    expect(m.headers.get('Content-Type')).toBeUndefined();
    expect(m.body.byteLength).toBe(0);
    expect(m2.headers.get('Via')).toBe('one');
    expect(m2.headers.get('Content-Type')).toBe('text/plain');
  });
});