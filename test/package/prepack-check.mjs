// Prepack release gate: publishing must fail if `dist` is absent or any
// advertised `exports` subpath fails to resolve. Runs from package.json
// `prepack` AFTER `npm run build`, so a missing/broken build aborts the pack.
//
// This file lives inside the package (test/package/), so Node package
// self-reference lets it resolve `sip-worker` and its subpaths through the
// real `exports` map — the same resolution a consumer uses.
import assert from 'node:assert/strict';
import { readdir, readFile, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const here = fileURLToPath(new URL('.', import.meta.url));
const packageRoot = join(here, '..', '..');
const requireFromRoot = createRequire(import.meta.url);
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
  const spec = sub === '.' ? 'sip-worker' : `sip-worker/${sub.replace(/^\.\//, '')}`;
  const imp = await import(spec);
  assert.ok(imp !== undefined && typeof imp === 'object', `prepack gate: ESM ${spec} did not resolve`);
  const req = requireFromRoot(spec);
  assert.ok(req !== undefined && typeof req === 'object', `prepack gate: CJS ${spec} did not resolve`);
}

console.error(`prepack gate OK: ${subpaths.length} subpaths resolve (dist present)`);