// Prepack release gate: publishing must fail if `dist` is absent or any
// advertised `exports` subpath fails to resolve. Runs from each workspace's
// package.json `prepack` AFTER `npm run build`, so a missing/broken build
// aborts the pack.
//
// npm runs a workspace's `prepack` with process.cwd() set to that workspace
// directory, so the gate derives the package root from cwd and resolves every
// advertised subpath through the real `exports` map — the same resolution a
// consumer uses (package self-reference).
import assert from 'node:assert/strict';
import { readdir, readFile, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const packageRoot = process.cwd();
const requireFromRoot = createRequire(join(packageRoot, 'package.json'));
const pkg = JSON.parse(await readFile(join(packageRoot, 'package.json')));

// ---- dist must exist and be non-empty ----
const dist = join(packageRoot, 'dist');
await stat(dist).catch(() => {
  throw new Error('prepack gate: dist/ is absent — run npm run build first');
});
const distEntries = await readdir(dist);
assert.ok(distEntries.length > 0, 'prepack gate: dist/ is empty');

// ---- every advertised exports subpath must resolve (import + require) ----
const subpaths = Object.keys(pkg.exports ?? {});
for (const sub of subpaths) {
  const spec = sub === '.' ? pkg.name : `${pkg.name}/${sub.replace(/^\.\//, '')}`;
  const imp = await import(requireFromRoot.resolve(spec));
  assert.ok(imp !== undefined && typeof imp === 'object', `prepack gate: ESM ${spec} did not resolve`);
  const req = requireFromRoot(spec);
  assert.ok(req !== undefined && typeof req === 'object', `prepack gate: CJS ${spec} did not resolve`);
}

console.error(`prepack gate OK: ${pkg.name} ${subpaths.length} subpaths resolve (dist present)`);