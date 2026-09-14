// test/freeswitch-matrix/recovery.spec.ts — matrix step 10: WSS-drop recovery.
//
// The `drop-wss` page step registers, establishes an outgoing 9196 call, then
// severs the live WSS from the page (RecordingWebSocket.hardDrop synthesizes
// the abnormal 1006 close observation a network cut produces — mirroring the
// v0.7 browser-phone recovery technique of dropping the socket server-side;
// a clean 1000 close would be treated as a manual disconnect and would NOT
// arm recovery) and observes the library's bounded recovery pipeline.
//
// The spec asserts the row-10 recovery contract: registration RECOVERED
// (connection reconnected + registrationState back to 'registered') and a
// RECOVERY RECORD OBSERVED (registration.recovering plus a connection.*
// recovery diagnostic, with a real re-REGISTER on the wire after the drop) —
// NOT a specific call re-establishment. The call may either re-establish
// (cleanly hung up after the recovery) or terminate with typed evidence; the
// step returns the observed outcome as data. A terminal recovery record
// (connection.recovery_failed / registration.recovery_failed) fails the step.
//
// The call negotiates WebRTC media, so the same DTLS pem seeding and node-side
// STUN responder prerequisites as audio.spec.ts / controls.spec.ts apply
// (replicated here — neither spec exports those helpers and they are not in
// this task's allowed file set).
import { test, expect } from '@playwright/test';
import { copyFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createSocket, type RemoteInfo, type Socket } from 'node:dgram';
import { bootMatrix, disposeMatrix, runStep } from './helpers';
import { type FsHandle } from './fsctl';

const CREDENTIALS = { user: '1000', password: 'matrix-pass-2026' };

/**
 * Seed the DTLS-SRTP certificate FreeSWITCH needs for WebRTC media (same
 * rationale as audio.spec.ts: the read-only /etc/freeswitch mount prevents
 * first-use generation, so a copy of wss.pem is seeded per run).
 */
function ensureDtlsPem(handle: FsHandle): void {
  const tlsDir = join(handle.runtimeDir, 'tls');
  const dtlsPem = join(tlsDir, 'dtls-srtp.pem');
  if (!existsSync(dtlsPem)) {
    copyFileSync(join(tlsDir, 'wss.pem'), dtlsPem);
  }
}

/**
 * Minimal RFC 5389 STUN server on loopback (same rationale as audio.spec.ts:
 * the srflx 127.0.0.1 candidate it teaches the page is not mDNS-obfuscated
 * and passes the FreeSWITCH candidate ACL).
 */
function startStunResponder(): Promise<{ port: number; close: () => Promise<void> }> {
  const socket: Socket = createSocket('udp4');
  socket.on('message', (msg: Buffer, rinfo: RemoteInfo) => {
    if (msg.length < 20 || msg[0] !== 0x00 || msg[1] !== 0x01) return;
    const res = Buffer.alloc(32);
    res[0] = 0x01;
    res[1] = 0x01; // Binding Response
    res[2] = 0x00;
    res[3] = 0x0c;
    msg.copy(res, 4, 4, 20);
    res[20] = 0x00;
    res[21] = 0x20;
    res[22] = 0x00;
    res[23] = 0x08;
    res[24] = 0x00;
    res[25] = 0x01;
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

interface RecoveryStepResult {
  connectionState: string;
  registrationState: string;
  callOutcome: string;
  diagCodes: string[];
  wireRegisters: number;
  wireRegistersAfterDrop: number;
}

test.describe('matrix · WSS-drop recovery', () => {
  test('step 10: hard WSS drop re-registers and observes the recovery path', async ({ page }) => {
    const ctx = await bootMatrix(page);
    const stun = await startStunResponder();
    try {
      ensureDtlsPem(ctx.handle);

      const r = await runStep(page, 'drop-wss', { ...CREDENTIALS, stunPort: stun.port });
      expect(r.ok, r.detail).toBe(true);
      const res = r.result as RecoveryStepResult;

      // Row-10 contract: registration recovered.
      expect(res.connectionState, `connection ${res.connectionState}`).toBe('connected');
      expect(res.registrationState, `registration ${res.registrationState}`).toBe('registered');

      // Row-10 contract: a recovery record observed — the registration
      // recovery diagnostic plus at least one connection.* recovery code.
      expect(res.diagCodes, `diag trace: ${res.diagCodes.join(',')}`).toContain('registration.recovering');
      expect(
        res.diagCodes.some((c) => c === 'connection.reconnect_attempt' || c === 'connection.reconnected'),
        `connection recovery record in: ${res.diagCodes.join(',')}`,
      ).toBe(true);
      expect(res.diagCodes, `no terminal recovery record: ${res.diagCodes.join(',')}`).not.toContain(
        'connection.recovery_failed',
      );
      expect(res.diagCodes, `no terminal recovery record: ${res.diagCodes.join(',')}`).not.toContain(
        'registration.recovery_failed',
      );

      // The recovery re-REGISTER really crossed the new socket.
      expect(
        res.wireRegistersAfterDrop,
        `wire REGISTERs after drop: ${res.wireRegistersAfterDrop} of ${res.wireRegisters}`,
      ).toBeGreaterThanOrEqual(1);

      // The call either re-establishes (cleanly hung up after the recovery) or
      // terminates; a failed outcome must carry the typed call.failed evidence.
      expect(
        ['established', 'terminated', 'failed'],
        `call outcome ${res.callOutcome}`,
      ).toContain(res.callOutcome);
      if (res.callOutcome === 'failed') {
        expect(res.diagCodes, `typed call failure: ${res.diagCodes.join(',')}`).toContain('call.failed');
      }
    } finally {
      await stun.close();
      await disposeMatrix(ctx);
    }
  });
});
