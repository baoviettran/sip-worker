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
const MEDIA_HARNESS_URL = process.env.HARNESS_URL || `https://localhost:${HARNESS_PORT}/index.html`;
const PHONE_HARNESS_URL = process.env.PHONE_HARNESS_URL || `https://localhost:${PHONE_HARNESS_PORT}/index.html`;
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

  console.log(`Safari harness: media https://localhost:${HARNESS_PORT}/  phone https://localhost:${PHONE_HARNESS_PORT}/  wss://127.0.0.1:${SIP_WSS_PORT}/sip`);
}

// --- macOS keychain trust --------------------------------------------------
async function setupKeychainTrust() {
  if (process.platform !== 'darwin') {
    console.log('NOT macOS: skipping keychain import (the Safari job is macOS-only; this run cannot attest Safari)');
    return;
  }
  // Install the ephemeral CA as a root trust anchor in the SYSTEM domain. The
  // previous ephemeral-keychain recipe (`create-keychain` + import +
  // `set-key-partition-list`) failed deterministically on GitHub's macos-14
  // runners on every retry, before any Safari test launched — this gate was
  // never observed green in CI. A System-keychain trust anchor needs no
  // partition list (the cert is readable by every process) and the GitHub
  // runner user has passwordless sudo. Teardown removes the trust in `finally`
  // and again via the workflow's `if: always()` step.
  execFileSync(
    'sudo',
    ['security', 'add-trusted-cert', '-d', '-r', 'trustRoot', '-k', '/Library/Keychains/System.keychain', certs.caCrt],
    { stdio: 'inherit', timeout: 30000 },
  );
  logProgress(`Installed ephemeral CA as a System keychain trust root: ${certs.caCrt}`);
}

function teardownKeychainTrust() {
  if (process.platform !== 'darwin') return;
  if (!certs) return;
  logProgress('safari: removing System keychain trust');
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
  await wdFetch(`${DRIVER_URL}/session/${sessionId}/url`, { method: 'POST', body: { url } });
  const booted = await poll(30000, async () => {
    const v = await wdExecute(`return ${bootScript}`);
    return v === true;
  }, bootFailMsg);
  if (!booted) {
    await captureBootFailure(url);
    throw new Error(bootFailMsg);
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
  const mediaResult = await poll(120000, async () => {
    const r = await wdExecute('return window.runMediaAcceptance().then((x) => ({ __done: true, x }))');
    return r?.__done ? r.x : null;
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
  logProgress('safari: polling runPhoneAcceptance (5 minute bound)');
  let phoneResult;
  try {
    phoneResult = await poll(300000, async () => {
      const r = await wdExecute('return window.runPhoneAcceptance().then((x) => ({ __done: true, x }))');
      return r?.__done ? r.x : null;
    }, 'runPhoneAcceptance did not complete', true);
  } catch (error) {
    // Surface what the page knew at the moment it stopped completing, so a
    // stuck acceptance reports a cause (captured uncaught errors / rejections)
    // instead of a bare timeout.
    try {
      const pageDiag = await wdExecute('return { booted: !!(window.__phoneRun && window.__phoneRun.booted), relayConnected: !!(window.__phoneRun && window.__phoneRun.relayConnected), errors: (window.__phoneRun && window.__phoneRun.errors) || [] }');
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
