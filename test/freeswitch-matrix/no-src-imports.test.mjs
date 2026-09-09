// test/freeswitch-matrix/no-src-imports.test.mjs
// Enforces the packed-artifact constraint: page.ts and every spec file imports
// zero modules from packages/**/src and no VALUE imports of @sip-worker/*
// (type-only is fine). Mirrors the WS2 gate in test/sipp/.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const files = readdirSync(__dirname).filter(
  (f) => f === 'page.ts' || f.endsWith('.spec.ts'),
);

test('page.ts and spec files import no packages/**/src and no @sip-worker value imports', () => {
  assert.ok(files.length >= 5, `expected at least 5 targets, got ${files.length}`);
  for (const file of files) {
    const source = readFileSync(join(__dirname, file), 'utf8');
    const valueImport = /\bimport\s+(?!type\b)[^\n]*from\s+['"]@sip-worker\//;
    const srcImport = /from\s+['"][^'"]*(?:packages\/\w+\/src)['"]/;
    assert.ok(!valueImport.test(source), `${file}: value import of @sip-worker/*`);
    assert.ok(!srcImport.test(source), `${file}: import from packages/**/src`);
  }
});
