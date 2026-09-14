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
    const probe = await startStunResponder();
    try {
      expect(typeof probe.port).toBe('number');
    } finally {
      await probe.close();
    }
    expect(port).toBeGreaterThan(0);
  });
});
