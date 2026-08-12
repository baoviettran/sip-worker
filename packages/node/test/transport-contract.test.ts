import { defineTransportContract } from '../../../test/compatibility/transport-contract.js';
import { createNodeWebSocketTransportHarness } from './support/ws-transport-harness.js';
import { createNodeTcpTransportHarness } from './support/tcp-transport-harness.js';
import { createNodeUdpTransportHarness } from './support/udp-transport-harness.js';

defineTransportContract('node WebSocket', createNodeWebSocketTransportHarness);
defineTransportContract('node TCP', createNodeTcpTransportHarness);
defineTransportContract('node UDP', createNodeUdpTransportHarness);