// test/sipp/orchestrator-config.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { SCENARIOS } from './run-scenario.mjs';

test('SCENARIOS shape is valid', () => {
  assert.ok(Object.keys(SCENARIOS).length >= 1, 'at least one scenario');
  for (const [name, cfg] of Object.entries(SCENARIOS)) {
    assert.ok(cfg.role === 'uas' || cfg.role === 'uac', `${name}: role must be uas|uac`);
    assert.ok(Number.isInteger(cfg.deadlineMs) && cfg.deadlineMs > 0, `${name}: deadlineMs`);
    assert.ok(Array.isArray(cfg.runs) && cfg.runs.length >= 1, `${name}: runs`);
    for (const run of cfg.runs) {
      assert.ok(run.transport === 'udp' || run.transport === 'tcp', `${name}/${run.variant}: transport`);
      assert.ok(typeof run.xml === 'string' && run.xml.endsWith('.xml'), `${name}/${run.variant}: xml`);
      assert.ok(typeof run.variant === 'string' && run.variant.length > 0, `${name}/${run.variant}: variant`);
      assert.ok(typeof run.password === 'string', `${name}/${run.variant}: password`);
    }
  }
});
