import { TransportError } from '../errors.js';
import type { SipRequestMessage, SipResponseMessage } from '../messages/message.js';
import { serializeMessage } from '../messages/serializer.js';
import type { Clock, Transport } from '../transport/transport.js';
import { cseqMethod } from './ack.js';
import { cancel, schedule } from './timers.js';
import { assertTransition, type TransitionTable } from './transitions.js';
import type {
  ClientTransaction,
  DerivedTimers,
  TransactionKey,
  TransactionLayerEvent,
} from './types.js';

export type InviteState = 'Calling' | 'Proceeding' | 'Accepted' | 'Completed' | 'Terminated';

/** RFC 3261 figure 5 / RFC 6026 §8.4. Terminated is reachable from every state. */
export const INVITE_CLIENT_TRANSITIONS: TransitionTable<InviteState> = {
  Calling: ['Proceeding', 'Accepted', 'Completed', 'Terminated'],
  Proceeding: ['Accepted', 'Completed', 'Terminated'],
  Accepted: ['Terminated'],
  Completed: ['Terminated'],
  Terminated: [],
};

export interface InviteClientOptions {
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
 * RFC 3261 17.1.1 client INVITE transaction.
 *
 * Calling -&gt; Proceeding -&gt; Accepted | Completed -&gt; Terminated.
 * Timer A retransmits on an unreliable transport, doubling without a T2 cap.
 * Timer B is the overall timeout; Timer D lingers in Completed; Timer M
 * lingers in Accepted. The non-2xx ACK bytes are cached on first entry to
 * Completed and resent on repeated final responses.
 */
export class InviteClientTransaction {
  readonly key: TransactionKey;
  readonly request: SipRequestMessage;

  private readonly transport: Transport;
  private readonly clock: Clock;
  private readonly timers: DerivedTimers;
  private readonly reliable: boolean;
  private readonly emit: (event: TransactionLayerEvent) => void;
  private readonly buildNon2xxAck: (request: SipRequestMessage, response: SipResponseMessage) => SipRequestMessage;

  private currentState: InviteState = 'Calling';
  private started = false;
  private timerA = -1;
  private timerB = -1;
  private timerD = -1;
  private timerM = -1;
  private retransmitInterval = 0;
  private ackBytes: Uint8Array | undefined;
  private requestBytes: Uint8Array | undefined;

  constructor(options: InviteClientOptions) {
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
    this.buildNon2xxAck = options.buildNon2xxAck;
  }

  get state(): InviteState {
    return this.currentState;
  }

  private setState(next: InviteState): void {
    assertTransition(INVITE_CLIENT_TRANSITIONS, this.currentState, next);
    this.currentState = next;
  }

  /** Send the request once, then arm the timeout and (unreliable) retransmit timers. */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.sendRequest();
    if (this.currentState !== 'Calling' && this.currentState !== 'Proceeding') return;
    this.armTimerB();
    if (this.currentState === 'Calling') {
      this.retransmitInterval = this.timers.T1;
      if (!this.reliable) this.armTimerA(this.retransmitInterval);
    }
  }

  receive(response: SipResponseMessage): void {
    if (this.currentState === 'Terminated') return;
    if (!this.matches(response)) return;
    const code = response.statusCode;
    if (code < 100 || code > 699) return;
    if (code <= 199) this.onProvisional(response);
    else if (code <= 299) this.on2xx(response);
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
    if (this.currentState === 'Calling') {
      this.cancelTimerA();
      this.setState('Proceeding');
      this.emitResponse(response);
    } else if (this.currentState === 'Proceeding') {
      this.emitResponse(response);
    }
  }

  private on2xx(response: SipResponseMessage): void {
    if (this.currentState === 'Calling' || this.currentState === 'Proceeding') {
      this.cancelTimerA();
      this.cancelTimerB();
      this.setState('Accepted');
      this.emitResponse(response);
      if (this.currentState !== 'Accepted') return;
      this.armTimerM();
    } else if (this.currentState === 'Accepted') {
      // Emit every 2xx; do not restart Timer M.
      this.emitResponse(response);
    }
  }

  private onFinal(response: SipResponseMessage): void {
    if (this.currentState === 'Calling' || this.currentState === 'Proceeding') {
      this.cancelTimerA();
      this.cancelTimerB();
      const ack = this.buildNon2xxAck(this.request, response);
      this.ackBytes = serializeMessage(ack);
      this.setState('Completed');
      this.sendBytes(this.ackBytes);
      if (this.currentState !== 'Completed') return;
      this.emitResponse(response);
      if (this.currentState !== 'Completed') return;
      this.armTimerD();
    } else if (this.currentState === 'Completed') {
      // Repeated final response: resend the cached ACK without emitting.
      if (this.ackBytes !== undefined) this.sendBytes(this.ackBytes);
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

  private armTimerA(delay: number): void {
    this.cancelTimerA();
    this.timerA = schedule(this.clock, delay, () => this.onTimerA());
  }

  private onTimerA(): void {
    if (this.currentState !== 'Calling') return;
    this.sendRequest();
    if (this.currentState !== 'Calling') return;
    this.retransmitInterval *= 2;
    this.armTimerA(this.retransmitInterval);
  }

  private armTimerB(): void {
    this.timerB = schedule(this.clock, this.timers.B, () => this.onTimerB());
  }

  private onTimerB(): void {
    if (this.currentState !== 'Calling' && this.currentState !== 'Proceeding') return;
    this.emit({ type: 'timeout', key: this.key });
    this.terminateInternal();
  }

  private armTimerD(): void {
    this.timerD = schedule(this.clock, this.timers.D, () => this.onTimerD());
  }

  private onTimerD(): void {
    if (this.currentState !== 'Completed') return;
    this.terminateInternal();
  }

  private armTimerM(): void {
    this.timerM = schedule(this.clock, this.timers.M, () => this.onTimerM());
  }

  private onTimerM(): void {
    if (this.currentState !== 'Accepted') return;
    this.terminateInternal();
  }

  private cancelTimerA(): void {
    cancel(this.clock, this.timerA);
    this.timerA = -1;
  }

  private cancelTimerB(): void {
    cancel(this.clock, this.timerB);
    this.timerB = -1;
  }

  private terminateInternal(): void {
    if (this.currentState === 'Terminated') return;
    this.setState('Terminated');
    this.clearAllTimers();
    this.emit({ type: 'terminated', key: this.key });
  }

  private clearAllTimers(): void {
    cancel(this.clock, this.timerA);
    cancel(this.clock, this.timerB);
    cancel(this.clock, this.timerD);
    cancel(this.clock, this.timerM);
    this.timerA = -1;
    this.timerB = -1;
    this.timerD = -1;
    this.timerM = -1;
  }
}
