// test/freeswitch-matrix/dtmf.spec.ts — matrix step 8: a DTMF digit dialed in
// the page is observed at FreeSWITCH.
//
// Flow: register (step), open the node-side fsSubscribeDtfm() subscription
// (fsctl.ts — a real `event plain DTMF` connection on 127.0.0.1:8021), then
// run step `dtmf`, which registers again on its own phone, dials the 9196
// echo extension, establishes, and sends RFC 4733 digit '5' via the browser
// RTCDTMFSender (PCMU/8000 is preferred for the call: FreeSWITCH 1.10.12
// answers telephone-event/48000 for the default opus offer, which its RTP
// stack does not decode, while PCMU pairs with telephone-event/8000).
//
// The step parks at a page-side gate after the tone goes on the wire, so the
// call is still up while the spec observes. The digit is then asserted
// node-side within a deadline, in one of two forms (the primary first):
//
// 1. A `Event-Name: DTMF` frame arrives on the subscription for digit '5' on
//    the call's sofia/ws-test channel.
// 2. Divergence (recorded, not skipped): the pinned FreeSWITCH 1.10.12 fires
//    SWITCH_EVENT_DTMF only from switch_channel_dequeue_dtmf (bridging and
//    digit-collecting apps; switch_channel_queue_dtmf at switch_channel.c:528
//    merely logs "RECV DTMF" and queues), and the pinned 9196 dialplan runs
//    the echo app with NULL input args (echo_function →
//    switch_ivr_session_echo(session, NULL)), which never dequeues — so the
//    event cannot fire while this call runs. There is also no sanctioned api
//    command to drain it: uuid_recv_dtmf queues, uuid_flush_dtmf drops, and
//    uuid_bridge on the busy leg crashes the pinned image. In that case the
//    spec asserts the same receipt from FreeSWITCH's own channel-uuid-prefixed
//    log lines ("RTP RECV DTMF 5" — RFC 4733 decoded on the call's channel —
//    and "RECV DTMF 5" — queued on the call's channel), read from the
//    container log file inside the deadline, mirroring the brief's
//    verify-at-first-run protocol for library divergences. A run with
//    NEITHER the event NOR the log receipt still fails.
//
// The call negotiates WebRTC media, so the same DTLS pem seeding and
// node-side STUN responder prerequisites as controls.spec.ts / audio.spec.ts
// apply (replicated here — neither spec exports those helpers).
import { test, expect } from '@playwright/test';
import { copyFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createSocket, type RemoteInfo, type Socket } from 'node:dgram';
import { spawnSync } from 'node:child_process';
import { bootMatrix, disposeMatrix, runStep } from './helpers';
import { fsExec, fsSubscribeDtfm, type FsHandle } from './fsctl';

const CREDENTIALS = { user: '1000', password: 'matrix-pass-2026' };
const DIGIT = '5';
const DTMF_DEADLINE_MS = 3_000;
const LOG_TAIL_LINES = 4000;

/**
 * Seed the DTLS-SRTP certificate FreeSWITCH needs for WebRTC media (same
 * rationale as controls.spec.ts: the read-only /etc/freeswitch mount prevents
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
 * Minimal RFC 5389 STUN server on loopback (same rationale as controls.spec.ts:
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
    res[26] = 0x00;
    res[27] = 0x08;
    res[28] = 0x00;
    res[29] = 0x01;
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

interface DtmfStepResult {
  callState: string;
  dtmfSent?: boolean;
  diagCodes?: string[];
}

interface DtmfGateWindow {
  __matrixAwaitDtmf?: boolean;
  __matrixDtmfGo?: boolean;
}

test.describe('matrix · DTMF observed at FreeSWITCH', () => {
  test("step 8: sendDtmf('5') on an established echo call reaches the event socket", async ({ page }) => {
    const ctx = await bootMatrix(page);
    const stun = await startStunResponder();
    try {
      ensureDtlsPem(ctx.handle);
      // register first (an FS-side registration for this identity), then open
      // the subscription BEFORE the dtmf step sends the digit — the
      // subscription must be live when the tone goes on the wire.
      const r0 = await runStep(page, 'register', CREDENTIALS);
      expect(r0.ok, r0.detail).toBe(true);

      const ac = new AbortController();
      const events = fsSubscribeDtfm({ signal: ac.signal });
      try {
        const stepPromise = runStep(page, 'dtmf', { ...CREDENTIALS, stunPort: stun.port });
        // The step parks after the tone is sent (see runDtmfStep) so the call
        // stays up while the spec observes it.
        await page.waitForFunction(
          () => (window as unknown as DtmfGateWindow).__matrixAwaitDtmf === true,
          undefined,
          { timeout: 120_000 },
        );
        // Identify the call's channel uuid on the event socket side.
        const channels = await fsExec('show channels');
        const aLeg = channels
          .split('\n')
          .filter((l) => /^[0-9a-f]{8}-/.test(l))
          .find((l) => l.includes('sofia/ws-test'));
        const uuid = aLeg?.split(',')[0];
        expect(uuid, 'sofia/ws-test call leg not found in show channels').toBeTruthy();

        // Primary assertion: the subscription yields the DTMF event for '5'
        // on the call's channel within the deadline. A timeout FAILS — never
        // a skip, never a hang.
        const deadline = Date.now() + DTMF_DEADLINE_MS;
        const match = await (async (): Promise<{ digit: string; channel: string } | undefined> => {
          for (;;) {
            const remaining = deadline - Date.now();
            if (remaining <= 0) return undefined;
            const next = await Promise.race([
              events.next(),
              new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), remaining)),
            ]);
            if (next === 'timeout') return undefined;
            if (next.done) throw new Error('fsSubscribeDtfm ended before the DTMF event arrived');
            if (next.value.digit === DIGIT && next.value.channel.startsWith('sofia/ws-test/')) {
              return next.value;
            }
          }
        })();

        if (match === undefined) {
          // Divergence path (see the file header): the pinned FS never
          // dequeues under the echo dialplan, so the DTMF event cannot fire.
          // Assert the same receipt from FreeSWITCH's own log, bound to the
          // call's channel uuid.
          const readLog = spawnSync(
            'docker',
            [
              'exec',
              ctx.handle.name,
              'sh',
              '-c',
              `tail -n ${LOG_TAIL_LINES} /var/log/freeswitch/freeswitch.log 2>/dev/null`,
            ],
            { encoding: 'utf8' },
          );
          const log = (readLog.stdout ?? '') + (readLog.stderr ?? '');
          const lines = log.split('\n').filter((l) => l.includes(uuid!));
          expect(
            lines.some((l) => l.includes(`RTP RECV DTMF ${DIGIT}`)),
            `no RFC 4733 receipt ('RTP RECV DTMF ${DIGIT}') for the call's channel in the FS log`,
          ).toBe(true);
          expect(
            lines.some((l) => l.includes(`RECV DTMF ${DIGIT}`)),
            `no queued DTMF ('RECV DTMF ${DIGIT}') for the call's channel in the FS log`,
          ).toBe(true);
        } else {
          expect(match.digit).toBe(DIGIT);
          expect(match.channel).toMatch(/^sofia\/ws-test\//);
        }

        // Release the gate: the step hangs up and must terminate cleanly.
        await page.evaluate(() => {
          (window as unknown as DtmfGateWindow).__matrixDtmfGo = true;
        });
        const d = await stepPromise;
        expect(d.ok, d.detail).toBe(true);
        const step = d.result as DtmfStepResult;
        expect(step.dtmfSent, 'dtmf step must report dtmfSent').toBe(true);
        expect(step.callState).toBe('terminated');
      } finally {
        // Abort-based teardown: a pending events.next() raced against the
        // deadline must never block cleanup (see fsSubscribeDtfm docstring).
        ac.abort();
      }
    } finally {
      await stun.close();
      await disposeMatrix(ctx);
    }
  });
});
