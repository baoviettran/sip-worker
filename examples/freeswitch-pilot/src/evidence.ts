import type { ResourceSnapshot, DiagnosticRecord } from 'sip-worker';
import { safeError } from './redaction.js';

// ---------------------------------------------------------------------------
// Scenario schema
// ---------------------------------------------------------------------------

export const SCENARIOS = [
  'authenticated-registration',
  'outgoing-two-way-audio',
  'incoming-answer-remote-bye',
  'incoming-reject',
  'outgoing-cancel',
  'local-and-remote-hangup',
  'mute-unmute',
  'hold-resume',
  'rfc4733-dtmf',
  'wss-registration-recovery',
  'call-network-recovery',
  'stun-turn-nonlocal',
  'repeated-call-cycles',
  'zero-resource-dispose',
] as const;

export type ScenarioId = (typeof SCENARIOS)[number];
export type ScenarioStatus = 'not-run' | 'pass' | 'fail' | 'blocked';

// ---------------------------------------------------------------------------
// Supporting types
// ---------------------------------------------------------------------------

export interface BuildMetadata {
  readonly commitSha: string;
  readonly branch: string;
  readonly timestamp: string;
}

export interface PilotEnvironment {
  readonly os: string;
  readonly browser: string;
  readonly networkCondition: string;
}

type FindingSeverity = 'info' | 'low' | 'medium' | 'high' | 'critical';
type Verdict = 'incomplete' | 'pass' | 'fail';

// --- Event discriminated union ---

interface OperationStartEvent {
  readonly kind: 'operation-start';
  readonly label: string;
  readonly timestamp: number;
}

interface OperationResultEvent {
  readonly kind: 'operation-result';
  readonly label: string;
  readonly success: boolean;
  readonly error?: { readonly code: string | undefined; readonly message: string };
  readonly timestamp: number;
}

interface TransitionEvent {
  readonly kind: 'transition';
  readonly from: string;
  readonly to: string;
  readonly context?: Readonly<Record<string, string | number | boolean>>;
  readonly timestamp: number;
}

interface DiagnosticEvent {
  readonly kind: 'diagnostic';
  readonly severity: string;
  readonly subsystem: string;
  readonly code: string;
  readonly context?: Readonly<Record<string, string | number | boolean>>;
  readonly timestamp: number;
}

type EvidenceEvent =
  | OperationStartEvent
  | OperationResultEvent
  | TransitionEvent
  | DiagnosticEvent;

interface Finding {
  readonly severity: FindingSeverity;
  readonly message: string;
  readonly timestamp: number;
}

// ---------------------------------------------------------------------------
// EvidenceReport — the finalized shape
// ---------------------------------------------------------------------------

export interface EvidenceReport {
  readonly runId: string;
  readonly build: BuildMetadata;
  readonly environment: PilotEnvironment;
  readonly scenarios: Readonly<Record<ScenarioId, ScenarioStatus>>;
  readonly events: readonly EvidenceEvent[];
  readonly findings: readonly Finding[];
  readonly verdict: Verdict;
}

// ---------------------------------------------------------------------------
// EvidenceRecorderOptions
// ---------------------------------------------------------------------------

export interface EvidenceRecorderOptions {
  readonly secrets: readonly string[];
  readonly build: BuildMetadata;
  readonly environment: PilotEnvironment;
  readonly resourceSnapshot: ResourceSnapshot;
  readonly runId: string;
  readonly now?: () => number;
}

const MAX_EVENTS = 500;

// ---------------------------------------------------------------------------
// EvidenceRecorder
// ---------------------------------------------------------------------------

export class EvidenceRecorder {
  private readonly secrets: readonly string[];
  private readonly build: BuildMetadata;
  private readonly environment: PilotEnvironment;
  private readonly resourceSnapshot: ResourceSnapshot;
  private readonly runId: string;
  private readonly now: () => number;
  private readonly _scenarios: Record<ScenarioId, ScenarioStatus>;
  private readonly _events: EvidenceEvent[] = [];
  private readonly _findings: Finding[] = [];

  constructor(options: EvidenceRecorderOptions) {
    this.secrets = options.secrets;
    this.build = options.build;
    this.environment = options.environment;
    this.resourceSnapshot = options.resourceSnapshot;
    this.runId = options.runId;
    this.now = options.now ?? (() => Date.now());

    // Initialise every scenario as not-run
    this._scenarios = {} as Record<ScenarioId, ScenarioStatus>;
    for (const id of SCENARIOS) {
      this._scenarios[id] = 'not-run';
    }
  }

  // --- Mutators ---

  setScenario(id: ScenarioId, status: 'pass' | 'fail' | 'blocked'): void {
    this._scenarios[id] = status;
  }

  operation(label: string, fn: () => void): void {
    this.pushEvent({
      kind: 'operation-start',
      label,
      timestamp: this.now(),
    });

    try {
      fn();
    } catch (err: unknown) {
      const error =
        err instanceof Error
          ? err
          : new Error(typeof err === 'string' ? err : 'Unknown error');
      const safe = safeError(error as Error & { code?: string }, this.secrets);
      this.pushEvent({
        kind: 'operation-result',
        label,
        success: false,
        error: safe,
        timestamp: this.now(),
      });
      throw err;
    }

    this.pushEvent({
      kind: 'operation-result',
      label,
      success: true,
      timestamp: this.now(),
    });
  }

  transition(
    from: string,
    to: string,
    context?: Readonly<Record<string, string | number | boolean>>,
  ): void {
    this.pushEvent({
      kind: 'transition',
      from,
      to,
      context,
      timestamp: this.now(),
    });
  }

  diagnostic(
    severity: string,
    subsystem: string,
    code: string,
    context?: Readonly<Record<string, string | number | boolean>>,
  ): void {
    this.pushEvent({
      kind: 'diagnostic',
      severity,
      subsystem,
      code,
      context,
      timestamp: this.now(),
    });
  }

  addFinding(severity: FindingSeverity, message: string): void {
    this._findings.push({
      severity,
      message: redactField(message, this.secrets),
      timestamp: this.now(),
    });
  }

  // --- Finalization ---

  finalize(): EvidenceReport {
    const verdict = this.computeVerdict();

    return {
      runId: this.runId,
      build: this.build,
      environment: this.environment,
      scenarios: Object.freeze({ ...this._scenarios }) as Readonly<
        Record<ScenarioId, ScenarioStatus>
      >,
      events: Object.freeze([...this._events]),
      findings: Object.freeze([...this._findings]),
      verdict,
    };
  }

  // --- Serialization ---

  toJson(): string {
    const report = this.finalize();
    return JSON.stringify(report, null, 2);
  }

  // --- Private helpers ---

  private computeVerdict(): Verdict {
    // Fail if any scenario is failed
    for (const id of SCENARIOS) {
      if (this._scenarios[id] === 'fail') return 'fail';
    }

    // Fail if any high/critical finding
    for (const f of this._findings) {
      if (f.severity === 'high' || f.severity === 'critical') return 'fail';
    }

    // Fail if resources are non-zero (leaked)
    if (!isZeroSnapshot(this.resourceSnapshot)) return 'fail';

    // Pass only when every scenario is pass or blocked
    for (const id of SCENARIOS) {
      const s = this._scenarios[id];
      if (s !== 'pass' && s !== 'blocked') return 'incomplete';
    }

    return 'pass';
  }

  private pushEvent(event: EvidenceEvent): void {
    this._events.push(event);
    // Retain only the newest MAX_EVENTS
    if (this._events.length > MAX_EVENTS) {
      this._events.splice(0, this._events.length - MAX_EVENTS);
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isZeroSnapshot(snapshot: ResourceSnapshot): boolean {
  return (
    snapshot.activeSocketGenerations === 0 &&
    snapshot.reconnectAttempts === 0 &&
    snapshot.reconnectTimers === 0 &&
    snapshot.activeCalls === 0 &&
    snapshot.activeNegotiations === 0 &&
    snapshot.pendingOperations === 0 &&
    snapshot.timers === 0 &&
    snapshot.peerConnections === 0 &&
    snapshot.localTracks === 0 &&
    snapshot.lifecycleListeners === 0 &&
    snapshot.deviceListeners === 0
  );
}

function redactField(value: string, secrets: readonly string[]): string {
  const sorted = [...secrets].filter((s) => s.length > 0).sort((a, b) => b.length - a.length);
  let output = value;
  for (const secret of sorted) {
    output = output.replaceAll(secret, '[redacted]');
  }
  return output;
}
