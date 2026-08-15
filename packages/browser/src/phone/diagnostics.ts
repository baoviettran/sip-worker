/**
 * Browser-safe structured diagnostics (v0.7).
 *
 * Every code is a closed union member with a per-code allowlist of context
 * keys. Values are bounded (strings capped), unknown keys are dropped, and the
 * injected logger is invoked inside a try/catch so a throwing sink can never
 * crash the phone. History is collected only as a test seam; production uses
 * the injected logger as the sole sink and stores no history.
 */

import type {
  DiagnosticCode,
  DiagnosticLogger,
  DiagnosticRecord,
  DiagnosticSubsystem,
} from './types.js';

/** Upper bound on any string context value. */
export const MAX_CONTEXT_LENGTH = 128;

/** Delivery options for a {@link DiagnosticRecorder}. */
export interface DiagnosticRecorderOptions {
  readonly logger: DiagnosticLogger;
  /** When true, keep an in-memory history (test-only). Production omits it. */
  readonly collect?: boolean;
  readonly now?: () => number;
}

/** Subsystem, severity, and context-key allowlist for each closed code. */
interface CodeSpec {
  readonly subsystem: DiagnosticSubsystem;
  readonly severity: 'debug' | 'info' | 'warn' | 'error';
  readonly allowed: readonly string[];
}

const CODE_SPECS: Readonly<Record<DiagnosticCode, CodeSpec>> = {
  'connection.connecting': {
    subsystem: 'connection', severity: 'info', allowed: ['connectionId', 'attempt'],
  },
  'connection.connected': {
    subsystem: 'connection', severity: 'info', allowed: ['connectionId'],
  },
  'connection.reconnect_attempt': {
    subsystem: 'connection', severity: 'info', allowed: ['connectionId', 'attempt'],
  },
  'connection.reconnect_attempt_failed': {
    subsystem: 'connection', severity: 'warn', allowed: ['connectionId', 'attempt'],
  },
  'connection.reconnected': {
    subsystem: 'connection', severity: 'info', allowed: ['connectionId'],
  },
  'connection.recovery_failed': {
    subsystem: 'connection', severity: 'warn', allowed: ['attempt', 'reason'],
  },
  'connection.closed': {
    subsystem: 'connection', severity: 'info', allowed: ['connectionId'],
  },
  'registration.registering': {
    subsystem: 'registration', severity: 'info', allowed: ['attempt'],
  },
  'registration.registered': {
    subsystem: 'registration', severity: 'info', allowed: [],
  },
  'registration.recovering': {
    subsystem: 'registration', severity: 'info', allowed: ['connectionId', 'attempt'],
  },
  'registration.recovery_failed': {
    subsystem: 'registration', severity: 'warn', allowed: ['attempt'],
  },
  'registration.unregistered': {
    subsystem: 'registration', severity: 'info', allowed: [],
  },
  'call.established': {
    subsystem: 'call', severity: 'info', allowed: ['callId', 'attempt'],
  },
  'call.recovering': {
    subsystem: 'call', severity: 'info', allowed: ['callId'],
  },
  'call.hold': {
    subsystem: 'call', severity: 'info', allowed: ['callId'],
  },
  'call.resume': {
    subsystem: 'call', severity: 'info', allowed: ['callId'],
  },
  'call.dtmf_failed': {
    subsystem: 'call', severity: 'error', allowed: ['callId'],
  },
  'call.terminated': {
    subsystem: 'call', severity: 'info', allowed: ['callId'],
  },
  'call.failed': {
    subsystem: 'call', severity: 'error', allowed: ['callId', 'attempt'],
  },
  'media.failed': {
    subsystem: 'media', severity: 'error', allowed: ['callId'],
  },
  'lifecycle.disposed': {
    subsystem: 'lifecycle', severity: 'info', allowed: ['connectionId'],
  },
};

/**
 * Records structured, redacted diagnostics. Production callers construct one
 * with an injected {@link DiagnosticLogger} and without `collect`; tests may
 * pass `collect: true` and read {@link records}.
 */
export class DiagnosticRecorder {
  readonly records: readonly DiagnosticRecord[];
  private readonly _records: DiagnosticRecord[] = [];
  private readonly logger: DiagnosticLogger;
  private readonly collect: boolean;
  private readonly now: () => number;

  constructor(options: DiagnosticRecorderOptions) {
    this.logger = options.logger;
    this.collect = options.collect === true;
    this.now = options.now ?? (() => Date.now());
    this.records = this._records;
  }

  /**
   * Record one closed diagnostic event. `connectionId`/`callId` are opaque
   * local identifiers emitted as TOP-LEVEL fields (per the public schema),
   * never inside `context`. Both are bounded to {@link MAX_CONTEXT_LENGTH} and
   * only included when the code's allowlist admits them. `context` values are
   * bounded and the keys are allowlisted per code; unknown keys are dropped.
   */
  record(
    code: DiagnosticCode,
    options?: {
      readonly connectionId?: string;
      readonly callId?: string;
      readonly context?: Readonly<Record<string, string | number | boolean>>;
    },
  ): void {
    const spec = CODE_SPECS[code];

    // Emit only the exact record the schema describes.
    let sub: DiagnosticSubsystem = 'lifecycle';
    let severity: 'debug' | 'info' | 'warn' | 'error' = 'info';
    let allowed: readonly string[] = [];
    if (spec !== undefined) {
      sub = spec.subsystem;
      severity = spec.severity;
      allowed = spec.allowed;
    }

    const connectionId = allowed.includes('connectionId')
      ? sanitizeId(options?.connectionId)
      : undefined;
    const callId = allowed.includes('callId')
      ? sanitizeId(options?.callId)
      : undefined;
    const safeContext = sanitizeContext(options?.context, allowed);

    const record: DiagnosticRecord = {
      timestamp: this.now(),
      severity,
      subsystem: sub,
      code,
      ...(connectionId === undefined ? {} : { connectionId }),
      ...(callId === undefined ? {} : { callId }),
      ...(safeContext === undefined ? {} : { context: safeContext }),
    };

    if (this.collect) this._records.push(record);
    try {
      this.logger(record);
    } catch {
      // A throwing sink must never crash or reject the phone.
    }
  }
}

function sanitizeContext(
  context: Readonly<Record<string, string | number | boolean>> | undefined,
  allowed: readonly string[],
): Readonly<Record<string, string | number | boolean>> | undefined {
  if (context === undefined) return undefined;
  const allowedSet = new Set(allowed);
  const out: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(context)) {
    // connectionId/callId are top-level record fields, never context keys.
    if (key === 'connectionId' || key === 'callId') continue;
    if (!allowedSet.has(key)) continue;
    out[key] = typeof value === 'string' ? value.slice(0, MAX_CONTEXT_LENGTH) : value;
  }
  return Object.keys(out).length === 0 ? undefined : Object.freeze(out);
}

/** Bound an opaque top-level identifier; drop non-strings and empty values. */
function sanitizeId(value: string | undefined): string | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  return value.slice(0, MAX_CONTEXT_LENGTH);
}
