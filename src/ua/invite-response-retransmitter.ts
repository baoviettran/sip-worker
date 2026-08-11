/**
 * TU-owned 2xx retransmission for INVITE responses (RFC 3261 13.3.1.4).
 *
 * Retransmits a 200 OK response with exponential backoff: T1, 2*T1, 4*T1, ...,
 * capped at T2. Stops when ACK arrives or after 64*T1 timeout.
 */

import type { SipResponseMessage } from '../messages/message.js';
import { serializeMessage } from '../messages/serializer.js';
import type { Clock, Transport } from '../transport/transport.js';
import { TransportError } from '../errors.js';
import { cancel, schedule } from '../transactions/timers.js';

export interface RetransmitterOptions {
  readonly response: SipResponseMessage;
  readonly transport: Transport;
  readonly clock: Clock;
  readonly T1: number;
  readonly T2: number;
  readonly onTimeout?: () => void;
  readonly onError?: (error: TransportError) => void;
}

export class InviteResponseRetransmitter {
  private readonly response: SipResponseMessage;
  private readonly transport: Transport;
  private readonly clock: Clock;
  private readonly T1: number;
  private readonly T2: number;
  private readonly timeoutCallback?: () => void;
  private readonly errorCallback?: (error: TransportError) => void;
  private readonly responseBytes: Uint8Array;

  private currentInterval: number;
  private timerId = -1;
  private timeoutId = -1;
  private stopped = false;

  constructor(options: RetransmitterOptions) {
    this.response = options.response;
    this.transport = options.transport;
    this.clock = options.clock;
    this.T1 = options.T1;
    this.T2 = options.T2;
    this.timeoutCallback = options.onTimeout;
    this.errorCallback = options.onError;
    this.responseBytes = serializeMessage(this.response);
    this.currentInterval = this.T1;
  }

  /** Start retransmission. First retransmit at T1, then 2*T1, 4*T1, ..., T2. */
  start(): void {
    if (this.stopped) return;

    // Schedule first retransmit at T1 (the initial send is done by the transaction layer)
    this.timerId = schedule(this.clock, this.currentInterval, () => this.onTimer());

    // Schedule timeout at 64*T1
    this.timeoutId = schedule(this.clock, 64 * this.T1, () => this.handleTimeout());
  }

  /** Stop retransmission (ACK arrived). */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    cancel(this.clock, this.timerId);
    cancel(this.clock, this.timeoutId);
    this.timerId = -1;
    this.timeoutId = -1;
  }

  private onTimer(): void {
    if (this.stopped) return;

    // Resend
    this.send();
    if (this.stopped) return;

    // Double interval, cap at T2
    this.currentInterval = Math.min(2 * this.currentInterval, this.T2);

    // Schedule next retransmit
    this.timerId = schedule(this.clock, this.currentInterval, () => this.onTimer());
  }

  private send(): void {
    const onError = (reason: unknown): void => {
      if (this.stopped) return;
      const error = reason instanceof TransportError
        ? reason
        : new TransportError(String(reason));
      this.stop();
      this.errorCallback?.(error);
    };

    try {
      void this.transport.send(this.responseBytes).catch(onError);
    } catch (error) {
      onError(error);
    }
  }

  private handleTimeout(): void {
    if (this.stopped) return;
    this.stop();
    if (this.timeoutCallback !== undefined) {
      this.timeoutCallback();
    }
  }
}
