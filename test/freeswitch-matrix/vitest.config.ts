// test/freeswitch-matrix/vitest.config.ts — docker infra tests only: each file
// boots its own FreeSWITCH container bound to the fixed event socket 127.0.0.1:8021,
// so files must run one at a time (unit tests keep the repo root defaults).
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    fileParallelism: false,
    testTimeout: 150_000,
  },
});
