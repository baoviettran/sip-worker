// test/sipp/run-scenario.mjs
// v0.9 WS2 protocol corpus orchestrator.
//
// This module currently defines the scenario table and pinned docker image;
// Task 4 appends the run logic (pack, docker spawn, driver spawn, verdict).
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

export const SIPP_IMAGE =
  'pbertera/sipp@sha256:063e8e9c8ecf54552e8efc3c363007afbfd3cae5a0f3f037db1c2e7fa4cd0349';

export const SIPP_DIR = fileURLToPath(new URL('.', import.meta.url));
export const SCENARIOS_DIR = join(SIPP_DIR, 'scenarios');
export const FIXTURE_DIR = join(SIPP_DIR, 'fixtures');
export const DRIVER_ENTRY = join(SIPP_DIR, 'driver', 'dist', 'agent.js');

// One entry per scenario. `runs` enumerates the docker runs for that scenario
// (variants share the same driver action; the driver picks the expected outcome
// from EXPECTATIONS["<scenario>:<variant>"]). `xml` is relative to SCENARIOS_DIR.
export const SCENARIOS = {
  'register-basic': {
    role: 'uas',
    runs: [{ variant: 'success', transport: 'udp', xml: 'register-basic.xml', password: 'unused' }],
    deadlineMs: 10_000,
  },
  'register-auth': {
    role: 'uas',
    runs: [
      { variant: 'success', transport: 'udp', xml: 'register-auth.xml', password: 'correct-password' },
      { variant: 'wrong-password', transport: 'udp', xml: 'register-auth-fail.xml', password: 'definitely-wrong' },
    ],
    deadlineMs: 15_000,
  },
  'register-refresh': {
    role: 'uas',
    runs: [{ variant: 'success', transport: 'udp', xml: 'register-refresh.xml', password: 'unused' }],
    deadlineMs: 15_000,
  },
  'invite-outgoing': {
    role: 'uas',
    runs: [
      { variant: 'udp', transport: 'udp', xml: 'invite-outgoing.xml', password: 'unused' },
      { variant: 'tcp', transport: 'tcp', xml: 'invite-outgoing.xml', password: 'unused' },
    ],
    deadlineMs: 15_000,
  },
  'invite-incoming': {
    role: 'uac',
    runs: [{ variant: 'success', transport: 'udp', xml: 'invite-incoming.xml', password: 'unused' }],
    deadlineMs: 15_000,
  },
  'cancel-race': {
    role: 'uac',
    runs: [{ variant: 'success', transport: 'udp', xml: 'cancel-race.xml', password: 'unused' }],
    deadlineMs: 10_000,
  },
  'retransmissions': {
    role: 'uas',
    runs: [{ variant: 'success', transport: 'udp', xml: 'retransmissions.xml', password: 'unused' }],
    deadlineMs: 15_000,
  },
  'bye-timeout': {
    role: 'uas',
    runs: [{ variant: 'success', transport: 'udp', xml: 'bye-timeout.xml', password: 'unused' }],
    deadlineMs: 45_000,
  },
  'malformed': {
    role: 'uas',
    runs: [{ variant: 'success', transport: 'udp', xml: 'malformed.xml', password: 'unused' }],
    deadlineMs: 15_000,
  },
  'reconnect': {
    role: 'uas',
    runs: [{ variant: 'success', transport: 'udp', xml: 'reconnect.xml', password: 'unused' }],
    deadlineMs: 15_000,
  },
};
