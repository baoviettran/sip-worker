#!/usr/bin/env node
/**
 * Shipping-Safari media acceptance gate (macOS). Runs ONLY against the
 * BUILT/PACKED browser package served over a real HTTPS secure context.
 *
 * The library's media acceptance in Safari is a MANDATORY release prerequisite.
 * This runner:
 *   1. serves the harness `index.html` + built bundles over a self-signed HTTPS
 *      server (Safari requires a true secure context — unlike Playwright it will
 *      NOT grant getUserMedia/AudioContext over plain HTTP), reusing the exact
 *      built-only handler from server.mjs so the 503-when-artifact-absent
 *      contract is inherited,
 *   2. creates a Safari WebDriver session via Node's built-in `fetch` against the
 *      W3C WebDriver /session endpoint of a locally-started `safaridriver`,
 *   3. navigates to the HTTPS harness, waits for it to boot the built bundle, and
 *      calls `window.runMediaAcceptance()`, asserting the structured result
 *      {passed, checks, ...}, and records Safari/OS versions,
 *   4. deletes the WebDriver session in `finally` (ALWAYS), terminates the
 *      driver, and exits non-zero if Safari is unavailable, cannot launch, or any
 *      media check fails. There is NO skip path and NO `continue-on-error`.
 *
 * Env:
 *   SAFARIDRIVER_URL   default http://localhost:4444
 *   SAFARIDRIVER_BIN   default safaridriver (searched on PATH)
 *   SAFARIDRIVER_PORT  default 4444 (only used when starting the driver)
 *   HARNESS_PORT       default 8443 (self-signed HTTPS harness)
 *   HARNESS_URL        default https://localhost:<HARNESS_PORT>/index.html
 */

import { spawn, execFileSync } from 'node:child_process';
import https from 'node:https';
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DRIVER_URL = process.env.SAFARIDRIVER_URL || 'http://localhost:4444';
const DRIVER_BIN = process.env.SAFARIDRIVER_BIN || 'safaridriver';
const DRIVER_PORT = Number(process.env.SAFARIDRIVER_PORT || 4444);
const HARNESS_PORT = Number(process.env.HARNESS_PORT || 8443);
const HARNESS_URL = process.env.HARNESS_URL || `https://localhost:${HARNESS_PORT}/index.html`;
const CERT_CN = 'localhost';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errors = [];

let sessionId = null;
let driver = null;
let httpsServer = null;
let certFiles = null;

// --- TLS ------------------------------------------------------------------
// Safari needs a real secure context. The macOS runner has `openssl`; mint a
// throwaway loopback cert (CN=localhost + IP:127.0.0.1 SAN). Node's runner-side
// fetch is pointed at the SAME localhost the cert names, and the macOS workflow
// runs it with NODE_TLS_REJECT_UNAUTHORIZED=0 (self-signed, throwaway, never in
// the tree). No credentials ever pass over this link.
function makeSelfSignedCert() {
  const d = tmpdir();
  const key = join(d, `sipw-${process.pid}-key.pem`);
  const crt = join(d, `sipw-${process.pid}-crt.pem`);
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', key, '-out', crt, '-days', '1',
    '-subj', `/CN=${CERT_CN}`,
    '-addext', 'subjectAltName=IP:127.0.0.1,DNS:localhost',
  ], { stdio: 'ignore' });
  return { key, crt };
}

async function startHttpsHarness() {
  const { handler } = await import('./server.mjs');
  certFiles = makeSelfSignedCert();
  httpsServer = https.createServer(
    { key: readFileSync(certFiles.key), cert: readFileSync(certFiles.crt) },
    handler,
  );
  await new Promise((resolve, reject) => {
    httpsServer.once('error', reject);
    httpsServer.listen(HARNESS_PORT, '127.0.0.1', resolve);
  });
}

// --- W3C WebDriver over Node fetch ----------------------------------------
async function wdFetch(url, { method = 'GET', body } = {}) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

async function wdDelete(url) {
  try { await fetch(url, { method: 'DELETE' }); } catch {}
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
  driver = spawn(DRIVER_BIN, ['--enable', '-p', String(DRIVER_PORT)], {
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  // Surface driver stderr to aid CI diagnosis if it fails to start.
  driver.stderr.on('data', (d) => process.stderr.write(`[safaridriver] ${d}`));
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (driver.exitCode !== null) {
      throw new Error(`safaridriver exited early (code ${driver.exitCode}); Safari unavailable on this runner`);
    }
    try {
      const res = await fetch(`${DRIVER_URL}/status`);
      if (res.status >= 200 && res.status < 500) return;
    } catch {}
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
async function navigateAndRun() {
  // 2. create a Safari session
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
  console.log(`Safari session: browser=${browserVersion} os=${platformVersion} platform=${platformName}`);
  if (browserVersion === 'unknown') throw new Error('Safaridriver returned no browserVersion; cannot attest which Safari ran');

  // 3. navigate to the HTTPS harness
  await wdFetch(`${DRIVER_URL}/session/${sessionId}/url`, { method: 'POST', body: { url: HARNESS_URL } });

  // 4. wait for the built bundle to boot, then call the acceptance function
  const booted = await poll(30000, async () => {
    const v = await wdExecute('return window.__webRtcMediaRun && window.__webRtcMediaRun.booted === true');
    return v === true;
  }, 'harness did not boot the built bundle');
  if (!booted) throw new Error('harness did not boot the built browser bundle over HTTPS');

  const result = await poll(120000, async () => {
    const r = await wdExecute('return window.runMediaAcceptance().then((x) => ({ __done: true, x }))');
    return r?.__done ? r.x : null;
  }, 'runMediaAcceptance did not complete', true);

  console.log('runMediaAcceptance result:', JSON.stringify(result));
  if (!result || result.passed !== true) {
    throw new Error(`Safari media acceptance FAILED: ${JSON.stringify(result)}`);
  }
  const names = Object.keys(result.checks || {});
  if (names.length === 0) throw new Error('runMediaAcceptance returned no checks');
  for (const name of names) {
    if (result.checks[name] !== true) throw new Error(`media check failed: ${name}`);
  }
  console.log(`Safari media acceptance PASSED. Verified: ${names.join(', ')}`);
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
async function main() {
  await startHttpsHarness();
  try {
    await startDriver();
    await navigateAndRun();
    const exit = await driverExited();
    if (!exit.ok) errors.push('safaridriver did not terminate cleanly');
  } catch (error) {
    errors.push(error.message || String(error));
  } finally {
    if (sessionId) await wdDelete(`${DRIVER_URL}/session/${sessionId}`);
    stopDriver();
    if (httpsServer) await new Promise((r) => httpsServer.close(r));
    if (certFiles) { try { unlinkSync(certFiles.key); } catch {} try { unlinkSync(certFiles.crt); } catch {} }
  }
  if (errors.length) { process.stderr.write(`Safari gate FAILED: ${errors.join(' | ')}\n`); process.exit(1); }
  console.log('Safari gate PASSED.');
}

main().catch((e) => { process.stderr.write(`Safari gate FAILED: ${e.message}\n`); process.exit(1); });
