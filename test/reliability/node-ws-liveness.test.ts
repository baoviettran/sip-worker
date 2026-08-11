import { describe, expect, it } from 'vitest';
import { TransportError } from '../../src/errors.js';
import { NodeWebSocketLiveness } from '../../src/reliability/node-ws-liveness.js';
import type { NativePingSocket } from '../../src/reliability/node-ws-liveness.js';
import { FakeClock } from '../support/fake-clock.js';

class FakeNativePingSocket implements NativePingSocket {
  readonly pings: Uint8Array[] = [];
  pingError?: Error;
  private readonly pongListeners = new Set<(payload: Uint8Array) => void>();

  ping(payload: Uint8Array): void {
    const error = this.pingError;
    if (error !== undefined) throw error;
    this.pings.push(payload.slice());
  }

  onPong(listener: (payload: Uint8Array) => void): () => void {
    this.pongListeners.add(listener);
    return () => {
      this.pongListeners.delete(listener);
    };
  }

  get lastPing(): Uint8Array | undefined {
    const last = this.pings[this.pings.length - 1];
    return last === undefined ? undefined : last.slice();
  }

  liveListenerCount(): number {
    return this.pongListeners.size;
  }

  replyPong(payload?: Uint8Array): void {
    const bytes = payload ?? this.lastPing ?? new Uint8Array();
    for (const listener of [...this.pongListeners]) listener(bytes);
  }
}

function setup(
  options: { probeIntervalMs?: number; deadlineMs?: number } = {},
): {
  clock: FakeClock;
  socket: FakeNativePingSocket;
  failures: TransportError[];
  liveness: NodeWebSocketLiveness;
} {
  const clock = new FakeClock();
  const socket = new FakeNativePingSocket();
  const failures: TransportError[] = [];
  const liveness = new NodeWebSocketLiveness({
    socket,
    clock,
    probeIntervalMs: options.probeIntervalMs ?? 5000,
    deadlineMs: options.deadlineMs ?? 1000,
    onFailure: (error) => failures.push(error),
  });
  return { clock, socket, failures, liveness };
}

describe('NodeWebSocketLiveness', () => {
  it('sends no immediate probe and emits one native ping at the first interval', () => {
    const { clock, socket, liveness } = setup();
    liveness.start();

    expect(socket.pings).toHaveLength(0);
    clock.advance(4999);
    expect(socket.pings).toHaveLength(0);
    clock.advance(1);
    expect(socket.pings).toHaveLength(1);
  });

  it('clears the deadline on a matching pong and probes again at the next interval', () => {
    const { clock, socket, failures, liveness } = setup();
    liveness.start();

    clock.advance(5000);
    expect(socket.pings).toHaveLength(1);

    socket.replyPong();
    clock.advance(5000);
    expect(socket.pings).toHaveLength(2);
    expect(failures).toHaveLength(0);
  });

  it('emits a fresh, distinct nonce per probe and clears it with its own matching pong', () => {
    const { clock, socket, failures, liveness } = setup();
    liveness.start();

    clock.advance(5000); // first probe
    const first = socket.pings[0]!;
    expect(first.length).toBe(16);

    socket.replyPong(); // clear first probe
    clock.advance(5000); // second probe
    expect(socket.pings).toHaveLength(2);
    const second = socket.pings[1]!;
    expect(second.length).toBe(16);

    // Freshness: two consecutive probes must carry different nonce bytes.
    expect(second).not.toEqual(first);

    // A stale pong echoing the FIRST (already-cleared) nonce must not clear the SECOND.
    socket.replyPong(first);
    // The dedicated deadline for the second probe is still outstanding.
    clock.advance(1000);
    expect(failures).toHaveLength(1);
    expect(failures[0]!.message).toBe('liveness timeout');
  });

  it('ignores a pong that does not match the outstanding nonce', () => {
    const { clock, socket, failures, liveness } = setup();
    liveness.start();

    clock.advance(5000);
    socket.replyPong(new Uint8Array([0x51, 0x99]));

    clock.advance(1000);
    expect(failures).toHaveLength(1);
    const failure = failures[0];
    expect(failure).not.toBeUndefined();
    expect(failure).toBeInstanceOf(TransportError);
    expect(failure!.message).toBe('liveness timeout');
  });

  it('converts a synchronously-throwing ping to a typed liveness failure and stops', () => {
    const { clock, socket, failures, liveness } = setup();
    socket.pingError = new Error('ping threw');
    liveness.start();

    clock.advance(5000); // probe fires; ping throws synchronously

    expect(failures).toHaveLength(1);
    const failure = failures[0];
    expect(failure).toBeInstanceOf(TransportError);
    expect(failure!.message).toBe('liveness ping failed');
    expect(failure!.cause).toBeInstanceOf(Error);

    // The strategy stops and must not rethrow on the next tick.
    clock.advance(50000);
    expect(failures).toHaveLength(1);
  });

  it('emits exactly one TransportError when the pong is missed and then stops', () => {
    const { clock, socket, failures, liveness } = setup();
    liveness.start();

    clock.advance(5000); // ping sent, deadline armed
    clock.advance(1000); // deadline fires

    expect(failures).toHaveLength(1);
    const failure = failures[0];
    expect(failure).not.toBeUndefined();
    expect(failure).toBeInstanceOf(TransportError);
    expect(failure!.message).toBe('liveness timeout');

    clock.advance(50000);
    expect(socket.pings).toHaveLength(1);
    expect(failures).toHaveLength(1);
  });

  it('makes start and stop idempotent', () => {
    const { clock, socket, failures, liveness } = setup();
    liveness.start();
    liveness.start();
    clock.advance(5000);
    expect(socket.pings).toHaveLength(1); // a single probe timer despite double start

    liveness.stop();
    liveness.stop();
    const before = socket.pings.length;
    clock.advance(50000);
    expect(socket.pings).toHaveLength(before);
    expect(failures).toHaveLength(0);
  });

  it('never overlaps pings while a pong is outstanding', () => {
    const { clock, socket, liveness } = setup({ probeIntervalMs: 1000, deadlineMs: 5000 });
    liveness.start();

    clock.advance(1000); // first ping
    clock.advance(4000); // each subsequent interval skips while the pong is pending
    expect(socket.pings).toHaveLength(1);

    socket.replyPong();
    clock.advance(1000);
    expect(socket.pings).toHaveLength(2);
  });

  it('ignores a late pong that arrives after stop', () => {
    const { clock, socket, failures, liveness } = setup();
    liveness.start();
    clock.advance(5000);

    liveness.stop();
    const before = socket.pings.length;
    socket.replyPong();
    clock.advance(50000);

    expect(socket.pings).toHaveLength(before);
    expect(failures).toHaveLength(0);
  });

  it('unsubscribes the pong listener on stop', () => {
    const { socket, liveness } = setup();
    liveness.start();
    expect(socket.liveListenerCount()).toBe(1);
    liveness.stop();
    expect(socket.liveListenerCount()).toBe(0);
  });
});
