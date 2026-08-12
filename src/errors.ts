import type { SipErrorCode } from './error-codes.js';

export class SipError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
    readonly code: SipErrorCode = 'PROTOCOL_ERROR',
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'SipError';
  }
}

export class ParseError extends Error {
  readonly code = 'PROTOCOL_ERROR' as const;
  constructor(readonly offset: number, message: string) {
    super(message);
    this.name = 'ParseError';
  }
}

export class TransportError extends Error {
  readonly code = 'TRANSPORT_FAILED' as const;
  constructor(message: string, readonly cause?: unknown) {
    super(message, { cause });
    this.name = 'TransportError';
  }
}
