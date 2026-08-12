// ESM consumer fixture for the @sip-worker/node tarball. Imports the root and
// ./transport + ./reliability subpaths, and constructs UDP/TCP/WebSocket
// adapters with fake sockets. Proves the node adapter package resolves and
// composes on its own installed copy of @sip-worker/core.
import assert from 'node:assert/strict';

import {
  NodeTcpTransport,
  NodeUdpTransport,
  NodeWebSocketTransport,
  toNativePingSocket,
} from '@sip-worker/node';

import { NodeWebSocketLiveness } from '@sip-worker/node/reliability';
import { NodeUdpTransport as SubpathUdp } from '@sip-worker/node/transport';
import { TransportError } from '@sip-worker/core';

// ---- subpath identity ----
assert.equal(SubpathUdp, NodeUdpTransport, 'node root/subpath transport mismatch');

// ---- fake sockets ----
function fakeStreamSocket() {
  const listeners = new Map();
  return {
    on(type, fn) { listeners.set(type, fn); },
    off(type) { listeners.delete(type); },
    once() {},
    readyState: 1,
    write() {},
    end() {},
    destroy() {},
    setNoDelay() {},
    connect() { listeners.get('connect')?.(); },
  };
}
function fakeDgramSocket() {
  const listeners = new Map();
  return {
    on(type, fn) { listeners.set(type, fn); },
    off(type) { listeners.delete(type); },
    bind(port, cb) { cb?.(); },
    send(data, port, host, cb) { cb?.(); },
    close(cb) { cb?.(); },
  };
}
function fakeWs() {
  const listeners = new Map();
  const socket = {
    readyState: 1,
    protocol: 'sip',
    on(type, fn) { listeners.set(type, fn); },
    off(type) { listeners.delete(type); },
    send(data, cb) { cb?.(); },
    close() { listeners.get('close')?.(); },
  };
  socket.on('open', () => {});
  return socket;
}

// ---- NodeUdpTransport with a fake datagram socket ----
{
  const sock = fakeDgramSocket();
  const udp = new NodeUdpTransport(sock, {
    localPort: 5060,
    remoteHost: '192.0.2.10',
    remotePort: 5060,
  });
  assert.equal(udp.capabilities.framing, 'datagram');
  assert.equal(udp.capabilities.token, 'UDP');
  await udp.connect();
  assert.equal(udp.isConnected(), true);
  await udp.send(new Uint8Array([1, 2, 3]));
  await udp.disconnect();
  assert.equal(udp.isConnected(), false);
}

// ---- NodeTcpTransport with a fake stream socket ----
{
  const sock = fakeStreamSocket();
  sock.connect();
  const tcp = new NodeTcpTransport(sock, { host: 'sip.example.test', port: 5060 });
  assert.equal(tcp.capabilities.token, 'TCP');
}

// ---- NodeWebSocketTransport with a fake ws socket ----
{
  const sock = fakeWs();
  const ws = new NodeWebSocketTransport(sock);
  assert.equal(ws.capabilities.token, 'WS');
  await ws.connect();
  assert.equal(ws.isConnected(), true);
  await ws.send(new Uint8Array([1, 2, 3]));
  await ws.disconnect();
  assert.equal(ws.isConnected(), false);
}

// ---- toNativePingSocket no-op + native adaptation ----
assert.equal(toNativePingSocket(undefined), undefined);
assert.equal(toNativePingSocket({}), undefined);
{
  const native = { ping() {}, on() {}, off() {} };
  const sock = toNativePingSocket(native);
  assert.ok(sock && typeof sock.ping === 'function' && typeof sock.onPong === 'function');
}

// ---- NodeWebSocketLiveness constructs with a native ping socket ----
{
  const clock = { now: () => 0, setTimeout: () => 0, clearTimeout: () => {} };
  const native = { ping() {}, on() {}, off() {} };
  const liveness = new NodeWebSocketLiveness({
    socket: toNativePingSocket(native),
    clock,
    probeIntervalMs: 30000,
    deadlineMs: 5000,
    onFailure: () => {},
  });
  assert.ok(liveness instanceof NodeWebSocketLiveness);
}

// ---- observed node transport error is a real core TransportError ----
{
  const sock = fakeWs();
  const ws = new NodeWebSocketTransport(sock);
  await ws.connect();
  let observed;
  try {
    // A closed socket send must reject with a core TransportError.
    await ws.disconnect();
    await ws.send(new Uint8Array([1]));
  } catch (e) {
    observed = e;
  }
  assert.ok(observed instanceof TransportError, 'observed error is not a core TransportError');
}

console.log('node-esm-consumer OK');