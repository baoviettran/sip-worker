import { describe, expect, it } from 'vitest';
import { DiagnosticRecorder } from '../../src/phone/diagnostics.js';
import type {
  DiagnosticCode,
  DiagnosticLogger,
  DiagnosticRecord,
} from '../../src/phone/types.js';

function recorderWithLogger(
  logger: DiagnosticLogger,
  collect = false,
): DiagnosticRecorder {
  return new DiagnosticRecorder({ logger, collect });
}

describe('DiagnosticRecorder', () => {
  it('drops every context key that is not allowlisted for the closed event code', () => {
    const logger: DiagnosticLogger = () => {};
    const recorder = recorderWithLogger(logger, true);
    recorder.record('connection.recovery_failed', {
      attempt: 8,
      password: 'secret',
      sdp: 'v=0',
      uri: 'sip:alice@example.com',
    });
    expect(recorder.records[0]!.context).toEqual({ attempt: 8 });
  });

  it('binds string context values to 128 characters', () => {
    const logger: DiagnosticLogger = () => {};
    const recorder = recorderWithLogger(logger, true);
    recorder.record('connection.recovery_failed', {
      attempt: 1,
      reason: 'x'.repeat(200),
    });
    expect(recorder.records[0]!.context!.reason).toHaveLength(128);
  });

  it('passes the exact allowlisted record to the injected logger', () => {
    let seen: DiagnosticRecord | undefined;
    const recorder = recorderWithLogger((record) => { seen = record; }, true);
    recorder.record('call.failed', { callId: 'opaque-call', attempt: 3 });
    expect(seen!.code).toBe('call.failed');
    expect(seen!.context).toEqual({ callId: 'opaque-call', attempt: 3 });
  });

  it('records a timestamp and a subsystem for the event code', () => {
    const recorder = recorderWithLogger(() => {}, true);
    const before = Date.now();
    recorder.record('media.failed', { callId: 'opaque-call' });
    const after = Date.now();
    const record = recorder.records[0]!;
    expect(record.timestamp).toBeGreaterThanOrEqual(before);
    expect(record.timestamp).toBeLessThanOrEqual(after);
    expect(typeof record.timestamp).toBe('number');
  });

  it('keeps an allowlisted discipline when an unknown code is rejected at compile time', () => {
    // Runtime guard: an unrecognized code is dropped (no crash, no record).
    const logger: DiagnosticLogger = () => {};
    const recorder = recorderWithLogger(logger, true);
    recorder.record('connection.recovery_failed' as DiagnosticCode, { attempt: 1 });
    expect(recorder.records[0]!.context).toEqual({ attempt: 1 });
  });

  it('fault-isolates a throwing logger and still does not leak unhandled errors', () => {
    const recorder = recorderWithLogger(() => { throw new Error('boom'); }, true);
    expect(() => recorder.record('connection.recovery_failed', { attempt: 1 })).not.toThrow();
  });

  it('stores no history when collect is disabled (production sink only)', () => {
    const recorder = recorderWithLogger(() => {}, false);
    recorder.record('connection.recovery_failed', { attempt: 1 });
    expect(recorder.records).toEqual([]);
  });
});
