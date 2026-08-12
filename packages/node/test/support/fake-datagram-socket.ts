import type { DatagramSocketLike } from '../../src/transport/udp.js';

type DatagramEvent = 'message' | 'error' | 'close';
type SocketListener = (...args: unknown[]) => void;

/**
 * Shared fake UDP datagram socket. The node UDP transport tests and the adapter
 * contract harness both drive the same implementation so the lifecycle
 * controls stay in one place.
 */
export class FakeDatagramSocket implements DatagramSocketLike {
  readonly listeners = new Map<DatagramEvent, Set<SocketListener>>();
  readonly offCalls: Array<{ event: DatagramEvent; listener: SocketListener }> = [];
  readonly sent: Array<{ data: Uint8Array; port: number; host: string }> = [];
  boundPort?: number;
  private bindCallback?: () => void;
  private closeCallback?: () => void;
  sendError?: Error;

  bind(port: number, callback: () => void): void {
    this.boundPort = port;
    this.bindCallback = callback;
  }

  send(
    data: Uint8Array,
    port: number,
    host: string,
    callback: (error?: Error) => void,
  ): void {
    this.sent.push({ data, port, host });
    const error = this.sendError;
    this.sendError = undefined;
    callback(error);
  }

  close(callback: () => void): void {
    this.closeCallback = callback;
  }

  on(event: DatagramEvent, listener: SocketListener): void {
    let listeners = this.listeners.get(event);
    if (listeners === undefined) {
      listeners = new Set();
      this.listeners.set(event, listeners);
    }
    listeners.add(listener);
  }

  off(event: DatagramEvent, listener: SocketListener): void {
    this.offCalls.push({ event, listener });
    this.listeners.get(event)?.delete(listener);
  }

  emit(event: DatagramEvent, ...args: unknown[]): void {
    for (const listener of [...(this.listeners.get(event) ?? [])]) listener(...args);
  }

  completeBind(): void {
    this.bindCallback?.();
  }

  completeClose(): void {
    this.closeCallback?.();
  }
}