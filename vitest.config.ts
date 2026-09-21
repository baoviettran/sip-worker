import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts', 'test/compatibility/**/*.test.ts', 'test/matrix-shared/**/*.unit.test.ts', 'test/freeswitch-matrix/**/*.unit.test.ts', 'test/asterisk-matrix/**/*.unit.test.ts', 'test/freeswitch-pilot/**/*.test.ts', 'test/soak/**/*.test.ts', 'test/sipp/**/*.test.ts', 'test/browser-matrix/**/*.unit.test.ts', 'test/browser-media/**/*.unit.test.ts'],
    // FLOOR, not a convenience. `true` here meant a glob naming a nonexistent
    // file still exited 0, and so did all-unmatched ("No test files found") —
    // a whole tree's unit tests could vanish and the gate stayed green, the
    // same shape as the step-count hole the integrity gate now closes.
    // Measured before flipping it: every script that runs Vitest through THIS
    // config collects at least one file, so no gate legitimately collects
    // nothing — `npm test`, test:matrix:unit (4 files), test:astmatrix:unit
    // (5: 3 × matrix-shared + 2 × asterisk-matrix), test:pilot:unit (6),
    // test:soak:core (1), test:sipp:unit (2). The
    // two infra scripts pass their own --config (test/*/vitest.config.ts), which
    // never set this option and therefore already defaulted to false.
    passWithNoTests: false,
  },
});
