// test/freeswitch-matrix/call-inbound.spec.ts — matrix steps 5 and 9: the
// inbound originate (page answers a FreeSWITCH-originated call) and the remote
// BYE (uuid_kill on the FS leg terminates the page call).
//
// The IncomingBrowserCall cannot hang up locally yet (ownerHangup is staged
// for a later task), so BOTH scenarios terminate the call from the node side
// with `uuid_kill <uuid>` on the originated channel — FreeSWITCH sends the
// BYE and the page observes `terminated`. The scenarios differ in what the
// final page step asserts: `hangup` proves clean termination;
// `expect-remote-terminated` additionally asserts the diagnostic chain
// `call.established` → `call.terminated` with no error records.
//
// The inbound answer negotiates WebRTC media, so the same DTLS pem seeding and
// node-side STUN responder prerequisites as audio.spec.ts apply (replicated
// here — audio.spec.ts does not export them and is not in this task's allowed
// file set).
import { test, expect } from '@playwright/test';
import { copyFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createSocket, type RemoteInfo, type Socket } from 'node:dgram';
import { bootMatrix, disposeMatrix, runStep } from './helpers';
import { fsExec, originateCall, resolveWssDestination, type FsHandle } from './fsctl';

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

interface InboundStepResult {
  callState: string;
  diagCodes?: string[];
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Terminate the originated FS channel; the BYE to the page follows. */
async function killChannel(uuid: string): Promise<string> {
  const body = await fsExec(`uuid_kill ${uuid}`);
  if (body.startsWith('-ERR')) throw new Error(`uuid_kill -ERR: ${body}`);
  return body;
}

/**
 * Originate a parked call to the page's WSS registration and return the
 * channel uuid once the call is answered. The originate api call blocks until
 * the destination answers, so the page's answer step must run concurrently
 * with this promise — callers start it, run `answer-incoming`, then await it.
 * A failed originate never throws synchronously: it resolves to '' and the
 * error is reported through `originateError`, so the concurrent answer step
 * is never left with an unhandled rejection.
 */
async function originateParked(
  destination: string,
): Promise<{ uuidPromise: Promise<string>; originateError: () => unknown }> {
  let error: unknown;
  const uuidPromise = originateCall(destination).catch((e: unknown) => {
    error = e;
    return '';
  });
  return { uuidPromise, originateError: () => error };
}

test.describe('matrix · inbound originate + remote BYE', () => {
  test('step 5: page answers an originate, call establishes, clean hangup', async ({ page }) => {
    const ctx = await bootMatrix(page);
    const stun = await startStunResponder();
    try {
      ensureDtlsPem(ctx.handle);
      const waitArgs = { ...CREDENTIALS, stunPort: stun.port };
      const w = await runStep(page, 'wait-incoming', waitArgs);
      expect(w.ok, w.detail).toBe(true);

      // The destination is resolved from the live registration (fs_path port
      // + explicit wss transport) — see resolveWssDestination.
      const destination = await resolveWssDestination('ws-test', CREDENTIALS.user, '127.0.0.1');
      const { uuidPromise, originateError } = await originateParked(destination);

      const a = await runStep(page, 'answer-incoming', CREDENTIALS);
      const uuid = await uuidPromise;
      expect(originateError(), `originate: ${originateError()}`).toBeUndefined();
      expect(uuid, `originate response: ${uuid}`).toMatch(UUID_RE);

      expect(a.ok, a.detail).toBe(true);
      expect((a.result as InboundStepResult).callState).toBe('established');
      // wire evidence: the INVITE reached the page and the 200 OK went out
      expect(a.events).toContainEqual(expect.objectContaining({ type: 'wire', detail: 'INVITE' }));
      expect(a.events).toContainEqual(expect.objectContaining({ type: 'wire', detail: '200' }));

      const kill = await killChannel(uuid);
      expect(kill.startsWith('-ERR'), `uuid_kill: ${kill}`).toBe(false);

      const h = await runStep(page, 'hangup', CREDENTIALS);
      expect(h.ok, h.detail).toBe(true);
      expect((h.result as InboundStepResult).callState).toBe('terminated');
      // the BYE from FreeSWITCH arrived on the wire
      expect(h.events).toContainEqual(expect.objectContaining({ type: 'wire', detail: 'BYE' }));
    } finally {
      await stun.close();
      await disposeMatrix(ctx);
    }
  });

  test('step 9: remote BYE (uuid_kill) terminates the page call with a clean diagnostic chain', async ({ page }) => {
    const ctx = await bootMatrix(page);
    const stun = await startStunResponder();
    try {
      ensureDtlsPem(ctx.handle);
      const waitArgs = { ...CREDENTIALS, stunPort: stun.port };
      const w = await runStep(page, 'wait-incoming', waitArgs);
      expect(w.ok, w.detail).toBe(true);

      const destination = await resolveWssDestination('ws-test', CREDENTIALS.user, '127.0.0.1');
      const { uuidPromise, originateError } = await originateParked(destination);

      const a = await runStep(page, 'answer-incoming', CREDENTIALS);
      const uuid = await uuidPromise;
      expect(originateError(), `originate: ${originateError()}`).toBeUndefined();
      expect(uuid, `originate response: ${uuid}`).toMatch(UUID_RE);

      expect(a.ok, a.detail).toBe(true);
      expect((a.result as InboundStepResult).callState).toBe('established');

      const kill = await killChannel(uuid);
      expect(kill.startsWith('-ERR'), `uuid_kill: ${kill}`).toBe(false);

      const t = await runStep(page, 'expect-remote-terminated', CREDENTIALS);
      expect(t.ok, t.detail).toBe(true);
      const res = t.result as InboundStepResult;
      expect(res.callState).toBe('terminated');
      // diagnostic chain: call.established precedes call.terminated
      const diags = res.diagCodes ?? [];
      expect(diags, `diag trace: ${diags.join(',')}`).toContain('call.established');
      expect(diags, `diag trace: ${diags.join(',')}`).toContain('call.terminated');
      expect(diags.indexOf('call.terminated')).toBeGreaterThan(diags.indexOf('call.established'));
    } finally {
      await stun.close();
      await disposeMatrix(ctx);
    }
  });
});
