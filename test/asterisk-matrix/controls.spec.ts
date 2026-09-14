// test/asterisk-matrix/controls.spec.ts — matrix steps 6 and 7: hold/resume and
// mute/unmute on an established outgoing call, against Asterisk.
//
// ONE persistent outgoing call is established by the `hold` step (register →
// dial the echo target sip:600@127.0.0.1 → established → local hold) and
// carried through `resume`, `mute`, and `unmute` (which also terminates the
// call and asserts the clean diagnostic chain via assertCleanDiagChain in
// page.ts). The four are sequential and share one call — `controlsRun` is a
// single engine-global slot that `hold` fills and `unmute` clears — so they
// live in ONE test in FreeSWITCH's order rather than four: splitting them would
// need the call re-established and would lose the ordering evidence the
// diagnostic-chain assertions depend on.
//
// Assertions follow the control-plane contract, not an SDP direction literal:
// hold() → holdState.local flips true + the `call.hold` diagnostic (after
// `call.established`); resume() → holdState.local clears + `call.resume` and
// the Task 6 sampler shows both-direction RTP growth again (≥1 s of echo flow);
// setMuted(true) → `muted` true; setMuted(false) → RTP resumes. The steps
// additionally return wire-INVITE counts and under-hold/under-mute growth
// booleans as observed evidence.
//
// Two differences from test/freeswitch-matrix/controls.spec.ts, and no others:
//   - no `ensureDtlsPem` seeding. Asterisk's DTLS pair is rendered into the
//     runtime tree by `renderAstConf` (Task 2), so the read-only /etc/asterisk
//     mount that forces FreeSWITCH's seed step has no counterpart here.
//   - `stunPort` is passed on the FIRST step only, and that is forced by the
//     shared engine's signatures rather than chosen: `runHoldStep(args, profile)`
//     is the only one of the four that takes a `StepArgs` at all
//     (steps.ts:746 vs runResumeStep/runMuteStep/runUnmuteStep at 804/840/876),
//     so there is no way to pass it to the other three — and the call they
//     continue is the one `hold` established.
//
// `stunPort` is UNCONDITIONAL on `hold`, not a maybe. Task 8 measured that
// without an srflx candidate the dialog reaches `established` while no media
// ever flows, so a stack missing it produces a silent-media failure that looks
// exactly like a hold bug — the very failure this spec's diagnosis would send
// someone chasing. Same reason it is unconditional in audio.spec.ts and
// call-inbound.spec.ts.
import { test, expect } from '@playwright/test';
import { bootMatrix, disposeMatrix, runStep } from './helpers';
import { startStunResponder } from '../matrix-shared/stun';

const CREDENTIALS = { user: '1000', password: 'matrix-pass-2026' };

interface RtpCounters {
  packets: number;
  bytes: number;
}

interface ControlsStepResult {
  callState: string;
  holdState?: { local: boolean; remote: boolean };
  muted?: boolean;
  /** The diagnostic codes live HERE, not on MatrixEvent: `events` carries
   *  `{type: 'connection'|'registration'|'wire'}` records and no event's
   *  `detail` is ever a diagnostic code. */
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

test.describe('asterisk matrix · hold/resume + mute/unmute control plane', () => {
  test('steps 6-7: hold, resume, mute, unmute on an established outgoing call', async ({ page }) => {
    const ctx = await bootMatrix(page);
    const stun = await startStunResponder();
    try {
      // hold: established → local hold, `call.hold` after `call.established`.
      // `stunPort` is REQUIRED on this stack — Task 8 measured it: Chromium
      // offers mDNS-obfuscated `.local` host candidates that pjsip cannot
      // resolve, so without an srflx candidate the dialog still reaches
      // `established` while no media ever flows. Unconditional here for the
      // same reason it is unconditional in audio.spec.ts and
      // call-inbound.spec.ts; `StepArgs.stunPort` is consumed generically by
      // every step that builds an RTCPeerConnection, not by `outgoing-audio`
      // alone.
      const h = await runStep(page, 'hold', { ...CREDENTIALS, stunPort: stun.port });
      expect(h.ok, h.detail).toBe(true);
      const hold = h.result as ControlsStepResult;
      expect(hold.callState).toBe('established');
      expect(hold.holdState?.local, `holdState ${JSON.stringify(hold.holdState)}`).toBe(true);
      const holdDiags = hold.diagCodes ?? [];
      expect(holdDiags, `diag trace: ${holdDiags.join(',')}`).toContain('call.established');
      expect(holdDiags, `diag trace: ${holdDiags.join(',')}`).toContain('call.hold');
      expect(holdDiags.indexOf('call.hold')).toBeGreaterThan(holdDiags.indexOf('call.established'));
      // wire evidence of the hold signalling: the initial INVITE plus the
      // re-INVITE, both answered 200 by Asterisk.
      //
      // The 200 count is tied to the INVITE count, not to a literal. `>= 2` is
      // satisfied by the registration handshake's own 200 plus the initial
      // INVITE's, so it passes when the re-INVITE goes unanswered — vacuous
      // against the exact mutation it exists to catch. Same defect class Task
      // 9's review measured on its own 200 assertion (plan commit e01aad2).
      // If a stack quirk ever makes this fail with every INVITE genuinely
      // answered, REPORT it and record what the extra 200 was; do not relax the
      // line back to a literal.
      expect(hold.wireInvites, `wire INVITEs: ${hold.wireInvites}`).toBeGreaterThanOrEqual(2);
      expect(
        hold.wire200s,
        `wire 200s: ${hold.wire200s} vs INVITEs: ${hold.wireInvites}`,
      ).toBeGreaterThanOrEqual(hold.wireInvites);

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
