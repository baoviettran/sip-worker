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

type InviteServerState = 'Proceeding' | 'Accepted' | 'Completed' | 'Confirmed' | 'Terminated';

export interface InviteServerOptions {
  readonly request: SipRequestMessage;
  readonly key: TransactionKey;
  readonly transport: Transport;
  readonly clock: Clock;
  readonly timers: DerivedTimers;
  readonly reliable: boolean;
  readonly emit: (event: TransactionLayerEvent) => void;
}

/** RFC 3261 17.2.1: the UAS sends a 100 Trying automatically after 200 ms. */
const AUTOMATIC_100_MS = 200;

/**
 * RFC 3261 17.2.1 server INVITE transaction.
 *
 * Proceeding -> Accepted | Completed -> Confirmed -> Terminated.
 * A 200 ms automatic-100 timer is armed on the initial request and cancelled
 * by any user-agent-server response. A 1xx or final response is cached and
 * resent on duplicate INVITEs. Timer G retransmits the final response on an
 * unreliable transport (doubling up to T2); Timer H is the overdue timeout;
 * Timer L lingers in Accepted; Timer I lingers in Confirmed until the ACK
 * arrives. A matching ACK in Completed cancels G/H and moves to Confirmed.
 * Reliable transports never arm G and use zero I, but always arm H and L.
 */
export class InviteServerTransaction {
  readonly key: TransactionKey;
  readonly request: SipRequestMessage;

  private readonly transport: Transport;
  private readonly clock: Clock;
  private readonly timers: DerivedTimers;
  private readonly reliable: boolean;
  private readonly emit: (event: TransactionLayerEvent) => void;

  private currentState: InviteServerState = 'Proceeding';
  private started = false;
  private timer100 = -1;
  private timerG = -1;
  private timerH = -1;
  private timerI = -1;
  private timerL = -1;
  private retransmitInterval = 0;
  private cachedResponse: Uint8Array | undefined;

  constructor(options: InviteServerOptions) {
    this.key = options.key;
    this.request = options.request;
    this.transport = options.transport;
    this.clock = options.clock;
    this.timers = options.timers;
    this.reliable = options.reliable;
    this.emit = options.emit;
  }

  get state(): InviteServerState {
    return this.currentState;
  }

  /** Deliver an incoming request (the initial INVITE or a duplicate / ACK). */
  receiveRequest(request: SipRequestMessage): void {
    if (this.currentState === 'Terminated') return;
    if (!this.started) {
      this.started = true;
      this.emit({ type: 'request', transaction: this.snapshot(), request });
      this.armTimer100();
      return;
    }
    if (this.currentState === 'Completed') {
      if (request.method === 'ACK') this.onAck();
      else this.resendCached();
    } else if (this.currentState === 'Proceeding') {
      this.resendCached();
    } else if (this.currentState === 'Accepted') {
      // Pass the duplicate to the TU so it can resend the 2xx.
      this.emit({ type: 'request', transaction: this.snapshot(), request });
    }
    // Confirmed: ignore duplicates and ACKs.
  }

  /** Send a response from the user-agent server. */
  sendResponse(response: SipResponseMessage): void {
    if (this.currentState === 'Terminated') return;
    this.cancelTimer100();
    const code = response.statusCode;
    if (code < 100 || code > 699) return;
    if (code <= 199) {
      if (this.currentState === 'Proceeding') {
        this.cachedResponse = serializeMessage(response);
        this.sendBytes(this.cachedResponse);
      }
    } else if (code <= 299) {
      if (this.currentState === 'Proceeding') {
        this.currentState = 'Accepted';
        this.sendBytes(serializeMessage(response));
        this.armTimerL();
      } else if (this.currentState === 'Accepted') {
        this.sendBytes(serializeMessage(response));
      }
    } else {
      if (this.currentState === 'Proceeding') {
        this.currentState = 'Completed';
        this.cachedResponse = serializeMessage(response);
        this.sendBytes(this.cachedResponse);
        if (!this.reliable) this.startG();
        this.armTimerH();
      }
    }
  }

  terminate(error?: TransportError): void {
    if (this.currentState === 'Terminated') return;
    if (error !== undefined) {
      this.emit({ type: 'transportError', key: this.key, error });
    }
    this.terminateInternal();
  }

  private onAck(): void {
    this.cancelTimerG();
    this.cancelTimerH();
    this.currentState = 'Confirmed';
    this.armTimerI();
  }

  private resendCached(): void {
    if (this.cachedResponse !== undefined) this.sendBytes(this.cachedResponse);
  }

  private snapshot(): ServerTransaction {
    return { key: this.key, request: this.request, state: this.currentState };
  }

  private sendBytes(bytes: Uint8Array): void {
    // A failed send surfaces a transportError but never discards INVITE server
    // state prematurely: the RFC timers still terminate the transaction (and
    // the server must stay alive to receive the ACK).
    this.transport.send(bytes).catch((err: unknown) => {
      const error = err instanceof TransportError ? err : new TransportError(String(err));
      this.emit({ type: 'transportError', key: this.key, error });
    });
  }

  private armTimer100(): void {
    this.timer100 = schedule(this.clock, AUTOMATIC_100_MS, () => this.onTimer100());
  }

  private onTimer100(): void {
    if (this.currentState !== 'Proceeding') return;
    const response: SipResponseMessage = {
      kind: 'response',
      statusCode: 100,
      reasonPhrase: 'Trying',
      headers: this.request.headers.clone(),
      body: new Uint8Array(),
    };
    this.cachedResponse = serializeMessage(response);
    this.sendBytes(this.cachedResponse);
  }

  private startG(): void {
    this.retransmitInterval = this.timers.T1;
    this.timerG = schedule(this.clock, this.retransmitInterval, () => this.onTimerG());
  }

  private onTimerG(): void {
    if (this.currentState !== 'Completed') return;
    this.resendCached();
    this.retransmitInterval = Math.min(2 * this.retransmitInterval, this.timers.T2);
    this.timerG = schedule(this.clock, this.retransmitInterval, () => this.onTimerG());
  }

  private armTimerH(): void {
    this.timerH = schedule(this.clock, this.timers.H, () => this.onTimerH());
  }

  private onTimerH(): void {
    if (this.currentState !== 'Completed') return;
    this.emit({ type: 'timeout', key: this.key });
    this.terminateInternal();
  }

  private armTimerI(): void {
    this.timerI = schedule(this.clock, this.timers.I, () => this.onTimerI());
  }

  private onTimerI(): void {
    if (this.currentState !== 'Confirmed') return;
    this.terminateInternal();
  }

  private armTimerL(): void {
    this.timerL = schedule(this.clock, this.timers.L, () => this.onTimerL());
  }

  private onTimerL(): void {
    if (this.currentState !== 'Accepted') return;
    this.terminateInternal();
  }

  private cancelTimer100(): void {
    cancel(this.clock, this.timer100);
    this.timer100 = -1;
  }

  private cancelTimerG(): void {
    cancel(this.clock, this.timerG);
    this.timerG = -1;
  }

  private cancelTimerH(): void {
    cancel(this.clock, this.timerH);
    this.timerH = -1;
  }

  private terminateInternal(): void {
    if (this.currentState === 'Terminated') return;
    this.currentState = 'Terminated';
    this.clearAllTimers();
    this.emit({ type: 'terminated', key: this.key });
  }

  private clearAllTimers(): void {
    cancel(this.clock, this.timer100);
    cancel(this.clock, this.timerG);
    cancel(this.clock, this.timerH);
    cancel(this.clock, this.timerI);
    cancel(this.clock, this.timerL);
    this.timer100 = -1;
    this.timerG = -1;
    this.timerH = -1;
    this.timerI = -1;
    this.timerL = -1;
  }
}