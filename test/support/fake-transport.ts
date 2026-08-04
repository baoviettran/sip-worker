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
  private readonly listeners = new Set<(event: TransportEvent) => void>();

  constructor(capabilities: TransportCapabilities) {
    this.capabilities = Object.freeze({ ...capabilities });
  }

  async connect(): Promise<void> {
    this.connected = true;
    this.emit({ type: 'connected' });
  }

  async disconnect(): Promise<void> {
    this.emitDisconnected();
  }

  async send(data: Uint8Array): Promise<void> {
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
    this.emit(error === undefined ? { type: 'disconnected' } : { type: 'disconnected', error });
  }

  private emit(event: TransportEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}
