import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts', 'test/compatibility/**/*.test.ts'],
    passWithNoTests: true,
  },
});
