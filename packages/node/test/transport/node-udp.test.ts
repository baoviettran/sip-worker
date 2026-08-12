import { describe, expect, expectTypeOf, it } from 'vitest';
import { TransportError } from '@sip-worker/core';
import {
  NodeUdpTransport,
  type DatagramSocketLike,
} from '../../src/transport/udp.js';
import type { TransportEvent } from '@sip-worker/core/transport';
import { FakeDatagramSocket } from '../support/fake-datagram-socket.js';

type DatagramEvent = 'message' | 'error' | 'close';
type SocketListener = (...args: unknown[]) => void;

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
      remoteAddresses: ['192.0.2.10'],
    }),
  };
}

async function connect(socket: FakeDatagramSocket, transport: NodeUdpTransport): Promise<void> {
  const pending = transport.connect();
  socket.completeBind();
  await pending;
}

describe('NodeUdpTransport', () => {
  it('requires injected sockets to provide listener removal', () => {
    expectTypeOf<DatagramSocketLike['off']>().toEqualTypeOf<
      (event: DatagramEvent, listener: SocketListener) => void
    >();
  });

  it('advertises datagram capabilities and emits a copied event for each datagram', async () => {
    const { socket, transport } = createTransport();
    const events: TransportEvent[] = [];
    transport.subscribe((event) => events.push(event));
    await connect(socket, transport);
    const first = new Uint8Array([1, 2, 3]);
    const second = new Uint8Array([4]);

    socket.emit('message', first, { address: '192.0.2.10', port: 5070 });
    socket.emit('message', second, { address: '192.0.2.10', port: 5070 });
    first[0] = 9;
    second[0] = 9;

    expect(transport.capabilities).toEqual({ reliable: false, framing: 'datagram', token: 'UDP' });
    expect(Object.isFrozen(transport.capabilities)).toBe(true);
    expect(events.filter((event) => event.type === 'data')).toEqual([
      { type: 'data', data: new Uint8Array([1, 2, 3]) },
      { type: 'data', data: new Uint8Array([4]) },
    ]);
  });

  it('accepts a resolved address for a configured hostname', async () => {
    const socket = new FakeDatagramSocket();
    const transport = new NodeUdpTransport(socket, {
      localPort: 5060,
      remoteHost: 'sip.example.test',
      remotePort: 5070,
      remoteAddresses: ['192.0.2.10'],
    });
    const data: TransportEvent[] = [];
    transport.subscribe((event) => data.push(event));
    await connect(socket, transport);

    socket.emit('message', new Uint8Array([1]), { address: '192.0.2.10', port: 5070 });
    socket.emit('message', new Uint8Array([2]), { address: '192.0.2.11', port: 5070 });

    expect(data.filter((event) => event.type === 'data')).toEqual([
      { type: 'data', data: new Uint8Array([1]) },
    ]);
  });

  it('silently drops datagrams from a peer other than the configured remote', async () => {
    const socket = new FakeDatagramSocket();
    const transport = new NodeUdpTransport(socket, {
      localPort: 5060,
      remoteHost: '192.0.2.10',
      remotePort: 5070,
    });
    const events: TransportEvent[] = [];
    transport.subscribe((event) => events.push(event));
    await connect(socket, transport);

    const foreign = new Uint8Array([9, 9, 9]);
    socket.emit('message', foreign, { address: 'evil.example.test', port: 5070 });
    socket.emit('message', foreign, { address: '192.0.2.10', port: 9999 });

    expect(events.filter((event) => event.type === 'data')).toHaveLength(0);
    expect(events.filter((event) => event.type === 'error')).toHaveLength(0);
    expect(transport.isConnected()).toBe(true);
  });

  it('fails closed when a hostname has no resolved-address allowlist', () => {
    expect(() => new NodeUdpTransport(new FakeDatagramSocket(), {
      localPort: 5060,
      remoteHost: 'sip.example.test',
      remotePort: 5070,
    })).toThrow('remoteAddresses is required when remoteHost is a hostname');
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
    transport.subscribe(() => {
      throw new Error('observer failed');
    });

    const pending = transport.connect();
    expect(() => socket.emit('error', cause)).not.toThrow();
    await expect(pending).rejects.toMatchObject({ name: 'TransportError', cause });
    socket.completeBind();

    expect(transport.isConnected()).toBe(false);
    expect(events.filter((event) => event.type === 'connected')).toHaveLength(0);
    expect(events).toContainEqual({
      type: 'error',
      error: expect.objectContaining({ name: 'TransportError', cause }),
    });
  });

  it('is one-shot: a failed connect permanently closes the transport', async () => {
    const { socket, transport } = createTransport();
    const events: TransportEvent[] = [];
    const cause = new Error('bind failed');
    transport.subscribe((event) => events.push(event));

    const pending = transport.connect();
    socket.emit('error', cause);
    await expect(pending).rejects.toMatchObject({ name: 'TransportError', cause });
    await expect(transport.connect()).rejects.toBeInstanceOf(TransportError);
    expect(transport.isConnected()).toBe(false);
    expect(events).toContainEqual({
      type: 'disconnected',
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

  it('settles disconnect before notifying a throwing subscriber', async () => {
    const { socket, transport } = createTransport();
    await connect(socket, transport);
    transport.subscribe(() => {
      throw new Error('subscriber failed');
    });

    let outcome = 'pending';
    const disconnected = transport.disconnect().then(
      () => { outcome = 'resolved'; },
      () => { outcome = 'rejected'; },
    );

    expect(() => socket.emit('close')).not.toThrow();
    await Promise.resolve();

    expect(outcome).toBe('resolved');
    await disconnected;
  });
});
