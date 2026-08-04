export class SipError extends Error {
  constructor(readonly statusCode: number, message: string) { super(message); this.name = 'SipError'; }
}
export class ParseError extends Error {
  constructor(readonly offset: number, message: string) { super(message); this.name = 'ParseError'; }
}
export class TransportError extends Error {
  constructor(message: string, readonly cause?: unknown) { super(message); this.name = 'TransportError'; }
}
