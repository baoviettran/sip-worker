// test/asterisk-matrix/call-inbound.spec.ts — matrix steps 5 and 9: the
// PBX-originated call (the page answers an INVITE Asterisk sends down the
// browser's own WSS connection) and the remote BYE (hanging the originated
// channel up terminates the page call with a clean diagnostic chain).
//
// This is risk #4's proof. FreeSWITCH needed the Contact rewritten to the live
// WSS source port before it would route a server→client request back down the
// browser connection; what Asterisk needs is what these two tests measure.
//
// Order matters and is half the test: the page must be registered AND listening
// before the originate, because `Channel: PJSIP/1000` dials the endpoint's
// registered contact — originating first reaches a stale (or absent) one. Then
// the originate and the answer must OVERLAP: see originateParked, which is why
// the originate is started rather than awaited.
import { test, expect } from '@playwright/test';
import { bootMatrix, disposeMatrix, runStep } from './helpers';
import { findContactPort, hangupChannel, originateToBrowser, type AstHandle } from './astctl';
import { startStunResponder } from '../matrix-shared/stun';

const CREDENTIALS = { user: '1000', password: 'matrix-pass-2026' };

/** The step engine's call-state result. `diagCodes` lives HERE, not on
 *  `MatrixEvent`: events carry `{type: 'connection'|'registration'|'wire'}`
 *  records, and no event's `detail` is ever a diagnostic code. */
interface InboundStepResult {
  callState: string;
  diagCodes?: string[];
}

/**
 * Start the originate WITHOUT awaiting it, and hand back the uniqueid promise.
 *
 * Asterisk sends `OriginateResponse` when the originate COMPLETES, and for a
 * ringing channel that completion is the destination answering — measured, not
 * assumed: awaiting `originateToBrowser` before the page answers deadlocks, and
 * the AMI transcript shows the reason (the action is acknowledged, the channel
 * dials, and no OriginateResponse follows until the 20s wait expires — the
 * originate is waiting on a 200 OK that only the not-yet-run answer step would
 * send). This is the same shape the FreeSWITCH spec documents at
 * `test/freeswitch-matrix/call-inbound.spec.ts:56-73`, for the same reason.
 *
 * A failed originate never throws synchronously: it resolves to '' and the
 * error is reported through `originateError`, so the concurrent answer step is
 * never left holding an unhandled rejection.
 */
function originateParked(
  h: AstHandle,
  o: { user: string; exten: string },
): { uniqueid: Promise<string>; originateError: () => unknown } {
  let error: unknown;
  const uniqueid = originateToBrowser(h, o)
    .then((r) => r.uniqueid)
    .catch((e: unknown) => {
      error = e;
      return '';
    });
  return { uniqueid, originateError: () => error };
}

test.describe('asterisk matrix · inbound', () => {
  test('step 5: PBX-originated call is answered', async ({ page }) => {
    const ctx = await bootMatrix(page);
    const stun = await startStunResponder();
    try {
      // Register AND start listening first: the originate dials the registered
      // contact, so originating before this resolves reaches a stale one.
      //
      // `stunPort` is REQUIRED on this stack, not optional — Task 8 measured why.
      // Chromium offers mDNS-obfuscated `.local` host candidates and pjsip cannot
      // resolve them, so without an srflx candidate the dialog still reaches
      // `established` while no media ever flows. The browser's candidate set is
      // direction-agnostic (an offer and an answer carry the same obfuscated
      // candidates), so this binds the inbound leg exactly as it bound the
      // outbound one in `audio.spec.ts`. The FreeSWITCH spec this mirrors passes
      // it unconditionally in both tests (`call-inbound.spec.ts:78,81`), which is
      // why it is unconditional here rather than left to a judgement call.
      const waitArgs = { ...CREDENTIALS, stunPort: stun.port };
      const listening = await runStep(page, 'wait-incoming', waitArgs);
      expect(listening.ok, listening.detail).toBe(true);
      const contactPort = findContactPort(ctx.handle, '1000');
      expect(contactPort, 'Asterisk has no registered contact for 1000').toBeGreaterThan(0);

      // Started, NOT awaited — see originateParked.
      const { uniqueid: parked, originateError } = originateParked(ctx.handle, { user: '1000', exten: '600' });
      const answered = await runStep(page, 'answer-incoming', CREDENTIALS);
      const uniqueid = await parked;
      expect(originateError(), `originate: ${originateError()}`).toBeUndefined();
      expect(uniqueid).toBeTruthy();

      expect(answered.ok, answered.detail).toBe(true);
      expect((answered.result as InboundStepResult).callState).toBe('established');
      // Risk #4's whole content: the server→client INVITE reached the browser
      // and the browser's 200 went back out. A SIP trace shows the attempt;
      // only these two prove delivery.
      expect(answered.events).toContainEqual(expect.objectContaining({ type: 'wire', detail: 'INVITE' }));
      expect(answered.events).toContainEqual(expect.objectContaining({ type: 'wire', detail: '200' }));
    } finally {
      await stun.close();
      await disposeMatrix(ctx);
    }
  });

  test('step 9: remote BYE ends the call cleanly', async ({ page }) => {
    const ctx = await bootMatrix(page);
    const stun = await startStunResponder();
    try {
      // Same `stunPort` requirement and the same reason as step 5 above.
      const waitArgs = { ...CREDENTIALS, stunPort: stun.port };
      const listening = await runStep(page, 'wait-incoming', waitArgs);
      expect(listening.ok, listening.detail).toBe(true);
      // Started, NOT awaited — see originateParked.
      const { uniqueid: parked, originateError } = originateParked(ctx.handle, { user: '1000', exten: '600' });
      const answered = await runStep(page, 'answer-incoming', CREDENTIALS);
      const uniqueid = await parked;
      expect(originateError(), `originate: ${originateError()}`).toBeUndefined();
      expect(answered.ok, answered.detail).toBe(true);

      await hangupChannel(ctx.handle, uniqueid);

      const terminated = await runStep(page, 'expect-remote-terminated', CREDENTIALS);
      expect(terminated.ok, terminated.detail).toBe(true);
      const res = terminated.result as InboundStepResult;
      expect(res.callState).toBe('terminated');
      // The BYE arrived at the page — the server→client request this scenario exists for.
      expect(terminated.events).toContainEqual(expect.objectContaining({ type: 'wire', detail: 'BYE' }));
      // The diagnostic chain proves the call went established → terminated
      // rather than never having been up.
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
