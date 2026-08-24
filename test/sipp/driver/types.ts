// test/sipp/driver/types.ts
export type TransportKind = 'udp' | 'tcp';

export type TraceEventType =
  | 'registration'  // detail: RegisterState; meta: { callId, nextCSeq }
  | 'call'          // detail: SessionState
  | 'incoming'      // detail: 'invitation'
  | 'error'         // detail: '<code>:<message>'
  | 'transport'     // detail: 'REGISTER' | 'INVITE' (observed wire send)
  | 'hangup';       // detail: 'resolved' | 'rejected:<code>'

export interface AgentEventRecord {
  readonly type: TraceEventType;
  readonly at: number;
  readonly detail: string;
  readonly meta?: Readonly<Record<string, string | number>>;
}

export type ExpectedOutcome =
  | { readonly kind: 'registration-sequence'; readonly sequence: readonly string[] }
  | { readonly kind: 'registration-error'; readonly code: string }
  | { readonly kind: 'refresh-cycles'; readonly minRegisterSends: number }
  | { readonly kind: 'call-sequence'; readonly sequence: readonly string[] }
  | { readonly kind: 'incoming-answered' }
  | { readonly kind: 'cancelled-before-answer' }
  | { readonly kind: 'retransmission'; readonly minInviteSends: number }
  | { readonly kind: 'bye-timeout' }
  | { readonly kind: 'parse-error-then-registered' }
  | { readonly kind: 'reconnect-monotonic-cseq' };

export interface ScenarioExpectation {
  readonly outcome: ExpectedOutcome;
}

export interface DriverEnv {
  readonly scenario: string;
  readonly variant: string;
  readonly host: string;
  readonly sippPort: number;
  readonly localPort: number;
  readonly transport: TransportKind;
  readonly username: string;
  readonly password: string;
  readonly fixtureDir: string;
  readonly deadlineMs: number;
}
