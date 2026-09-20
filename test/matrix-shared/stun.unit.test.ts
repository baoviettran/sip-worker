import { describe, it, expect } from 'vitest';
import { createSocket } from 'node:dgram';
import { networkInterfaces } from 'node:os';
import { startStunResponder } from './stun';

/** IPv4 address text -> the 32-bit value XOR-MAPPED-ADDRESS carries. */
function ipv4ToInt(address: string): number {
  const parts = address.split('.').map(Number);
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

/** A non-loopback IPv4 to source a request from, or undefined if there is none. */
const nonLoopbackAddress = Object.values(networkInterfaces())
  .flat()
  .find((a) => a?.family === 'IPv4' && !a.internal);

describe('startStunResponder', () => {
  it('answers a Binding Request with the source port in XOR-MAPPED-ADDRESS', async () => {
    const stun = await startStunResponder();
    const sock = createSocket('udp4');
    try {
      const req = Buffer.alloc(20);
      req[0] = 0x00;
      req[1] = 0x01; // Binding Request
      req.writeUInt32BE(0x2112a442, 4); // magic cookie
      for (let i = 8; i < 20; i++) req[i] = i; // a distinctive transaction id
      const res = await new Promise<Buffer>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('no STUN response within 2s')), 2_000);
        sock.once('message', (m) => {
          clearTimeout(timer);
          resolve(m);
        });
        sock.send(req, stun.port, '127.0.0.1');
      });
      expect(res[0]).toBe(0x01);
      expect(res[1]).toBe(0x01); // Binding Response
      // The message-length header must cover the one attribute that follows it.
      // Without this line the test still passes if the responder writes 0x0008,
      // and Chromium ignores an attribute the header does not account for — so
      // only a browser leg would notice.
      expect(res.readUInt16BE(2)).toBe(0x000c); // length: one 12-byte attribute
      // Transaction id echoed verbatim.
      expect(res.subarray(4, 20)).toEqual(req.subarray(4, 20));
      // XOR-MAPPED-ADDRESS: 0x0020, length 8, reserved, family 1, x-port, x-addr.
      expect(res.readUInt16BE(20)).toBe(0x0020);
      expect(res.readUInt16BE(22)).toBe(0x0008);
      expect(res[25]).toBe(0x01);
      const xport = res.readUInt16BE(26);
      const port = xport ^ 0x2112;
      expect(port).toBe(sock.address().port);
      // The mapped address is the one the request was OBSERVED from, as RFC 5389
      // requires — not a hardcoded 127.0.0.1. A fabricated loopback address here
      // makes a browser whose ICE socket is on another interface (Firefox)
      // advertise a loopback port nothing is listening on, and the PBX's
      // connectivity checks to it are dropped.
      //
      // Asserted against the LITERAL 0x7f000001, not via ipv4ToInt: this socket
      // sends to 127.0.0.1 without binding, so the kernel routes the request out
      // `lo` and the observed address is 127.0.0.1. Using the helper here would
      // make the assertion move with the implementation — a byte-order bug in
      // ipv4ToInt would keep it green. The literal pins the wire format.
      expect(res.readUInt32BE(28) ^ 0x2112a442).toBe(0x7f000001);
    } finally {
      sock.close();
      await stun.close();
    }
  }, 10_000);

  it.skipIf(!nonLoopbackAddress)(
    'reports the observed source address, not a hardcoded loopback',
    async () => {
      const stun = await startStunResponder();
      // Send from a non-loopback source so a hardcoded 127.0.0.1 reply is
      // distinguishable from the observed address. `skipIf` rather than an
      // early return: a hermetic CI container may have no non-loopback IPv4,
      // and a silent return would be reported as a pass — hiding that this
      // test did not run exactly where the behaviour matters.
      const source = nonLoopbackAddress!;
      const sock = createSocket('udp4');
      try {
        const res = await new Promise<Buffer>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('no STUN response within 2s')), 2_000);
          sock.once('message', (m) => {
            clearTimeout(timer);
            resolve(m);
          });
          sock.bind(0, source.address, () => {
            const req = Buffer.alloc(20);
            req[0] = 0x00;
            req[1] = 0x01;
            req.writeUInt32BE(0x2112a442, 4);
            sock.send(req, stun.port, '127.0.0.1');
          });
        });
        expect(res.readUInt32BE(28) ^ 0x2112a442).toBe(ipv4ToInt(source.address) | 0);
        expect((res.readUInt16BE(26) ^ 0x2112) >>> 0).toBe(sock.address().port);
      } finally {
        sock.close();
        await stun.close();
      }
    },
    10_000,
  );

  it('frees its port on close', async () => {
    const stun = await startStunResponder();
    const { port } = stun;
    await stun.close();
    // Re-binding the same port IS the assertion: node's dgram sockets do not set
    // SO_REUSEADDR, so a close() that left the socket held would leave 127.0.0.1:port
    // occupied and this bind would throw EADDRINUSE. An earlier draft of this test
    // started a second responder and asserted `typeof probe.port === 'number'`, which
    // passes even when close() is a no-op — port 0 just gets a different port.
    const probe = createSocket('udp4');
    try {
      await new Promise<void>((resolve, reject) => {
        probe.once('error', reject);
        probe.bind(port, '127.0.0.1', () => {
          probe.removeListener('error', reject);
          resolve();
        });
      });
      expect(probe.address().port).toBe(port);
    } finally {
      probe.close();
    }
  });
});
