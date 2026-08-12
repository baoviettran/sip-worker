import { expect, it } from 'vitest';
import { NodeTcpTransport, NodeUdpTransport, NodeWebSocketLiveness } from '../src/index.js';

it('exports only Node adapters from its root', () => {
  expect(NodeTcpTransport).toBeTypeOf('function');
  expect(NodeUdpTransport).toBeTypeOf('function');
  expect(NodeWebSocketLiveness).toBeTypeOf('function');
});