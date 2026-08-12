import {
  NodeTcpTransport,
  type StreamSocketLike,
} from '../../src/transport/tcp.js';
import type { TransportContractHarness } from '../../../../test/compatibility/transport-contract.js';

type StreamEvent = 'data' | 'error' | 'close';

class FakeStreamSocket implements StreamSocketLike {
  readonly writes: Uint8Array[] = [];
  private readonly listeners = new Map<StreamEvent, Set<(...args: unknown[]) => void>>();
  private connectCallback?: () => void;

  connect(_port: number, _host: string, callback: () => void): void {
    this.connectCallback = callback;
  }

  write(data: Uint8Array, callback: (error?: Error) => void): void {
    this.writes.push(data);
    callback();
  }

  end(_callback: () => void): void {
    // Half-close: the transport settles only once the socket emits `close`.
  }

  on(event: StreamEvent, listener: (...args: unknown[]) => void): void {
    let set = this.listeners.get(event);
    if (set === undefined) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(listener);
  }

  off(event: StreamEvent, listener: (...args: unknown[]) => void): void {
    this.listeners.get(event)?.delete(listener);
  }

  private emit(event: StreamEvent, ...args: unknown[]): void {
    for (const listener of [...(this.listeners.get(event) ?? [])]) listener(...args);
  }

  completeConnect(): void {
    this.connectCallback?.();
  }

  emitData(data: Uint8Array): void {
    this.emit('data', data);
  }

  emitError(error: Error): void {
    this.emit('error', error);
  }

  emitClose(): void {
    this.emit('close');
  }
}

export function createNodeTcpTransportHarness(): TransportContractHarness {
  const socket = new FakeStreamSocket();
  const transport = new NodeTcpTransport(socket, {
    host: 'sip.example.test',
    port: 5060,
  });

  return {
    transport,
    sent: socket.writes,
    open(): void {
      socket.completeConnect();
    },
    deliver(data: Uint8Array): void {
      socket.emitData(data);
    },
    remoteClose(error?: Error): void {
      if (error !== undefined) socket.emitError(error);
      socket.emitClose();
    },
  };
}