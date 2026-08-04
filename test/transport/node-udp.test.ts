import { describe, expect, it } from 'vitest';
import { TransportError } from '../../src/errors.js';
import {
  NodeUdpTransport,
  type DatagramSocketLike,
} from '../../src/transport/node/udp.js';
import type { TransportEvent } from '../../src/transport/index.js';

type DatagramEvent = 'message' | 'error' | 'close';
type SocketListener = (...args: unknown[]) => void;

class FakeDatagramSocket implements DatagramSocketLike {
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

function createTransport(socket = new FakeDatagramSocket()): {
  socket: FakeDatagramSocket;
  transport: NodeUdpTransport;
} {
  return {
    socket,
    transport: new NodeUdpTransport(socket, {
      localPort: 5060,
      remoteHost: 'sip.example.test',
      remotePort: 5070,
    }),
  };
}

async function connect(socket: FakeDatagramSocket, transport: NodeUdpTransport): Promise<void> {
  const pending = transport.connect();
  socket.completeBind();
  await pending;
}

describe('NodeUdpTransport', () => {
  it('advertises datagram capabilities and emits a copied event for each datagram', async () => {
    const { socket, transport } = createTransport();
    const events: TransportEvent[] = [];
    transport.subscribe((event) => events.push(event));
    await connect(socket, transport);
    const first = new Uint8Array([1, 2, 3]);
    const second = new Uint8Array([4]);

    socket.emit('message', first, { address: '127.0.0.1' });
    socket.emit('message', second, { address: '127.0.0.1' });
    first[0] = 9;
    second[0] = 9;

    expect(transport.capabilities).toEqual({ reliable: false, framing: 'datagram' });
    expect(Object.isFrozen(transport.capabilities)).toBe(true);
    expect(events.filter((event) => event.type === 'data')).toEqual([
      { type: 'data', data: new Uint8Array([1, 2, 3]) },
      { type: 'data', data: new Uint8Array([4]) },
    ]);
  });

  it('binds locally and copies outbound bytes to the configured peer', async () => {
    const { socket, transport } = createTransport();
    const data = new Uint8Array([5, 6]);

    await connect(socket, transport);
    await transport.send(data);
    data[0] = 9;

    expect(socket.boundPort).toBe(5060);
    expect(socket.sent).toEqual([
      { data: new Uint8Array([5, 6]), port: 5070, host: 'sip.example.test' },
    ]);
    expect(socket.sent[0]?.data).not.toBe(data);
  });

  it('wraps send callback failures as TransportError', async () => {
    const { socket, transport } = createTransport();
    const cause = new Error('send failed');
    await connect(socket, transport);
    socket.sendError = cause;

    await expect(transport.send(new Uint8Array([1]))).rejects.toMatchObject({
      name: 'TransportError',
      cause,
    });
  });

  it('rejects a failed connect once and ignores a late bind callback', async () => {
    const { socket, transport } = createTransport();
    const events: TransportEvent[] = [];
    const cause = new Error('bind failed');
    transport.subscribe((event) => events.push(event));

    const pending = transport.connect();
    socket.emit('error', cause);
    await expect(pending).rejects.toMatchObject({ name: 'TransportError', cause });
    socket.completeBind();

    expect(transport.isConnected()).toBe(false);
    expect(events.filter((event) => event.type === 'connected')).toHaveLength(0);
    expect(events).toContainEqual({
      type: 'error',
      error: expect.objectContaining({ name: 'TransportError', cause }),
    });
  });

  it('settles disconnect once, rejects post-close sends, and removes socket listeners', async () => {
    const { socket, transport } = createTransport();
    const events: TransportEvent[] = [];
    transport.subscribe((event) => events.push(event));
    const connected = transport.connect();
    socket.completeBind();
    socket.completeBind();
    await connected;

    const disconnected = transport.disconnect();
    socket.emit('close');
    socket.completeClose();
    await disconnected;

    expect(events.filter((event) => event.type === 'connected')).toHaveLength(1);
    expect(events.filter((event) => event.type === 'disconnected')).toHaveLength(1);
    await expect(transport.send(new Uint8Array([1]))).rejects.toBeInstanceOf(TransportError);
    expect(socket.offCalls.map(({ event }) => event).sort()).toEqual(['close', 'error', 'message']);
    expect([...socket.listeners.values()].every((listeners) => listeners.size === 0)).toBe(true);
  });
});
