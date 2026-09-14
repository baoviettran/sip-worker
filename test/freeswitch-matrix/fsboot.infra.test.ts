// test/freeswitch-matrix/fsboot.infra.test.ts — the committed conf tree must boot
// the pinned image into a RUNNING profile (fail-not-skip: a broken tree is a failure).
import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { startFreeSwitch, stopFreeSwitch, fsExec } from './fsctl';

const CONF = join(import.meta.dirname, 'fs-conf');

describe('committed fs-conf tree boots the pinned image', () => {
  it('reports UP and a RUNNING ws-test profile', async () => {
    const handle = await startFreeSwitch(CONF);
    try {
      expect(await fsExec('status')).toMatch(/^UP /);
      expect(await fsExec('sofia status')).toMatch(/ws-test\s+profile\s+sip:mod_sofia@127\.0\.0\.1:\d+\s+RUNNING/);
    } finally {
      await stopFreeSwitch(handle);
    }
  });
});
