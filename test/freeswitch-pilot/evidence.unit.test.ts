import { describe, expect, it } from 'vitest';
import {
  SCENARIOS,
  EvidenceRecorder,
  type ScenarioId,
  type EvidenceReport,
} from '../../examples/freeswitch-pilot/src/evidence.js';
import type { ResourceSnapshot } from 'sip-worker';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const zero: ResourceSnapshot = {
  activeSocketGenerations: 0,
  reconnectAttempts: 0,
  reconnectTimers: 0,
  activeCalls: 0,
  activeNegotiations: 0,
  pendingOperations: 0,
  timers: 0,
  peerConnections: 0,
  localTracks: 0,
  lifecycleListeners: 0,
  deviceListeners: 0,
};

function makeRecorder(secretList: readonly string[] = ['s3cret']) {
  return new EvidenceRecorder({
    secrets: secretList,
    build: {
      commitSha: 'abc1234',
      branch: 'main',
      timestamp: '2026-08-17T12:00:00Z',
    },
    environment: {
      os: 'Linux',
      browser: 'Chromium',
      networkCondition: 'stable',
    },
    resourceSnapshot: zero,
    runId: 'test-run-001',
    now: () => 1_000_000,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SCENARIOS', () => {
  it('has exactly 14 scenario ids', () => {
    expect(SCENARIOS).toHaveLength(14);
  });

  it('contains expected scenario ids', () => {
    const set = new Set(SCENARIOS);
    expect(set.has('authenticated-registration')).toBe(true);
    if (set.has('authenticated-registration')) {
      expect(set.has('zero-resource-dispose')).toBe(true);
      expect(set.has('wss-registration-recovery')).toBe(true);
      expect(set.has('rfc4733-dtmf')).toBe(true);
    }
  });
});

describe('EvidenceRecorder', () => {
  it('uses the provided deterministic runId', () => {
    const rec = makeRecorder();
    const report = rec.finalize();
    expect(report.runId).toBe('test-run-001');
  });

  it('uses the provided deterministic timestamp', () => {
    const rec = makeRecorder();
    const report = rec.finalize();
    expect(report.build.timestamp).toBe('2026-08-17T12:00:00Z');
  });

  it('initialises every scenario as not-run', () => {
    const rec = makeRecorder();
    const report = rec.finalize();
    for (const id of SCENARIOS) {
      expect(report.scenarios[id]).toBe('not-run');
    }
  });

  it('setScenario marks a scenario as pass/fail/blocked', () => {
    const rec = makeRecorder();
    rec.setScenario('authenticated-registration', 'pass');
    rec.setScenario('outgoing-two-way-audio', 'fail');
    rec.setScenario('mute-unmute', 'blocked');
    const report = rec.finalize();
    expect(report.scenarios['authenticated-registration']).toBe('pass');
    expect(report.scenarios['outgoing-two-way-audio']).toBe('fail');
    expect(report.scenarios['mute-unmute']).toBe('blocked');
  });

  it('operation() records start and pass on success', () => {
    const rec = makeRecorder();
    rec.operation('test-op', () => {
      // noop — success
    });
    const report = rec.finalize();
    const startEvent = report.events.find(
      (e) => e.kind === 'operation-start' && e.label === 'test-op',
    );
    expect(startEvent).toBeDefined();
    const settleEvent = report.events.find(
      (e) => e.kind === 'operation-result' && e.label === 'test-op',
    );
    expect(settleEvent).toBeDefined();
    if (settleEvent && settleEvent.kind === 'operation-result') {
      expect(settleEvent.success).toBe(true);
    }
  });

  it('operation() records failure and rethrows', () => {
    const rec = makeRecorder();
    expect(() => {
      rec.operation('failing-op', () => {
        throw new Error('boom with s3cret inside');
      });
    }).toThrow();
    const report = rec.finalize();
    const settleEvent = report.events.find(
      (e) => e.kind === 'operation-result' && e.label === 'failing-op',
    );
    expect(settleEvent).toBeDefined();
    if (settleEvent && settleEvent.kind === 'operation-result') {
      expect(settleEvent.success).toBe(false);
    }
  });

  it('transition() records a state transition', () => {
    const rec = makeRecorder();
    rec.transition('idle', 'ringing', { callId: 'c1' });
    const report = rec.finalize();
    const event = report.events.find((e) => e.kind === 'transition');
    expect(event).toBeDefined();
    if (event && event.kind === 'transition') {
      expect(event.from).toBe('idle');
      expect(event.to).toBe('ringing');
    }
  });

  it('diagnostic() captures a diagnostic record', () => {
    const rec = makeRecorder();
    rec.diagnostic('info', 'call', 'call.established', { callId: 'c1' });
    const report = rec.finalize();
    const event = report.events.find((e) => e.kind === 'diagnostic');
    expect(event).toBeDefined();
    if (event && event.kind === 'diagnostic') {
      expect(event.severity).toBe('info');
      expect(event.subsystem).toBe('call');
    }
  });

  it('addFinding() records a finding with severity', () => {
    const rec = makeRecorder();
    rec.addFinding('high', 'Audio dropped after hold/resume');
    const report = rec.finalize();
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0].severity).toBe('high');
  });

  it('zero snapshot passes finalize', () => {
    const rec = makeRecorder();
    // All scenarios must be pass or blocked for a 'pass' verdict
    for (const id of SCENARIOS) {
      rec.setScenario(id, 'pass');
    }
    const report = rec.finalize();
    expect(report.verdict).toBe('pass');
  });

  it('non-zero snapshot (timers: 1) fails finalize', () => {
    const leaked: ResourceSnapshot = { ...zero, timers: 1 };
    const rec = new EvidenceRecorder({
      secrets: ['s3cret'],
      build: { commitSha: 'abc', branch: 'main', timestamp: '2026-01-01' },
      environment: { os: 'Linux', browser: 'Chromium', networkCondition: 'stable' },
      resourceSnapshot: leaked,
      runId: 'leak-001',
    });
    rec.setScenario('authenticated-registration', 'pass');
    const report = rec.finalize();
    expect(report.verdict).toBe('fail');
  });

  it('toJson() excludes the secret list', () => {
    const rec = makeRecorder(['top-secret', 's3cret']);
    rec.setScenario('authenticated-registration', 'pass');
    const report = rec.finalize();
    const json = rec.toJson();
    expect(json).not.toContain('top-secret');
    expect(json).not.toContain('s3cret');
  });

  it('toJson() excludes secrets from error messages in findings', () => {
    const rec = makeRecorder(['leaked-password']);
    rec.addFinding('medium', 'Auth failed with leaked-password in logs');
    const report = rec.finalize();
    const json = rec.toJson();
    expect(json).not.toContain('leaked-password');
  });

  it('toJson() excludes secrets from operation errors', () => {
    const rec = makeRecorder(['super-secret']);
    expect(() => {
      rec.operation('auth-test', () => {
        throw new Error('auth failed: super-secret was rejected');
      });
    }).toThrow();
    const json = rec.toJson();
    expect(json).not.toContain('super-secret');
  });

  it('retains only the newest 500 events after 550 transitions', () => {
    const rec = makeRecorder();
    for (let i = 0; i < 550; i++) {
      rec.transition(`state-${i}`, `state-${i + 1}`);
    }
    const report = rec.finalize();
    expect(report.events.length).toBeLessThanOrEqual(500);
    // Most recent events should still be present
    const last = report.events[report.events.length - 1];
    expect(last.kind).toBe('transition');
    if (last.kind === 'transition') {
      expect(last.to).toBe('state-550');
    }
  });
});
