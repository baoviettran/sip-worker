import { SipError, TransportError } from '../errors.js';
import type { SipRequestMessage, SipResponseMessage } from '../messages/message.js';
import { serializeMessage } from '../messages/serializer.js';
import type { Clock, Transport } from '../transport/transport.js';
import { cancel, schedule } from './timers.js';
import { assertTransition, type TransitionTable } from './transitions.js';
import type {
  DerivedTimers,
  ServerTransaction,
  TransactionKey,
  TransactionLayerEvent,
} from './types.js';

type NonInviteServerState = 'Trying' | 'Proceeding' | 'Completed' | 'Terminated';

/** RFC 3261 figure 8. Terminated is reachable from every state. */
export const NON_INVITE_SERVER_TRANSITIONS: TransitionTable<NonInviteServerState> = {
  Trying: ['Proceeding', 'Completed', 'Terminated'],
  Proceeding: ['Completed', 'Terminated'],
  Completed: ['Terminated'],
  Terminated: [],
};

export interface NonInviteServerOptions {
  readonly request: SipRequestMessage;
  readonly key: TransactionKey;
  readonly transport: Transport;
  readonly clock: Clock;
  readonly timers: DerivedTimers;
  // `reliable` is intentionally unused here: Timer J correctness depends on the
  // caller passing timers derived from the transport reliability (J=0 on a
  // reliable transport), so the transaction itself does not branch on it.
  readonly reliable: boolean;
  readonly emit: (event: TransactionLayerEvent) => void;
}

/**
 * RFC 3261 17.2.2 server non-INVITE transaction.
 *
 * Trying -&gt; Proceeding -&gt; Completed -&gt; Terminated.
 * The initial request emits to the TU. A 1xx moves to Proceeding; a final
 * response moves to Completed and arms Timer J. Duplicate requests in Trying,
 * Proceeding, or Completed resend the latest response when one is cached.
 * Timer J lingers in Completed and terminates (zero on a reliable transport).
 */
export class NonInviteServerTransaction {
  readonly key: TransactionKey;
  readonly request: SipRequestMessage;

  private readonly transport: Transport;
  private readonly clock: Clock;
  private readonly timers: DerivedTimers;
  private readonly emit: (event: TransactionLayerEvent) => void;

  private currentState: NonInviteServerState = 'Trying';
  private started = false;
  private timerJ = -1;
  private cachedResponse: Uint8Array | undefined;

  constructor(options: NonInviteServerOptions) {
    this.key = options.key;
    this.request = options.request;
    this.transport = options.transport;
    this.clock = options.clock;
    this.timers = options.timers;
    this.emit = options.emit;
  }

  get state(): NonInviteServerState {
    return this.currentState;
  }

  private setState(next: NonInviteServerState): void {
    assertTransition(NON_INVITE_SERVER_TRANSITIONS, this.currentState, next);
    this.currentState = next;
  }

  /** Deliver an incoming request (the initial request or a duplicate). */
  receiveRequest(request: SipRequestMessage): void {
    if (this.currentState === 'Terminated') return;
    if (!this.started) {
      this.started = true;
      this.emit({ type: 'request', transaction: this.snapshot(), request });
      return;
    }
    // Duplicate in Trying/Proceeding/Completed: resend the latest response.
    this.resendCached();
  }

  /**
   * Send a response from the user-agent server.
   *
   * The transaction state commits BEFORE the transport send, and the returned
   * promise settles with THAT exact send (rejecting when the send rejects).
   * Retransmissions and cached resends use `sendBytes`, which stays
   * fire-and-forget and emits a transportError only via the existing path.
   */
  sendResponseAwait(response: SipResponseMessage): Promise<void> {
    if (this.currentState === 'Terminated') return Promise.resolve();
    const code = response.statusCode;
    if (code < 100 || code > 699) return Promise.resolve();
    // RFC 4320 §4.1: a non-INVITE request MUST NOT receive a provisional
    // response other than 100. Reject loudly so the TU learns the misuse
    // (mirrors SIP.js's throw); the fire-and-forget sendResponse wrapper
    // consumes the rejection.
    if (code > 100 && code <= 199) {
      return Promise.reject(
        new SipError(0, 'non-INVITE provisional response other than 100 is not allowed (RFC 4320 §4.1)'),
      );
    }
    if (code <= 199) {
      if (this.currentState === 'Trying') {
        this.setState('Proceeding');
        this.cachedResponse = serializeMessage(response);
        return this.sendAwait(this.cachedResponse);
      } else if (this.currentState === 'Proceeding') {
        this.cachedResponse = serializeMessage(response);
        return this.sendAwait(this.cachedResponse);
      }
      return Promise.resolve();
    } else if (this.currentState === 'Trying' || this.currentState === 'Proceeding') {
      this.setState('Completed');
      this.cachedResponse = serializeMessage(response);
      const send = this.sendAwait(this.cachedResponse);
      if (this.currentState !== 'Completed') return send;
      this.armTimerJ();
      return send;
    }
    return Promise.resolve();
  }

  /**
   * Fire-and-forget compatibility wrapper over `sendResponseAwait`. The state
   * commits and the bytes go on the wire exactly as in the awaited form; only
   * the returned promise (carrying the exact send) is dropped here. A failed
   * send still terminates the transaction via the awaited path's transportError.
   */
  sendResponse(response: SipResponseMessage): void {
    void this.sendResponseAwait(response).catch(() => {});
  }

  terminate(error?: TransportError): void {
    if (this.currentState === 'Terminated') return;
    if (error !== undefined) {
      this.emit({ type: 'transportError', key: this.key, error });
    }
    this.terminateInternal();
  }

  private resendCached(): void {
    if (this.cachedResponse !== undefined) this.sendBytes(this.cachedResponse);
  }

  private snapshot(): ServerTransaction {
    return { key: this.key, request: this.request, state: this.currentState };
  }

  private sendBytes(bytes: Uint8Array): void {
    const onError = (err: unknown): void => {
      const error = err instanceof TransportError ? err : new TransportError(String(err));
      this.terminate(error);
    };
    try {
      void this.transport.send(bytes).catch(onError);
    } catch (error) {
      onError(error);
    }
  }

  /** Await a transport send while preserving the fire-and-forget error surface. */
  private sendAwait(bytes: Uint8Array): Promise<void> {
    try {
      return this.transport.send(bytes).catch((err: unknown) => {
        const error = err instanceof TransportError ? err : new TransportError(String(err));
        this.terminate(error);
        throw error;
      });
    } catch (error) {
      const wrapped = error instanceof TransportError ? error : new TransportError(String(error));
      this.terminate(wrapped);
      return Promise.reject(wrapped);
    }
  }

  private armTimerJ(): void {
    this.timerJ = schedule(this.clock, this.timers.J, () => this.onTimerJ());
  }

  private onTimerJ(): void {
    if (this.currentState !== 'Completed') return;
    this.terminateInternal();
  }

  private terminateInternal(): void {
    if (this.currentState === 'Terminated') return;
    this.setState('Terminated');
    this.clearAllTimers();
    this.emit({ type: 'terminated', key: this.key });
  }

  private clearAllTimers(): void {
    cancel(this.clock, this.timerJ);
    this.timerJ = -1;
  }
}
