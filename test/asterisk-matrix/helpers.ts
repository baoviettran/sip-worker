// test/asterisk-matrix/helpers.ts — the Asterisk binding of the shared glue.
import { fileURLToPath } from 'node:url';
import { startAsterisk, stopAsterisk, type AstHandle } from './astctl';
import { AST_IMAGE } from './conf';
import { createMatrixHelpers } from '../matrix-shared/helpers';

const h = createMatrixHelpers<AstHandle>({
  label: 'Asterisk',
  handleEnvVar: 'MATRIX_AST_HANDLE_FILE',
  defaultHttpPort: 4510,
  imageRef: AST_IMAGE,
  boot: () => startAsterisk(fileURLToPath(new URL('./ast-conf', import.meta.url))),
  stop: stopAsterisk,
});

export default h.globalSetup;
export const { readHandle, bootMatrix, runStep, disposeMatrix } = h;
