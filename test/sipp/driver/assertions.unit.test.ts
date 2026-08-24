// test/sipp/driver/assertions.unit.test.ts
import { describe, expect, it } from 'vitest';
import { assertExpectedOutcome, EXPECTATIONS } from './assertions.js';
import type { AgentEventRecord, ExpectedOutcome } from './types.js';
import { SCENARIOS } from '../run-scenario.mjs';

const record = (partial: Partial<Omit<AgentEventRecord, 'type'>> & { type: AgentEventRecord['type'] }): AgentEventRecord => ({
  at: 0,
  detail: '',
  ...partial,
});

describe('assertExpectedOutcome', () => {
  it('registration-sequence passes on a matching trace', () => {
    const result = assertExpectedOutcome(
      [record({ type: 'registration', detail: 'registered' })],
      { kind: 'registration-sequence', sequence: ['registered'] },
    );
    expect(result.pass).toBe(true);
  });

  it('registration-sequence fails on a missing state', () => {
    const result = assertExpectedOutcome([], { kind: 'registration-sequence', sequence: ['registered'] });
    expect(result.pass).toBe(false);
  });

  it('registration-error matches the typed code', () => {
    const result = assertExpectedOutcome(
      [record({ type: 'error', detail: 'REGISTRATION_FAILED:rejected' })],
      { kind: 'registration-error', code: 'REGISTRATION_FAILED' },
    );
    expect(result.pass).toBe(true);
  });

  it('registration-error fails when registration succeeded', () => {
    const result = assertExpectedOutcome(
      [record({ type: 'error', detail: 'REGISTRATION_FAILED:rejected' }), record({ type: 'registration', detail: 'registered' })],
      { kind: 'registration-error', code: 'REGISTRATION_FAILED' },
    );
    expect(result.pass).toBe(false);
  });

  it('call-sequence is an ordered subsequence', () => {
    const trace = ['inviting', 'ringing', 'confirmed', 'terminating', 'terminated'].map((state) =>
      record({ type: 'call', detail: state }));
    expect(assertExpectedOutcome(trace, { kind: 'call-sequence', sequence: ['confirmed', 'terminated'] }).pass).toBe(true);
  });

  it('incoming-answered passes on answer-then-remote-bye', () => {
    const trace = [
      record({ type: 'incoming', detail: 'invitation' }),
      record({ type: 'call', detail: 'confirmed' }),
      record({ type: 'call', detail: 'terminated' }),
    ];
    expect(assertExpectedOutcome(trace, { kind: 'incoming-answered' }).pass).toBe(true);
  });

  it('cancelled-before-answer fails if the call was answered', () => {
    const trace = [
      record({ type: 'incoming', detail: 'invitation' }),
      record({ type: 'call', detail: 'confirmed' }),
      record({ type: 'call', detail: 'terminated' }),
    ];
    expect(assertExpectedOutcome(trace, { kind: 'cancelled-before-answer' }).pass).toBe(false);
  });

  it('retransmission passes with two INVITEs and one confirmation', () => {
    const trace = [
      record({ type: 'transport', detail: 'INVITE' }),
      record({ type: 'transport', detail: 'INVITE' }),
      record({ type: 'call', detail: 'confirmed' }),
      record({ type: 'call', detail: 'terminated' }),
    ];
    expect(assertExpectedOutcome(trace, { kind: 'retransmission', minInviteSends: 2 }).pass).toBe(true);
  });

  it('bye-timeout passes when hangup rejected and session reverted to confirmed', () => {
    const trace = [
      record({ type: 'call', detail: 'confirmed' }),
      record({ type: 'call', detail: 'terminating' }),
      record({ type: 'hangup', detail: 'rejected:TIMEOUT' }),
      record({ type: 'call', detail: 'confirmed' }),
    ];
    expect(assertExpectedOutcome(trace, { kind: 'bye-timeout' }).pass).toBe(true);
  });

  it('parse-error-then-registered passes on protocol error then success', () => {
    const trace = [
      record({ type: 'error', detail: 'PROTOCOL_ERROR:unparseable message' }),
      record({ type: 'registration', detail: 'registered' }),
    ];
    expect(assertExpectedOutcome(trace, { kind: 'parse-error-then-registered' }).pass).toBe(true);
  });

  it('reconnect-monotonic-cseq passes across two generations', () => {
    const trace = [
      record({ type: 'registration', detail: 'registered', meta: { callId: 'abc', nextCSeq: 2 } }),
      record({ type: 'registration', detail: 'registered', meta: { callId: 'abc', nextCSeq: 3 } }),
    ];
    expect(assertExpectedOutcome(trace, { kind: 'reconnect-monotonic-cseq' }).pass).toBe(true);
  });

  it('reconnect-monotonic-cseq fails when the Call-ID changes', () => {
    const trace = [
      record({ type: 'registration', detail: 'registered', meta: { callId: 'abc', nextCSeq: 2 } }),
      record({ type: 'registration', detail: 'registered', meta: { callId: 'xyz', nextCSeq: 3 } }),
    ];
    expect(assertExpectedOutcome(trace, { kind: 'reconnect-monotonic-cseq' }).pass).toBe(false);
  });
});

describe('EXPECTATIONS coverage', () => {
  it('every SCENARIOS run has an expectation and vice versa', () => {
    const runs = Object.entries(SCENARIOS)
      .flatMap(([name, cfg]) => cfg.runs.map((run) => `${name}:${run.variant}`))
      .sort();
    const expected = Object.keys(EXPECTATIONS).sort();
    expect(runs).toEqual(expected);
  });
});
