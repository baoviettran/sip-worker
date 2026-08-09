import { TransportError } from '../errors.js';
import type { SipRequestMessage, SipResponseMessage } from '../messages/message.js';
import { serializeMessage } from '../messages/serializer.js';
import type { Clock, Transport } from '../transport/transport.js';
import { cseqMethod } from './ack.js';
import { cancel, schedule } from './timers.js';
import type {
  ClientTransaction,
  DerivedTimers,
  TransactionKey,
  TransactionLayerEvent,
} from './types.js';

type NonInviteState = 'Trying' | 'Proceeding' | 'Completed' | 'Terminated';

export interface NonInviteClientOptions {
  readonly request: SipRequestMessage;
  readonly key: TransactionKey;
  readonly transport: Transport;
  readonly clock: Clock;
  readonly timers: DerivedTimers;
  readonly reliable: boolean;
  readonly emit: (event: TransactionLayerEvent) => void;
  readonly buildNon2xxAck: (request: SipRequestMessage, response: SipResponseMessage) => SipRequestMessage;
}

/**
 * RFC 3261 17.1.2 client non-INVITE transaction.
 *
 * Trying -> Proceeding -> Completed -> Terminated.
 * Timer E retransmits on an unreliable transport, halving the interval until
 * it plateaus at T2. Timer F is the overall timeout; Timer K lingers in
 * Completed. A final response (200-699) completes the transaction.
 */
export class NonInviteClientTransaction {
  readonly key: TransactionKey;
  readonly request: SipRequestMessage;

  private readonly transport: Transport;
  private readonly clock: Clock;
  private readonly timers: DerivedTimers;
  private readonly reliable: boolean;
  private readonly emit: (event: TransactionLayerEvent) => void;

  private currentState: NonInviteState = 'Trying';
  private started = false;
  private timerE = -1;
  private timerF = -1;
  private timerK = -1;
  private retransmitInterval = 0;
  private requestBytes: Uint8Array | undefined;

  constructor(options: NonInviteClientOptions) {
    this.key = options.key;
    this.request = {
      ...options.request,
      headers: options.request.headers.clone(),
      body: options.request.body.slice(),
    };
    this.transport = options.transport;
    this.clock = options.clock;
    this.timers = options.timers;
    this.reliable = options.reliable;
    this.emit = options.emit;
  }

  get state(): NonInviteState {
    return this.currentState;
  }

  /** Send the request once, then arm the timeout and (unreliable) retransmit timers. */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.sendRequest();
    this.retransmitInterval = this.timers.T1;
    this.armTimerF();
    if (!this.reliable) this.armTimerE(this.retransmitInterval);
  }

  receive(response: SipResponseMessage): void {
    if (this.currentState === 'Terminated') return;
    if (!this.matches(response)) return;
    const code = response.statusCode;
    if (code < 100 || code > 699) return;
    if (code <= 199) this.onProvisional(response);
    else this.onFinal(response);
  }

  terminate(error?: TransportError): void {
    if (this.currentState === 'Terminated') return;
    if (error !== undefined) {
      this.emit({ type: 'transportError', key: this.key, error });
    }
    this.terminateInternal();
  }

  private matches(response: SipResponseMessage): boolean {
    return cseqMethod(response) === this.request.method;
  }

  private onProvisional(response: SipResponseMessage): void {
    if (this.currentState === 'Trying') {
      this.currentState = 'Proceeding';
      this.retransmitInterval = this.timers.T2;
      if (!this.reliable) this.armTimerE(this.timers.T2);
      this.emitResponse(response);
    } else if (this.currentState === 'Proceeding') {
      this.emitResponse(response);
    }
  }

  private onFinal(response: SipResponseMessage): void {
    if (this.currentState === 'Trying' || this.currentState === 'Proceeding') {
      this.cancelTimerE();
      this.cancelTimerF();
      this.currentState = 'Completed';
      this.emitResponse(response);
      if (this.currentState !== 'Completed') return;
      this.armTimerK();
    }
  }

  private emitResponse(response: SipResponseMessage): void {
    this.emit({ type: 'response', transaction: this.snapshot(), response });
  }

  private snapshot(): ClientTransaction {
    return { key: this.key, request: this.request, state: this.currentState };
  }

  private sendRequest(): void {
    if (this.requestBytes === undefined) {
      this.requestBytes = serializeMessage(this.request);
    }
    this.sendBytes(this.requestBytes);
  }

  private sendBytes(bytes: Uint8Array): void {
    this.transport.send(bytes).catch((err: unknown) => {
      const error = err instanceof TransportError ? err : new TransportError(String(err));
      this.terminate(error);
    });
  }

  private armTimerE(delay: number): void {
    this.cancelTimerE();
    this.timerE = schedule(this.clock, delay, () => this.onTimerE());
  }

  private onTimerE(): void {
    if (this.currentState === 'Trying') {
      this.sendRequest();
      if (this.currentState !== 'Trying') return;
      this.retransmitInterval = Math.min(2 * this.retransmitInterval, this.timers.T2);
      this.armTimerE(this.retransmitInterval);
    } else if (this.currentState === 'Proceeding') {
      this.sendRequest();
      if (this.currentState !== 'Proceeding') return;
      this.armTimerE(this.timers.T2);
    }
  }

  private armTimerF(): void {
    this.timerF = schedule(this.clock, this.timers.F, () => this.onTimerF());
  }

  private onTimerF(): void {
    if (this.currentState !== 'Trying' && this.currentState !== 'Proceeding') return;
    this.emit({ type: 'timeout', key: this.key });
    this.terminateInternal();
  }

  private armTimerK(): void {
    this.timerK = schedule(this.clock, this.timers.K, () => this.onTimerK());
  }

  private onTimerK(): void {
    if (this.currentState !== 'Completed') return;
    this.terminateInternal();
  }

  private cancelTimerE(): void {
    cancel(this.clock, this.timerE);
    this.timerE = -1;
  }

  private cancelTimerF(): void {
    cancel(this.clock, this.timerF);
    this.timerF = -1;
  }

  private terminateInternal(): void {
    if (this.currentState === 'Terminated') return;
    this.currentState = 'Terminated';
    this.clearAllTimers();
    this.emit({ type: 'terminated', key: this.key });
  }

  private clearAllTimers(): void {
    cancel(this.clock, this.timerE);
    cancel(this.clock, this.timerF);
    cancel(this.clock, this.timerK);
    this.timerE = -1;
    this.timerF = -1;
    this.timerK = -1;
  }
}
