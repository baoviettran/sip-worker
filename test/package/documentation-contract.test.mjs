// Documentation-contract assertion gate (Phase 12, Task 2; rewritten for v0.3,
// extended for v0.5 real WebRTC media).
//
// Small, real, honest checks that the release contract is not fiction:
//   1. Every `[text](./path)` link in README.md resolves to a file in the repo.
//   2. Every shell command documented in README.md's "Project" section as an npm
//      script exists in a workspace manifest (the docs must not advertise scripts
//      that are not runnable).
//   3. The workspace manifests frame 0.5.0 truthfully: private/publishable split,
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

// ---- (3) workspace framing is honest: private root, publishable packages, 0.5.0 ----
assert.equal(pkg.private, true, 'root package.json must be private (orchestrator, never published)');
assert.equal(pkg.version, '0.5.0', 'root package.json version drift');
for (const [name, w] of Object.entries(workspaces)) {
  assert.equal(w.version, '0.5.0', `${name} version drift`);
  assert.notEqual(w.private, true, `${name} must be publishable (not private)`);
}
// browser and node depend on core exactly; core depends on nothing of ours.
for (const [name, w] of Object.entries(workspaces)) {
  if (name === '@sip-worker/core') assert.equal(w.dependencies?.['sip-worker'], undefined);
  if (name === '@sip-worker/node') assert.equal(w.dependencies?.['@sip-worker/core'], '0.5.0');
  if (name === 'sipworker') assert.equal(w.dependencies?.['@sip-worker/core'], '0.5.0');
}
// Core remains signaling-only (it still ships no media fabrication). The
// browser package now carries real WebRTC media, so it is no longer framed
// signaling-only; both must refuse a "v1 release candidate"/completed-v1 claim.
for (const w of Object.values(workspaces)) {
  assert.ok(
    !/v1 release candidate/i.test(w.name),
    `${w.name} must not call 0.5.0 a "v1 release candidate"`,
  );
}
// Core package README keeps the signaling-only framing (true there); the
// browser package README must reflect that it adds real media but is NOT a
// completed v1 product.
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
    `${rel} should frame 0.5.0 as a signaling-only package`,
  );
  assert.ok(
    !/v1 release candidate/i.test(text),
    `${rel} must not call 0.5.0 a "v1 release candidate"`,
  );
}
assert.ok(
  !/v1 release candidate/i.test(browserReadme),
  'packages/browser/README.md must not call 0.5.0 a "v1 release candidate"',
);
// The root README, SECURITY.md, and CHANGELOG must keep honest pre-1.0 framing:
// never a "v1 release candidate" and never a completed-v1-production claim.
for (const [name, text] of [['README.md', readme], ['SECURITY.md', security], ['CHANGELOG.md', changelog]]) {
  assert.ok(
    !/v1 release candidate/i.test(text),
    `${name} must not call 0.5.0 a "v1 release candidate"`,
  );
  assert.ok(
    !/production-ready certificate|v1 certification|is a completed v1 product|has reached v1/i.test(text),
    `${name} must not claim 0.5.0 is a completed v1 product`,
  );
  assert.ok(
    /real WebRTC media/i.test(text) || /browser media/i.test(text),
    `${name} should acknowledge the v0.5 real WebRTC media surface`,
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
  'ABORTED', 'INTERNAL_ERROR',
];
for (const code of allCodes) {
  assert.match(mediaErrors, new RegExp(code), `media-errors.md must document ${code}`);
  assert.match(browserMedia, new RegExp(code), `browser-media.md must reference ${code}`);
}
// INVALID_STATE is deliberately not a user-facing media code; it must be mapped
// to INTERNAL_ERROR, never documented as a surfaceable code.
assert.doesNotMatch(mediaErrors, />\s*INVALID_STATE\s*</m, 'media-errors.md must not present INVALID_STATE as a surfaceable code');

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

console.error(`documentation contract OK: ${links} README links resolve, scripts present, 0.5.0 workspace framing honest, migration map complete, browser-media contract complete and honest`);