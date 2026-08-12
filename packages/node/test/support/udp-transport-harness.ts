import { NodeUdpTransport } from '../../src/transport/udp.js';
import type { TransportContractHarness } from '../../../../test/compatibility/transport-contract.js';
import { FakeDatagramSocket } from './fake-datagram-socket.js';

/**
 * Wraps the shared FakeDatagramSocket (also used by node-udp.test.ts) and
 * exposes its lifecycle controls through the five-member TransportContractHarness.
 * `open()` fires the socket's real bind (listening) callback; `deliver()` emits
 * a `message` from the configured remote peer so the fail-closed filter admits it;
 * `remoteClose()` drives the shared fake's `error`/`close` events.
 */
export function createNodeUdpTransportHarness(): TransportContractHarness {
  const socket = new FakeDatagramSocket();
  const transport = new NodeUdpTransport(socket, {
    localPort: 5060,
    remoteHost: 'sip.example.test',
    remotePort: 5070,
    remoteAddresses: ['192.0.2.10'],
  });

  // Live view of outbound copies: the contract reads `sent` after sends. The
  // shared fake records `{data,port,host}` tuples, so expose just the data.
  const sent: Uint8Array[] = [];
  const recordSend = socket.send.bind(socket);
  socket.send = (data, port, host, callback) => {
    recordSend(data, port, host, callback);
    sent.push(data);
  };

  return {
    transport,
    sent,
    open(): void {
      socket.completeBind();
    },
    deliver(data: Uint8Array): void {
      socket.emit('message', data, { address: '192.0.2.10', port: 5070 });
    },
    remoteClose(error?: Error): void {
      if (error !== undefined) socket.emit('error', error);
      socket.emit('close');
    },
  };
}