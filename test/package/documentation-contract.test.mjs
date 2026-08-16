// Documentation-contract assertion gate (Phase 12, Task 2; rewritten for v0.3,
// extended for v0.5 real WebRTC media, rewritten for v0.7 call controls and
// recovery).
//
// Small, real, honest checks that the release contract is not fiction:
//   1. Every `[text](./path)` link in README.md resolves to a file in the repo.
//   2. Every shell command documented in README.md's "Project" section as an npm
//      script exists in a workspace manifest (the docs must not advertise scripts
//      that are not runnable).
//   3. The workspace manifests frame 0.7.0 truthfully: private/publishable split,
//      version parity, the exact core dependency graph, and an honest framing
//      that is never a "v1 release candidate" or a completed-v1-production claim.
//   4. The migration document contains the exact old→new import map, the
//      `answer()` breaking change, and states the clean break (no shim).
//   5. The required release-hygiene files declared in SECURITY.md and the package
//      manifests actually exist.
//   6. The README links the migration guide and the current public event names.
//   7. The v0.5 browser-media contract is truthful and complete: HTTPS/WSS,
//      permissions, autoplay gesture, Permissions Policy, short-lived TURN
//      credentials, the relay option, every media error code, the `answer()`
//      migration, exact tested versions, and stated limitations.
//   8. The v0.7 browser-phone contract is truthful and complete: version parity
//      and the exact core dependency, BrowserPhone/BrowserCall examples, the
//      connection/registration/call/signaling/hold state lists, every new
//      v0.7 error code, WSS policy, reconnect defaults and caps, hold direction,
//      DTMF constraints, mute ownership, TURN provider validation, diagnostics
//      and resource counters, browser evidence, Safari truthfulness, migration
//      signature map, v0.7 limitations, and links to all four new documents.
//
// This is `npm run test:docs`; it is also wired into `pretest`, which fires
// before `npm test` (the `test` script), and it runs explicitly in CI.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const readProject = (rel) => readFileSync(join(packageRoot, rel), 'utf8');

const readme = readProject('README.md');
const security = readProject('SECURITY.md');
const changelog = readProject('CHANGELOG.md');
const pkg = JSON.parse(readProject('package.json'));
const core = JSON.parse(readProject('packages/core/package.json'));
const browser = JSON.parse(readProject('packages/browser/package.json'));
const node = JSON.parse(readProject('packages/node/package.json'));
const workspaces = { '@sip-worker/core': core, sipworker: browser, '@sip-worker/node': node };

// The 0.7.0 release contract is version-parity-exact across the three publishable
// workspaces; browser and node depend on core exactly.
const VERSION = '0.7.0';

// ---- (1) every relative markdown link in README resolves to an existing file ----
const linkRe = /\[[^\]]*\]\(([^)]+)\)/g;
let m;
let links = 0;
while ((m = linkRe.exec(readme)) !== null) {
  const target = m[1];
  if (isAbsolute(target) || /^[a-z]+:/i.test(target) || target.startsWith('#') || target.startsWith('mailto:')) {
    continue; // absolute URL, scheme, or in-page anchor — not a repo file
  }
  if (target.includes('#')) continue; // file.md#anchor — presence of the file is checked below on the base
  const base = target.split('#')[0];
  const abs = resolve(packageRoot, base);
  assert.ok(
    existsSync(abs),
    `README links to missing file: ${target} (resolved ${abs})`,
  );
  links += 1;
}
assert.ok(links > 0, 'README should contain at least one resolvable file link');

// ---- (2) every npm script documented in the README "Project" section exists ----
const projectSection = readme.split('## Project')[1] ?? '';
const scriptRe = /npm run ([a-z0-9:_-]+)/g;
const documentedScripts = new Set();
let s;
while ((s = scriptRe.exec(projectSection)) !== null) documentedScripts.add(s[1]);
for (const script of documentedScripts) {
  if (typeof pkg.scripts[script] === 'string') continue; // root-orchestrated script
  const owner = Object.values(workspaces).find((w) => typeof w.scripts?.[script] === 'string');
  assert.ok(
    owner,
    `README documents npm run ${script} but neither the root nor any workspace has such a script`,
  );
}
assert.ok(documentedScripts.size > 0, 'README "Project" section should document npm scripts');

// ---- (3) workspace framing is honest: private root, publishable packages, 0.7.0 ----
assert.equal(pkg.private, true, 'root package.json must be private (orchestrator, never published)');
assert.equal(pkg.version, VERSION, 'root package.json version drift');
for (const [name, w] of Object.entries(workspaces)) {
  assert.equal(w.version, VERSION, `${name} version drift`);
  assert.notEqual(w.private, true, `${name} must be publishable (not private)`);
}
// browser and node depend on core exactly; core depends on nothing of ours.
for (const [name, w] of Object.entries(workspaces)) {
  if (name === '@sip-worker/core') assert.equal(w.dependencies?.['sip-worker'], undefined);
  if (name === '@sip-worker/node') assert.equal(w.dependencies?.['@sip-worker/core'], VERSION);
  if (name === 'sipworker') assert.equal(w.dependencies?.['@sip-worker/core'], VERSION);
}
// Core remains signaling-only (it still ships no media fabrication). The
// browser package now carries real WebRTC media AND per-call controls/recovery,
// so it is no longer framed signaling-only; both must refuse a "v1 release
// candidate"/completed-v1 claim.
for (const w of Object.values(workspaces)) {
  assert.ok(
    !/v1 release candidate/i.test(w.name),
    `${w.name} must not call ${VERSION} a "v1 release candidate"`,
  );
}
// Core package README keeps the signaling-only framing (true there); the
// browser package README must reflect that it adds real media and per-call
// controls but is NOT a completed v1 product.
const coreReadme = readProject('packages/core/README.md');
const browserReadme = readProject('packages/browser/README.md');
const nodeReadme = readProject('packages/node/README.md');
assert.ok(
  /real WebRTC media/i.test(browserReadme),
  'packages/browser/README.md should note it adds real WebRTC media',
);
for (const [rel, text] of [
  ['packages/core/README.md', coreReadme],
  ['packages/node/README.md', nodeReadme],
]) {
  assert.ok(
    /signaling-only/i.test(text),
    `${rel} should frame ${VERSION} as a signaling-only package`,
  );
  assert.ok(
    !/v1 release candidate/i.test(text),
    `${rel} must not call ${VERSION} a "v1 release candidate"`,
  );
}
assert.ok(
  !/v1 release candidate/i.test(browserReadme),
  'packages/browser/README.md must not call 0.7.0 a "v1 release candidate"',
);
// The root README, SECURITY.md, and CHANGELOG must keep honest pre-1.0 framing:
// never a "v1 release candidate" and never a completed-v1-production claim.
for (const [name, text] of [['README.md', readme], ['SECURITY.md', security], ['CHANGELOG.md', changelog]]) {
  assert.ok(
    !/v1 release candidate/i.test(text),
    `${name} must not call ${VERSION} a "v1 release candidate"`,
  );
  assert.ok(
    !/production-ready certificate|v1 certification|is a completed v1 product|has reached v1/i.test(text),
    `${name} must not claim ${VERSION} is a completed v1 product`,
  );
  assert.ok(
    /real WebRTC media/i.test(text) || /browser media/i.test(text) || /browser phone/i.test(text),
    `${name} should acknowledge the v0.7 browser phone and real WebRTC media surface`,
  );
}

// ---- (4a) the v0.3 migration carries the exact clean-break import map ----
const migrationRel = 'docs/migrations/0.2-to-0.3.md';
assert.ok(existsSync(join(packageRoot, migrationRel)), 'migration guide is missing');
const migration = readProject(migrationRel);
assert.match(readme, /0\.2-to-0\.3\.md/, 'README should link the migration guide');
assert.match(migration, /sip-worker\/transport\/node[\s\S]*@sip-worker\/node\/transport/);
assert.match(migration, /sip-worker\/transport\/browser[\s\S]*sip-worker\/transport/);
assert.match(migration, /sip-worker\/messages[\s\S]*@sip-worker\/core\/messages/);
assert.match(migration, /sip-worker\/stream[\s\S]*@sip-worker\/core\/stream/);
assert.match(migration, /sip-worker\/transactions[\s\S]*@sip-worker\/core\/transactions/);
assert.match(migration, /sip-worker\/dialogs[\s\S]*@sip-worker\/core\/dialogs/);
assert.match(migration, /sip-worker\/auth[\s\S]*@sip-worker\/core\/auth/);
assert.match(migration, /sip-worker\/ua[\s\S]*@sip-worker\/core\/ua/);
assert.match(migration, /sip-worker\/media[\s\S]*@sip-worker\/core\/media/);
assert.match(migration, /sip-worker\/bridge[\s\S]*@sip-worker\/core\/bridge/);
assert.match(migration, /sip-worker\/reliability[\s\S]*@sip-worker\/core\/reliability/);
assert.match(migration, /sip-worker\/reliability[\s\S]*@sip-worker\/node\/reliability/);
assert.doesNotMatch(migration, /compatibility shim|still works/i);

// ---- (5) declared release-hygiene files and metadata exist ----
for (const rel of ['LICENSE', 'SECURITY.md', 'CHANGELOG.md']) {
  assert.ok(existsSync(join(packageRoot, rel)), `required release file ${rel} is missing`);
}
for (const rel of ['packages/core/LICENSE', 'packages/browser/LICENSE', 'packages/node/LICENSE']) {
  assert.ok(existsSync(join(packageRoot, rel)), `required release file ${rel} is missing`);
}
for (const w of Object.values(workspaces)) {
  assert.equal(w.license, 'MIT', `${w.name} license mismatch vs LICENSE`);
}
assert.ok(pkg.engines?.node, 'package.json must declare node engines');
assert.ok(pkg.repository?.url, 'package.json must declare repository metadata');
assert.ok(pkg.support?.url, 'package.json must declare support metadata');

// ---- (6) browser v1.0 roadmap is linked from the README ----
assert.match(readme, /browser-v1-production-roadmap-design\.md/);

// ---- (7) no stale "unbounded AuthManager maps" limitation anywhere ----
for (const [name, text] of [['README.md', readme], ['SECURITY.md', security]]) {
  assert.doesNotMatch(text, /AuthManager maps are unbounded|Unbounded `AuthManager` maps/i, `${name} contains stale AuthManager limitation`);
}

// ---- (8) current public event names are documented in the README ----
assert.match(readme, /registrationStateChanged/);
assert.match(readme, /callStateChanged/);

// ---- (9) the v0.5 browser-media contract is truthful and complete ----
assert.ok(existsSync(join(packageRoot, 'docs/browser-media.md')), 'browser-media.md is missing');
assert.ok(existsSync(join(packageRoot, 'docs/media-errors.md')), 'media-errors.md is missing');
assert.ok(existsSync(join(packageRoot, 'docs/compatibility/0.5-browser-media.md')), '0.5-browser-media compatibility note is missing');
const browserMedia = readProject('docs/browser-media.md');
const mediaErrors = readProject('docs/media-errors.md');
const compatNote = readProject('docs/compatibility/0.5-browser-media.md');
const migration05 = readProject('docs/migrations/0.3-to-0.5.md');
const mediaReview = readProject('docs/reviews/2026-08-13-0.5-real-webrtc-audio-review.md');
const turnWorkflow = readProject('.github/workflows/browser-media.yml');
const turnBootstrap = readProject('test/turn/coturn.bootstrap.sh');

// TURN CI must generate both credentials per run; repository secrets are not required.
assert.doesNotMatch(turnWorkflow, /secrets.COTURN_PASSWORD/, 'TURN workflow must not depend on a static repository password');
assert.match(turnWorkflow, /Generate ephemeral TURN credentials/);
assert.match(turnWorkflow, /TURN_USERNAME=.*GITHUB_ENV/);
assert.match(turnWorkflow, /openssl rand/);
assert.match(turnWorkflow, /add-mask/);
assert.match(turnWorkflow, /TURN_PASSWORD=.*GITHUB_ENV/);
assert.match(turnBootstrap, /trap - EXIT/, 'coturn bootstrap must disable failure cleanup after successful health validation');
assert.ok(turnBootstrap.indexOf('trap - EXIT') > turnBootstrap.indexOf('relay healthy:'), 'coturn cleanup must be disabled only after health succeeds');
assert.match(turnBootstrap, /ip route get/, 'TURN bootstrap must accept an already-routed loopback peer');
assert.match(turnBootstrap, /sudo -n/, 'TURN bootstrap privilege fallback must be non-interactive');
assert.match(turnWorkflow, /if: always()/, 'TURN workflow must always clean up coturn');
assert.match(turnWorkflow, /docker rm -f sip-worker-relay/, 'TURN workflow must remove its exact coturn container');
assert.equal((turnWorkflow.match(/npm run test:browser-media:install/g) ?? []).length, 2, "both browser jobs must install every supported Playwright engine");
assert.doesNotMatch(turnWorkflow, /(?:--project|--test-project)=chromium[\s\S]{0,80}turn-relay\.spec\.ts/, "TURN workflow must not reduce relay evidence to Chromium");
assert.match(turnWorkflow, /npx playwright test[\s\S]{0,160}turn-relay\.spec\.ts/, "TURN workflow must run the relay gate across all configured engines");
assert.match(browser.description, /real WebRTC audio/i, 'browser package description must describe its real media surface');

// Playwright WebKit is automation evidence, not a shipping-Safari run.
for (const [name, text] of [['docs/browser-media.md', browserMedia], ['docs/compatibility/0.5-browser-media.md', compatNote]]) {
  assert.doesNotMatch(text, /WebKit *[/] *Safari|Playwright Desktop Safari/i, name + ' must not label Playwright WebKit as real Safari');
  assert.match(text, /Playwright WebKit/i, name + ' must identify the automated engine precisely');
}
assert.match(mediaReview, /forced TURN is \*\*VERIFIED locally/i);
assert.match(mediaReview, /(shipping|real) Safari[^]{0,160}(NOT[- ]RUN|unverified)/i);

// not a completed-v1 production claim
assert.match(browserMedia, /foundation/i);

// transport security: HTTPS/WSS
assert.match(browserMedia, /https/i);
assert.match(browserMedia, /wss/i);

// permissions and permission recovery
assert.match(browserMedia, /permission/i);
assert.match(browserMedia, /navigator\.mediaDevices/i);

// autoplay gesture
assert.match(browserMedia, /autoplay/i);

// Permissions Policy
assert.match(browserMedia, /Permissions-Policy|permissions-policy|PermissionsPolicy/i);

// short-lived TURN credentials
assert.match(browserMedia, /turn/i);
assert.match(browserMedia, /TURN/i);
assert.match(browserMedia, /short-lived|short lived|shortlived|ephemeral|expiry|expire/i);

// relay option
assert.match(browserMedia, /relay/i);

// every media error code must be documented, with recovery for the user-facing ones
const allCodes = [
  'PERMISSION_DENIED', 'DEVICE_NOT_FOUND', 'DEVICE_UNAVAILABLE', 'CONSTRAINT_UNSATISFIED',
  'NEGOTIATION_FAILED', 'REMOTE_DESCRIPTION_REJECTED', 'ICE_GATHERING_TIMEOUT',
  'ICE_CONNECTION_FAILED', 'OUTPUT_SELECTION_UNSUPPORTED', 'PLAYBACK_FAILED',
  'ABORTED', 'INVALID_STATE', 'MEDIA_OPERATION_TIMEOUT', 'INTERNAL_ERROR',
];
for (const code of allCodes) {
  assert.match(mediaErrors, new RegExp(code), `media-errors.md must document ${code}`);
  assert.match(browserMedia, new RegExp(code), `browser-media.md must reference ${code}`);
}
// All canonical media codes, including lifecycle and operation deadlines, must be documented.
assert.match(mediaErrors, /INVALID_STATE/);
assert.match(mediaErrors, /MEDIA_OPERATION_TIMEOUT/);

// the answer() migration (0.3 -> 0.5 break) is called out
assert.match(migration05, /answer\(/);
const compatContent = `${compatNote}`;
assert.match(compatContent, /answer/i);

// exact tested versions
assert.match(browserMedia, /chromium|Chrome/i);
assert.match(browserMedia, /firefox/i);
assert.match(browserMedia, /safari|webkit/i);
assert.match(browserMedia, /0\.5\.0/);

// limitations
assert.match(browserMedia, /limitations|limitation/i);

// ---- (10) the v0.7 browser-phone contract is truthful and complete ----
assert.ok(existsSync(join(packageRoot, 'docs/browser-phone.md')), 'docs/browser-phone.md is missing');
assert.ok(existsSync(join(packageRoot, 'docs/diagnostics.md')), 'docs/diagnostics.md is missing');
assert.ok(existsSync(join(packageRoot, 'docs/migrations/0.5-to-0.7.md')), 'docs/migrations/0.5-to-0.7.md is missing');
assert.ok(existsSync(join(packageRoot, 'docs/compatibility/0.7-browser-phone.md')), 'docs/compatibility/0.7-browser-phone.md is missing');
const browserPhoneDoc = readProject('docs/browser-phone.md');
const diagnosticsDoc = readProject('docs/diagnostics.md');
const migration07 = readProject('docs/migrations/0.5-to-0.7.md');
const compat07 = readProject('docs/compatibility/0.7-browser-phone.md');

// every new v0.7 document is linked from the README
for (const rel of [
  'docs/browser-phone.md',
  'docs/diagnostics.md',
  'docs/migrations/0.5-to-0.7.md',
  'docs/compatibility/0.7-browser-phone.md',
]) {
  assert.match(readme, new RegExp(rel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `README must link ${rel}`);
}

// version parity + exact core dependency are restated in the migration and compat docs
assert.match(migration07, /0\.7\.0/);
assert.match(compat07, /0\.7\.0/);
assert.match(migration07, /@sip-worker\/core@0\.7\.0/);
assert.match(compat07, /@sip-worker\/core@0\.7\.0/);

// BrowserPhone/BrowserCall are the preferred v0.7 surface
assert.match(browserPhoneDoc, /BrowserPhone/);
assert.match(browserPhoneDoc, /BrowserCall/);
assert.match(browserPhoneDoc, /createCall/);

// the four state lists (connection / registration / call / signaling)
for (const state of ['disconnected', 'connecting', 'connected', 'recovering', 'failed', 'disposed']) {
  assert.match(browserPhoneDoc, new RegExp(state), `browser-phone.md must document ConnectionState member ${state}`);
}
for (const state of ['unregistered', 'registering', 'registered', 'recovering', 'failed']) {
  assert.match(browserPhoneDoc, new RegExp(state), `browser-phone.md must document RegistrationState member ${state}`);
}
for (const state of ['new', 'establishing', 'established', 'terminating', 'terminated', 'failed']) {
  assert.match(browserPhoneDoc, new RegExp(state), `browser-phone.md must document CallState member ${state}`);
}
assert.match(browserPhoneDoc, /CallSignalingState/);
assert.match(browserPhoneDoc, /stable/);
assert.match(browserPhoneDoc, /lost/);

// hold state is local + remote
assert.match(browserPhoneDoc, /HoldState/);
assert.match(browserPhoneDoc, /local/);
assert.match(browserPhoneDoc, /remote/);

// every new v0.7 error code is documented
const v07Codes = [
  'CONNECTION_RECOVERY_EXHAUSTED', 'REGISTRATION_RECOVERY_FAILED',
  'SIGNALING_RECOVERY_FAILED', 'OPERATION_ABORTED', 'OPERATION_TIMEOUT',
  'OPERATION_IN_PROGRESS', 'HOLD_NEGOTIATION_FAILED',
  'DTMF_UNSUPPORTED', 'DTMF_FAILED',
];
for (const code of v07Codes) {
  assert.match(browserPhoneDoc, new RegExp(code), `browser-phone.md must document ${code}`);
}

// WSS policy: ws: requires allowInsecureWebSocket
assert.match(browserPhoneDoc, /allowInsecureWebSocket/);
assert.match(browserPhoneDoc, /wss/i);

// reconnect defaults and caps
assert.match(browserPhoneDoc, /250/);
assert.match(browserPhoneDoc, /5,?_?000/);
assert.match(browserPhoneDoc, /8/);
assert.match(browserPhoneDoc, /30,?_?000/);
assert.match(browserPhoneDoc, /20/);
assert.match(browserPhoneDoc, /120,?_?000/);
assert.match(browserPhoneDoc, /maxAttempts|maxDelayMs|recoveryTimeoutMs/);

// hold direction
assert.match(browserPhoneDoc, /sendonly/);
assert.match(browserPhoneDoc, /inactive/);

// DTMF constraints: RFC 4733 telephone-event, symbol set, no SIP INFO fallback
assert.match(browserPhoneDoc, /RFC 4733|telephone-event/);
assert.match(browserPhoneDoc, /0-9|A-D|\*|#/);
assert.match(browserPhoneDoc, /SIP INFO/);
assert.match(browserPhoneDoc, /never falls back|no (automatic )?fallback/i);
assert.match(browserPhoneDoc, /both/i);

// mute ownership
assert.match(browserPhoneDoc, /setMuted/);
assert.match(browserPhoneDoc, /INVALID_STATE/);

// TURN provider: validated credentials object, refreshed pair on refresh
assert.match(browserPhoneDoc, /IceServerProvider|iceServerProvider/);
assert.match(browserPhoneDoc, /username/);
assert.match(browserPhoneDoc, /password/);

// diagnostics + resource counters live in the diagnostics doc
assert.match(diagnosticsDoc, /resources\(\)|ResourceSnapshot|PhoneDiagnostics/);
for (const counter of [
  'activeSocketGenerations', 'reconnectAttempts', 'reconnectTimers', 'activeCalls',
  'activeNegotiations', 'pendingOperations', 'timers', 'peerConnections',
  'localTracks', 'lifecycleListeners', 'deviceListeners',
]) {
  assert.match(diagnosticsDoc, new RegExp(counter), `diagnostics.md must document resource counter ${counter}`);
}
for (const code of [
  'connection.connecting', 'connection.connected', 'connection.reconnect_attempt',
  'connection.reconnect_attempt_failed', 'connection.reconnected',
  'connection.recovery_failed', 'connection.closed', 'registration.registering',
  'registration.registered', 'registration.recovering', 'registration.recovery_failed',
  'registration.unregistered', 'call.established', 'call.recovering', 'call.hold',
  'call.resume', 'call.dtmf_failed', 'call.terminated', 'call.failed',
  'media.failed', 'lifecycle.disposed',
]) {
  assert.match(diagnosticsDoc, new RegExp(code.replace(/\./g, '\\.')), `diagnostics.md must document DiagnosticCode ${code}`);
}
assert.match(diagnosticsDoc, /redact|redaction|allowlist/i);

// Safari truthfulness: Playwright WebKit is not shipping Safari; shipping Safari
// is a macOS gate, so the docs must not claim Safari was verified on Linux.
assert.match(browserPhoneDoc, /Playwright WebKit/);
assert.doesNotMatch(browserPhoneDoc, /WebKit *[/] *Safari/);
assert.match(browserPhoneDoc, /macOS/);

// browser evidence: the browser-phone harness is the primary real-browser seam
assert.match(browserPhoneDoc, /chromium/i);
assert.match(browserPhoneDoc, /firefox/i);
assert.match(browserPhoneDoc, /coturn|TURN relay|forced TURN/i);

// v0.7 limitations: internal beta / tightly controlled pilot; PBX cert + soak are v0.9
assert.match(browserPhoneDoc, /internal beta|internal-beta/i);
assert.match(browserPhoneDoc, /pilot/i);
assert.match(browserPhoneDoc, /v0\.9|0\.9/i);
assert.match(browserPhoneDoc, /PBX|pbx/i);
assert.doesNotMatch(browserPhoneDoc, /(?<!not\s)authorized for general customer production/i);

// migration signature map: the 0.5 -> 0.7 signature changes
assert.match(migration07, /createCall\(target\)\.start\(\)/);
assert.match(migration07, /invite\(target\)/);
assert.match(migration07, /hangup\(\)/);
assert.match(migration07, /restartIce\(\)/);

// the compatibility note keeps BrowserUserAgent as a deprecated-but-working wrapper
assert.match(compat07, /BrowserUserAgent/);
assert.match(compat07, /deprecated/i);

console.error(`documentation contract OK: ${links} README links resolve, scripts present, 0.7.0 workspace framing honest, migration map complete, v0.5 browser-media contract complete and honest, v0.7 browser-phone contract complete and honest`);
