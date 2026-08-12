// CommonJS consumer fixture for the @sip-worker/node tarball. require()s the
// root and ./transport + ./reliability subpaths and constructs the adapters.
'use strict';

const assert = require('node:assert/strict');

const root = require('@sip-worker/node');
const transport = require('@sip-worker/node/transport');
const reliability = require('@sip-worker/node/reliability');
const core = require('@sip-worker/core');

assert.equal(typeof root.NodeTcpTransport, 'function');
assert.equal(typeof root.NodeUdpTransport, 'function');
assert.equal(typeof root.NodeWebSocketTransport, 'function');
assert.equal(typeof root.toNativePingSocket, 'function');
assert.equal(typeof transport.NodeUdpTransport, 'function');
assert.equal(typeof reliability.NodeWebSocketLiveness, 'function');
assert.equal(typeof core.TransportError, 'function');

// ---- fake sockets ----
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

// ---- adapters construct with fake sockets ----
{
  const udp = new root.NodeUdpTransport(fakeDgramSocket(), {
    localPort: 5060,
    remoteHost: '192.0.2.10',
    remotePort: 5060,
  });
  assert.equal(udp.capabilities.framing, 'datagram');
  assert.equal(udp.capabilities.token, 'UDP');
}

// ---- observed node transport error is a real core TransportError ----
(async () => {
  const ws = new root.NodeWebSocketTransport(fakeWs());
  await ws.connect();
  let observed;
  try {
    await ws.disconnect();
    await ws.send(new Uint8Array([1]));
  } catch (e) {
    observed = e;
  }
  assert.ok(observed instanceof core.TransportError, 'observed error is not a core TransportError');
  assert.equal(root.toNativePingSocket(undefined), undefined);
})().then(() => {
  console.log('node-cjs-consumer OK');
}).catch((e) => {
  console.error(e);
  process.exit(1);
});