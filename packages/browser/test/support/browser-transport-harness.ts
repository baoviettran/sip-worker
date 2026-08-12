import {
  BrowserWebSocketTransport,
  type BrowserWebSocketFactory,
} from '../../src/transport/ws.js';
import type { TransportContractHarness } from '../../../../test/compatibility/transport-contract.js';
import { FakeBrowserWebSocket } from './fake-browser-web-socket.js';

/**
 * Wraps the shared FakeBrowserWebSocket (also used by browser-ws.test.ts) and
 * exposes its lifecycle controls through the five-member TransportContractHarness.
 */
export function createBrowserTransportHarness(): TransportContractHarness {
  const socket = new FakeBrowserWebSocket();
  const factory: BrowserWebSocketFactory = () => socket;
  const transport = new BrowserWebSocketTransport('wss://sip.example.test/ws', factory);

  return {
    transport,
    sent: socket.sent,
    open(): void {
      if (transport.isConnected()) return;
      socket.emitOpen();
    },
    deliver(data: Uint8Array): void {
      socket.emitMessage(data);
    },
    remoteClose(error?: Error): void {
      if (error !== undefined) socket.emitError(error);
      socket.emitClose();
    },
  };
}