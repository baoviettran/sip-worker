import {
  BrowserWebSocketTransport,
  type BrowserWebSocketFactory,
  type BrowserWebSocketLike,
} from '../../src/transport/ws.js';
import type { TransportContractHarness } from '../../../../test/compatibility/transport-contract.js';

type BrowserWebSocketEvent = 'open' | 'message' | 'error' | 'close';

class FakeBrowserWebSocket implements BrowserWebSocketLike {
  readyState = 0;
  protocol = '';
  binaryType = 'blob';
  readonly sent: Uint8Array[] = [];
  private readonly listeners = new Map<BrowserWebSocketEvent, Set<(event: Event) => void>>();

  addEventListener(type: string, listener: (event: Event) => void): void {
    const event = type as BrowserWebSocketEvent;
    let set = this.listeners.get(event);
    if (set === undefined) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(listener);
  }

  removeEventListener(type: string, listener: (event: Event) => void): void {
    this.listeners.get(type as BrowserWebSocketEvent)?.delete(listener);
  }

  send(data: Uint8Array): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = 3;
  }

  private emit(type: BrowserWebSocketEvent, event: object): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener(event as Event);
  }

  emitOpen(): void {
    this.protocol = 'sip';
    this.readyState = 1;
    this.emit('open', {});
  }

  emitMessage(data: unknown): void {
    this.emit('message', { data });
  }

  emitClose(code = 1005): void {
    this.readyState = 3;
    this.emit('close', { code, reason: '' });
  }

  emitError(error: Error): void {
    this.emit('error', { error });
  }
}

export function createBrowserTransportHarness(): TransportContractHarness {
  const socket = new FakeBrowserWebSocket();
  const factory: BrowserWebSocketFactory = () => socket;
  const transport = new BrowserWebSocketTransport('wss://sip.example.test/ws', factory);

  return {
    transport,
    sent: socket.sent,
    open(): void {
      if (transport.isConnected()) return;
      socket.emitOpen();
    },
    deliver(data: Uint8Array): void {
      socket.emitMessage(data);
    },
    remoteClose(error?: Error): void {
      if (error !== undefined) socket.emitError(error);
      socket.emitClose();
    },
  };
}