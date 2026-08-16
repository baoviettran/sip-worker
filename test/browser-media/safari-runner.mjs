#!/usr/bin/env node
/**
 * Shipping-Safari acceptance gate (macOS). Runs ONLY against the BUILT/PACKED
 * browser package served over a real HTTPS secure context.
 *
 * Gates BOTH the v0.5 media acceptance AND the v0.7 phone controls/recovery
 * acceptance — both MANDATORY release prerequisites. This runner:
 *   1. mints a per-run local CA + leaf (openssl, never committed),
 *   2. serves the browser-media harness over HTTPS (8443) AND the browser-phone
 *      harness over HTTPS (8444) with that same leaf, plus the SIP WSS (4200)
 *      carrying `/sip` + `/relay` — reusing the exact built-only handlers from
 *      server.mjs and browser-phone/server.mjs so the 503-when-artifact-absent
 *      contract is inherited (Safari requires a true secure context; unlike
 *      Playwright it will NOT grant getUserMedia/AudioContext over plain HTTP),
 *   3. installs the ephemeral CA as a root trust anchor in the macOS System
 *      keychain (`sudo security add-trusted-cert`) so Safari accepts the leaf
 *      on 127.0.0.1/localhost; the trust is removed in `finally` and again by
 *      the workflow's `if: always()` step. (The earlier ephemeral-keychain +
 *      `set-key-partition-list` recipe failed deterministically on GitHub's
 *      macos-14 runners before any Safari test launched.)
 *   4. creates a Safari WebDriver session via Node's built-in `fetch` against the
 *      W3C WebDriver /session endpoint of a locally-started `safaridriver`,
 *   5. navigates to each HTTPS harness, waits for it to boot the built bundle,
 *      and calls `window.runMediaAcceptance()` then `window.runPhoneAcceptance()`,
 *      asserting the structured result {passed, checks, ...}, and records
 *      Safari/OS versions,
 *   6. deletes the WebDriver session in `finally` (ALWAYS), terminates the
 *      driver, and exits non-zero if Safari is unavailable, cannot launch, or any
 *      media OR phone check fails. There is NO skip path and NO `continue-on-error`.
 *
 * Env:
 *   SAFARIDRIVER_URL   default http://localhost:4444
 *   SAFARIDRIVER_BIN   default safaridriver (searched on PATH)
 *   SAFARIDRIVER_PORT  default 4444 (only used when starting the driver)
 *   HARNESS_PORT       default 8443 (browser-media HTTPS harness)
 *   PHONE_HARNESS_PORT default 8444 (browser-phone HTTPS harness)
 *   SIP_WSS_PORT       default 4200  (WSS for /sip + /relay)
 *   HARNESS_URL        default https://localhost:<HARNESS_PORT>/index.html
 *   PHONE_HARNESS_URL  default https://localhost:<PHONE_HARNESS_PORT>/index.html
 *   KEYCHAIN_DIR       default os.tmpdir() (where the per-run CA bundle is created)
 */

import { spawn, execFileSync } from 'node:child_process';
import https from 'node:https';
import { appendFileSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createFakeServer, createPhoneHandler, startSipWss, makeCertBundle } from '../browser-phone/server.mjs';
import { handler as mediaHandler } from './server.mjs';

const DRIVER_URL = process.env.SAFARIDRIVER_URL || 'http://localhost:4444';
const DRIVER_BIN = process.env.SAFARIDRIVER_BIN || 'safaridriver';
const DRIVER_PORT = Number(process.env.SAFARIDRIVER_PORT || 4444);
const HARNESS_PORT = Number(process.env.HARNESS_PORT || 8443);
const PHONE_HARNESS_PORT = Number(process.env.PHONE_HARNESS_PORT || 8444);
const SIP_WSS_PORT = Number(process.env.SIP_WSS_PORT || 4200);
// 127.0.0.1 literal (not `localhost`): the harness servers bind 127.0.0.1 (IPv4
// only), and Safari can resolve `localhost` to ::1 first — a refused IPv6
// connect fails the WebDriver navigation and leaves the session on about:blank.
// The per-run leaf carries the IP:127.0.0.1 SAN, so TLS still validates.
const MEDIA_HARNESS_URL = process.env.HARNESS_URL || `https://127.0.0.1:${HARNESS_PORT}/index.html`;
const PHONE_HARNESS_URL = process.env.PHONE_HARNESS_URL || `https://127.0.0.1:${PHONE_HARNESS_PORT}/index.html`;
const KEYCHAIN_DIR = process.env.KEYCHAIN_DIR || tmpdir();
// Bound every WebDriver HTTP call. A Safari stuck on a page-side operation
// (dialog, never-resolving script) otherwise holds a /execute open until the
// job timeout, and the gate dies as a silent 40-minute hang with no retained
// log. Each bounded call instead surfaces a warning naming the URL.
const WD_TIMEOUT_MS = 60000;
// Mirror every progress/warning line to a workspace file so a cancelled or
// timed-out run (whose step log GitHub retains nothing for) still leaves its
// partial trail in the uploaded artifact.
const LOG_PATH = join(process.cwd(), 'safari-runner.log');
function logProgress(line) {
  process.stdout.write(`${line}\n`);
  try { appendFileSync(LOG_PATH, `${new Date().toISOString()} ${line}\n`); } catch {}
}
// Hard watchdog: if anything still manages to stall the runner (a bounded call
// that does not settle, a synchronous tool that ignores its timeout), fail the
// gate explicitly instead of hanging until the 40-minute job timeout — GitHub
// retains no log for a timed-out job, so a silent hang is undiagnosable.
// Acceptance legitimately runs up to ~10 minutes; 20 is safely above that.
setTimeout(() => {
  process.stderr.write(`Safari gate WATCHDOG: exceeded 20 minutes; aborting.\n`);
  process.exit(1);
}, 20 * 60 * 1000).unref();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errors = [];

let sessionId = null;
let driver = null;
let httpsServers = [];
let sipWss = null;
let certs = null;
// Set when System-keychain trust teardown fails: the CA file must then survive
// the cert-file unlink below so the workflow's `if: always()` cleanup step can
// still find it and revoke the trust (see teardownKeychainTrust).
let trustRemovalFailed = false;

// --- TLS ------------------------------------------------------------------
// Safari needs a real secure context for getusermedia/AudioContext and for WSS
// (the SIP link is a real `wss://` per-run TLS service). The macOS runner has
// `openssl`; mint a throwaway local CA + leaf (CN=localhost + IP:127.0.0.1 SAN)
// covering BOTH HTTPS harnesses and the SIP WSS. The CA is installed as a
// root trust anchor below; Node's runner-side fetch is pointed at the
// SAME localhost the cert names, and the macOS workflow runs it with
// NODE_TLS_REJECT_UNAUTHORIZED=0 (throwaway, never in the tree). No credentials
// ever pass over this link.

function listen(server, port) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
}

async function startHarnessServers() {
  certs = await makeCertBundle(KEYCHAIN_DIR);
  const tlsOpts = { key: readFileSync(certs.leafKey), cert: readFileSync(certs.leafCrt) };
  const fakeServer = createFakeServer();

  const mediaServer = https.createServer(tlsOpts, mediaHandler);
  const phoneServer = https.createServer(tlsOpts, createPhoneHandler(fakeServer));
  await Promise.all([
    listen(mediaServer, HARNESS_PORT),
    listen(phoneServer, PHONE_HARNESS_PORT),
  ]);
  httpsServers = [mediaServer, phoneServer];

  // SIP WSS carrying /sip (signaling) + /relay (in-page media bridge). The same
  // fake server backs the phone HTTPS control plane, so the runner's page can
  // arm/drop/record the exact same controls the Playwright gate uses.
  sipWss = await startSipWss(fakeServer, { bundle: certs, port: SIP_WSS_PORT });

  // Preserve the exact certs macOS generated (uploaded with the artifact on any
  // outcome) so a trust failure can be diagnosed from the actual bytes.
  try {
    writeFileSync(join(process.cwd(), 'safari-ca.crt'), readFileSync(certs.caCrt));
    writeFileSync(join(process.cwd(), 'safari-leaf.crt'), readFileSync(certs.leafCrt));
    const leafTxt = execFileSync('openssl', ['x509', '-in', certs.leafCrt, '-noout', '-text']).toString();
    const i = leafTxt.indexOf('X509v3 extensions');
    logProgress(`safari: leaf extensions: ${leafTxt.slice(i, i + 350).replace(/\n+/g, ' | ')}`);
  } catch (error) {
    logProgress(`safari: could not preserve/dump certs -> ${error.message}`);
  }

  console.log(`Safari harness: media https://localhost:${HARNESS_PORT}/  phone https://localhost:${PHONE_HARNESS_PORT}/  wss://127.0.0.1:${SIP_WSS_PORT}/sip`);
  // Pre-flight the harness servers from Node (runs with NODE_TLS_REJECT_UNAUTHORIZED=0)
  // so a dead port or an artifact-absent 503 is attributed to the server, not to
  // a Safari boot failure.
  for (const [label, u] of [['media', MEDIA_HARNESS_URL], ['phone', PHONE_HARNESS_URL]]) {
    try {
      const res = await fetch(u, { signal: AbortSignal.timeout(10000) });
      logProgress(`safari: preflight ${label} ${u} -> HTTP ${res.status}`);
    } catch (error) {
      logProgress(`safari: preflight ${label} ${u} FAILED -> ${error && error.name}: ${error && error.message}`);
    }
  }
  // Pre-flight the module URLs the harness pages import, so a missing or
  // 503-ing artifact is attributed to the server, not to Safari.
  for (const u of [
    `https://127.0.0.1:${HARNESS_PORT}/synthetic-peer.js`,
    `https://127.0.0.1:${HARNESS_PORT}/assets/browser/media/index.js`,
    `https://127.0.0.1:${HARNESS_PORT}/assets/core/index.js`,
  ]) {
    try {
      const res = await fetch(u, { signal: AbortSignal.timeout(10000) });
      logProgress(`safari: preflight module ${u} -> HTTP ${res.status}`);
    } catch (error) {
      logProgress(`safari: preflight module ${u} FAILED -> ${error && error.name}: ${error && error.message}`);
    }
  }
}

// --- macOS keychain trust --------------------------------------------------
// GitHub's macos runners do NOT honor a System-keychain trust root reliably:
// the CA was present in the System keychain, yet `security verify-cert` still
// evaluated the leaf against PUBLIC CAs (CT was required), Safari kept showing
// "This Connection Is Not Private", and teardown's remove-trusted-cert hung.
// Safari runs as this same user, so trust the CA in the USER login keychain
// first (no admin store needed); fall back to the System keychain if the
// user-domain trust does not verify. Every attempt is verified and logged so a
// silent trust failure is never mistaken for a Safari boot error.
async function setupKeychainTrust() {
  if (process.platform !== 'darwin') {
    console.log('NOT macOS: skipping keychain import (the Safari job is macOS-only; this run cannot attest Safari)');
    return;
  }
  // Trust the per-run CA as a root in the SYSTEM admin store — the canonical
  // Safari-CI recipe. (User login-keychain trust ops HANG headlessly on the
  // runner, so they are not attempted.) The leaf is verified afterward so a
  // silent trust failure is reported as the cause, never a baffling boot error.
  execFileSync(
    'sudo',
    ['security', 'add-trusted-cert', '-d', '-r', 'trustRoot', '-k', '/Library/Keychains/System.keychain', certs.caCrt],
    { stdio: 'inherit', timeout: 30000 },
  );
  logProgress(`safari: installed CA trust root via the System keychain: ${certs.caCrt}`);
  if (!verifyLeafTrust()) {
    throw new Error('CA trust was installed but the leaf still does not verify');
  }
}

/** True iff the leaf verifies under the current macOS trust settings. */
function verifyLeafTrust() {
  try {
    execFileSync('security', ['verify-cert', '-p', 'ssl', '-c', certs.leafCrt], { stdio: 'inherit', timeout: 20000 });
    return true;
  } catch (error) {
    logProgress(`safari: verify-cert for the leaf FAILED -> ${error.message}`);
    dumpTrustSettings();
    return false;
  }
}

/** Log the admin and user trust-settings entries matching the per-run CA. */
function dumpTrustSettings() {
  for (const [domain, flag] of [['system', '-d'], ['user', '-u']]) {
    try {
      const out = execFileSync('security', ['dump-trust-settings', flag], { encoding: 'utf8', timeout: 20000 });
      const hits = out.split('\n').filter((l) => /sipw|sipw-test-ca|cert|root/i.test(l)).slice(0, 15);
      logProgress(`safari: ${domain} trust settings: ${hits.join(' | ') || '(no matching entries)'}`);
    } catch (error) {
      logProgress(`safari: dump-trust-settings ${flag} FAILED -> ${error.message}`);
    }
  }
}

function teardownKeychainTrust() {
  if (process.platform !== 'darwin') return;
  if (!certs) return;
  try {
    execFileSync('sudo', ['security', 'remove-trusted-cert', '-d', certs.caCrt], { stdio: 'inherit', timeout: 30000 });
    logProgress('Removed ephemeral CA trust from the System keychain');
  } catch (error) {
    trustRemovalFailed = true;
    logProgress(`Failed to remove System keychain trust; leaving the CA file for the workflow cleanup step: ${error.message}`);
  }
}

// --- W3C WebDriver over Node fetch ----------------------------------------
async function wdFetch(url, { method = 'GET', body } = {}) {
  try {
    const res = await fetch(url, {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(WD_TIMEOUT_MS),
    });
    const json = await res.json().catch(() => ({}));
    return { status: res.status, json };
  } catch (error) {
    logProgress(`[wd] ${method} ${url} -> ${error && error.name}: ${error && error.message}`);
    throw error;
  }
}

async function wdDelete(url) {
  try { await fetch(url, { method: 'DELETE', signal: AbortSignal.timeout(WD_TIMEOUT_MS) }); } catch {}
}

async function wdExecute(script, args = []) {
  const { json } = await wdFetch(
    `${DRIVER_URL}/session/${sessionId}/execute/sync`,
    { method: 'POST', body: { script, args } },
  );
  return json.value;
}

// --- driver lifecycle -------------------------------------------------------
async function startDriver() {
  logProgress(`safari: starting ${DRIVER_BIN} (readiness bound ${20}s)`);
  // NOTE: no `--enable` flag here. `--enable` requires admin authorization and,
  // run as the unprivileged runner user, makes safaridriver PROMPT FOR A
  // PASSWORD (which fails — no interactive user on the runner) before it ever
  // starts its HTTP server. Remote Automation was already granted by the
  // workflow's `sudo safaridriver --enable` step.
  driver = spawn(DRIVER_BIN, ['-p', String(DRIVER_PORT)], {
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  // Surface driver stderr to aid CI diagnosis if it fails to start.
  driver.stderr.on('data', (d) => process.stderr.write(`[safaridriver] ${d}`));
  let spawnError = null;
  driver.once('error', (e) => { spawnError = e; });
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (spawnError) {
      throw new Error(`safaridriver failed to spawn: ${spawnError.message}; Safari unavailable on this runner`);
    }
    if (driver.exitCode !== null) {
      throw new Error(`safaridriver exited early (code ${driver.exitCode}); Safari unavailable on this runner`);
    }
    try {
      // Bound the readiness poll: a safaridriver that accepts the connection
      // but never responds (e.g. blocked starting Safari on a permission
      // dialog) must fail the gate, not hang it until the job timeout.
      const res = await fetch(`${DRIVER_URL}/status`, { signal: AbortSignal.timeout(10000) });
      if (res.status >= 200 && res.status < 500) {
        logProgress('safari: safaridriver ready');
        return;
      }
    } catch (error) {
      logProgress(`[wd] status ${DRIVER_URL} -> ${error && error.name}: ${error && error.message}`);
    }
    await sleep(400);
  }
  throw new Error('safaridriver did not become ready within the bounded window');
}

function stopDriver() {
  if (driver && driver.exitCode === null) driver.kill('SIGTERM');
}

async function driverExited() {
  if (!driver) return { code: null, ok: true };
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve({ code: 'TIMEOUT', ok: false }), 5000);
    driver.once('exit', (code) => { clearTimeout(t); resolve({ code, ok: code === 0 || code === null }); });
    if (driver.exitCode !== null) { clearTimeout(t); resolve({ code: driver.exitCode, ok: driver.exitCode === 0 || driver.exitCode === null }); }
    else driver.kill('SIGTERM');
  });
}

// --- acceptance -------------------------------------------------------------
async function createSafariSession() {
  const created = await wdFetch(`${DRIVER_URL}/session`, {
    method: 'POST',
    body: { capabilities: { alwaysMatch: { browserName: 'Safari' } } },
  });
  if (created.status >= 300 || !created.json?.value?.sessionId) {
    throw new Error(`safaridriver did not create a Safari session: ${created.status} ${JSON.stringify(created.json)}`);
  }
  sessionId = created.json.value.sessionId;

  // record Safari/OS versions (audit trail); fail if only 'unknown'/missing
  const caps = created.json.value.capabilities || created.json.value || {};
  const browserVersion = caps.browserVersion || 'unknown';
  const platformVersion = caps.platformVersion || 'unknown';
  const platformName = caps.platformName || 'unknown';
  logProgress(`Safari session: browser=${browserVersion} os=${platformVersion} platform=${platformName}`);
  if (browserVersion === 'unknown') throw new Error('Safaridriver returned no browserVersion; cannot attest which Safari ran');
}

async function navigateTo(url, bootScript, bootFailMsg) {
  const nav = await wdFetch(`${DRIVER_URL}/session/${sessionId}/url`, { method: 'POST', body: { url } });
  // A non-2xx (e.g. "unknown error: ..." when Safari refuses the navigation)
  // must be visible, not silently ignored while we poll an about:blank page.
  if (nav.status >= 300) {
    logProgress(`safari: /url ${url} -> HTTP ${nav.status} ${JSON.stringify(nav.json)}`);
  }
  // Wait up to 90s for the harness to set booted === true. This CANNOT use the
  // generic poll(): that helper treats a falsy return (e.g. the boot probe's
  // `false`) as a valid result and returns immediately — the boot wait would be
  // a single 500ms probe, giving a booting page no time to load its modules
  // (observed: failed at 2.5s with only /synthetic-peer.js fetched).
  const deadline = Date.now() + 90000;
  let booted = false;
  while (Date.now() < deadline) {
    try {
      if (await wdExecute(`return ${bootScript}`) === true) { booted = true; break; }
    } catch {}
    await sleep(500);
  }
  if (!booted) {
    await captureBootFailure(url);
    throw new Error(bootFailMsg);
  }
}

/**
 * Grant user activation via a trusted WebDriver pointer action. Safari withholds
 * autoplay (Web Audio included) from pages without a real user gesture; the
 * phone page's synthetic AudioContext then stays suspended and the library's
 * outbound RTP never flows. A W3C /actions input is treated as a trusted event,
 * unlike a script-dispatched synthetic click.
 */
async function grantUserActivation() {
  try {
    await wdFetch(`${DRIVER_URL}/session/${sessionId}/actions`, {
      method: 'POST',
      body: {
        actions: [
          {
            type: 'pointer',
            id: 'mouse',
            parameters: { pointerType: 'mouse' },
            actions: [
              { type: 'pointerMove', duration: 0, x: 20, y: 20 },
              { type: 'pointerDown', button: 0 },
              { type: 'pointerUp', button: 0 },
            ],
          },
        ],
      },
    });
    logProgress('safari: dispatched a trusted click (user activation for autoplay)');
  } catch (error) {
    logProgress(`safari: user-activation click failed -> ${error.message}`);
  }
}

/**
 * When a harness page fails to boot, capture what the page actually shows and
 * a screenshot so the gate reports a cause (cert-interstitial, fatal harness
 * error, build absent) instead of a bare "did not boot".
 */
async function captureBootFailure(url) {
  try {
    const diag = await wdExecute(`return {
      href: location.href,
      readyState: document.readyState,
      statusText: (document.getElementById('status') && document.getElementById('status').textContent) || null,
      bodyText: document.body.innerText.slice(0, 400),
      bridge: window.__webRtcMediaRun || window.__phoneRun || null,
      resources: performance.getEntriesByType('resource').slice(0, 40).map((e) =>
        (e.initiatorType || '?') + ' ' + e.name + ' ' + (e.responseStatus ?? '') + ' ' + Math.round(e.duration) + 'ms').join(' | '),
    }`);
    logProgress(`safari: boot failure on ${url} — ${JSON.stringify(diag)}`);
  } catch (error) {
    logProgress(`safari: boot failure on ${url} — could not read page: ${error.message}`);
  }
  try {
    const { json } = await wdFetch(`${DRIVER_URL}/session/${sessionId}/screenshot`, { method: 'POST', body: {} });
    const b64 = json && json.value;
    if (typeof b64 === 'string') {
      const shotPath = join(process.cwd(), `safari-boot-failure-${sessionId}.png`);
      writeFileSync(shotPath, Buffer.from(b64, 'base64'));
      logProgress(`safari: wrote boot-failure screenshot to ${shotPath}`);
    }
  } catch (error) {
    logProgress(`safari: screenshot failed: ${error.message}`);
  }
}

function assertAcceptance(result, gate) {
  if (!result || result.passed !== true) {
    throw new Error(`Safari ${gate} acceptance FAILED: ${JSON.stringify(result)}`);
  }
  const names = Object.keys(result.checks || {});
  if (names.length === 0) throw new Error(`${gate} acceptance returned no checks`);
  for (const name of names) {
    if (result.checks[name] !== true) throw new Error(`${gate} check failed: ${name}`);
  }
  logProgress(`Safari ${gate} acceptance PASSED. Verified: ${names.join(', ')}`);
}

async function navigateAndRun() {
  logProgress('safari: creating WebDriver session');
  await createSafariSession();

  // 1. browser-media acceptance (v0.5): direct host path, real two-way RTP.
  logProgress('safari: navigating to the browser-media harness');
  await navigateTo(
    MEDIA_HARNESS_URL,
    'window.__webRtcMediaRun && window.__webRtcMediaRun.booted === true',
    'browser-media harness did not boot the built bundle over HTTPS',
  );
  logProgress('safari: polling runMediaAcceptance (120s bound)');
  // Fire-and-forget + flag poll: invoking runMediaAcceptance() from EVERY poll
  // iteration would start a fresh acceptance after each 60s WebDriver timeout,
  // piling up concurrent runs on the stuck one.
  await wdExecute('window.__mediaAcceptanceResult = null; window.__mediaAcceptanceDone = false; window.runMediaAcceptance().then((x) => { window.__mediaAcceptanceResult = x; window.__mediaAcceptanceDone = true; }).catch((e) => { window.__mediaAcceptanceResult = { passed: false, error: { name: e && e.name, message: e && e.message } }; window.__mediaAcceptanceDone = true; }); return true;');
  const mediaResult = await poll(120000, async () => {
    const r = await wdExecute('return window.__mediaAcceptanceDone ? window.__mediaAcceptanceResult : null');
    return r;
  }, 'runMediaAcceptance did not complete', true);
  logProgress(`runMediaAcceptance result: ${JSON.stringify(mediaResult)}`);
  assertAcceptance(mediaResult, 'media');

  // 2. browser-phone acceptance (v0.7): connect -> register -> real call ->
  //    mute / hold / DTMF -> cleanup, plus fast WSS-loss recovery and a real
  //    offline/online ICE-restart recovery, of the BUILT library over the real
  //    WSS. Three full cycles on Safari can run past 180s, so allow 5 minutes.
  logProgress('safari: navigating to the browser-phone harness');
  await navigateTo(
    PHONE_HARNESS_URL,
    'window.__phoneRun && window.__phoneRun.booted === true',
    'browser-phone harness did not boot the built bundle over HTTPS',
  );
  // Safari withholds autoplay from a page it has never seen a user gesture on;
  // the phone page's synthetic AudioContext then stays suspended and the
  // library sends no audio. A trusted WebDriver action counts as a real input,
  // granting user activation for the page.
  await grantUserActivation();
  logProgress('safari: polling runPhoneAcceptance (8 minute bound)');
  let phoneResult;
  try {
    // Fire-and-forget + flag poll (see the media acceptance above): the phone
    // acceptance legitimately runs minutes, and invoking it per poll iteration
    // would pile up concurrent runs after each 60s WebDriver timeout.
    await wdExecute('window.__phoneAcceptanceResult = null; window.__phoneAcceptanceDone = false; window.runPhoneAcceptance().then((x) => { window.__phoneAcceptanceResult = x; window.__phoneAcceptanceDone = true; }).catch((e) => { window.__phoneAcceptanceResult = { passed: false, error: { name: e && e.name, message: e && e.message } }; window.__phoneAcceptanceDone = true; }); return true;');
    let lastClickAt = Date.now();
    phoneResult = await poll(480000, async () => {
      // Re-grant user activation every ~15s: Safari's autoplay grant from the
      // initial click does not persist to AudioContexts created later (the
      // recovery scenarios' fresh sources stayed suspended while the controls
      // scenario's — created right after the click — resumed).
      if (Date.now() - lastClickAt > 15000) {
        await grantUserActivation();
        lastClickAt = Date.now();
      }
      const r = await wdExecute('return window.__phoneAcceptanceDone ? window.__phoneAcceptanceResult : null');
      return r;
    }, 'runPhoneAcceptance did not complete', true);
  } catch (error) {
    // Surface what the page knew at the moment it stopped completing, so a
    // stuck acceptance reports a cause (stage, last scenario result, captured
    // uncaught errors / rejections) instead of a bare timeout.
    try {
      const pageDiag = await wdExecute('return { booted: !!(window.__phoneRun && window.__phoneRun.booted), relayConnected: !!(window.__phoneRun && window.__phoneRun.relayConnected), stage: (window.__phoneRun && window.__phoneRun.stage) || null, lastResult: (window.__phoneRun && window.__phoneRun.lastResult) || null, errors: (window.__phoneRun && window.__phoneRun.errors) || [] }');
      logProgress(`safari: phone acceptance page diagnostic: ${JSON.stringify(pageDiag)}`);
    } catch {}
    throw error;
  }
  logProgress(`runPhoneAcceptance result: ${JSON.stringify(phoneResult)}`);
  assertAcceptance(phoneResult, 'phone');
}

async function poll(timeoutMs, fn, failMsg, allowNull = false) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try { last = await fn(); } catch { last = null; }
    if (last !== null && last !== undefined) return last;
    await sleep(500);
  }
  if (allowNull && last !== null) return last;
  throw new Error(failMsg);
}

// --- main ------------------------------------------------------------------
// `server.close()` waits for lingering connections; bound every close so a
// stuck relay/keep-alive socket can never hang the gate after the run.
const closeWithTimeout = (fn, ms = 5000) =>
  new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    Promise.resolve(fn()).then(() => { clearTimeout(t); resolve(); });
  });

async function main() {
  await startHarnessServers();
  try {
    await setupKeychainTrust();
    await startDriver();
    await navigateAndRun();
    const exit = await driverExited();
    if (!exit.ok) errors.push('safaridriver did not terminate cleanly');
  } catch (error) {
    errors.push(error.message || String(error));
  } finally {
    logProgress('safari: closing WebDriver session');
    if (sessionId) await wdDelete(`${DRIVER_URL}/session/${sessionId}`);
    stopDriver();
    teardownKeychainTrust();
    if (sipWss) await closeWithTimeout(() => sipWss.close());
    for (const s of httpsServers) {
      if (s) await closeWithTimeout(() => new Promise((r) => s.close(r)));
    }
    if (certs) {
      for (const f of [certs.leafKey, certs.leafCrt, certs.caKey, certs.caCrt]) {
        if (trustRemovalFailed && f === certs.caCrt) continue; // cleanup step still needs it to revoke trust
        try { unlinkSync(f); } catch {}
      }
      for (const f of ['leaf.csr', 'leaf.ext', 'ca.srl']) {
        try { unlinkSync(join(certs.certDir, f)); } catch {}
      }
    }
  }
  if (errors.length) { process.stderr.write(`Safari gate FAILED: ${errors.join(' | ')}\n`); process.exit(1); }
  console.log('Safari gate PASSED.');
}

main().catch((e) => { process.stderr.write(`Safari gate FAILED: ${e.message}\n`); process.exit(1); });
