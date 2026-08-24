// test/sipp/driver/assertions.ts
import type { AgentEventRecord, ExpectedOutcome, ScenarioExpectation } from './types.js';

export interface AssertionResult {
  readonly pass: boolean;
  readonly message: string;
}

export const EXPECTATIONS: Readonly<Record<string, ScenarioExpectation>> = {
  'register-basic:success': { outcome: { kind: 'registration-sequence', sequence: ['registered'] } },
  'register-auth:success': { outcome: { kind: 'registration-sequence', sequence: ['registered'] } },
  'register-auth:wrong-password': { outcome: { kind: 'registration-error', code: 'REGISTRATION_FAILED' } },
  'register-refresh:success': { outcome: { kind: 'refresh-cycles', minRegisterSends: 3 } },
  'invite-outgoing:udp': { outcome: { kind: 'call-sequence', sequence: ['confirmed', 'terminated'] } },
  'invite-outgoing:tcp': { outcome: { kind: 'call-sequence', sequence: ['confirmed', 'terminated'] } },
  'invite-incoming:success': { outcome: { kind: 'incoming-answered' } },
  'cancel-race:success': { outcome: { kind: 'cancelled-before-answer' } },
  'retransmissions:success': { outcome: { kind: 'retransmission', minInviteSends: 2 } },
  'bye-timeout:success': { outcome: { kind: 'bye-timeout' } },
  'malformed:success': { outcome: { kind: 'parse-error-then-registered' } },
  'reconnect:success': { outcome: { kind: 'reconnect-monotonic-cseq' } },
};

function registrations(trace: readonly AgentEventRecord[]): readonly string[] {
  return trace.filter((r) => r.type === 'registration').map((r) => r.detail);
}

function calls(trace: readonly AgentEventRecord[]): readonly string[] {
  return trace.filter((r) => r.type === 'call').map((r) => r.detail);
}

function errors(trace: readonly AgentEventRecord[]): readonly AgentEventRecord[] {
  return trace.filter((r) => r.type === 'error');
}

function transports(trace: readonly AgentEventRecord[], method: string): readonly AgentEventRecord[] {
  return trace.filter((r) => r.type === 'transport' && r.detail === method);
}

function hangups(trace: readonly AgentEventRecord[]): readonly AgentEventRecord[] {
  return trace.filter((r) => r.type === 'hangup');
}

function errorCode(error: AgentEventRecord): string {
  return error.detail.split(':')[0] ?? '';
}

function isSubsequence(needle: readonly string[], haystack: readonly string[]): boolean {
  let i = 0;
  for (const item of haystack) {
    if (item === needle[i]) i += 1;
    if (i === needle.length) return true;
  }
  return i === needle.length;
}

function result(pass: boolean, message: string): AssertionResult {
  return { pass, message };
}

export function assertExpectedOutcome(
  trace: readonly AgentEventRecord[],
  expected: ExpectedOutcome,
): AssertionResult {
  switch (expected.kind) {
    case 'registration-sequence': {
      const states = registrations(trace);
      return result(
        isSubsequence(expected.sequence, states) && errors(trace).length === 0,
        `registration states ${JSON.stringify(states)} must contain ${JSON.stringify(expected.sequence)} with no failures`,
      );
    }
    case 'registration-error': {
      const recorded = errors(trace).map(errorCode);
      return result(
        recorded.length >= 1 && recorded.every((code) => code === expected.code)
          && !registrations(trace).includes('registered'),
        `expected registration error ${expected.code}, got ${recorded.join(',') || '(none)'} and states ${JSON.stringify(registrations(trace))}`,
      );
    }
    case 'refresh-cycles': {
      const sends = transports(trace, 'REGISTER').length;
      return result(
        sends >= expected.minRegisterSends && errors(trace).length === 0,
        `expected >= ${expected.minRegisterSends} REGISTER wire sends, saw ${sends}`,
      );
    }
    case 'call-sequence': {
      const states = calls(trace);
      return result(
        isSubsequence(expected.sequence, states) && errors(trace).length === 0,
        `call states ${JSON.stringify(states)} must contain ${JSON.stringify(expected.sequence)} with no failures`,
      );
    }
    case 'incoming-answered': {
      const states = calls(trace);
      return result(
        trace.some((r) => r.type === 'incoming')
          && isSubsequence(['confirmed', 'terminated'], states)
          && errors(trace).length === 0,
        `incoming call must answer (confirmed) then terminate, saw calls ${JSON.stringify(states)}`,
      );
    }
    case 'cancelled-before-answer': {
      const states = calls(trace);
      return result(
        trace.some((r) => r.type === 'incoming')
          && states.includes('terminated') && !states.includes('confirmed')
          && errors(trace).length === 0,
        `cancelled call must reach terminated without confirming, saw calls ${JSON.stringify(states)}`,
      );
    }
    case 'retransmission': {
      const states = calls(trace);
      const invites = transports(trace, 'INVITE').length;
      const confirmed = states.filter((s) => s === 'confirmed').length;
      return result(
        invites >= expected.minInviteSends
          && isSubsequence(['confirmed', 'terminated'], states)
          && confirmed === 1
          && errors(trace).length === 0,
        `expected >= ${expected.minInviteSends} INVITE sends (saw ${invites}) and exactly one confirmed (saw ${confirmed})`,
      );
    }
    case 'bye-timeout': {
      const rejected = hangups(trace).filter((h) => h.detail.startsWith('rejected:'));
      const states = calls(trace);
      const lastState = states[states.length - 1];
      return result(
        rejected.length >= 1
          && lastState === 'confirmed',
        `hangup must reject (saw ${JSON.stringify(hangups(trace).map((h) => h.detail))}) and session return to confirmed (last state ${lastState ?? '(none)'})`,
      );
    }
    case 'parse-error-then-registered': {
      const recorded = errors(trace).map(errorCode);
      return result(
        recorded.some((code) => code === 'PROTOCOL_ERROR')
          && registrations(trace).includes('registered'),
        `expected a PROTOCOL_ERROR record then registered, got errors ${recorded.join(',') || '(none)'} and states ${JSON.stringify(registrations(trace))}`,
      );
    }
    case 'reconnect-monotonic-cseq': {
      const regs = trace.filter((r) => r.type === 'registration');
      const first = regs[0];
      const last = regs[regs.length - 1];
      const monotonic =
        typeof first?.meta?.nextCSeq === 'number'
        && typeof last?.meta?.nextCSeq === 'number'
        && (last.meta.nextCSeq as number) > (first.meta.nextCSeq as number);
      return result(
        regs.length >= 2 && first.meta?.callId === last.meta?.callId && monotonic,
        `expected monotonic CSeq across two registration generations with the same Call-ID, saw ${regs.length} registration records`,
      );
    }
  }
}
