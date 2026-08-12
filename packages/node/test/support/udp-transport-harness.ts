import {
  NodeUdpTransport,
  type DatagramSocketLike,
} from '../../src/transport/udp.js';
import type { TransportContractHarness } from '../../../../test/compatibility/transport-contract.js';

type DatagramEvent = 'message' | 'error' | 'close';

class FakeDatagramSocket implements DatagramSocketLike {
  readonly sent: Uint8Array[] = [];
  private readonly listeners = new Map<DatagramEvent, Set<(...args: unknown[]) => void>>();
  private bindCallback?: () => void;

  bind(_port: number, callback: () => void): void {
    this.bindCallback = callback;
  }

  send(data: Uint8Array, _port: number, _host: string, callback: (error?: Error) => void): void {
    this.sent.push(data);
    callback();
  }

  close(_callback: () => void): void {
    // The datagram transport settles once the socket emits `close`.
  }

  on(event: DatagramEvent, listener: (...args: unknown[]) => void): void {
    let set = this.listeners.get(event);
    if (set === undefined) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(listener);
  }

  off(event: DatagramEvent, listener: (...args: unknown[]) => void): void {
    this.listeners.get(event)?.delete(listener);
  }

  private emit(event: DatagramEvent, ...args: unknown[]): void {
    for (const listener of [...(this.listeners.get(event) ?? [])]) listener(...args);
  }

  completeBind(): void {
    this.bindCallback?.();
  }

  emitMessage(data: Uint8Array): void {
    this.emit('message', data, { address: '192.0.2.10', port: 5070 });
  }

  emitError(error: Error): void {
    this.emit('error', error);
  }

  emitClose(): void {
    this.emit('close');
  }
}

export function createNodeUdpTransportHarness(): TransportContractHarness {
  const socket = new FakeDatagramSocket();
  const transport = new NodeUdpTransport(socket, {
    localPort: 5060,
    remoteHost: 'sip.example.test',
    remotePort: 5070,
    remoteAddresses: ['192.0.2.10'],
  });

  return {
    transport,
    sent: socket.sent,
    open(): void {
      socket.completeBind();
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