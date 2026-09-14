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
// additionally return the under-hold/under-mute growth booleans as observed
// evidence. (They still COMPUTE wire-INVITE/200 counts in steps.ts, but this
// spec no longer declares or asserts them: a dead field on a result interface
// is what a later "fix" re-asserts vacuously — see the wire block below, which
// is positional instead. steps.ts still produces them for the FreeSWITCH
// spec's own local copy of the interface, and that tree is frozen.)
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
      // TWO assertions, and they are deliberately a CONJUNCTION. Each is
      // vacuous under a different model of the wire, so neither alone is the
      // fix, and this file has already shipped each alone in turn:
      //
      //   - the COUNT form (`wire200s >= wireInvites`) is vacuous when the
      //     stack does not challenge the initial INVITE: two INVITEs, three
      //     200s, suppress the hold re-INVITE's 200 -> 2 >= 2 passes. Note what
      //     that failure is: with FEWER INVITEs the count form does not go red,
      //     it goes VACUOUS — fewer INVITEs only make `200s >= INVITEs` easier
      //     to satisfy. (Round 1 of this fix wave wrote the opposite into the
      //     plan — "a count of 2 would make it red on a correct tree" — and
      //     that is backwards.)
      //   - the POSITIONAL form (a 200 after the last INVITE) is
      //     TRANSACTION-BLIND: it cannot tell the hold re-INVITE from the
      //     establishing INVITE or from a PBX-initiated re-INVITE the page
      //     answers. Measured: suppress the hold re-INVITE's own 200 AND let
      //     the PBX initiate a re-INVITE the page answers -> the wire ends
      //     `…,INVITE,INVITE,200,ACK`, the positional form passes, and the
      //     count form (`3 >= 4`) is the one that catches it.
      //
      // Measured truth table — these three mutant scenarios plus green, and the
      // conjunction is red on all three and green only on the committed tree:
      //
      //   scenario                                        count  positional  both
      //   challenge model, hold 200 suppressed (3/2 INV)   RED    RED         RED
      //   no-challenge model, hold 200 suppressed (2/2)    green  RED         RED
      //   hold INVITE unanswered, PBX re-INVITE (4/3)      RED    green       RED
      //   committed tree                                   green  green       GREEN
      //
      // The positional half is anchored to the LAST INVITE, not the second, and
      // that is a MEASURED correction. The wire the hold step actually produces
      // is
      //
      //   REGISTER REGISTER 200 INVITE ACK INVITE 200 ACK INVITE 200 ACK
      //                              ^auth retry, dialog established
      //                                                 ^ the hold re-INVITE
      //
      // — pjsip challenges the first INVITE (401, ACKed but unrecorded), so the
      // SECOND INVITE is the authenticated retry that establishes the dialog and
      // it carries its own 200. Anchoring there (as this wave first did) is
      // satisfied by that establishing 200, which this step never had to prove
      // anything about: measured, suppressing the hold re-INVITE's 200 left it
      // GREEN. The hold re-INVITE is the last INVITE this step's own `hold()`
      // puts on the wire, so the 200 must follow THAT one. The second-INVITE
      // guard is kept as well: it fails when fewer than two INVITEs were seen at
      // all, and the index is bound and GUARDED rather than read inline exactly
      // as test/asterisk-matrix/call-inbound.spec.ts does one step over — with
      // no INVITE, `indexOf` returns -1 and `lastIndexOf('200') > -1` is true
      // for ANY 200. `h.events` is the OUTER step result's event list (the
      // `MatrixResult.events` sibling of `result`), not a field of `h.result`.
      //
      // KNOWN LIMIT, measured and left open deliberately: a hold that sent NO
      // re-INVITE at all is still silent here. Position cannot separate the hold
      // re-INVITE from the establishing INVITE, and the count form is vacuous
      // under exactly that model; only an exact INVITE count would catch it, and
      // that count is stack-dependent. This is incompleteness, not vacuity —
      // every assertion present is real. If a stack quirk ever makes this fail
      // with every INVITE genuinely answered, REPORT it and record what the
      // extra 200 was; do not relax either line to a literal.
      const wire = h.events.filter((e) => e.type === 'wire').map((e) => e.detail);
      const firstInvite = wire.indexOf('INVITE');
      expect(firstInvite, `no INVITE on the wire — wire: ${wire.join(',')}`).toBeGreaterThanOrEqual(0);
      const reInvite = wire.indexOf('INVITE', firstInvite + 1);
      expect(reInvite, `no re-INVITE on the wire — wire: ${wire.join(',')}`).toBeGreaterThan(firstInvite);
      // Both halves of the conjunction — see the table above for which mutant
      // each one owns.
      const wireInvites = wire.filter((x) => x === 'INVITE').length;
      const wire200s = wire.filter((x) => x === '200').length;
      expect(
        wire200s,
        `wire 200s: ${wire200s} vs INVITEs: ${wireInvites} — wire: ${wire.join(',')}`,
      ).toBeGreaterThanOrEqual(wireInvites);
      expect(
        wire.lastIndexOf('200'),
        `no 200 after the last INVITE — wire: ${wire.join(',')}`,
      ).toBeGreaterThan(wire.lastIndexOf('INVITE'));

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
