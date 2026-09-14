// test/asterisk-matrix/recovery.spec.ts — matrix step 10: WSS-drop recovery.
//
// The `drop-wss` page step registers, establishes an outgoing 600 call, then
// severs the live WSS from the page (RecordingWebSocket.hardDrop synthesizes
// the abnormal 1006 close observation a network cut produces; a clean 1000
// close would be treated as a manual disconnect and would NOT arm recovery)
// and observes the library's bounded recovery pipeline.
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
// This mirrors test/freeswitch-matrix/recovery.spec.ts and adds the
// Asterisk-side contact count. That count is readable only because
// `runDropWssStep` was changed (Task 12) to keep its phone alive on success:
// pjsip reaps a WS contact when its connection closes, so a disposed phone
// would leave the AOR at zero. Unlike the FreeSWITCH mirror there is no DTLS
// pem seeding here: TLS is minted per run into a temp tree by startAsterisk,
// not generated inside a read-only mount.
import { test, expect } from '@playwright/test';
import { bootMatrix, disposeMatrix, runStep } from './helpers';
import { countContacts } from './astctl';
import { startStunResponder } from '../matrix-shared/stun';

const CREDENTIALS = { user: '1000', password: 'matrix-pass-2026' };

interface RecoveryStepResult {
  connectionState: string;
  registrationState: string;
  callOutcome: string;
  diagCodes: string[];
  wireRegisters: number;
  wireRegistersAfterDrop: number;
}

test.describe('asterisk matrix · recovery', () => {
  test('step 10: a severed WSS re-registers and the call survives', async ({ page }) => {
    const ctx = await bootMatrix(page);
    const stun = await startStunResponder();
    try {
      // No `register` step here, and no `portBefore`: the FreeSWITCH mirror
      // goes straight to `drop-wss` (recovery.spec.ts:60), and the pre-drop port
      // read this plan used to do was unreadable anyway — `register` disposes
      // its phone in its own `finally` (steps.ts:508), so the AOR was empty by
      // the time the read happened and `findContactPort` returned `undefined`.
      // The Asterisk-side evidence is the contact COUNT after recovery, below.
      //
      // `stunPort` on the drop-wss step for the same measured reason as every
      // other step that establishes media on this stack (Task 8):
      // `test/freeswitch-matrix/recovery.spec.ts:61` passes it here too.
      const dropped = await runStep(page, 'drop-wss', { ...CREDENTIALS, stunPort: stun.port });
      expect(dropped.ok, dropped.detail).toBe(true);
      const res = dropped.result as RecoveryStepResult;

      // Row-10 contract: registration recovered.
      expect(res.connectionState, `connection ${res.connectionState}`).toBe('connected');
      expect(res.registrationState, `registration ${res.registrationState}`).toBe('registered');

      // Row-10 contract: a recovery record observed — the registration recovery
      // diagnostic plus at least one connection.* recovery code.
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
      expect(['established', 'terminated', 'failed'], `call outcome ${res.callOutcome}`).toContain(res.callOutcome);
      if (res.callOutcome === 'failed') {
        expect(res.diagCodes, `typed call failure: ${res.diagCodes.join(',')}`).toContain('call.failed');
      }

      // The Asterisk-side addition. Read what it does and does not prove
      // before trusting it — an over-claimed assertion is worse than no
      // assertion, because it retires a risk nothing is actually watching.
      //
      // The AOR lists exactly ONE contact after recovery. This works only
      // because `runDropWssStep` now leaves its phone alive (see Step 1(a)):
      // pjsip reaps a WS contact when its connection closes, so if the step
      // disposed its phone first, the correct answer at this moment would be 0
      // and this line would be red no matter how well the recovery worked.
      //
      // What it catches: a recovery that opened a second socket and left the
      // first one registered, which lists TWO rows here while every page-side
      // assertion above still passes — both sockets look like one healthy
      // connection from inside the page. What it does NOT catch: a failure of
      // `remove_existing=yes`. A dead socket is reaped by pjsip on close, so it
      // never lingers to be replaced, which means this row count is about live
      // sockets and not about the AOR's replacement config.
      expect(countContacts(ctx.handle, '1000'), 'live contacts after recovery').toBe(1);

      // A NEGATIVE CONTROL, and the reason this assertion is not vacuous: the
      // same helper, at the same instant, for a user that never registered.
      // If this ever returns non-zero the counter is measuring something other
      // than the AOR and the line above is meaningless.
      expect(countContacts(ctx.handle, '1999'), 'contacts for a never-registered user').toBe(0);
    } finally {
      await stun.close();
      await disposeMatrix(ctx);
    }
  });
});
