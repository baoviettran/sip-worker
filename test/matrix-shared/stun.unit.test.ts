import { describe, it, expect } from 'vitest';
import { createSocket } from 'node:dgram';
import { startStunResponder } from './stun';

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
      expect(res.readUInt32BE(28) ^ 0x2112a442).toBe(0x7f000001); // 127.0.0.1
    } finally {
      sock.close();
      await stun.close();
    }
  }, 10_000);

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
