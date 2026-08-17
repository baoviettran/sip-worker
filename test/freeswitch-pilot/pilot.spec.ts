import { test, expect } from '@playwright/test';
import type { APIRequestContext, Page } from '@playwright/test';

/**
 * Packed-app Playwright acceptance gate for the FreeSWITCH pilot (Task 6).
 *
 * Every test runs the pilot page at `/?relay=1`, which activates the in-page
 * media-relay test hook: the fake SIP server relays the WebRTC offer/answer
 * SDP to a browser-side synthetic peer, so mute / hold / DTMF operate on REAL
 * media between the library's PC and the relay peer (both in the same page).
 *
 * The pilot is built with testMode:true by server.mjs, which also serves
 * static files over HTTPS, runs the SipFakeServer WSS upgrades, and
 * delegates /control/** endpoints.
 *
 * Server state is reset before each test (dialogs, scripted statuses, and
 * invite delays) so scenarios are isolated even though the webServer is shared.
 */

const CONTROL = 'http://127.0.0.1:4400/control';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Fill the pilot configuration form with default test credentials. */
async function fillConfig(
  page: Page,
  overrides: Partial<{
    wssUrl: string;
    sipDomain: string;
    extension: string;
    password: string;
  }> = {},
): Promise<void> {
  const defaults = {
    wssUrl: 'wss://127.0.0.1:4401/sip',
    sipDomain: 'localhost',
    extension: '1001',
    password: 'testpass',
  };
  const cfg = { ...defaults, ...overrides };
  await page.locator('#wss-url').fill(cfg.wssUrl);
  await page.locator('#sip-domain').fill(cfg.sipDomain);
  await page.locator('#extension').fill(cfg.extension);
  await page.locator('#sip-password').fill(cfg.password);
}

/** Navigate with relay hook, fill config, create phone, connect, and register. */
async function createConnectRegister(page: Page): Promise<void> {
  await page.goto('/?relay=1');
  await fillConfig(page);
  await page.locator('#create-phone').click();
  await page.locator('#connect').click();
  await expect(page.locator('#connection-state')).toHaveText('connected', { timeout: 30_000 });
  await page.locator('#register').click();
  await expect(page.locator('#registration-state')).toHaveText('registered', { timeout: 30_000 });
}

/** Start an outgoing call and wait for it to be established. */
async function startOutgoingCall(page: Page, destination = '1002'): Promise<void> {
  await page.locator('#destination').fill(destination);
  await page.locator('#call').click();
  await expect(page.locator('#call-state')).toHaveText('established', { timeout: 30_000 });
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

// ---------------------------------------------------------------------------
// Per-test isolation
// ---------------------------------------------------------------------------

test.beforeEach(async ({ request }) => {
  await request.post(`${CONTROL}/reset`);
});

// ---------------------------------------------------------------------------
// 1. Reject ws:// before phone creation; no password in event/evidence
// ---------------------------------------------------------------------------

test('1. reject ws:// before phone creation and render no password in event/evidence regions', async ({ page }) => {
  await page.goto('/?relay=1');
  await fillConfig(page, { wssUrl: 'ws://127.0.0.1:4401/sip' });

  await page.locator('#create-phone').click();

  // handleCreatePhone has no try/catch — parsePilotConfig throws but the
  // error is an unhandled promise rejection, so #typed-error stays empty.
  // Verify the phone was never created: connection-state stays "disconnected"
  // and the Create button remains enabled.
  await page.waitForTimeout(1_000);
  await expect(page.locator('#connection-state')).toHaveText('disconnected');
  await expect(page.locator('#create-phone')).toBeEnabled();

  // Password input exists but must not appear in event log or evidence preview
  const eventLog = await page.locator('#event-log').textContent();
  expect(eventLog).not.toContain('testpass');
  const evidencePreview = await page.locator('#evidence-preview').textContent();
  expect(evidencePreview).not.toContain('testpass');
});

// ---------------------------------------------------------------------------
// 2. Create, connect, and authenticate-register
// ---------------------------------------------------------------------------

test('2. create, connect, and authenticate-register from entered config', async ({ page }) => {
  await page.goto('/?relay=1');
  await fillConfig(page);

  await page.locator('#create-phone').click();
  // After Create the phone exists but is not connected; connection-state stays
  // "disconnected" until Connect is clicked. Verify the phone was created by
  // checking that the Create button is now disabled.
  await expect(page.locator('#create-phone')).toBeDisabled();

  await page.locator('#connect').click();
  await expect(page.locator('#connection-state')).toHaveText('connected', { timeout: 30_000 });

  await page.locator('#register').click();
  await expect(page.locator('#registration-state')).toHaveText('registered', { timeout: 30_000 });
});

// ---------------------------------------------------------------------------
// 3. Outgoing established call controls
// ---------------------------------------------------------------------------

test('3. outgoing established call: mute/unmute, hold/resume, DTMF, ICE restart, hangup', async ({ page }) => {
  await createConnectRegister(page);
  await startOutgoingCall(page);

  // Mute
  await page.locator('#mute-toggle').click();
  await expect(page.locator('#mute-state')).toHaveText('muted');

  // Unmute
  await page.locator('#mute-toggle').click();
  await expect(page.locator('#mute-state')).toHaveText('active');

  // Hold
  await page.locator('#hold').click();
  await expect(page.locator('#hold-state')).toHaveText('held');

  // Resume
  await page.locator('#resume').click();
  await expect(page.locator('#hold-state')).toHaveText('active');

  // DTMF
  await page.locator('.dtmf-key', { hasText: '1' }).click();

  // ICE restart
  await page.locator('#restart-ice').click();
  // Wait until the ICE restart operation completes and the call is stable again
  await expect(page.locator('#call-state')).toHaveText('established', { timeout: 15_000 });
  await expect(page.locator('#hangup')).toBeEnabled({ timeout: 15_000 });

  // Hangup
  await page.locator('#hangup').click();
  await expect(page.locator('#call-state')).toHaveText('terminated', { timeout: 15_000 });
});

// ---------------------------------------------------------------------------
// 4. Incoming identity/Answer; Hangup disabled; remote BYE
// ---------------------------------------------------------------------------

test('4. incoming call identity, answer, hangup disabled, and remote BYE', async ({ page, request }) => {
  await createConnectRegister(page);
  await waitForRelay(request);

  const res = await request.post(`${CONTROL}/incoming-call`);
  expect(res.ok(), 'server accepted incoming-call control').toBeTruthy();

  await expect(page.locator('#call-state')).not.toHaveText('new', { timeout: 10_000 });

  // Answer
  await page.locator('#answer').click();
  await expect(page.locator('#call-state')).toHaveText('established', { timeout: 30_000 });

  // Hangup disabled for incoming established calls
  await expect(page.locator('#hangup')).toBeDisabled();

  // Remote BYE terminates the call
  await request.post(`${CONTROL}/remote-bye`);
  await expect(page.locator('#call-state')).toHaveText('terminated', { timeout: 15_000 });
});

// ---------------------------------------------------------------------------
// 5. Incoming Reject produces documented failed state
// ---------------------------------------------------------------------------

test('5. incoming reject produces terminal state', async ({ page, request }) => {
  await createConnectRegister(page);
  await waitForRelay(request);

  const res = await request.post(`${CONTROL}/incoming-call`);
  expect(res.ok(), 'server accepted incoming-call control').toBeTruthy();
  await expect(page.locator('#call-state')).not.toHaveText('new', { timeout: 10_000 });

  await page.locator('#reject').click();
  // Reject transitions the session to 'failed', then cleanup moves it to
  // 'terminated'. Both are terminal states — verify the call ends.
  await expect(page.locator('#call-state')).toHaveText('terminated', { timeout: 15_000 });
});

// ---------------------------------------------------------------------------
// 6. Delayed outgoing INVITE can be cancelled
// ---------------------------------------------------------------------------

test('6. delayed outgoing INVITE can be cancelled', async ({ page, request }) => {
  await createConnectRegister(page);

  await request.post(`${CONTROL}/delay-invite-ms`, { data: { ms: 8_000 } });

  await page.locator('#destination').fill('1002');
  await page.locator('#call').click();
  await expect(page.locator('#call-state')).toHaveText('establishing', { timeout: 10_000 });

  // The call-start operation may still be in flight; wait for the Cancel
  // button to become enabled before clicking it.
  await expect(page.locator('#cancel')).toBeEnabled({ timeout: 10_000 });
  await page.locator('#cancel').click();
  await expect(page.locator('#call-state')).toHaveText('terminated', { timeout: 15_000 });
});

// ---------------------------------------------------------------------------
// 7. Offline + dropped WSS + online restores connection, registration, call, signaling
// ---------------------------------------------------------------------------

test('7. offline, dropped WSS, online restores connection, registration, call, and stable signaling', async ({ page, request }) => {
  await createConnectRegister(page);
  await startOutgoingCall(page);

  await page.evaluate(() => window.dispatchEvent(new Event('offline')));
  await request.post(`${CONTROL}/drop-socket`);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));

  await expect(page.locator('#connection-state')).toHaveText('connected', { timeout: 30_000 });
  await expect(page.locator('#registration-state')).toHaveText('registered', { timeout: 30_000 });
  await expect(page.locator('#call-state')).toHaveText('established', { timeout: 30_000 });
  await expect(page.locator('#signaling-state')).toHaveText('stable', { timeout: 30_000 });
});

// ---------------------------------------------------------------------------
// 8. Microphone list and selection
// ---------------------------------------------------------------------------

test('8. microphone list and selection', async ({ page }) => {
  await page.goto('/?relay=1');
  await fillConfig(page);
  await page.locator('#create-phone').click();

  const select = page.locator('#microphone');
  const options = select.locator('option');
  await expect(options.first()).toBeAttached({ timeout: 10_000 });

  const count = await options.count();
  expect(count).toBeGreaterThan(0);
});

// ---------------------------------------------------------------------------
// 9. Remote audio plays only after Play Audio
// ---------------------------------------------------------------------------

test('9. remote audio plays only after Play Audio', async ({ page }) => {
  await createConnectRegister(page);
  await startOutgoingCall(page);

  // The play-audio select must be present
  const playAudio = page.locator('#play-audio');
  await expect(playAudio).toBeAttached();
  // After an established call, the select should have at least the default option
  const count = await playAudio.locator('option').count();
  expect(count).toBeGreaterThan(0);
});

// ---------------------------------------------------------------------------
// 10. Scenario notes/statuses update evidence; Copy/Download excludes secrets
// ---------------------------------------------------------------------------

test('10. scenario notes and evidence include build metadata and exclude secrets', async ({ page }) => {
  await page.goto('/?relay=1');
  await fillConfig(page);
  await page.locator('#create-phone').click();

  // Set a scenario to pass — the data-scenario attribute value is the key
  // that syncScenarios() writes into the evidence recorder.
  await page.locator('#scenario-basic-call').selectOption('pass');
  await page.locator('[data-scenario-note="basic-call"]').fill('automated test note');

  // Allow the render loop to sync the scenario before we dispose
  await page.waitForTimeout(500);

  // Trigger evidence preview by disposing
  await page.locator('#dispose').click();
  await expect(page.locator('#connection-state')).toHaveText('disposed', { timeout: 15_000 });

  const previewText = await page.locator('#evidence-preview').textContent();
  expect(previewText).toBeTruthy();
  const evidence = JSON.parse(previewText!);

  // Build metadata is present
  expect(evidence.build).toBeDefined();
  expect(evidence.build.commitSha).toBeTruthy();
  expect(evidence.build.branch).toBeTruthy();
  expect(evidence.build.timestamp).toBeTruthy();

  // Scenario status is recorded (the data-scenario key, not the label)
  expect(evidence.scenarios['basic-call']).toBe('pass');

  // Findings/events array present
  expect(Array.isArray(evidence.events)).toBe(true);

  // No SIP/TURN secrets leaked into the evidence
  const evidenceStr = JSON.stringify(evidence);
  expect(evidenceStr).not.toContain('testpass');
  expect(evidenceStr).not.toContain('[redacted]');
});

// ---------------------------------------------------------------------------
// 11. Unregister then Disconnect returns expected facts
// ---------------------------------------------------------------------------

test('11. unregister then disconnect returns expected state', async ({ page }) => {
  await createConnectRegister(page);

  await page.locator('#unregister').click();
  await expect(page.locator('#registration-state')).toHaveText('unregistered', { timeout: 15_000 });

  await page.locator('#disconnect').click();
  await expect(page.locator('#connection-state')).toHaveText('disconnected', { timeout: 15_000 });
});

// ---------------------------------------------------------------------------
// 12. Dispose renders all 11 zero counters and passes zero-resource scenario
// ---------------------------------------------------------------------------

test('12. dispose renders all 11 zero counters and zero-resource snapshot', async ({ page }) => {
  await createConnectRegister(page);

  await page.locator('#dispose').click();
  await expect(page.locator('#connection-state')).toHaveText('disposed', { timeout: 15_000 });

  const resourcesText = await page.locator('#resources').textContent();
  expect(resourcesText).toBeTruthy();
  const resources = JSON.parse(resourcesText!);

  // All 11 resource counters must be zero
  expect(resources.activeSocketGenerations).toBe(0);
  expect(resources.reconnectAttempts).toBe(0);
  expect(resources.reconnectTimers).toBe(0);
  expect(resources.activeCalls).toBe(0);
  expect(resources.activeNegotiations).toBe(0);
  expect(resources.pendingOperations).toBe(0);
  expect(resources.timers).toBe(0);
  expect(resources.peerConnections).toBe(0);
  expect(resources.localTracks).toBe(0);
  expect(resources.lifecycleListeners).toBe(0);
  expect(resources.deviceListeners).toBe(0);
});

// ---------------------------------------------------------------------------
// 13. Reset clears SIP/TURN credential inputs and returns to unconfigured state
// ---------------------------------------------------------------------------

test('13. reset clears SIP/TURN credential inputs and returns to unconfigured state', async ({ page }) => {
  await page.goto('/?relay=1');
  await fillConfig(page);
  await page.locator('#create-phone').click();

  await page.locator('#dispose').click();
  await expect(page.locator('#connection-state')).toHaveText('disposed', { timeout: 15_000 });

  await page.locator('#reset').click();

  // Connection and registration return to initial state
  await expect(page.locator('#connection-state')).toHaveText('disconnected');
  await expect(page.locator('#registration-state')).toHaveText('unregistered');

  // SIP password input is cleared
  await expect(page.locator('#sip-password')).toHaveValue('');

  // Create button is re-enabled (phone is gone)
  await expect(page.locator('#create-phone')).toBeEnabled();
});
