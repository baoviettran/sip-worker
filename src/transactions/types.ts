import type { TransportError } from '../errors.js';
import type { SipRequestMessage, SipResponseMessage } from '../messages/message.js';

export interface TimerConfig {
  readonly T1: number;
  readonly T2: number;
  readonly T4: number;
}

export const DEFAULT_TIMERS: TimerConfig = { T1: 500, T2: 4000, T4: 5000 };

export interface DerivedTimers extends TimerConfig {
  readonly B: number;
  readonly D: number;
  readonly F: number;
  readonly H: number;
  readonly I: number;
  readonly J: number;
  readonly K: number;
  readonly L: number;
  readonly M: number;
}

// top Via branch | CSeq method
export type TransactionKey = `${string}|${string}`;

export interface ClientTransaction {
  readonly key: TransactionKey;
  readonly request: SipRequestMessage;
  readonly state: string;
}

// Placeholder: the full ServerTransaction machine is built in a later task.
// Defined here with the same shape as ClientTransaction so the event union
// typechecks until the real machine lands.
export interface ServerTransaction {
  readonly key: TransactionKey;
  readonly request: SipRequestMessage;
  readonly state: string;
}

export type TransactionLayerEvent =
  | { type: 'response'; transaction: ClientTransaction; response: SipResponseMessage }
  | { type: 'request'; transaction: ServerTransaction; request: SipRequestMessage }
  | { type: 'statelessRequest'; request: SipRequestMessage }
  | { type: 'timeout'; key: TransactionKey }
  | { type: 'transportError'; key: TransactionKey; error: TransportError }
  | { type: 'terminated'; key: TransactionKey };
