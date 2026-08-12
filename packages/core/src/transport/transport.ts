import type { TransportError } from '../errors.js';

/**
 * The SIP transport protocol a Via header must advertise (RFC 3261 18.1.1).
 * `WS` is a plain WebSocket, `WSS` a secure one (RFC 7118).
 */
export type TransportToken = 'UDP' | 'TCP' | 'WS' | 'WSS';

export interface TransportCapabilities {
  readonly reliable: boolean;
  readonly framing: 'datagram' | 'stream' | 'message';
  readonly token: TransportToken;
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
 * `disconnect()` resolves once the connection is fully torn down (or rejects
 * on teardown failure). After either `disconnect()` or a failed `connect()`,
 * the instance is closed and further `connect()` calls reject — reconnecting
 * requires a new instance.
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
