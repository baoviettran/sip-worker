import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'transport/index': 'src/transport/index.ts',
    'reliability/index': 'src/reliability/index.ts',
  },
  tsconfig: './tsconfig.json',
  external: ['@sip-worker/core', /^@sip-worker\/core\//],
  format: ['esm', 'cjs'],
  dts: true,
  splitting: true,
  sourcemap: true,
  clean: true,
  target: 'es2022',
});