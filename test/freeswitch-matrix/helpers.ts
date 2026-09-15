// test/freeswitch-matrix/helpers.ts — the FreeSWITCH binding of the shared
// matrix glue. The lookups below are the only FreeSWITCH-specific facts: the
// label, the handle env var (unchanged, so CI needs no edit), the page port,
// and the container controller.
import { join } from 'node:path';
import { startFreeSwitch, stopFreeSwitch, FS_IMAGE, type FsHandle } from './fsctl';
import { createMatrixHelpers } from '../matrix-shared/helpers';

const h = createMatrixHelpers<FsHandle>({
  label: 'FreeSWITCH',
  handleEnvVar: 'MATRIX_FS_HANDLE_FILE',
  defaultHttpPort: 4500,
  imageRef: FS_IMAGE,
  boot: () => startFreeSwitch(join(import.meta.dirname, 'fs-conf')),
  stop: stopFreeSwitch,
});

export default h.globalSetup;
export const { readHandle, bootMatrix, runStep, disposeMatrix } = h;
