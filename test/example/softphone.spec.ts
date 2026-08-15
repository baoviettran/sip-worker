import { test, expect } from '@playwright/test';
import type { APIRequestContext, Page } from '@playwright/test';

/**
 * Packed reference softphone UI gate (Task 15).
 *
 * Every test runs the example page at `/?relay=1`, which activates the in-page
 * media-relay test hook: the fake SIP server relays the WebRTC offer/answer SDP
 * to a browser-side synthetic peer, so mute / hold / DTMF operate on REAL media
 * between the library's PC and the relay peer (both in the same page).
 *
 * The example imports ONLY the packed public `sip-worker` artifact (tarballs
 * installed into a temp fixture by `build-softphone.mjs`, then esbuild-bundled).
 * The server 503s when the artifact is absent and never resolves workspace
 * source.
 *
 * Server state is reset before each test (dialogs, scripted statuses, and
 * invite delays) so scenarios are isolated even though the webServer is shared.
 */

const CONTROL = 'http://127.0.0.1:4200/control';

async function gotoExample(page: Page): Promise<void> {
  await page.goto('/?relay=1');
}

async function connectAndRegister(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Connect' }).click();
  await expect(page.getByTestId('registration-state')).toHaveText('registered');
}

async function startOutgoingCall(page: Page, destination = 'sip:bob@example.com'): Promise<void> {
  await page.getByLabel('Destination').fill(destination);
  await page.getByRole('button', { name: 'Call' }).click();
  await expect(page.getByTestId('call-state')).toHaveText('established');
}

/** Wait until the in-page media relay is connected to the fake SIP server. */
async function waitForRelay(request: APIRequestContext): Promise<void> {
  await expect
    .poll(async () => {
      const res = await request.get(`${CONTROL}/status`);
      if (!res.ok()) return false;
      const body = (await res.json()) as { relayConnected?: boolean };
      return body.relayConnected === true;
    }, { timeout: 15_000 })
    .toBe(true);
}

test.beforeEach(async ({ request }) => {
  await request.post(`${CONTROL}/reset`);
});

test('outgoing call controls and recovery UI', async ({ page }) => {
  await gotoExample(page);
  await connectAndRegister(page);
  await startOutgoingCall(page);

  await page.getByRole('button', { name: 'Mute' }).click();
  await expect(page.getByTestId('call-muted')).toHaveText('muted');

  await page.getByRole('button', { name: 'Hold' }).click();
  await expect(page.getByTestId('call-hold')).toHaveText('held');

  await page.getByRole('button', { name: 'Resume' }).click();
  await expect(page.getByTestId('call-hold')).toHaveText('active');

  // DTMF negotiates telephone-event on BOTH sides (the relay peer answers with
  // a=rtpmap:101 telephone-event/8000), so the digit actually sends.
  await page.getByRole('button', { name: '1' }).click();
  await expect(page.getByTestId('last-dtmf')).toHaveText('1');

  await page.getByRole('button', { name: 'Hangup' }).click();
  await expect(page.getByTestId('call-state')).toHaveText('terminated');
});

test('incoming call answer', async ({ page, request }) => {
  await gotoExample(page);
  await connectAndRegister(page);
  await waitForRelay(request);

  const res = await request.post(`${CONTROL}/incoming-call`);
  expect(res.ok(), 'server accepted incoming-call control').toBeTruthy();

  await expect(page.getByTestId('incoming-panel')).toBeVisible();
  await page.getByRole('button', { name: 'Answer' }).click();
  await expect(page.getByTestId('call-state')).toHaveText('established');

  // Inbound hangup is staged in a later task (IncomingBrowserCall.hangup() is
  // INVALID_STATE), so the caller ends the answered call with a remote BYE.
  await request.post(`${CONTROL}/remote-bye`);
  await expect(page.getByTestId('call-state')).toHaveText('terminated');
});

test('incoming call reject', async ({ page, request }) => {
  await gotoExample(page);
  await connectAndRegister(page);
  await waitForRelay(request);

  await request.post(`${CONTROL}/incoming-call`);
  await expect(page.getByTestId('incoming-panel')).toBeVisible();

  // The core contract treats a local 4xx rejection as a FAILED call (not a
  // normal termination): Invitation.reject() fails the session, so the UI
  // renders the typed CALL_FAILED state and hides the incoming panel.
  await page.getByRole('button', { name: 'Reject' }).click();
  await expect(page.getByTestId('call-state')).toHaveText('failed');
  await expect(page.getByTestId('incoming-panel')).toBeHidden();
});

test('outgoing call cancel', async ({ page, request }) => {
  await gotoExample(page);
  await connectAndRegister(page);

  // Hold the INVITE so the call stays establishing; the CANCEL reconciles it.
  await request.post(`${CONTROL}/delay-invite-ms`, { data: { ms: 8_000 } });

  await page.getByLabel('Destination').fill('sip:bob@example.com');
  await page.getByRole('button', { name: 'Call' }).click();
  await expect(page.getByTestId('call-state')).toHaveText('establishing');

  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByTestId('call-state')).toHaveText('terminated');
});

test('failed call renders the typed error', async ({ page, request }) => {
  await gotoExample(page);
  await connectAndRegister(page);

  await request.post(`${CONTROL}/next-invite-status`, { data: { status: 486 } });

  await page.getByLabel('Destination').fill('sip:bob@example.com');
  await page.getByRole('button', { name: 'Call' }).click();
  await expect(page.getByTestId('call-state')).toHaveText('failed');
  await expect(page.getByTestId('call-error')).toContainText('486');
});

test('remote end terminates the call', async ({ page, request }) => {
  await gotoExample(page);
  await connectAndRegister(page);
  await startOutgoingCall(page);

  await request.post(`${CONTROL}/remote-bye`);
  await expect(page.getByTestId('call-state')).toHaveText('terminated');
});

test('offline/online recovery restores registration and the call', async ({ page, request }) => {
  await gotoExample(page);
  await connectAndRegister(page);
  await startOutgoingCall(page);

  // Simulate the browser losing the network while the WSS dies abruptly. The
  // phone arms recovery, reconnects, re-registers, and restores the call.
  await page.evaluate(() => window.dispatchEvent(new Event('offline')));
  await request.post(`${CONTROL}/drop-socket`);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));

  await expect(page.getByTestId('connection-state')).toHaveText('connected', { timeout: 30_000 });
  await expect(page.getByTestId('registration-state')).toHaveText('registered', { timeout: 30_000 });
  await expect(page.getByTestId('call-state')).toHaveText('established', { timeout: 30_000 });
  await expect(page.getByTestId('call-signaling')).toHaveText('stable', { timeout: 30_000 });
});

test('device selection lists and commits a microphone', async ({ page }) => {
  await gotoExample(page);
  await connectAndRegister(page);

  const select = page.getByTestId('device-select');
  const options = select.locator('option');
  await expect(options).not.toHaveCount(0);

  const count = await options.count();
  expect(count).toBeGreaterThan(0);
  const firstLabel = (await options.nth(0).textContent()) ?? '';
  await select.selectOption({ index: 0 });
  await expect(page.getByTestId('selected-device')).toHaveText(firstLabel);
});

test('remote audio plays only after a user gesture', async ({ page }) => {
  await gotoExample(page);
  await connectAndRegister(page);
  await startOutgoingCall(page);

  const play = page.getByRole('button', { name: 'Play audio' });
  await expect(play).toBeEnabled();
  await play.click();
  await expect(page.getByTestId('audio-state')).toHaveText('playing');
});

test('unregister returns to unregistered', async ({ page }) => {
  await gotoExample(page);
  await connectAndRegister(page);

  await page.getByRole('button', { name: 'Unregister' }).click();
  await expect(page.getByTestId('registration-state')).toHaveText('unregistered');
});

test('dispose releases every owned resource', async ({ page }) => {
  await gotoExample(page);
  await connectAndRegister(page);

  await page.getByRole('button', { name: 'Dispose' }).click();
  await expect(page.getByTestId('connection-state')).toHaveText('disposed');

  // The rendered diagnostics resource snapshot returns to zero owned resources.
  await expect
    .poll(async () => (await page.getByTestId('resources').textContent()) ?? '', { timeout: 15_000 })
    .toMatch(/"activeSocketGenerations":0/);
  await expect
    .poll(async () => (await page.getByTestId('resources').textContent()) ?? '', { timeout: 15_000 })
    .toMatch(/"peerConnections":0/);
});
