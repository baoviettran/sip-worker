import { TransportError } from '../errors.js';
import type { SipRequestMessage, SipResponseMessage } from '../messages/message.js';
import { serializeMessage } from '../messages/serializer.js';
import type { Clock, Transport } from '../transport/transport.js';
import { cancel, schedule } from './timers.js';
import type {
  DerivedTimers,
  ServerTransaction,
  TransactionKey,
  TransactionLayerEvent,
} from './types.js';

type NonInviteServerState = 'Trying' | 'Proceeding' | 'Completed' | 'Terminated';

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
 * Trying -> Proceeding -> Completed -> Terminated.
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

  /** Send a response from the user-agent server. */
  sendResponse(response: SipResponseMessage): void {
    if (this.currentState === 'Terminated') return;
    const code = response.statusCode;
    if (code < 100 || code > 699) return;
    if (code <= 199) {
      if (this.currentState === 'Trying') {
        this.currentState = 'Proceeding';
        this.cachedResponse = serializeMessage(response);
        this.sendBytes(this.cachedResponse);
      } else if (this.currentState === 'Proceeding') {
        this.cachedResponse = serializeMessage(response);
        this.sendBytes(this.cachedResponse);
      }
    } else if (this.currentState === 'Trying' || this.currentState === 'Proceeding') {
      this.currentState = 'Completed';
      this.cachedResponse = serializeMessage(response);
      this.sendBytes(this.cachedResponse);
      if (this.currentState !== 'Completed') return;
      this.armTimerJ();
    }
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

  private armTimerJ(): void {
    this.timerJ = schedule(this.clock, this.timers.J, () => this.onTimerJ());
  }

  private onTimerJ(): void {
    if (this.currentState !== 'Completed') return;
    this.terminateInternal();
  }

  private terminateInternal(): void {
    if (this.currentState === 'Terminated') return;
    this.currentState = 'Terminated';
    this.clearAllTimers();
    this.emit({ type: 'terminated', key: this.key });
  }

  private clearAllTimers(): void {
    cancel(this.clock, this.timerJ);
    this.timerJ = -1;
  }
}
