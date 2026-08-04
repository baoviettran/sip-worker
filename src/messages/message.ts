import { Headers } from './headers.js';
import type { ParseError } from '../errors.js';

export interface SipRequestMessage {
  readonly kind: 'request';
  readonly method: string;
  readonly uri: string;
  readonly headers: Headers;
  readonly body: Uint8Array;
}

export interface SipResponseMessage {
  readonly kind: 'response';
  readonly statusCode: number;
  readonly reasonPhrase: string;
  readonly headers: Headers;
  readonly body: Uint8Array;
}

export type SipMessage = SipRequestMessage | SipResponseMessage;
export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: ParseError };

export function isRequest(m: SipMessage): m is SipRequestMessage {
  return m.kind === 'request';
}
export function isResponse(m: SipMessage): m is SipResponseMessage {
  return m.kind === 'response';
}

export function makeRequest(method: string, uri: string, headers: Headers = new Headers(), body: Uint8Array = new Uint8Array()): SipRequestMessage {
  return { kind: 'request', method, uri, headers, body };
}
export function makeResponse(statusCode: number, reasonPhrase: string, headers: Headers = new Headers(), body: Uint8Array = new Uint8Array()): SipResponseMessage {
  return { kind: 'response', statusCode, reasonPhrase, headers, body };
}

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8');

export function bodyText(msg: SipMessage): string {
  return decoder.decode(msg.body);
}

export function withTextBody(msg: SipMessage, body: string, contentType: string): SipMessage {
  const headers = msg.headers.clone();
  headers.set('Content-Type', contentType);
  return { ...msg, headers, body: encoder.encode(body) };
}
