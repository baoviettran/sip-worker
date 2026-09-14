import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts', 'test/compatibility/**/*.test.ts', 'test/matrix-shared/**/*.unit.test.ts', 'test/freeswitch-matrix/**/*.unit.test.ts', 'test/freeswitch-pilot/**/*.test.ts', 'test/soak/**/*.test.ts', 'test/sipp/**/*.test.ts'],
    passWithNoTests: true,
  },
});
