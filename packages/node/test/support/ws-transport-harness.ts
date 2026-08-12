import {
  NodeWebSocketTransport,
  type NodeWebSocketLike,
} from '../../src/transport/ws.js';
import type { TransportContractHarness } from '../../../../test/compatibility/transport-contract.js';

type NodeWebSocketEvent = 'open' | 'message' | 'error' | 'close';

class FakeNodeWebSocket implements NodeWebSocketLike {
  readyState = 0;
  protocol = '';
  readonly sent: Uint8Array[] = [];
  private readonly listeners = new Map<NodeWebSocketEvent, Set<(...args: unknown[]) => void>>();

  on(event: NodeWebSocketEvent, listener: (...args: unknown[]) => void): void {
    let set = this.listeners.get(event);
    if (set === undefined) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(listener);
  }

  off(event: NodeWebSocketEvent, listener: (...args: unknown[]) => void): void {
    this.listeners.get(event)?.delete(listener);
  }

  send(data: Uint8Array, callback: (error?: Error) => void): void {
    this.sent.push(data);
    callback();
  }

  close(): void {
    this.readyState = 3;
  }

  private emit(event: NodeWebSocketEvent, ...args: unknown[]): void {
    for (const listener of [...(this.listeners.get(event) ?? [])]) listener(...args);
  }

  emitOpen(): void {
    this.protocol = 'sip';
    this.readyState = 1;
    this.emit('open');
  }

  emitMessage(data: unknown): void {
    this.emit('message', data);
  }

  emitClose(code = 1005): void {
    this.readyState = 3;
    this.emit('close', code, new Uint8Array());
  }

  emitError(error: Error): void {
    this.emit('error', error);
  }
}

export function createNodeWebSocketTransportHarness(): TransportContractHarness {
  const socket = new FakeNodeWebSocket();
  const transport = new NodeWebSocketTransport(socket);

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