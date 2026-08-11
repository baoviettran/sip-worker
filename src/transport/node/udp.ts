import { TransportError } from '../../errors.js';
import type {
  Transport,
  TransportCapabilities,
  TransportEvent,
} from '../transport.js';

type DatagramEvent = 'message' | 'error' | 'close';
type SocketListener = (...args: unknown[]) => void;

export interface DatagramSocketLike {
  bind(port: number, callback: () => void): void;
  send(
    data: Uint8Array,
    port: number,
    host: string,
    callback: (error?: Error) => void,
  ): void;
  close(callback: () => void): void;
  on(event: DatagramEvent, listener: SocketListener): void;
  off(event: DatagramEvent, listener: SocketListener): void;
  removeListener?(event: DatagramEvent, listener: SocketListener): void;
}

export interface NodeUdpTransportOptions {
  readonly localPort: number;
  readonly remoteHost: string;
  readonly remotePort: number;
}

interface ConnectAttempt {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
  readonly reject: (error: TransportError) => void;
}

interface DisconnectAttempt extends ConnectAttempt {}

export class NodeUdpTransport implements Transport {
  readonly capabilities: TransportCapabilities = Object.freeze({
    reliable: false,
    framing: 'datagram',
    token: 'UDP',
  });

  private readonly listeners = new Set<(event: TransportEvent) => void>();
  private connected = false;
  private closing = false;
  private closed = false;
  private socketListenersActive = true;
  private disconnectedEmitted = false;
  private pendingConnect?: ConnectAttempt;
  private pendingDisconnect?: DisconnectAttempt;

  private readonly handleMessage: SocketListener = (...args) => {
    if (!this.socketListenersActive) return;
    const message = args[0];
    if (!(message instanceof Uint8Array)) return;
    // Only accept datagrams from the configured remote peer. Node's `message`
    // event carries `(msg, rinfo)` where `rinfo = { address, port, ... }`; a
    // datagram sent from any other source is foreign and must be silently
    // dropped — it is not a peer message and must never be surfaced as data.
    if (!this.isFromConfiguredPeer(args[1])) return;
    this.emit({ type: 'data', data: message.slice() });
  };

  private isFromConfiguredPeer(rinfo: unknown): boolean {
    if (typeof rinfo !== 'object' || rinfo === null) return false;
    const info = rinfo as { address?: unknown; port?: unknown };
    return info.address === this.options.remoteHost && info.port === this.options.remotePort;
  }

  private readonly handleError: SocketListener = (...args) => {
    if (!this.socketListenersActive) return;
    const error = new TransportError('UDP socket error', args[0]);
    const connect = this.pendingConnect;
    if (connect !== undefined) {
      this.failConnect(connect, error);
      try {
        this.emit({ type: 'error', error });
      } finally {
        this.finishClose(error);
      }
      return;
    }
    this.emit({ type: 'error', error });
  };

  private readonly handleClose: SocketListener = () => {
    if (!this.socketListenersActive) return;
    this.finishClose();
  };

  constructor(
    private readonly socket: DatagramSocketLike,
    private readonly options: NodeUdpTransportOptions,
  ) {
    socket.on('message', this.handleMessage);
    socket.on('error', this.handleError);
    socket.on('close', this.handleClose);
  }

  connect(): Promise<void> {
    if (this.connected) return Promise.resolve();
    if (this.closed || this.closing) {
      return Promise.reject(new TransportError('UDP transport is closed'));
    }
    if (this.pendingConnect !== undefined) return this.pendingConnect.promise;

    let resolvePromise!: () => void;
    let rejectPromise!: (error: TransportError) => void;
    const promise = new Promise<void>((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });
    const attempt: ConnectAttempt = {
      promise,
      resolve: resolvePromise,
      reject: rejectPromise,
    };
    this.pendingConnect = attempt;

    try {
      this.socket.bind(this.options.localPort, () => this.finishConnect(attempt));
    } catch (cause) {
      this.failConnect(attempt, new TransportError('UDP bind failed', cause));
    }
    return promise;
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
      this.failConnect(connect, new TransportError('UDP connection cancelled'));
    }

    let resolvePromise!: () => void;
    let rejectPromise!: (error: TransportError) => void;
    const promise = new Promise<void>((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });
    const attempt: DisconnectAttempt = {
      promise,
      resolve: resolvePromise,
      reject: rejectPromise,
    };
    this.pendingDisconnect = attempt;

    try {
      this.socket.close(() => this.finishClose());
    } catch (cause) {
      const error = new TransportError('UDP close failed', cause);
      try {
        this.emit({ type: 'error', error });
      } finally {
        this.finishClose(error);
      }
    }
    return promise;
  }

  send(data: Uint8Array): Promise<void> {
    if (!this.connected || this.closing || this.closed) {
      return Promise.reject(new TransportError('UDP transport is not connected'));
    }

    const outbound = data.slice();
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const settle = (error?: Error): void => {
        if (settled) return;
        settled = true;
        if (error === undefined) resolve();
        else reject(new TransportError('UDP send failed', error));
      };
      try {
        this.socket.send(
          outbound,
          this.options.remotePort,
          this.options.remoteHost,
          settle,
        );
      } catch (cause) {
        if (settled) return;
        settled = true;
        reject(new TransportError('UDP send failed', cause));
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
    if (this.pendingConnect !== attempt || this.closing || this.closed) return;
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

  private finishClose(error?: TransportError): void {
    if (this.closed) return;
    this.closed = true;
    this.closing = false;
    this.connected = false;

    const connect = this.pendingConnect;
    if (connect !== undefined) {
      this.failConnect(connect, error ?? new TransportError('UDP socket closed before connection'));
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
      this.emit(error === undefined ? { type: 'disconnected' } : { type: 'disconnected', error });
    }
  }

  private removeSocketListeners(): void {
    if (!this.socketListenersActive) return;
    this.socketListenersActive = false;
    this.socket.off('message', this.handleMessage);
    this.socket.off('error', this.handleError);
    this.socket.off('close', this.handleClose);
  }

  private emit(event: TransportEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}
