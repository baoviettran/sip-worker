import { defineConfig } from 'tsup';
export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'messages/index': 'src/messages/index.ts',
    'stream/index': 'src/stream/index.ts',
    'transport/node/index': 'src/transport/node/index.ts',
    'transport/browser/index': 'src/transport/browser/index.ts',
    'transactions/index': 'src/transactions/index.ts',
    'dialogs/index': 'src/dialogs/index.ts',
    'auth/index': 'src/auth/index.ts',
    'ua/index': 'src/ua/index.ts',
    'media/index': 'src/media/index.ts',
    'reliability/index': 'src/reliability/index.ts',
    'bridge/index': 'src/bridge/index.ts',
  },
  format: ['esm', 'cjs'],
  outExtension: ({ format }) => ({ js: format === 'cjs' ? '.cjs' : '.js' }),
  dts: true, clean: true, sourcemap: true, splitting: false, target: 'es2022',
});
