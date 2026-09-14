// test/freeswitch-matrix/controls.spec.ts — matrix steps 6 and 7: hold/resume
// and mute/unmute on an established outgoing call.
//
// One persistent outgoing call is established by the `hold` step (register →
// dial 9196 → established → local hold) and carried through `resume`, `mute`,
// and `unmute` (which also terminates the call and asserts the clean
// diagnostic chain via assertCleanDiagChain in page.ts).
//
// Assertions follow the control-plane contract, not an SDP direction literal:
// hold() → holdState.local flips true + the `call.hold` diagnostic (after
// `call.established`); resume() → holdState.local clears + `call.resume` and
// the Task 6 sampler shows both-direction RTP growth again (≥1 s of echo
// flow); setMuted(true) → `muted` true; setMuted(false) → RTP resumes.
// The steps additionally return wire-INVITE counts (the hold re-INVITE is on
// the wire) and under-hold/under-mute growth booleans as observed evidence.
//
// The call negotiates WebRTC media, so the same DTLS pem seeding and node-side
// STUN responder prerequisites as audio.spec.ts / call-inbound.spec.ts apply
// (replicated here — neither spec exports those helpers).
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

interface RtpCounters {
  packets: number;
  bytes: number;
}

interface ControlsStepResult {
  callState: string;
  holdState?: { local: boolean; remote: boolean };
  muted?: boolean;
  diagCodes?: string[];
  /** both-direction growth after resume / unmute (asserted) */
  rtpGrowth?: boolean;
  rtp?: { ok: boolean; baseline: RtpCounters; inbound: RtpCounters; outbound: RtpCounters };
  /** observed evidence (not asserted): growth under hold / under mute */
  rtpUnderHold?: { ok: boolean; baseline: RtpCounters; inbound: RtpCounters; outbound: RtpCounters };
  rtpDuringMute?: { ok: boolean; baseline: RtpCounters; inbound: RtpCounters; outbound: RtpCounters };
  wireInvites?: number;
  wire200s?: number;
}

test.describe('matrix · hold/resume + mute/unmute control plane', () => {
  test('steps 6-7: hold, resume, mute, unmute on an established outgoing call', async ({ page }) => {
    const ctx = await bootMatrix(page);
    const stun = await startStunResponder();
    try {
      ensureDtlsPem(ctx.handle);

      // hold: established → local hold, `call.hold` after `call.established`
      const h = await runStep(page, 'hold', { ...CREDENTIALS, stunPort: stun.port });
      expect(h.ok, h.detail).toBe(true);
      const hold = h.result as ControlsStepResult;
      expect(hold.callState).toBe('established');
      expect(hold.holdState?.local, `holdState ${JSON.stringify(hold.holdState)}`).toBe(true);
      const holdDiags = hold.diagCodes ?? [];
      expect(holdDiags, `diag trace: ${holdDiags.join(',')}`).toContain('call.established');
      expect(holdDiags, `diag trace: ${holdDiags.join(',')}`).toContain('call.hold');
      expect(holdDiags.indexOf('call.hold')).toBeGreaterThan(holdDiags.indexOf('call.established'));
      // wire evidence of the hold signaling: the initial INVITE plus the
      // re-INVITE, both answered 200 by FreeSWITCH
      expect(hold.wireInvites, `wire INVITEs: ${hold.wireInvites}`).toBeGreaterThanOrEqual(2);
      expect(hold.wire200s, `wire 200s: ${hold.wire200s}`).toBeGreaterThanOrEqual(2);

      // resume: hold released, `call.resume` after `call.hold`, RTP grows again
      const r = await runStep(page, 'resume', CREDENTIALS);
      expect(r.ok, r.detail).toBe(true);
      const resume = r.result as ControlsStepResult;
      expect(resume.callState).toBe('established');
      expect(resume.holdState?.local, `holdState ${JSON.stringify(resume.holdState)}`).toBe(false);
      const resumeDiags = resume.diagCodes ?? [];
      expect(resumeDiags, `diag trace: ${resumeDiags.join(',')}`).toContain('call.hold');
      expect(resumeDiags, `diag trace: ${resumeDiags.join(',')}`).toContain('call.resume');
      expect(resumeDiags.indexOf('call.resume')).toBeGreaterThan(resumeDiags.indexOf('call.hold'));
      expect(resume.rtpGrowth, `rtp counters ${JSON.stringify(resume.rtp)}`).toBe(true);

      // mute: the muted flag flips true
      const m = await runStep(page, 'mute', CREDENTIALS);
      expect(m.ok, m.detail).toBe(true);
      expect((m.result as ControlsStepResult).muted, 'setMuted(true)').toBe(true);

      // unmute: muted false, RTP resumes, call terminates cleanly
      const u = await runStep(page, 'unmute', CREDENTIALS);
      expect(u.ok, u.detail).toBe(true);
      const unmute = u.result as ControlsStepResult;
      expect(unmute.muted, 'setMuted(false)').toBe(false);
      expect(unmute.rtpGrowth, `rtp counters ${JSON.stringify(unmute.rtp)}`).toBe(true);
      expect(unmute.callState).toBe('terminated');
      const finalDiags = unmute.diagCodes ?? [];
      expect(finalDiags, `diag trace: ${finalDiags.join(',')}`).toContain('call.established');
      expect(finalDiags, `diag trace: ${finalDiags.join(',')}`).toContain('call.terminated');
      expect(finalDiags.indexOf('call.terminated')).toBeGreaterThan(finalDiags.indexOf('call.established'));
    } finally {
      await stun.close();
      await disposeMatrix(ctx);
    }
  });
});
