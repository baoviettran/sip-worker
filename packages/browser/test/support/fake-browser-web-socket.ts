import type { BrowserWebSocketLike } from '../../src/transport/ws.js';

type BrowserWebSocketEvent = 'open' | 'message' | 'error' | 'close';
type BrowserListener = (event: Event) => void;

/**
 * Shared fake browser WebSocket. The browser transport tests and the adapter
 * contract harness both drive the same implementation so the lifecycle
 * controls stay in one place.
 */
export class FakeBrowserWebSocket implements BrowserWebSocketLike {
  readonly listeners = new Map<BrowserWebSocketEvent, Set<BrowserListener>>();
  readonly removeCalls: Array<{ type: BrowserWebSocketEvent; listener: BrowserListener }> = [];
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
  binaryType = 'blob';
  closeCalls: Array<{ code?: number; reason?: string }> = [];
  pingCalls = 0;

  addEventListener(type: string, listener: (event: Event) => void): void {
    const event = type as BrowserWebSocketEvent;
    let listeners = this.listeners.get(event);
    if (listeners === undefined) {
      listeners = new Set();
      this.listeners.set(event, listeners);
    }
    listeners.add(listener);
  }

  removeEventListener(type: string, listener: (event: Event) => void): void {
    const event = type as BrowserWebSocketEvent;
    this.removeCalls.push({ type: event, listener });
    this.listeners.get(event)?.delete(listener);
  }

  send(data: Uint8Array): void {
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.closeCalls.push({ code, reason });
  }

  ping(): void {
    this.pingCalls += 1;
  }

  emitOpen(protocol = 'sip'): void {
    this.protocol = protocol;
    this.readyState = 1;
    this.emit('open', {});
  }

  emitMessage(data: unknown): void {
    this.emit('message', { data });
  }

  emitError(error: Error): void {
    this.emit('error', { error });
  }

  emitClose(code = 1000, reason = ''): void {
    this.readyState = 3;
    this.emit('close', { code, reason });
  }

  private emit(type: BrowserWebSocketEvent, event: object): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) {
      listener(event as Event);
    }
  }
}