import { TransportError } from '@sip-worker/core';
import type { Clock } from '@sip-worker/core/transport';
import type { LivenessStrategy } from '@sip-worker/core/reliability';

/**
 * The narrow socket surface a liveness strategy needs to run protocol-level
 * Ping/Pong. `NodeWebSocketTransport` adapts an optional injected Node
 * WebSocket implementation to this interface when it exposes native ping/pong.
 */
export interface NativePingSocket {
  ping(payload: Uint8Array): void;
  onPong(listener: (payload: Uint8Array) => void): () => void;
}

export interface NodeWebSocketLivenessOptions {
  readonly socket: NativePingSocket;
  readonly clock: Clock;
  readonly probeIntervalMs: number;
  readonly deadlineMs: number;
  readonly onFailure: (error: TransportError) => void;
}

/**
 * WebSocket liveness via native protocol-level Ping/Pong.
 *
 * Each probe period generates a fresh nonce and sends it with `ping`, then
 * arms a deadline timer. Only the pong that echoes the exact nonce bytes
 * clears the deadline; anything else is ignored. A missed pong stops the
 * strategy and reports a single `TransportError('liveness timeout')`.
 *
 * The strategy owns exactly one recurring probe timer and one deadline timer
 * and never sends a new ping while a previous pong is still outstanding.
 */
export class NodeWebSocketLiveness implements LivenessStrategy {
  private readonly socket: NativePingSocket;
  private readonly clock: Clock;
  private readonly probeIntervalMs: number;
  private readonly deadlineMs: number;
  private readonly onFailure: (error: TransportError) => void;

  private started = false;
  private probeTimer?: number;
  private deadlineTimer?: number;
  private pendingNonce?: Uint8Array;
  private unlisten?: () => void;
  /** Monotonic counter driving a uniqueness-guaranteed nonce per probe. */
  private nonceCounter = 0;

  constructor(readonly options: NodeWebSocketLivenessOptions) {
    this.socket = options.socket;
    this.clock = options.clock;
    this.probeIntervalMs = options.probeIntervalMs;
    this.deadlineMs = options.deadlineMs;
    this.onFailure = options.onFailure;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.unlisten = this.socket.onPong((payload) => this.handlePong(payload));
    this.probeTimer = this.clock.setTimeout(() => this.sendProbe(), this.probeIntervalMs);
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    this.clearDeadline();
    if (this.probeTimer !== undefined) {
      this.clock.clearTimeout(this.probeTimer);
      this.probeTimer = undefined;
    }
    this.pendingNonce = undefined;
    this.unlisten?.();
    this.unlisten = undefined;
  }

  private sendProbe(): void {
    if (!this.started) return;
    this.probeTimer = this.clock.setTimeout(() => this.sendProbe(), this.probeIntervalMs);
    // Never start a second probe while the previous pong is outstanding. Cadence
    // is preserved by the rescheduled timer above, so the next interval can probe
    // as soon as the matching pong clears the outstanding slot.
    if (this.pendingNonce !== undefined) return;
    this.pendingNonce = this.nextNonce();
    try {
      this.socket.ping(this.pendingNonce);
    } catch (cause) {
      // A synchronous throw from ping must surface as a typed callback, never
      // escape the clock timer that invoked this probe.
      this.stop();
      this.onFailure(new TransportError('liveness ping failed', cause));
      return;
    }
    this.deadlineTimer = this.clock.setTimeout(() => this.handleTimeout(), this.deadlineMs);
  }

  private nextNonce(): Uint8Array {
    const nonce = new Uint8Array(16); // fresh 16-byte body, deterministic
    let value = ++this.nonceCounter;
    for (let i = nonce.length - 1; i >= 0 && value > 0; i -= 1) {
      nonce[i] = value % 256;
      value = Math.floor(value / 256);
    }
    return nonce;
  }

  private handlePong(payload: Uint8Array): void {
    if (!this.started || this.pendingNonce === undefined) return;
    if (!equalNonce(this.pendingNonce, payload)) return;
    this.pendingNonce = undefined;
    this.clearDeadline();
  }

  private handleTimeout(): void {
    if (!this.started || this.pendingNonce === undefined) return;
    this.stop();
    this.onFailure(new TransportError('liveness timeout'));
  }

  private clearDeadline(): void {
    if (this.deadlineTimer !== undefined) {
      this.clock.clearTimeout(this.deadlineTimer);
      this.deadlineTimer = undefined;
    }
  }
}

function equalNonce(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i += 1) {
    if (left[i] !== right[i]) return false;
  }
  return true;
}
