import { TransportError } from '../errors.js';
import type { SipRequestMessage } from '../messages/message.js';
import type { Clock } from '../transport/index.js';
import type {
  TransactionLayer,
  TransactionLayerEvent,
  TransactionKey,
} from '../transactions/index.js';
import { sendOwnedRequest } from '../transactions/request-ownership.js';
import type { LivenessStrategy } from './liveness.js';

/**
 * Build one complete OPTIONS probe. `index` grows monotonically on every probe,
 * so a factory can derive a fresh Via branch and a strictly increasing CSeq per
 * probe while keeping the Call-ID stable across the lifetime of a strategy.
 */
export type RequestFactory = (index: number) => SipRequestMessage;

export interface OptionsLivenessOptions {
  readonly layer: TransactionLayer;
  readonly clock: Clock;
  /** Returns a complete OPTIONS request for probe `index` (index is 1-based, increasing). */
  readonly requestFactory: RequestFactory;
  readonly probeIntervalMs: number;
  readonly onFailure: (error: TransportError) => void;
}

/**
 * Environment-neutral SIP OPTIONS liveness strategy.
 *
 * Each probe period asks the injected request factory for a fresh OPTIONS
 * request (new Via branch, increasing CSeq) and sends it through a non-INVITE
 * client transaction owned exactly once by this strategy. The outstanding slot
 * is cleared only on a final response or a terminal failure:
 *
 * - A final response (2xx-6xx) proves peer liveness and schedules the next probe.
 * - A provisional response (e.g. 100 trying) does NOT complete the probe, so the
 *   underlying transaction keeps running and no second probe overlaps it.
 * - A transaction timeout or transport error reports exactly one liveness
 *   failure, then monitoring continues on the recurring probe timer.
 *
 * `stop()` unsubscribes from its owned probe and schedules nothing further. The
 * strategy drives liveness purely through the TransactionLayer — it never
 * writes directly to a WebSocket and never treats SIP traffic as a
 * protocol-level WebSocket pong.
 */
export class OptionsLiveness implements LivenessStrategy {
  private readonly layer: TransactionLayer;
  private readonly clock: Clock;
  private readonly requestFactory: RequestFactory;
  private readonly probeIntervalMs: number;
  private readonly onFailure: (error: TransportError) => void;

  private started = false;
  private probeTimer?: number;
  private unsubscribe?: () => void;
  private outstanding?: TransactionKey;
  private probeIndex = 0;
  private generation = 0;

  constructor(readonly options: OptionsLivenessOptions) {
    this.layer = options.layer;
    this.clock = options.clock;
    this.requestFactory = options.requestFactory;
    this.probeIntervalMs = options.probeIntervalMs;
    this.onFailure = options.onFailure;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.generation += 1;
    this.probeTimer = this.clock.setTimeout(() => this.sendProbe(), this.probeIntervalMs);
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    this.generation += 1;
    this.cancelProbeTimer();
    this.unsubscribeOwnership();
    this.outstanding = undefined;
  }

  private sendProbe(): void {
    if (!this.started) return;
    const generation = this.generation;
    // Preserve cadence: always reschedule the recurring probe timer, then only
    // skip the probe (no overlap) while a previous probe is still outstanding.
    this.probeTimer = this.clock.setTimeout(() => this.sendProbe(), this.probeIntervalMs);
    if (this.outstanding !== undefined) return;

    this.probeIndex += 1;
    let request: SipRequestMessage;
    try {
      request = this.requestFactory(this.probeIndex);
    } catch (cause) {
      // A synchronous throw from the factory must surface as a typed callback,
      // never escape the clock timer that invoked this probe.
      this.stop();
      this.onFailure(new TransportError('liveness probe failed', cause));
      return;
    }
    this.unsubscribeOwnership();
    sendOwnedRequest(
      this.layer,
      request,
      (unsubscribe, key) => {
        if (!this.started || generation !== this.generation) {
          unsubscribe();
          return;
        }
        this.unsubscribe = unsubscribe;
        this.outstanding = key;
      },
      (event) => this.handleEvent(event),
    );
  }

  private handleEvent(event: TransactionLayerEvent): void {
    if (this.outstanding === undefined) return;
    switch (event.type) {
      case 'response': {
        // A final response only clears the slot when it belongs to the probe
        // transaction we own. The layer carries concurrent traffic (REGISTER,
        // INVITE, BYE) on a shared layer, so an unrelated final response must
        // not clear the outstanding probe slot or a second probe could start.
        const code = event.response.statusCode;
        if (code >= 200 && code <= 699 && event.transaction.key === this.outstanding) {
          // Any final response proves peer liveness; clear the slot so the next
          // probe period can fire. Provisional responses fall through.
          this.clearOutstanding();
        }
        break;
      }
      case 'timeout':
      case 'transportError': {
        if (event.key !== this.outstanding) return;
        this.clearOutstanding();
        const message = event.type === 'timeout' ? 'liveness timeout' : 'liveness transport error';
        this.onFailure(new TransportError(message, event.type === 'transportError' ? event.error : undefined));
        break;
      }
      default:
        break;
    }
  }

  /** Clear the outstanding probe: drop the transaction-layer listener and slot. */
  private clearOutstanding(): void {
    this.unsubscribeOwnership();
    this.outstanding = undefined;
  }

  private unsubscribeOwnership(): void {
    if (this.unsubscribe !== undefined) {
      this.unsubscribe();
      this.unsubscribe = undefined;
    }
  }

  private cancelProbeTimer(): void {
    if (this.probeTimer !== undefined) {
      this.clock.clearTimeout(this.probeTimer);
      this.probeTimer = undefined;
    }
  }
}
