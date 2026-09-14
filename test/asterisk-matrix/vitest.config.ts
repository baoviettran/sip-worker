// test/asterisk-matrix/vitest.config.ts — docker infra tests only; the unit
// tests (ami, conf) keep the repo root defaults and need no docker.
//
// No `include` key, deliberately: mirroring test/freeswitch-matrix/
// vitest.config.ts, which lets the CLI glob in the npm script select the files
// and keeps this config to the two things the CLI cannot express.
//
// fileParallelism: false is not tidiness. The committed rtp.conf pins a FIXED
// range (20102-20202, chosen to avoid the FreeSWITCH matrix's), and containers
// run with --network host, so two Asterisk containers at once would both try to
// bind the same RTP range and the second would fail in a way that looks like a
// media bug.
//
// hookTimeout matters because the boot happens in beforeAll, and vitest's
// default is 10s — shorter than a cold container start.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    fileParallelism: false,
    testTimeout: 180_000,
    hookTimeout: 180_000,
  },
});
