import { describe, expect, it } from 'vitest';
import { TransportError } from '@sip-worker/core';
import {
  BrowserWebSocketTransport,
  type BrowserWebSocketFactory,
  type BrowserWebSocketLike,
} from '../../src/transport/ws.js';
import type { TransportEvent } from '@sip-worker/core/transport';

type BrowserWebSocketEvent = 'open' | 'message' | 'error' | 'close';
type BrowserListener = (event: Event) => void;

class FakeBrowserWebSocket implements BrowserWebSocketLike {
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

function createTransport(): {
  socket: FakeBrowserWebSocket;
  factory: BrowserWebSocketFactory;
  calls: Array<{ url: string; protocols: string[] }>;
  transport: BrowserWebSocketTransport;
} {
  const socket = new FakeBrowserWebSocket();
  const calls: Array<{ url: string; protocols: string[] }> = [];
  const factory: BrowserWebSocketFactory = (url, protocols) => {
    calls.push({ url, protocols });
    return socket;
  };
  return {
    socket,
    factory,
    calls,
    transport: new BrowserWebSocketTransport('wss://sip.example.test/ws', factory),
  };
}

async function connect(
  socket: FakeBrowserWebSocket,
  transport: BrowserWebSocketTransport,
): Promise<void> {
  const pending = transport.connect();
  socket.emitOpen();
  await pending;
}

describe('BrowserWebSocketTransport', () => {
  it('derives the Via token from the URL scheme (wss -> WSS, ws -> WS)', () => {
    const { socket, factory } = createTransport();
    const wss = new BrowserWebSocketTransport('wss://sip.example.test/ws', factory);
    const plain = new BrowserWebSocketTransport('ws://sip.example.test/ws', factory);
    expect(wss.capabilities.token).toBe('WSS');
    expect(plain.capabilities.token).toBe('WS');
    expect(socket).toBeDefined();
  });

  it('creates the socket on connect, requests sip, and waits for open', async () => {
    const { socket, calls, transport } = createTransport();
    const events: TransportEvent[] = [];
    let settled = false;
    transport.subscribe((event) => events.push(event));

    expect(calls).toHaveLength(0);
    const pending = transport.connect().then(() => {
      settled = true;
    });
    await Promise.resolve();

    expect(calls).toEqual([
      { url: 'wss://sip.example.test/ws', protocols: ['sip'] },
    ]);
    expect(socket.binaryType).toBe('arraybuffer');
    expect(settled).toBe(false);
    expect(transport.capabilities).toEqual({ reliable: true, framing: 'message', token: 'WSS' });
    expect(Object.isFrozen(transport.capabilities)).toBe(true);

    socket.emitOpen('sip');
    await pending;
    expect(transport.isConnected()).toBe(true);
    expect(events.filter((event) => event.type === 'connected')).toHaveLength(1);
  });

  it('converts a synchronously-throwing factory to a typed error and closes', async () => {
    const cause = new Error('factory threw');
    const factory: BrowserWebSocketFactory = () => {
      throw cause;
    };
    const transport = new BrowserWebSocketTransport('wss://sip.example.test/ws', factory);
    const events: TransportEvent[] = [];
    transport.subscribe((event) => events.push(event));

    await expect(transport.connect()).rejects.toMatchObject({ name: 'TransportError', cause });
    expect(transport.isConnected()).toBe(false);
    expect(events).toContainEqual({
      type: 'error',
      error: expect.objectContaining({ name: 'TransportError', cause }),
    });
    expect(events).toContainEqual({
      type: 'disconnected',
      error: expect.objectContaining({ name: 'TransportError', cause }),
    });
  });

  it('rejects a pre-open browser error and ignores a late open', async () => {
    const { socket, transport } = createTransport();
    const events: TransportEvent[] = [];
    const cause = new Error('handshake failed');
    transport.subscribe((event) => events.push(event));

    const pending = transport.connect();
    socket.emitError(cause);

    await expect(pending).rejects.toMatchObject({ name: 'TransportError', cause });
    socket.emitOpen();
    expect(transport.isConnected()).toBe(false);
    expect(socket.closeCalls).toEqual([{}]);
    expect(socket.removeCalls.map(({ type }) => type).sort()).toEqual([
      'close',
      'error',
      'message',
      'open',
    ]);
    expect(events).toContainEqual({
      type: 'error',
      error: expect.objectContaining({ name: 'TransportError', cause }),
    });
    expect(events.filter((event) => event.type === 'connected')).toHaveLength(0);
    expect(events).toContainEqual({
      type: 'disconnected',
      error: expect.objectContaining({ name: 'TransportError', cause }),
    });
  });

  it('rejects a pre-open browser error without letting a throwing observer block it', async () => {
    const { socket, transport } = createTransport();
    const events: TransportEvent[] = [];
    const cause = new Error('handshake failed');
    transport.subscribe(() => {
      throw new Error('observer failed');
    });
    transport.subscribe((event) => events.push(event));

    let rejection: unknown;
    const connected = transport.connect().catch((error: unknown) => {
      rejection = error;
    });

    expect(() => socket.emitError(cause)).not.toThrow();
    await Promise.resolve();

    expect(rejection).toMatchObject({ name: 'TransportError', cause });
    await connected;
    expect(events).toContainEqual({
      type: 'error',
      error: expect.objectContaining({ name: 'TransportError', cause }),
    });
  });

  it('rejects a connection that negotiates another subprotocol', async () => {
    const { socket, transport } = createTransport();
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
    const { socket, transport } = createTransport();
    const events: TransportEvent[] = [];
    transport.subscribe((event) => events.push(event));
    await connect(socket, transport);

    const buffer = new Uint8Array([2, 3]).buffer;
    const backing = new Uint8Array([9, 4, 5, 9]);
    const typedView = new Uint8Array(backing.buffer, 1, 2);
    const dataView = new DataView(backing.buffer, 1, 2);
    socket.emitMessage('A');
    socket.emitMessage(buffer);
    socket.emitMessage(typedView);
    socket.emitMessage(dataView);
    socket.emitMessage('');
    new Uint8Array(buffer).fill(8);
    backing.fill(8);

    expect(events.filter((event) => event.type === 'data')).toEqual([
      { type: 'data', data: new Uint8Array([65]) },
      { type: 'data', data: new Uint8Array([2, 3]) },
      { type: 'data', data: new Uint8Array([4, 5]) },
      { type: 'data', data: new Uint8Array([4, 5]) },
      { type: 'data', data: new Uint8Array() },
    ]);
  });

  it('copies outbound bytes and sends only while the browser socket is OPEN', async () => {
    const { socket, transport } = createTransport();
    const data = new Uint8Array([6, 7]);

    await expect(transport.send(data)).rejects.toBeInstanceOf(TransportError);
    await connect(socket, transport);
    await transport.send(data);
    data[0] = 9;

    expect(socket.sent).toEqual([new Uint8Array([6, 7])]);
    expect(socket.sent[0]).not.toBe(data);

    socket.readyState = 0;
    await expect(transport.send(new Uint8Array([1]))).rejects.toBeInstanceOf(TransportError);
  });

  it('emits typed error and close events without callbacks or browser ping', async () => {
    const { socket, transport } = createTransport();
    const events: TransportEvent[] = [];
    const cause = new Error('socket failed');
    transport.subscribe((event) => events.push(event));
    await connect(socket, transport);

    socket.emitError(cause);
    socket.emitClose(1006, 'lost');

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
    expect(socket.pingCalls).toBe(0);
    expect(socket.removeCalls.map(({ type }) => type).sort()).toEqual([
      'close',
      'error',
      'message',
      'open',
    ]);
  });

  it('waits for close when disconnecting and rejects sends immediately', async () => {
    const { socket, transport } = createTransport();
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

    expect(() => socket.emitClose(1005)).not.toThrow();
    await Promise.resolve();

    expect(outcome).toBe('resolved');
    await disconnected;
  });
});
