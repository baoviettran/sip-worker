// test/freeswitch-matrix/page.ts — the bundled entry. Everything it needs from
// FreeSWITCH is in the profile; the engine itself lives in matrix-shared.
import { bootMatrixPage } from '../matrix-shared/steps';
import { freeSwitchProfile } from './profile';

bootMatrixPage(freeSwitchProfile);
