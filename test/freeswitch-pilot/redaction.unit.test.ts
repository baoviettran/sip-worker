import { describe, expect, it } from 'vitest';
import { redactText, safeError } from '../../examples/freeswitch-pilot/src/redaction.js';

describe('pilot redaction boundary', () => {
  it('removes explicit secrets and sensitive protocol material', () => {
    const input = [
      'Authorization: Digest username="1001", response="abc"',
      'sip:1001@tenant.example.test',
      'a=candidate:1 1 UDP 1 192.0.2.10 50000 typ host',
      'v=0\r\na=ice-pwd:ice-secret',
      'password=top-secret',
    ].join('\n');
    const output = redactText(input, ['top-secret', 'ice-secret']);
    expect(output).not.toContain('top-secret');
    expect(output).not.toContain('ice-secret');
    expect(output).not.toContain('1001@');
    expect(output).not.toContain('192.0.2.10');
    expect(output).not.toMatch(/Authorization: Digest/);
  });

  it('returns only a typed code and redacted message for errors', () => {
    const error = Object.assign(new Error('failed for sip:1001@tenant.test with top-secret'), { code: 'REGISTRATION_FAILED' });
    expect(safeError(error, ['top-secret'])).toEqual({
      code: 'REGISTRATION_FAILED',
      message: 'failed for sip:[redacted]@tenant.test with [redacted]',
    });
  });
});
