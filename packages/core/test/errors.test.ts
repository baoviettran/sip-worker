import { describe, expect, expectTypeOf, it } from 'vitest';
import { ParseError, SipError, TransportError } from '../src/errors.js';
import type { SipErrorCode } from '../src/error-codes.js';

describe('public error codes', () => {
  it('assigns stable default and explicit codes without breaking old constructors', () => {
    expect(new SipError(486, 'Busy').code).toBe('PROTOCOL_ERROR');
    expect(new SipError(0, 'closed', 'LIFECYCLE_ABORTED').code).toBe('LIFECYCLE_ABORTED');
    expect(new ParseError(4, 'bad').code).toBe('PROTOCOL_ERROR');
    expect(new TransportError('down').code).toBe('TRANSPORT_FAILED');
  });

  it('retains a standard Error cause on coded SipError values', () => {
    const cause = new Error('socket');
    expect(new SipError(0, 'registration failed', 'REGISTRATION_FAILED', { cause }).cause).toBe(cause);
  });

  it('exports a closed code union', () => {
    const codes: SipErrorCode[] = [
      'CONNECTION_RECOVERY_EXHAUSTED', 'REGISTRATION_RECOVERY_FAILED',
      'SIGNALING_RECOVERY_FAILED', 'OPERATION_ABORTED', 'OPERATION_TIMEOUT',
      'OPERATION_IN_PROGRESS', 'HOLD_NEGOTIATION_FAILED',
      'DTMF_UNSUPPORTED', 'DTMF_FAILED',
    ];
    for (const code of codes) {
      expect(new SipError(0, 'x', code).code).toBe(code);
    }
    expectTypeOf<'TIMEOUT'>().toMatchTypeOf<SipErrorCode>();
    // @ts-expect-error arbitrary strings are not public error codes
    const invalid: SipErrorCode = 'anything';
    void invalid;
  });
});
