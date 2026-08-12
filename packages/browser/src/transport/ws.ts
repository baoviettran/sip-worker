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

interface DisconnectAttempt extends ConnectAttempt {}

export class BrowserWebSocketTransport implements Transport {
  readonly capabilities: TransportCapabilities;

  private readonly token: 'WS' | 'WSS';

  private readonly listeners = new Set<(event: TransportEvent) => void>();
  private socket?: BrowserWebSocketLike;
  private connected = false;
  private closing = false;
  private closed = false;
  private failed = false;
  private socketListenersActive = false;
  private disconnectedEmitted = false;
  private pendingConnect?: ConnectAttempt;
  private pendingDisconnect?: DisconnectAttempt;

  private readonly handleOpen = (): void => {
    if (!this.socketListenersActive) return;
    const connect = this.pendingConnect;
    if (connect !== undefined) this.finishConnect(connect);
  };

  private readonly handleMessage = (event: Event): void => {
    if (!this.socketListenersActive || !this.connected) return;
    const data = copyWebSocketData((event as Event & { readonly data?: unknown }).data);
    if (data === undefined) {
      this.emit({
        type: 'error',
        error: new TransportError('Unsupported browser WebSocket message data'),
      });
      return;
    }
    this.emit({ type: 'data', data });
  };

  private readonly handleError = (event: Event): void => {
    if (!this.socketListenersActive) return;
    const cause = (event as Event & { readonly error?: unknown }).error ?? event;
    const error = new TransportError('Browser WebSocket error', cause);
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

  private readonly handleClose = (event: Event): void => {
    if (!this.socketListenersActive) return;
    const close = event as Event & { readonly code?: unknown; readonly reason?: unknown };
    this.finishClose(webSocketCloseError('Browser WebSocket', close.code, close.reason));
  };

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
    if (this.connected) return Promise.resolve();
    if (this.closed || this.closing || this.failed) {
      return Promise.reject(new TransportError('Browser WebSocket transport is closed'));
    }
    if (this.pendingConnect !== undefined) return this.pendingConnect.promise;

    const attempt = createAttempt();
    this.pendingConnect = attempt;
    let socket: BrowserWebSocketLike;
    try {
      socket = this.factory(this.url, ['sip']);
    } catch (cause) {
      const error = new TransportError('Browser WebSocket creation failed', cause);
      this.failed = true;
      try {
        this.emit({ type: 'error', error });
      } finally {
        this.finishClose(error);
      }
      return attempt.promise;
    }

    this.socket = socket;
    socket.binaryType = 'arraybuffer';
    this.addSocketListeners(socket);
    if (socket.readyState === OPEN) this.finishConnect(attempt);
    else if (socket.readyState === CLOSED) {
      this.failed = true;
      this.finishClose(new TransportError('Browser WebSocket closed before connection'));
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
      this.failConnect(connect, new TransportError('Browser WebSocket connection cancelled'));
    }

    const attempt = createAttempt();
    this.pendingDisconnect = attempt;
    const socket = this.socket;
    if (socket === undefined || socket.readyState === CLOSED) {
      this.finishClose();
      return attempt.promise;
    }

    try {
      socket.close(1000);
    } catch (cause) {
      const error = new TransportError('Browser WebSocket close failed', cause);
      try {
        this.emit({ type: 'error', error });
      } finally {
        this.finishClose(error);
      }
    }
    return attempt.promise;
  }

  send(data: Uint8Array): Promise<void> {
    const socket = this.socket;
    if (
      socket === undefined
      || !this.connected
      || this.closing
      || this.closed
      || socket.readyState !== OPEN
    ) {
      return Promise.reject(new TransportError('Browser WebSocket transport is not open'));
    }

    try {
      socket.send(data.slice());
      return Promise.resolve();
    } catch (cause) {
      return Promise.reject(new TransportError('Browser WebSocket send failed', cause));
    }
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

    const socket = this.socket;
    if (socket === undefined) return;
    if (socket.protocol !== 'sip') {
      const error = new TransportError(
        `Browser WebSocket negotiated unsupported protocol: ${socket.protocol || '(none)'}`,
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
    const socket = this.socket;
    try {
      if (socket !== undefined && socket.readyState !== CLOSED) socket.close();
      this.finishClose(error);
    } catch (cause) {
      const closeError = new TransportError('Browser WebSocket close failed', cause);
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
        error ?? new TransportError('Browser WebSocket closed before connection'),
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

  private addSocketListeners(socket: BrowserWebSocketLike): void {
    this.socketListenersActive = true;
    socket.addEventListener('open', this.handleOpen);
    socket.addEventListener('message', this.handleMessage);
    socket.addEventListener('error', this.handleError);
    socket.addEventListener('close', this.handleClose);
  }

  private removeSocketListeners(): void {
    if (!this.socketListenersActive) return;
    this.socketListenersActive = false;
    const socket = this.socket;
    if (socket === undefined) return;
    socket.removeEventListener('open', this.handleOpen);
    socket.removeEventListener('message', this.handleMessage);
    socket.removeEventListener('error', this.handleError);
    socket.removeEventListener('close', this.handleClose);
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
