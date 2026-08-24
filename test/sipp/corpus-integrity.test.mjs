// test/sipp/corpus-integrity.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { SCENARIOS, SCENARIOS_DIR, SIPP_IMAGE } from './run-scenario.mjs';

test('every scenario XML exists on disk', () => {
  assert.ok(Object.keys(SCENARIOS).length >= 10, 'the full ten-scenario corpus is present');
  for (const [name, cfg] of Object.entries(SCENARIOS)) {
    for (const run of cfg.runs) {
      assert.ok(existsSync(join(SCENARIOS_DIR, run.xml)), `${name}/${run.variant}: missing ${run.xml}`);
    }
  }
});

test('SIPP_IMAGE is digest-pinned', () => {
  assert.match(SIPP_IMAGE, /@sha256:[0-9a-f]{64}$/);
});
