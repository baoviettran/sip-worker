import type { TransportError } from '../errors.js';

export interface TransportCapabilities {
  readonly reliable: boolean;
  readonly framing: 'datagram' | 'stream' | 'message';
}

export type TransportEvent =
  | { readonly type: 'connected' }
  | { readonly type: 'data'; readonly data: Uint8Array }
  | { readonly type: 'disconnected'; readonly error?: TransportError }
  | { readonly type: 'error'; readonly error: TransportError };

/**
 * A single SIP transport connection boundary.
 *
 * Lifecycle: a `Transport` instance owns one connection attempt. `connect()`
 * resolves when the connection is established (or rejects on failure), and
 * `disconnect()` resolves when the connection is fully torn down. After either
 * `disconnect()` or a failed `connect()`, the instance is closed and further
 * `connect()` calls reject — reconnecting requires a new instance.
 *
 * Sends: `send()` resolves when the bytes are handed to the underlying socket
 * (fire-and-forget), not when they reach the peer. Callers get no delivery
 * confirmation; the transport does not queue or retry.
 *
 * `capabilities` is frozen at runtime and readonly at the type level.
 */
export interface Transport {
  readonly capabilities: Readonly<TransportCapabilities>;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  send(data: Uint8Array): Promise<void>;
  subscribe(listener: (event: TransportEvent) => void): () => void;
  isConnected(): boolean;
}

export interface Clock {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): number;
  clearTimeout(id: number): void;
}
