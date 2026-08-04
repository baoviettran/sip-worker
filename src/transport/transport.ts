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

export interface Transport {
  readonly capabilities: TransportCapabilities;
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
