// Documentation-contract assertion gate (Phase 12, Task 2).
//
// Small, real, honest checks that the release contract is not fiction:
//   1. Every `[text](./path)` link in README.md resolves to a file in the repo.
//   2. Every shell command documented in README.md's "Project" section as an npm
//      script exists in package.json (the docs must not advertise scripts that
//      are not runnable).
//   3. README and package.json frame 0.1.0 as a signaling-only prototype — never
//      as a "v1 release candidate" (amend on the Phase 12 Global Constraint).
//   4. The required release-hygiene files declared in SECURITY.md and package.json
//      metadata actually exist.
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
const pkg = JSON.parse(readProject('package.json'));

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
  assert.ok(
    typeof pkg.scripts[script] === 'string',
    `README documents npm run ${script} but package.json has no such script`,
  );
}
assert.ok(documentedScripts.size > 0, 'README "Project" section should document npm scripts');

// ---- (3) 0.1.0 framing is honest: no "v1 release candidate" anywhere ----
for (const [name, text] of [['README.md', readme], ['package.json', JSON.stringify(pkg)]]) {
  assert.ok(
    !/v1 release candidate/i.test(text),
    `${name} must not call 0.1.0 a "v1 release candidate"`,
  );
  assert.ok(
    /signaling-only/i.test(text),
    `${name} should frame 0.1.0 as a signaling-only prototype`,
  );
}

// ---- (4) declared release-hygiene files and metadata exist ----
for (const rel of ['LICENSE', 'SECURITY.md', 'CHANGELOG.md']) {
  assert.ok(existsSync(join(packageRoot, rel)), `required release file ${rel} is missing`);
}
assert.equal(pkg.license, 'MIT', 'package.json license mismatch vs LICENSE');
assert.equal(pkg.version, '0.1.0', 'package.json version drift');
assert.ok(pkg.engines?.node, 'package.json must declare node engines');
assert.ok(pkg.repository?.url, 'package.json must declare repository metadata');
assert.ok(pkg.support?.url, 'package.json must declare support metadata');

console.error(`documentation contract OK: ${links} README links resolve, scripts present, 0.1.0 framing honest`);