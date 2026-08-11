import { describe, expect, it } from 'vitest';
import { TransportError } from '../../src/errors.js';
import {
  NodeWebSocketTransport,
  type NodeWebSocketLike,
} from '../../src/transport/node/ws.js';
import type { TransportEvent } from '../../src/transport/index.js';

type NodeWebSocketEvent = 'open' | 'message' | 'error' | 'close';
type SocketListener = (...args: unknown[]) => void;

class FakeNodeWebSocket implements NodeWebSocketLike {
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

async function connect(
  socket: FakeNodeWebSocket,
  transport: NodeWebSocketTransport,
): Promise<void> {
  const pending = transport.connect();
  socket.emitOpen();
  await pending;
}

describe('NodeWebSocketTransport', () => {
  it('advertises an explicit Via token (WS by default, WSS on request)', () => {
    const socket = new FakeNodeWebSocket();
    const plain = new NodeWebSocketTransport(socket);
    const wss = new NodeWebSocketTransport(socket, { token: 'WSS' });
    expect(plain.capabilities.token).toBe('WS');
    expect(wss.capabilities.token).toBe('WSS');
  });

  it('waits for open, requires the sip protocol, and advertises message capabilities', async () => {
    const socket = new FakeNodeWebSocket();
    const transport = new NodeWebSocketTransport(socket);
    const events: TransportEvent[] = [];
    let settled = false;
    transport.subscribe((event) => events.push(event));

    const pending = transport.connect().then(() => {
      settled = true;
    });
    await Promise.resolve();

    expect(settled).toBe(false);
    expect(transport.isConnected()).toBe(false);
    expect(transport.capabilities).toEqual({ reliable: true, framing: 'message', token: 'WS' });
    expect(Object.isFrozen(transport.capabilities)).toBe(true);

    socket.emitOpen('sip');
    await pending;

    expect(transport.isConnected()).toBe(true);
    expect(events.filter((event) => event.type === 'connected')).toHaveLength(1);
  });

  it('rejects a pre-open socket error and ignores a late open', async () => {
    const socket = new FakeNodeWebSocket();
    const transport = new NodeWebSocketTransport(socket);
    const events: TransportEvent[] = [];
    const cause = new Error('handshake failed');
    transport.subscribe((event) => events.push(event));

    const pending = transport.connect();
    socket.emitError(cause);

    await expect(pending).rejects.toMatchObject({ name: 'TransportError', cause });
    socket.emitOpen();
    expect(transport.isConnected()).toBe(false);
    expect(socket.closeCalls).toEqual([{}]);
    expect(socket.offCalls.map(({ event }) => event).sort()).toEqual([
      'close',
      'error',
      'message',
      'open',
    ]);
    expect(events).toContainEqual({
      type: 'error',
      error: expect.objectContaining({ name: 'TransportError', cause }),
    });
    expect(events).toContainEqual({
      type: 'disconnected',
      error: expect.objectContaining({ name: 'TransportError', cause }),
    });
    expect(events.filter((event) => event.type === 'connected')).toHaveLength(0);
  });

  it('rejects a pre-open socket error when a subscriber throws', async () => {
    const socket = new FakeNodeWebSocket();
    const transport = new NodeWebSocketTransport(socket);
    const cause = new Error('handshake failed');
    transport.subscribe(() => {
      throw new Error('subscriber failed');
    });

    let rejection: unknown;
    const connected = transport.connect().catch((error: unknown) => {
      rejection = error;
    });

    expect(() => socket.emitError(cause)).toThrow('subscriber failed');
    await Promise.resolve();

    expect(rejection).toMatchObject({ name: 'TransportError', cause });
    await connected;
  });

  it('rejects a connection that negotiates another subprotocol', async () => {
    const socket = new FakeNodeWebSocket();
    const transport = new NodeWebSocketTransport(socket);
    const events: TransportEvent[] = [];
    transport.subscribe((event) => events.push(event));

    const pending = transport.connect();
    socket.emitOpen('chat');

    await expect(pending).rejects.toBeInstanceOf(TransportError);
    expect(transport.isConnected()).toBe(false);
    expect(socket.closeCalls).toHaveLength(1);
    expect(events).toContainEqual({
      type: 'error',
      error: expect.objectContaining({ name: 'TransportError' }),
    });
  });

  it('copies supported inbound forms and preserves an empty message as data', async () => {
    const socket = new FakeNodeWebSocket();
    const transport = new NodeWebSocketTransport(socket);
    const events: TransportEvent[] = [];
    transport.subscribe((event) => events.push(event));
    await connect(socket, transport);

    const buffer = new Uint8Array([2, 3]).buffer;
    const backing = new Uint8Array([9, 4, 5, 9]);
    const view = new DataView(backing.buffer, 1, 2);
    socket.emitMessage('A');
    socket.emitMessage(buffer);
    socket.emitMessage(view);
    socket.emitMessage('');
    new Uint8Array(buffer).fill(8);
    backing.fill(8);

    expect(events.filter((event) => event.type === 'data')).toEqual([
      { type: 'data', data: new Uint8Array([65]) },
      { type: 'data', data: new Uint8Array([2, 3]) },
      { type: 'data', data: new Uint8Array([4, 5]) },
      { type: 'data', data: new Uint8Array() },
    ]);
  });

  it('copies outbound bytes, reports send failures, and sends only while OPEN', async () => {
    const socket = new FakeNodeWebSocket();
    const transport = new NodeWebSocketTransport(socket);
    const data = new Uint8Array([6, 7]);

    await expect(transport.send(data)).rejects.toBeInstanceOf(TransportError);
    await connect(socket, transport);
    await transport.send(data);
    data[0] = 9;

    expect(socket.sent).toEqual([new Uint8Array([6, 7])]);
    expect(socket.sent[0]).not.toBe(data);

    socket.readyState = 0;
    await expect(transport.send(new Uint8Array([1]))).rejects.toBeInstanceOf(TransportError);
    socket.readyState = 1;
    const cause = new Error('send failed');
    socket.sendError = cause;
    await expect(transport.send(new Uint8Array([2]))).rejects.toMatchObject({
      name: 'TransportError',
      cause,
    });
  });

  it('emits typed error and close events without overwriting callback properties', async () => {
    const socket = new FakeNodeWebSocket();
    const transport = new NodeWebSocketTransport(socket);
    const events: TransportEvent[] = [];
    const cause = new Error('socket failed');
    transport.subscribe((event) => events.push(event));
    await connect(socket, transport);

    socket.emitError(cause);
    socket.emitClose(1006);

    expect(events).toContainEqual({
      type: 'error',
      error: expect.objectContaining({ name: 'TransportError', cause }),
    });
    expect(events.filter((event) => event.type === 'disconnected')).toEqual([
      {
        type: 'disconnected',
        error: expect.objectContaining({ name: 'TransportError' }),
      },
    ]);
    expect(socket.onopen).toBe(socket.originalOnOpen);
    expect(socket.onmessage).toBe(socket.originalOnMessage);
    expect(socket.onerror).toBe(socket.originalOnError);
    expect(socket.onclose).toBe(socket.originalOnClose);
    expect(socket.offCalls.map(({ event }) => event).sort()).toEqual([
      'close',
      'error',
      'message',
      'open',
    ]);
  });

  it('waits for close when disconnecting and rejects sends immediately', async () => {
    const socket = new FakeNodeWebSocket();
    const transport = new NodeWebSocketTransport(socket);
    await connect(socket, transport);

    let settled = false;
    const pending = transport.disconnect().then(() => {
      settled = true;
    });
    await Promise.resolve();

    expect(settled).toBe(false);
    expect(socket.closeCalls).toEqual([{ code: 1000, reason: undefined }]);
    await expect(transport.send(new Uint8Array([1]))).rejects.toBeInstanceOf(TransportError);

    socket.emitClose(1005);
    await pending;
    expect(settled).toBe(true);
  });

  it('settles disconnect before notifying a throwing subscriber', async () => {
    const socket = new FakeNodeWebSocket();
    const transport = new NodeWebSocketTransport(socket);
    await connect(socket, transport);
    transport.subscribe(() => {
      throw new Error('subscriber failed');
    });

    let outcome = 'pending';
    const disconnected = transport.disconnect().then(
      () => { outcome = 'resolved'; },
      () => { outcome = 'rejected'; },
    );

    expect(() => socket.emitClose(1005)).toThrow('subscriber failed');
    await Promise.resolve();

    expect(outcome).toBe('resolved');
    await disconnected;
  });
});
