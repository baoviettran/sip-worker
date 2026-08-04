import { TransportError } from '../errors.js';
import type { SipRequestMessage, SipResponseMessage } from '../messages/message.js';
import { serializeMessage } from '../messages/serializer.js';
import type { Clock, Transport } from '../transport/transport.js';
import { cancel, schedule } from './timers.js';
import type {
  ClientTransaction,
  DerivedTimers,
  TransactionKey,
  TransactionLayerEvent,
} from './types.js';

type InviteState = 'Calling' | 'Proceeding' | 'Accepted' | 'Completed' | 'Terminated';

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

/** Last whitespace-separated token of CSeq is the method; undefined if absent. */
function cseqMethod(response: SipResponseMessage): string | undefined {
  const cseq = response.headers.get('CSeq');
  if (cseq === undefined) return undefined;
  const parts = cseq.trim().split(/\s+/);
  return parts[parts.length - 1];
}

/**
 * RFC 3261 17.1.1 client INVITE transaction.
 *
 * Calling -> Proceeding -> Accepted | Completed -> Terminated.
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

  constructor(options: InviteClientOptions) {
    this.key = options.key;
    this.request = options.request;
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

  /** Send the request once, then arm the timeout and (unreliable) retransmit timers. */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.sendRequest();
    this.retransmitInterval = this.timers.T1;
    this.armTimerB();
    if (!this.reliable) this.armTimerA(this.retransmitInterval);
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
      this.currentState = 'Proceeding';
      this.emitResponse(response);
    } else if (this.currentState === 'Proceeding') {
      this.emitResponse(response);
    }
  }

  private on2xx(response: SipResponseMessage): void {
    if (this.currentState === 'Calling' || this.currentState === 'Proceeding') {
      this.cancelTimerA();
      this.cancelTimerB();
      this.currentState = 'Accepted';
      this.emitResponse(response);
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
      this.sendBytes(this.ackBytes);
      this.emitResponse(response);
      this.currentState = 'Completed';
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
    this.sendBytes(serializeMessage(this.request));
  }

  private sendBytes(bytes: Uint8Array): void {
    this.transport.send(bytes).catch((err: unknown) => {
      const error = err instanceof TransportError ? err : new TransportError(String(err));
      this.terminate(error);
    });
  }

  private armTimerA(delay: number): void {
    this.cancelTimerA();
    this.timerA = schedule(this.clock, delay, () => this.onTimerA());
  }

  private onTimerA(): void {
    if (this.currentState !== 'Calling') return;
    this.sendRequest();
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
    this.currentState = 'Terminated';
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