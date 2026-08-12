import { NodeTcpTransport } from '../../src/transport/tcp.js';
import type { TransportContractHarness } from '../../../../test/compatibility/transport-contract.js';
import { FakeStreamSocket } from './fake-stream-socket.js';

/**
 * Wraps the shared FakeStreamSocket (also used by node-tcp.test.ts) and exposes
 * its lifecycle controls through the five-member TransportContractHarness.
 * `open()` fires the socket's real connect callback; `remoteClose()` drives the
 * shared fake's `error`/`close` events.
 */
export function createNodeTcpTransportHarness(): TransportContractHarness {
  const socket = new FakeStreamSocket();
  const transport = new NodeTcpTransport(socket, {
    host: 'sip.example.test',
    port: 5060,
  });

  return {
    transport,
    sent: socket.writes,
    open(): void {
      socket.completeConnect();
    },
    deliver(data: Uint8Array): void {
      socket.emit('data', data);
    },
    remoteClose(error?: Error): void {
      if (error !== undefined) socket.emit('error', error);
      socket.emit('close');
    },
  };
}