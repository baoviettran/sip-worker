// test/matrix-shared/stun.ts — one RFC 5389 Binding responder for every PBX
// matrix. It replies with XOR-MAPPED-ADDRESS = the address the request actually
// arrived from, which is what a STUN server is required to report. Fed to the
// page as an iceServer, this makes the browser gather an srflx candidate that is
// NOT mDNS-obfuscated, unlike the *.local host candidates browsers offer by
// default, and an address literal passes a candidate ACL that rejects the
// obfuscated ones (FreeSWITCH's wan.auto answered 488 with "no suitable
// candidates found" without this).
//
// Reporting the OBSERVED address, rather than always 127.0.0.1, is load-bearing
// for Firefox: Firefox's host socket for a LAN-only browser sits on the LAN
// interface, so a fabricated 127.0.0.1 srflx advertises a loopback port nothing
// is listening on. The PBX then sends its connectivity checks to that address
// and the kernel drops every one of them, so the call never establishes.
// Chromium's host socket happens to be on loopback, which is why the fabricated
// address worked there and the defect stayed hidden.
//
// The socket stays bound to 127.0.0.1: the harness always hands the browser
// `stun:127.0.0.1:<port>` (see steps.ts), so requests always arrive over `lo`
// and the observed address is a loopback one regardless. Binding wider would
// only let the responder answer unrelated hosts on the network.
// See test/matrix-shared/stun.unit.test.ts.
import { createSocket, type RemoteInfo, type Socket } from 'node:dgram';

export interface StunResponder {
  port: number;
  close: () => Promise<void>;
}

/** IPv4 address text -> the 32-bit value XOR-MAPPED-ADDRESS carries. */
function ipv4ToInt(address: string): number {
  const parts = address.split('.').map(Number);
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

export function startStunResponder(): Promise<StunResponder> {
  const socket: Socket = createSocket('udp4');
  socket.on('message', (msg: Buffer, rinfo: RemoteInfo) => {
    // Binding Request: type 0x0001, then length, magic cookie, 12-byte txn id.
    if (msg.length < 20 || msg[0] !== 0x00 || msg[1] !== 0x01) return;
    const res = Buffer.alloc(32);
    res[0] = 0x01;
    res[1] = 0x01; // Binding Response
    res[2] = 0x00;
    res[3] = 0x0c; // message length: one 12-byte attribute
    msg.copy(res, 4, 4, 20); // magic cookie + transaction id, verbatim
    // XOR-MAPPED-ADDRESS (0x0020), value: reserved, family IPv4, x-port, x-addr.
    res[20] = 0x00;
    res[21] = 0x20;
    res[22] = 0x00;
    res[23] = 0x08;
    res[24] = 0x00; // reserved
    res[25] = 0x01; // IPv4
    const xport = rinfo.port ^ 0x2112;
    res[26] = (xport >> 8) & 0xff;
    res[27] = xport & 0xff;
    res.writeUInt32BE((ipv4ToInt(rinfo.address) ^ 0x2112a442) >>> 0, 28);
    socket.send(res, rinfo.port, rinfo.address);
  });
  return new Promise((resolve, reject) => {
    socket.once('error', reject);
    socket.bind(0, '127.0.0.1', () => {
      socket.removeListener('error', reject);
      resolve({
        port: (socket.address() as { port: number }).port,
        close: () =>
          new Promise<void>((res) => {
            socket.once('close', () => res());
            socket.close();
          }),
      });
    });
  });
}
