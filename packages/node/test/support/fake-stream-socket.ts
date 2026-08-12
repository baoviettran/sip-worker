import type { StreamSocketLike } from '../../src/transport/tcp.js';

type StreamEvent = 'data' | 'error' | 'close';
type SocketListener = (...args: unknown[]) => void;

/**
 * Shared fake TCP stream socket. The node TCP transport tests and the adapter
 * contract harness both drive the same implementation so the lifecycle
 * controls stay in one place.
 */
export class FakeStreamSocket implements StreamSocketLike {
  readonly listeners = new Map<StreamEvent, Set<SocketListener>>();
  readonly offCalls: Array<{ event: StreamEvent; listener: SocketListener }> = [];
  readonly writes: Uint8Array[] = [];
  connectedTo?: { port: number; host: string };
  private connectCallback?: () => void;
  private endCallback?: () => void;
  writeError?: Error;

  connect(port: number, host: string, callback: () => void): void {
    this.connectedTo = { port, host };
    this.connectCallback = callback;
  }

  write(data: Uint8Array, callback: (error?: Error) => void): void {
    this.writes.push(data);
    const error = this.writeError;
    this.writeError = undefined;
    callback(error);
  }

  end(callback: () => void): void {
    this.endCallback = callback;
  }

  on(event: StreamEvent, listener: SocketListener): void {
    let listeners = this.listeners.get(event);
    if (listeners === undefined) {
      listeners = new Set();
      this.listeners.set(event, listeners);
    }
    listeners.add(listener);
  }

  off(event: StreamEvent, listener: SocketListener): void {
    this.offCalls.push({ event, listener });
    this.listeners.get(event)?.delete(listener);
  }

  emit(event: StreamEvent, ...args: unknown[]): void {
    for (const listener of [...(this.listeners.get(event) ?? [])]) listener(...args);
  }

  completeConnect(): void {
    this.connectCallback?.();
  }

  completeEnd(): void {
    this.endCallback?.();
  }
}