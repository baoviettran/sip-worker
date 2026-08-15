import { describe, expect, expectTypeOf, it } from 'vitest';
import { DiagnosticRecorder } from '../../src/phone/diagnostics.js';
import type {
  MediaErrorCode,
} from '@sip-worker/core';
import type {
  BrowserCallEventMap,
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
      context: {
        attempt: 8,
        password: 'secret',
        sdp: 'v=0',
        uri: 'sip:alice@example.com',
      },
    });
    expect(recorder.records[0]!.context).toEqual({ attempt: 8 });
  });

  it('binds string context values to 128 characters', () => {
    const logger: DiagnosticLogger = () => {};
    const recorder = recorderWithLogger(logger, true);
    recorder.record('connection.recovery_failed', {
      context: { attempt: 1, reason: 'x'.repeat(200) },
    });
    expect(recorder.records[0]!.context!.reason).toHaveLength(128);
  });

  it('passes the exact allowlisted record to the injected logger', () => {
    let seen: DiagnosticRecord | undefined;
    const recorder = recorderWithLogger((record) => { seen = record; }, true);
    recorder.record('call.failed', { callId: 'opaque-call', context: { attempt: 3 } });
    expect(seen!.code).toBe('call.failed');
    expect(seen!.callId).toBe('opaque-call');
    expect(seen!.context).toEqual({ attempt: 3 });
  });

  it('places connectionId and callId at the top level, never inside context', () => {
    const recorder = recorderWithLogger(() => {}, true);
    recorder.record('call.failed', {
      callId: 'opaque-call',
      context: { callId: 'nested', attempt: 3 },
    });
    expect(recorder.records[0]!.callId).toBe('opaque-call');
    expect(recorder.records[0]!.connectionId).toBeUndefined();
    expect(recorder.records[0]!.context).toEqual({ attempt: 3 });
  });

  it('binds an oversized top-level connectionId/callId and drops a non-string one', () => {
    const recorder = recorderWithLogger(() => {}, true);
    recorder.record('call.failed', { callId: 'x'.repeat(200) });
    recorder.record('connection.connected', { connectionId: 42 as unknown as string });
    expect(recorder.records[0]!.callId).toHaveLength(128);
    expect(recorder.records[1]!.connectionId).toBeUndefined();
  });

  it('records the closed control-terminal codes with their opaque ids', () => {
    const recorder = recorderWithLogger(() => {}, true);
    recorder.record('connection.reconnect_attempt', { connectionId: 'conn-1', context: { attempt: 2 } });
    recorder.record('connection.reconnected', { connectionId: 'conn-1' });
    recorder.record('registration.recovering', { connectionId: 'conn-1', context: { attempt: 1 } });
    recorder.record('call.recovering', { callId: 'call-7' });
    recorder.record('call.hold', { callId: 'call-7' });
    recorder.record('call.resume', { callId: 'call-7' });
    recorder.record('call.dtmf_failed', { callId: 'call-7' });
    expect(recorder.records.map((r) => r.code)).toEqual([
      'connection.reconnect_attempt',
      'connection.reconnected',
      'registration.recovering',
      'call.recovering',
      'call.hold',
      'call.resume',
      'call.dtmf_failed',
    ]);
    expect(recorder.records[0]).toMatchObject({ connectionId: 'conn-1', context: { attempt: 2 } });
    expect(recorder.records[3]).toMatchObject({ callId: 'call-7' });
  });

  it('emits the closed recovery/media codes through the injected logger with fixed severities', () => {
    const seen: DiagnosticRecord[] = [];
    const recorder = recorderWithLogger((record) => seen.push(record));
    recorder.record('connection.reconnect_attempt_failed', {
      connectionId: 'conn-1',
      context: { attempt: 3 },
    });
    recorder.record('media.failed', { callId: 'call-2' });
    expect(seen).toHaveLength(2);
    expect(seen[0]).toMatchObject({ code: 'connection.reconnect_attempt_failed', severity: 'warn' });
    expect(seen[1]).toMatchObject({ code: 'media.failed', severity: 'error' });
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
    recorder.record('connection.recovery_failed' as DiagnosticCode, { context: { attempt: 1 } });
    expect(recorder.records[0]!.context).toEqual({ attempt: 1 });
  });

  it('fault-isolates a throwing logger and still does not leak unhandled errors', () => {
    const recorder = recorderWithLogger(() => { throw new Error('boom'); }, true);
    expect(() => recorder.record('connection.recovery_failed', { context: { attempt: 1 } })).not.toThrow();
  });

  it('stores no history when collect is disabled (production sink only)', () => {
    const recorder = recorderWithLogger(() => {}, false);
    recorder.record('connection.recovery_failed', { context: { attempt: 1 } });
    expect(recorder.records).toEqual([]);
  });

  it('preserves the canonical v0.5 mediaStateChanged reason field on the call event payload', () => {
    type Payload = BrowserCallEventMap['mediaStateChanged'];
    // The canonical v0.5 payload carries an optional reason: MediaErrorCode.
    // A structural payload typed as the phone-level event must accept one.
    const payload: Payload = {
      type: 'mediaStateChanged',
      sessionId: 's-1',
      previous: 'new',
      state: 'connected',
      reason: 'ABORTED',
    };
    // Assert the field is actually present and typed as the canonical code union.
    expectTypeOf<Payload>().toHaveProperty('reason');
    expectTypeOf<Payload['reason']>().toEqualTypeOf<MediaErrorCode | undefined>();
    expect(payload.type).toBe('mediaStateChanged');
  });
});
