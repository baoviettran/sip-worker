import type { NodeWebSocketLike } from '../../src/transport/ws.js';

type NodeWebSocketEvent = 'open' | 'message' | 'error' | 'close';
type SocketListener = (...args: unknown[]) => void;

/**
 * Shared fake Node WebSocket. The node WebSocket transport tests and the
 * adapter contract harness both drive the same implementation so the lifecycle
 * controls stay in one place.
 */
export class FakeNodeWebSocket implements NodeWebSocketLike {
  readonly listeners = new Map<NodeWebSocketEvent, Set<SocketListener>>();
  readonly offCalls: Array<{ event: NodeWebSocketEvent; listener: SocketListener }> = [];
  readonly sent: Uint8Array[] = [];
  readonly originalOnOpen = () => undefined;
  readonly originalOnMessage = () => undefined;
  readonly originalOnError = () => undefined;
  readonly originalOnClose = () => undefined;
  onopen = this.originalOnOpen;
  onmessage = this.originalOnMessage;
  onerror = this.originalOnError;
  onclose = this.originalOnClose;
  readyState = 0;
  protocol = '';
  closeCalls: Array<{ code?: number; reason?: string }> = [];
  sendError?: Error;
  closeError?: Error;

  on(event: NodeWebSocketEvent, listener: SocketListener): void {
    let listeners = this.listeners.get(event);
    if (listeners === undefined) {
      listeners = new Set();
      this.listeners.set(event, listeners);
    }
    listeners.add(listener);
  }

  off(event: NodeWebSocketEvent, listener: SocketListener): void {
    this.offCalls.push({ event, listener });
    this.listeners.get(event)?.delete(listener);
  }

  send(data: Uint8Array, callback: (error?: Error) => void): void {
    this.sent.push(data);
    const error = this.sendError;
    this.sendError = undefined;
    callback(error);
  }

  close(code?: number, reason?: string): void {
    this.closeCalls.push({ code, reason });
    const error = this.closeError;
    if (error !== undefined) throw error;
  }

  emitOpen(protocol = 'sip'): void {
    this.protocol = protocol;
    this.readyState = 1;
    this.emit('open');
  }

  emitMessage(data: unknown): void {
    this.emit('message', data);
  }

  emitError(error: Error): void {
    this.emit('error', error);
  }

  emitClose(code = 1000, reason = new Uint8Array()): void {
    this.readyState = 3;
    this.emit('close', code, reason);
  }

  private emit(event: NodeWebSocketEvent, ...args: unknown[]): void {
    for (const listener of [...(this.listeners.get(event) ?? [])]) listener(...args);
  }
}