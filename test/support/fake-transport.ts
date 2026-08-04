import type {
  Transport,
  TransportCapabilities,
  TransportEvent,
} from '../../src/transport/index.js';
import type { TransportError } from '../../src/errors.js';

export class FakeTransport implements Transport {
  readonly capabilities: TransportCapabilities;
  readonly sent: Uint8Array[] = [];
  private connected = false;
  private closed = false;
  private disconnectedEmitted = false;
  private readonly listeners = new Set<(event: TransportEvent) => void>();

  constructor(capabilities: TransportCapabilities) {
    this.capabilities = Object.freeze({ ...capabilities });
  }

  async connect(): Promise<void> {
    if (this.closed) {
      throw new Error('FakeTransport is closed');
    }
    if (this.connected) return;
    this.connected = true;
    this.emit({ type: 'connected' });
  }

  async disconnect(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.connected = false;
    this.emitDisconnected();
  }

  async send(data: Uint8Array): Promise<void> {
    if (!this.connected || this.closed) {
      throw new Error('FakeTransport is not connected');
    }
    this.sent.push(data.slice());
  }

  subscribe(listener: (event: TransportEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  isConnected(): boolean {
    return this.connected;
  }

  emitData(data: Uint8Array): void {
    this.emit({ type: 'data', data });
  }

  emitError(error: TransportError): void {
    this.emit({ type: 'error', error });
  }

  emitDisconnected(error?: TransportError): void {
    this.connected = false;
    this.closed = true;
    if (this.disconnectedEmitted) return;
    this.disconnectedEmitted = true;
    this.emit(error === undefined ? { type: 'disconnected' } : { type: 'disconnected', error });
  }

  private emit(event: TransportEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}
