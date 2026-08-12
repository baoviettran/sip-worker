// Type fixture: compile against the INSTALLED @sip-worker/node tarball's
// declarations. Imports values AND types from every advertised subpath.
import {
  NodeTcpTransport,
  NodeUdpTransport,
  NodeWebSocketTransport,
  toNativePingSocket,
} from '@sip-worker/node';
import type {
  DatagramSocketLike,
  NativeNodeWebSocket,
  NodeWebSocketLike,
  StreamSocketLike,
  NodeTcpTransportOptions,
  NodeUdpTransportOptions,
} from '@sip-worker/node';

import { NodeWebSocketLiveness } from '@sip-worker/node/reliability';
import type { NodeWebSocketLivenessOptions, NativePingSocket } from '@sip-worker/node/reliability';

import { NodeUdpTransport as SubpathUdp } from '@sip-worker/node/transport';
import { TransportError } from '@sip-worker/core';

// ---- values ----
if (SubpathUdp !== NodeUdpTransport) throw new Error('subpath mismatch');
void NodeTcpTransport; void NodeUdpTransport; void NodeWebSocketTransport; void toNativePingSocket;

// ---- transport node ----
void new NodeUdpTransport(
  null as unknown as DatagramSocketLike,
  {
    localPort: 5060,
    remoteHost: 'sip.example.test',
    remotePort: 5060,
    remoteAddresses: ['192.0.2.10'],
  } as NodeUdpTransportOptions,
);
void new NodeTcpTransport(
  null as unknown as StreamSocketLike,
  { host: 'sip.example.test', port: 5060 } as NodeTcpTransportOptions,
);
void new NodeWebSocketTransport(null as unknown as NodeWebSocketLike);

declare const nativeWs: NativeNodeWebSocket;
const nativePingSocket: NativePingSocket = toNativePingSocket(nativeWs) as unknown as NativePingSocket;
void nativePingSocket;
void toNativePingSocket(undefined);

const clock = { now: () => 0, setTimeout: () => 0, clearTimeout: () => {} };
const wsLivenessOpts: NodeWebSocketLivenessOptions = {
  socket: nativePingSocket,
  clock,
  probeIntervalMs: 30000,
  deadlineMs: 5000,
  onFailure: (e: Error) => void e,
};
void new NodeWebSocketLiveness(wsLivenessOpts);

// ---- observed errors are typed as core TransportError ----
declare const observed: TransportError;
void observed;

export {};