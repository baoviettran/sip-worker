import { parseMessage } from '../messages/parser.js';
import type { SipMessage } from '../messages/message.js';
import type { Transport, TransportEvent } from './transport.js';

export interface MessageSink {
  receive(message: SipMessage): void;
}

export class SipIngress {
  private unsubscribe?: () => void;

  constructor(
    private readonly transport: Transport,
    private readonly sink: MessageSink,
    private readonly onError: (error: Error) => void,
  ) {}

  start(): void {
    if (this.unsubscribe !== undefined) return;
    this.unsubscribe = this.transport.subscribe(this.handleEvent);
  }

  stop(): void {
    const unsubscribe = this.unsubscribe;
    if (unsubscribe === undefined) return;
    this.unsubscribe = undefined;
    unsubscribe();
  }

  private readonly handleEvent = (event: TransportEvent): void => {
    switch (event.type) {
      case 'data': {
        const parsed = parseMessage(event.data);
        if (!parsed.ok) {
          this.onError(parsed.error);
          return;
        }
        try {
          this.sink.receive(parsed.value);
        } catch (error) {
          this.onError(error instanceof Error ? error : new Error(String(error)));
        }
        return;
      }
      case 'error':
        this.onError(event.error);
        return;
      case 'disconnected':
        if (event.error !== undefined) this.onError(event.error);
        return;
      case 'connected':
        return;
    }
  };
}
