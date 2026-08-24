// test/sipp/no-src-imports.test.mjs
// Enforces the packed-artifact constraint: the driver imports zero modules from
// packages/**/src and no VALUE imports of @sip-worker/* (type-only is fine).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { SIPP_DIR } from './run-scenario.mjs';

const driverDir = join(SIPP_DIR, 'driver');
const files = readdirSync(driverDir).filter((f) => f.endsWith('.ts'));

test('driver imports no packages/**/src and no @sip-worker value imports', () => {
  assert.ok(files.length >= 3, `expected driver sources, got ${files.join(',')}`);
  for (const file of files) {
    const source = readFileSync(join(driverDir, file), 'utf8');
    const valueImport = /\bimport\s+(?!type\b)[^\n]*from\s+['"]@sip-worker\//;
    const srcImport = /from\s+['"][^'"]*(?:packages\/\w+\/src)['"]/;
    assert.ok(!valueImport.test(source), `${file}: value import of @sip-worker/*`);
    assert.ok(!srcImport.test(source), `${file}: import from packages/**/src`);
  }
});
