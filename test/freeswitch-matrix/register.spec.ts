// test/freeswitch-matrix/register.spec.ts
import { test, expect } from '@playwright/test';
import { bootMatrix, disposeMatrix, runStep } from './helpers';

test.describe('matrix · registration', () => {
  test('register: digest challenge then registered', async ({ page }) => {
    const ctx = await bootMatrix(page);
    try {
      const r = await runStep(page, 'register', { user: '1000', password: 'matrix-pass-2026' });
      expect(r.ok, r.detail).toBe(true);
      expect(r.events).toContainEqual(expect.objectContaining({ type: 'registration', detail: 'registered' }));
      expect(r.result?.identity).toBeTruthy();
    } finally { await disposeMatrix(ctx); }
  });
  test('refresh: re-REGISTER before expiry', async ({ page }) => {
    const ctx = await bootMatrix(page);
    try {
      const r = await runStep(page, 'refresh', { user: '1000', password: 'matrix-pass-2026' });
      expect(r.ok, r.detail).toBe(true);
      const regs = r.events.filter((e) => e.type === 'wire' && e.detail === 'REGISTER');
      expect(regs.length).toBeGreaterThanOrEqual(2);
    } finally { await disposeMatrix(ctx); }
  });
  test('wrong-password: typed REGISTRATION_FAILED', async ({ page }) => {
    const ctx = await bootMatrix(page);
    try {
      const r = await runStep(page, 'wrong-password', { user: '1000', password: 'definitely-wrong' });
      expect(r.ok, r.detail).toBe(false);
      expect(r.errorCode).toBe('REGISTRATION_FAILED');
    } finally { await disposeMatrix(ctx); }
  });
});
