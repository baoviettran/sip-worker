import { NodeWebSocketTransport } from '../../src/transport/ws.js';
import type { TransportContractHarness } from '../../../../test/compatibility/transport-contract.js';
import { FakeNodeWebSocket } from './fake-node-web-socket.js';

/**
 * Wraps the shared FakeNodeWebSocket (also used by node-ws.test.ts) and exposes
 * its lifecycle controls through the five-member TransportContractHarness.
 */
export function createNodeWebSocketTransportHarness(): TransportContractHarness {
  const socket = new FakeNodeWebSocket();
  const transport = new NodeWebSocketTransport(socket);

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