// test/freeswitch-matrix/fsctl.infra.test.ts
import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { startFreeSwitch, stopFreeSwitch, fsExec, getRecordings } from './fsctl';

const CONF = join(import.meta.dirname, 'fs-conf');

describe('fsExec drives the event socket', () => {
  it('accepts status, originate, and uuid_kill', async () => {
    const handle = await startFreeSwitch(CONF);
    try {
      const uuid = (await fsExec('create_uuid')).trim();
      const started = await fsExec(`originate {origination_uuid=${uuid}}loopback/9196/default/XML &echo()`);
      expect(started).toMatch(/\+OK/); // originate accepted
      await fsExec(`uuid_kill ${uuid}`);
      expect(await fsExec('sofia status')).toMatch(/ws-test/); // socket healthy after kill
    } finally {
      await stopFreeSwitch(handle);
    }
  });

  it('records the echo dialplan into the mounted /recordings volume', async () => {
    const handle = await startFreeSwitch(CONF);
    try {
      const uuid = (await fsExec('create_uuid')).trim();
      await fsExec(`originate {origination_uuid=${uuid}}loopback/9196/default/XML &echo()`);
      // loopback legs are answered server-side; kill turns the call, then the
      // record_session file must exist. If loopback/9196 never answers, drop this
      // assertion here — the real recording proof is the Task 6 audio spec.
      await fsExec(`uuid_kill ${uuid}`);
      const wavs = getRecordings(handle);
      expect(wavs.length).toBeGreaterThan(0);
    } finally {
      await stopFreeSwitch(handle);
    }
  });
});
