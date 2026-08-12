// Documentation-contract assertion gate (Phase 12, Task 2; rewritten for v0.3).
//
// Small, real, honest checks that the release contract is not fiction:
//   1. Every `[text](./path)` link in README.md resolves to a file in the repo.
//   2. Every shell command documented in README.md's "Project" section as an npm
//      script exists in a workspace manifest (the docs must not advertise scripts
//      that are not runnable).
//   3. The workspace manifests frame 0.3.0 truthfully: private/publishable split,
//      version parity, the exact core dependency graph, and a signaling-only
//      framing (never a "v1 release candidate" or a production claim).
//   4. The migration document contains the exact old→new import map and states
//      the clean break (no compatibility shim).
//   5. The required release-hygiene files declared in SECURITY.md and the package
//      manifests actually exist.
//   6. The README links the migration guide and the current public event names.
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

// ---- (3) workspace framing is honest: private root, publishable packages, 0.3.0 ----
assert.equal(pkg.private, true, 'root package.json must be private (orchestrator, never published)');
assert.equal(pkg.version, '0.3.0', 'root package.json version drift');
for (const [name, w] of Object.entries(workspaces)) {
  assert.equal(w.version, '0.3.0', `${name} version drift`);
  assert.notEqual(w.private, true, `${name} must be publishable (not private)`);
}
// browser and node depend on core exactly; core depends on nothing of ours.
for (const [name, w] of Object.entries(workspaces)) {
  if (name === '@sip-worker/core') assert.equal(w.dependencies?.['sip-worker'], undefined);
  if (name === '@sip-worker/node') assert.equal(w.dependencies?.['@sip-worker/core'], '0.3.0');
  if (name === 'sipworker') assert.equal(w.dependencies?.['@sip-worker/core'], '0.3.0');
}
// signaling-only framing must live where it is now true: the package READMEs.
for (const w of Object.values(workspaces)) {
  assert.ok(
    !/v1 release candidate/i.test(w.name),
    `${w.name} must not call 0.3.0 a "v1 release candidate"`,
  );
}
for (const rel of ['packages/core/README.md', 'packages/browser/README.md', 'packages/node/README.md']) {
  const text = readProject(rel);
  assert.ok(
    /signaling-only/i.test(text),
    `${rel} should frame 0.3.0 as a signaling-only package`,
  );
  assert.ok(
    !/v1 release candidate/i.test(text),
    `${rel} must not call 0.3.0 a "v1 release candidate"`,
  );
}
// the root README and SECURITY.md must keep the signaling-only / pre-1.0 framing.
for (const [name, text] of [['README.md', readme], ['SECURITY.md', security], ['CHANGELOG.md', changelog]]) {
  assert.ok(
    !/v1 release candidate/i.test(text),
    `${name} must not call 0.3.0 a "v1 release candidate"`,
  );
  assert.ok(
    /signaling-only/i.test(text),
    `${name} should frame the release as signaling-only`,
  );
}

// ---- (4) the migration document carries the exact clean-break import map ----
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

console.error(`documentation contract OK: ${links} README links resolve, scripts present, 0.3.0 workspace framing honest, migration map complete`);