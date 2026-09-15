// test/matrix-shared/stun.ts — one RFC 5389 Binding responder for every PBX
// matrix. It replies with XOR-MAPPED-ADDRESS = 127.0.0.1:<source port>. Fed to
// the page as an iceServer, this makes Chromium gather an srflx 127.0.0.1
// candidate: srflx candidates are NOT mDNS-obfuscated, unlike the *.local host
// candidates Chromium offers by default, and loopback passes a candidate ACL
// that rejects the obfuscated ones (FreeSWITCH's wan.auto answered 488 with
// "no suitable candidates found" without this).
import { createSocket, type RemoteInfo, type Socket } from 'node:dgram';

export interface StunResponder {
  port: number;
  close: () => Promise<void>;
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
    res.writeUInt32BE((0x7f000001 ^ 0x2112a442) >>> 0, 28);
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
