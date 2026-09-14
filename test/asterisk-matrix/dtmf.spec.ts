import { test, expect } from '@playwright/test';
import { bootMatrix, disposeMatrix, runStep } from './helpers';
import { amiFor, collectDtmf } from './astctl';
import { startStunResponder } from '../matrix-shared/stun';

const CREDENTIALS = { user: '1000', password: 'matrix-pass-2026' };
const DIGITS = '1234#';

/** The page-side gate `runDtmfStep` parks on (see its "dtmf drain gate" wait). */
interface DtmfGateWindow {
  __matrixAwaitDtmf?: boolean;
  __matrixDtmfGo?: boolean;
}

test.describe('asterisk matrix · DTMF', () => {
  test('step 8: RFC 4733 digits reach the PBX', async ({ page }) => {
    const ctx = await bootMatrix(page);
    const stun = await startStunResponder();
    const ami = await amiFor(ctx.handle);
    // Arm the collector BEFORE the page dials — the digits go on the wire
    // during runStep, so a wait started afterwards races and usually loses —
    // then start the step WITHOUT awaiting it. runDtmfStep parks at a
    // page-side gate after sending, holding the call up while this spec
    // observes (its wait is capped at 90 s, so awaiting here would block for
    // that whole cap and then fail on the gate, not on the digits).
    const observed = collectDtmf(ami, DIGITS.length);
    const stepPromise = runStep(page, 'dtmf', { ...CREDENTIALS, stunPort: stun.port, digits: DIGITS });
    try {
      await page.waitForFunction(
        () => (window as unknown as DtmfGateWindow).__matrixAwaitDtmf === true,
        undefined,
        { timeout: 120_000 },
      );
      const got = await observed;
      // Release the gate before asserting: the digits are already collected,
      // so the call may hang up now, and a failing assertion below cannot
      // leave the step parked.
      await page.evaluate(() => {
        (window as unknown as DtmfGateWindow).__matrixDtmfGo = true;
      });
      expect(got, `digits Asterisk reported, in order (want ${DIGITS})`).toBe(DIGITS);
      const r = await stepPromise;
      expect(r.ok, r.detail).toBe(true);
    } finally {
      // Belt and braces: if the collector's deadline expired, the gate is
      // still closed and the step is still pending. Release it and drain the
      // promise, so a failing run reports the digit failure rather than an
      // unhandled rejection from the parked step.
      await page
        .evaluate(() => {
          (window as unknown as DtmfGateWindow).__matrixDtmfGo = true;
        })
        .catch(() => {});
      await stepPromise.catch(() => {});
      ami.close();
      await stun.close();
      await disposeMatrix(ctx);
    }
  });
});
