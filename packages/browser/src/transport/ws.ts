import { TransportError } from '@sip-worker/core';
import type {
  Transport,
  TransportCapabilities,
  TransportEvent,
} from '@sip-worker/core/transport';

const OPEN = 1;
const CLOSED = 3;

export interface BrowserWebSocketLike {
  readonly readyState: number;
  readonly protocol: string;
  binaryType: string;
  addEventListener(type: string, listener: (event: Event) => void): void;
  removeEventListener(type: string, listener: (event: Event) => void): void;
  send(data: Uint8Array): void;
  close(code?: number, reason?: string): void;
}

export type BrowserWebSocketFactory = (
  url: string,
  protocols: string[],
) => BrowserWebSocketLike;

interface ConnectAttempt {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
  readonly reject: (error: TransportError) => void;
}

interface SocketGeneration {
  readonly id: number;
  readonly socket: BrowserWebSocketLike;
  readonly connect: ConnectAttempt;
  detached: boolean;
  connected: boolean;
  disconnectedEmitted: boolean;
}

interface SocketHandlers {
  readonly open: () => void;
  readonly message: (event: Event) => void;
  readonly error: (event: Event) => void;
  readonly close: (event: Event) => void;
}

export class BrowserWebSocketTransport implements Transport {
  readonly capabilities: TransportCapabilities;

  private readonly token: 'WS' | 'WSS';

  private readonly listeners = new Set<(event: TransportEvent) => void>();
  private current?: SocketGeneration;
  private nextGeneration = 0;
  private disposed = false;
  private pendingDisconnect?: ConnectAttempt;
  private disposePromise?: Promise<void>;
  private readonly handlers = new WeakMap<BrowserWebSocketLike, SocketHandlers>();

  /** The id of the active socket generation (0 while idle / before first connect). */
  get generation(): number {
    return this.current?.id ?? this.nextGeneration;
  }

  constructor(
    private readonly url: string,
    private readonly factory: BrowserWebSocketFactory,
  ) {
    this.token = /^wss:/i.test(url) ? 'WSS' : 'WS';
    this.capabilities = Object.freeze({
      reliable: true,
      framing: 'message',
      token: this.token,
    });
  }

  connect(): Promise<void> {
    if (this.disposed) {
      return Promise.reject(
        new TransportError('Browser WebSocket transport is closed'),
      );
    }
    const current = this.current;
    if (current !== undefined) {
      if (current.connected) return Promise.resolve();
      if (!current.detached) return current.connect.promise;
    }

    const attempt = createAttempt();
    let socket: BrowserWebSocketLike;
    try {
      socket = this.factory(this.url, ['sip']);
    } catch (cause) {
      const error = new TransportError('Browser WebSocket creation failed', cause);
      attempt.reject(error);
      this.emit({ type: 'error', error });
      this.emit({ type: 'disconnected', error });
      return attempt.promise;
    }

    const generation: SocketGeneration = {
      id: ++this.nextGeneration,
      socket,
      connect: attempt,
      detached: false,
      connected: false,
      disconnectedEmitted: false,
    };
    this.current = generation;
    this.attachSocket(generation, socket);
    if (socket.readyState === OPEN) {
      this.finishOpen(generation, attempt);
    } else if (socket.readyState === CLOSED) {
      this.closeGeneration(
        generation,
        new TransportError('Browser WebSocket closed before connection'),
      );
    }
    return attempt.promise;
  }

  disconnect(): Promise<void> {
    if (this.pendingDisconnect !== undefined) return this.pendingDisconnect.promise;
    const generation = this.current;
    if (generation === undefined) return Promise.resolve();

    if (generation.connected) generation.connected = false;
    if (!generation.connected) {
      // A still-pending connect is cancelled by the disconnect, mirroring the
      // pre-generation behaviour of failing the in-flight attempt.
      generation.connect.reject(
        new TransportError('Browser WebSocket connection cancelled'),
      );
    }
    const attempt = createAttempt();
    this.pendingDisconnect = attempt;
    const socket = generation.socket;
    if (socket.readyState === CLOSED) {
      this.finishClose(generation);
      return attempt.promise;
    }
    try {
      socket.close(1000);
    } catch (cause) {
      const error = new TransportError('Browser WebSocket close failed', cause);
      this.emit({ type: 'error', error });
      this.finishClose(generation, error);
    }
    return attempt.promise;
  }

  send(data: Uint8Array): Promise<void> {
    if (this.disposed) {
      return Promise.reject(new TransportError('Browser WebSocket transport is not open'));
    }
    const generation = this.current;
    if (
      generation === undefined
      || !generation.connected
      || generation.detached
      || generation.socket.readyState !== OPEN
    ) {
      return Promise.reject(new TransportError('Browser WebSocket transport is not open'));
    }
    try {
      generation.socket.send(data.slice());
      return Promise.resolve();
    } catch (cause) {
      return Promise.reject(new TransportError('Browser WebSocket send failed', cause));
    }
  }

  dispose(): Promise<void> {
    if (this.disposePromise === undefined) {
      this.disposed = true;
      this.disposePromise = this.performDispose();
    }
    return this.disposePromise;
  }

  subscribe(listener: (event: TransportEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  isConnected(): boolean {
    return this.current !== undefined && this.current.connected;
  }

  private async performDispose(): Promise<void> {
    const generation = this.current;
    if (generation !== undefined) {
      generation.detached = true;
      if (this.current === generation) this.current = undefined;
      generation.connected = false;
      this.removeSocketListeners(generation.socket);
      if (generation.socket.readyState !== CLOSED) {
        try {
          generation.socket.close();
        } catch {
          // Best-effort teardown; dispose is terminal either way.
        }
      }
      generation.connect.reject(
        new TransportError('Browser WebSocket transport is closed'),
      );
    }
    if (this.pendingDisconnect !== undefined) {
      this.pendingDisconnect.resolve();
      this.pendingDisconnect = undefined;
    }
    this.listeners.clear();
  }

  private attachSocket(
    generation: SocketGeneration,
    socket: BrowserWebSocketLike,
  ): void {
    const open = (): void => {
      if (this.current !== generation || generation.detached) return;
      this.finishOpen(generation, generation.connect);
    };
    const message = (event: Event): void => {
      if (this.current !== generation || generation.detached) return;
      if (!generation.connected) return;
      const data = copyWebSocketData(
        (event as Event & { readonly data?: unknown }).data,
      );
      if (data === undefined) {
        this.emit({
          type: 'error',
          error: new TransportError('Unsupported browser WebSocket message data'),
        });
        return;
      }
      this.emit({ type: 'data', data });
    };
    const error = (event: Event): void => {
      if (this.current !== generation || generation.detached) return;
      const cause = (event as Event & { readonly error?: unknown }).error ?? event;
      const transportError = new TransportError('Browser WebSocket error', cause);
      if (generation.connected) {
        this.emit({ type: 'error', error: transportError });
        return;
      }
      this.closeGeneration(generation, transportError);
    };
    const close = (event: Event): void => {
      if (this.current !== generation || generation.detached) return;
      const closeEvent = event as Event & { readonly code?: unknown; readonly reason?: unknown };
      this.finishClose(
        generation,
        webSocketCloseError('Browser WebSocket', closeEvent.code, closeEvent.reason),
      );
    };
    this.handlers.set(socket, { open, message, error, close });
    socket.binaryType = 'arraybuffer';
    socket.addEventListener('open', open);
    socket.addEventListener('message', message);
    socket.addEventListener('error', error);
    socket.addEventListener('close', close);
  }

  private removeSocketListeners(socket: BrowserWebSocketLike): void {
    const handlers = this.handlers.get(socket);
    if (handlers === undefined) return;
    this.handlers.delete(socket);
    socket.removeEventListener('open', handlers.open);
    socket.removeEventListener('message', handlers.message);
    socket.removeEventListener('error', handlers.error);
    socket.removeEventListener('close', handlers.close);
  }

  private finishOpen(generation: SocketGeneration, attempt: ConnectAttempt): void {
    if (this.current !== generation || generation.detached) return;
    if (generation.socket.protocol !== 'sip') {
      this.closeGeneration(
        generation,
        new TransportError(
          `Browser WebSocket negotiated unsupported protocol: ${generation.socket.protocol || '(none)'}`,
        ),
      );
      return;
    }
    generation.connected = true;
    attempt.resolve();
    this.emit({ type: 'connected' });
  }

  /** An abnormal terminal close (open/close error, subprotocol mismatch, pre-open close). */
  private closeGeneration(generation: SocketGeneration, error: TransportError): void {
    if (generation.detached) return;
    generation.detached = true;
    if (this.current === generation) this.current = undefined;
    generation.connected = false;
    this.removeSocketListeners(generation.socket);
    generation.connect.reject(error);
    this.closeSocket(generation.socket);
    this.emit({ type: 'error', error });
    this.emitDisconnected(generation, error);
  }

  /** The socket's close event (or an explicit disconnect settling on that close). */
  private finishClose(generation: SocketGeneration, error?: TransportError): void {
    if (generation.detached) return;
    generation.detached = true;
    if (this.current === generation) this.current = undefined;
    generation.connected = false;
    this.removeSocketListeners(generation.socket);

    const disconnect = this.pendingDisconnect;
    if (disconnect !== undefined) {
      this.pendingDisconnect = undefined;
      if (error === undefined) disconnect.resolve();
      else disconnect.reject(error);
    }
    if (error !== undefined) this.emit({ type: 'error', error });
    this.emitDisconnected(generation, error);
  }

  private closeSocket(socket: BrowserWebSocketLike): void {
    if (socket.readyState === CLOSED) return;
    try {
      socket.close();
    } catch {
      // A peer socket that refuses to close does not block onward lifecycle.
    }
  }

  private emitDisconnected(generation: SocketGeneration, error?: TransportError): void {
    if (generation.disconnectedEmitted) return;
    generation.disconnectedEmitted = true;
    this.emit(error === undefined
      ? { type: 'disconnected' }
      : { type: 'disconnected', error });
  }

  private emit(event: TransportEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch {
        // An application observer cannot block transport lifecycle delivery.
      }
    }
  }
}

function createAttempt(): ConnectAttempt {
  let resolvePromise!: () => void;
  let rejectPromise!: (error: TransportError) => void;
  const promise = new Promise<void>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return {
    promise,
    resolve: resolvePromise,
    reject: rejectPromise,
  };
}

function copyWebSocketData(data: unknown): Uint8Array | undefined {
  if (typeof data === 'string') return new TextEncoder().encode(data);
  if (data instanceof ArrayBuffer) return new Uint8Array(data).slice();
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice();
  }
  return undefined;
}

function webSocketCloseError(
  name: string,
  code: unknown,
  reason: unknown,
): TransportError | undefined {
  // 1005 signals "no close code received" (RFC 6455), which is normal when a
  // peer acknowledges our client-initiated close with an empty frame. A clean
  // disconnect and a peer that simply omitted the code are both non-errors.
  if (code === undefined || code === 1000 || code === 1005) return undefined;
  return new TransportError(`${name} closed with code ${String(code)}`, { code, reason });
}
