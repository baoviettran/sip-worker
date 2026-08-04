import { TransportError } from '../../errors.js';
import type {
  Transport,
  TransportCapabilities,
  TransportEvent,
} from '../transport.js';

type NodeWebSocketEvent = 'open' | 'message' | 'error' | 'close';
type SocketListener = (...args: unknown[]) => void;

const OPEN = 1;
const CLOSED = 3;

export interface NodeWebSocketLike {
  readonly readyState: number;
  readonly protocol: string;
  on(event: NodeWebSocketEvent, listener: SocketListener): void;
  off(event: NodeWebSocketEvent, listener: SocketListener): void;
  removeListener?(event: NodeWebSocketEvent, listener: SocketListener): void;
  send(data: Uint8Array, callback: (error?: Error) => void): void;
  close(code?: number, reason?: string): void;
}

interface ConnectAttempt {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
  readonly reject: (error: TransportError) => void;
}

interface DisconnectAttempt extends ConnectAttempt {}

export class NodeWebSocketTransport implements Transport {
  readonly capabilities: TransportCapabilities = Object.freeze({
    reliable: true,
    framing: 'message',
  });

  private readonly listeners = new Set<(event: TransportEvent) => void>();
  private connected = false;
  private closing = false;
  private closed = false;
  private failed = false;
  private socketListenersActive = true;
  private disconnectedEmitted = false;
  private pendingConnect?: ConnectAttempt;
  private pendingDisconnect?: DisconnectAttempt;

  private readonly handleOpen: SocketListener = () => {
    if (!this.socketListenersActive) return;
    const connect = this.pendingConnect;
    if (connect !== undefined) this.finishConnect(connect);
  };

  private readonly handleMessage: SocketListener = (...args) => {
    if (!this.socketListenersActive || !this.connected) return;
    const data = copyWebSocketData(args[0]);
    if (data === undefined) {
      this.emit({
        type: 'error',
        error: new TransportError('Unsupported Node WebSocket message data'),
      });
      return;
    }
    this.emit({ type: 'data', data });
  };

  private readonly handleError: SocketListener = (...args) => {
    if (!this.socketListenersActive) return;
    const error = new TransportError('Node WebSocket error', args[0]);
    const connect = this.pendingConnect;
    if (connect !== undefined) {
      this.failed = true;
      try {
        this.emit({ type: 'error', error });
      } finally {
        this.closeAfterFailure(error);
      }
      return;
    }
    this.emit({ type: 'error', error });
  };

  private readonly handleClose: SocketListener = (...args) => {
    if (!this.socketListenersActive) return;
    this.finishClose(webSocketCloseError('Node WebSocket', args[0], args[1]));
  };

  constructor(private readonly socket: NodeWebSocketLike) {
    socket.on('open', this.handleOpen);
    socket.on('message', this.handleMessage);
    socket.on('error', this.handleError);
    socket.on('close', this.handleClose);
  }

  connect(): Promise<void> {
    if (this.connected) return Promise.resolve();
    if (this.closed || this.closing || this.failed) {
      return Promise.reject(new TransportError('Node WebSocket transport is closed'));
    }
    if (this.pendingConnect !== undefined) return this.pendingConnect.promise;

    const attempt = createAttempt();
    this.pendingConnect = attempt;

    if (this.socket.readyState === OPEN) this.finishConnect(attempt);
    else if (this.socket.readyState === CLOSED) {
      this.failed = true;
      this.finishClose(new TransportError('Node WebSocket closed before connection'));
    }
    return attempt.promise;
  }

  disconnect(): Promise<void> {
    if (this.pendingDisconnect !== undefined) return this.pendingDisconnect.promise;
    if (this.closed) {
      this.removeSocketListeners();
      return Promise.resolve();
    }

    this.closing = true;
    this.connected = false;
    const connect = this.pendingConnect;
    if (connect !== undefined) {
      this.failConnect(connect, new TransportError('Node WebSocket connection cancelled'));
    }

    const attempt = createAttempt();
    this.pendingDisconnect = attempt;
    if (this.socket.readyState === CLOSED) {
      this.finishClose();
      return attempt.promise;
    }

    try {
      this.socket.close(1000);
    } catch (cause) {
      const error = new TransportError('Node WebSocket close failed', cause);
      try {
        this.emit({ type: 'error', error });
      } finally {
        this.finishClose(error);
      }
    }
    return attempt.promise;
  }

  send(data: Uint8Array): Promise<void> {
    if (
      !this.connected
      || this.closing
      || this.closed
      || this.socket.readyState !== OPEN
    ) {
      return Promise.reject(new TransportError('Node WebSocket transport is not open'));
    }

    const outbound = data.slice();
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const settle = (error?: Error): void => {
        if (settled) return;
        settled = true;
        if (error === undefined) resolve();
        else reject(new TransportError('Node WebSocket send failed', error));
      };
      try {
        this.socket.send(outbound, settle);
      } catch (cause) {
        if (settled) return;
        settled = true;
        reject(new TransportError('Node WebSocket send failed', cause));
      }
    });
  }

  subscribe(listener: (event: TransportEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  isConnected(): boolean {
    return this.connected;
  }

  private finishConnect(attempt: ConnectAttempt): void {
    if (
      this.pendingConnect !== attempt
      || this.closing
      || this.closed
      || this.failed
    ) return;

    if (this.socket.protocol !== 'sip') {
      const error = new TransportError(
        `Node WebSocket negotiated unsupported protocol: ${this.socket.protocol || '(none)'}`,
      );
      this.failed = true;
      try {
        this.emit({ type: 'error', error });
      } finally {
        this.closeAfterFailure(error);
      }
      return;
    }

    this.pendingConnect = undefined;
    this.connected = true;
    attempt.resolve();
    this.emit({ type: 'connected' });
  }

  private failConnect(attempt: ConnectAttempt, error: TransportError): void {
    if (this.pendingConnect !== attempt) return;
    this.pendingConnect = undefined;
    this.connected = false;
    attempt.reject(error);
  }

  private closeAfterFailure(error: TransportError): void {
    this.closing = true;
    try {
      if (this.socket.readyState !== CLOSED) this.socket.close();
      this.finishClose(error);
    } catch (cause) {
      const closeError = new TransportError('Node WebSocket close failed', cause);
      try {
        this.emit({ type: 'error', error: closeError });
      } finally {
        this.finishClose(closeError);
      }
    }
  }

  private finishClose(error?: TransportError): void {
    if (this.closed) return;
    this.closed = true;
    this.closing = false;
    this.connected = false;

    const connect = this.pendingConnect;
    if (connect !== undefined) {
      this.failConnect(
        connect,
        error ?? new TransportError('Node WebSocket closed before connection'),
      );
    }
    const disconnect = this.pendingDisconnect;
    this.pendingDisconnect = undefined;
    this.removeSocketListeners();

    if (disconnect !== undefined) {
      if (error === undefined) disconnect.resolve();
      else disconnect.reject(error);
    }
    if (!this.disconnectedEmitted) {
      this.disconnectedEmitted = true;
      this.emit(error === undefined
        ? { type: 'disconnected' }
        : { type: 'disconnected', error });
    }
  }

  private removeSocketListeners(): void {
    if (!this.socketListenersActive) return;
    this.socketListenersActive = false;
    const remove = this.socket.off;
    remove.call(this.socket, 'open', this.handleOpen);
    remove.call(this.socket, 'message', this.handleMessage);
    remove.call(this.socket, 'error', this.handleError);
    remove.call(this.socket, 'close', this.handleClose);
  }

  private emit(event: TransportEvent): void {
    for (const listener of this.listeners) listener(event);
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
