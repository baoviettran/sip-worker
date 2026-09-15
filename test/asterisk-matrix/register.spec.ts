// test/asterisk-matrix/register.spec.ts
import { test, expect } from '@playwright/test';
import { bootMatrix, disposeMatrix, runStep } from './helpers';

const CREDENTIALS = { user: '1000', password: 'matrix-pass-2026' };

test.describe('asterisk matrix · registration', () => {
  test('register: digest challenge then registered', async ({ page }) => {
    const ctx = await bootMatrix(page);
    try {
      const r = await runStep(page, 'register', CREDENTIALS);
      expect(r.ok, r.detail).toBe(true);
      expect(r.events).toContainEqual(expect.objectContaining({ type: 'registration', detail: 'registered' }));
      expect(r.result?.identity).toBeTruthy();
    } finally {
      await disposeMatrix(ctx);
    }
  });

  test('refresh: re-REGISTER before expiry', async ({ page }) => {
    const ctx = await bootMatrix(page);
    try {
      const r = await runStep(page, 'refresh', CREDENTIALS);
      expect(r.ok, r.detail).toBe(true);
      const regs = r.events.filter((e) => e.type === 'wire' && e.detail === 'REGISTER');
      expect(regs.length).toBeGreaterThanOrEqual(2);
    } finally {
      await disposeMatrix(ctx);
    }
  });

  // Asterisk's code is AUTHENTICATION_FAILED, not the FreeSWITCH tree's
  // REGISTRATION_FAILED, and the difference is the switch's, not the package's.
  // FreeSWITCH finalises a bad credential with 403, which registrar.ts maps to
  // REGISTRATION_FAILED ("REGISTER rejected with 403"); pjsip re-challenges with
  // 401 (three `Failed to authenticate` NOTICEs in the container log), so the
  // client exhausts its ordinary auth-retry budget (DEFAULT_MAX_RETRIES = 3) and
  // reports AUTHENTICATION_FAILED from auth/manager.ts. Both are TYPED — which is
  // what this step exists to prove — and the exact code is asserted, not a
  // loosened boolean.
  test('wrong-password: typed AUTHENTICATION_FAILED', async ({ page }) => {
    const ctx = await bootMatrix(page);
    try {
      const r = await runStep(page, 'wrong-password', { user: '1000', password: 'definitely-wrong' });
      expect(r.ok, r.detail).toBe(false);
      expect(r.errorCode).toBe('AUTHENTICATION_FAILED');
    } finally {
      await disposeMatrix(ctx);
    }
  });
});
