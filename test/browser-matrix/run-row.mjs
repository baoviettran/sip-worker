// test/browser-matrix/run-row.mjs — run exactly one row, locally or in CI.
//
//   node test/browser-matrix/run-row.mjs <row-id> [--event pr|main|nightly]
//
// One entry point for both, so the local path and the CI path cannot diverge.
// It provisions the row (T2's CLI), exports the row's contract to the config
// through the environment, and runs the SAME suite the three-engine gate runs —
// with today's forced-TURN exclusion, because a row job has no coturn and the
// relay spec fails by design when TURN_URL/TURN_PEER_URL are absent.
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { EVENTS, ROWS } from './rows.mjs';

const here = fileURLToPath(new URL('.', import.meta.url));
const [rowId, ...rest] = process.argv.slice(2);
const eventIndex = rest.indexOf('--event');
// 'nightly' locally: a developer may run any row. CI passes the event that
// gates its row set, which is what makes an unselected row throw there.
const event = eventIndex === -1 ? 'nightly' : rest[eventIndex + 1];

if (!rowId) {
  process.stderr.write('usage: node test/browser-matrix/run-row.mjs <row-id> [--event pr|main|nightly]\n');
  process.exit(2);
}
if (!ROWS.some((row) => row.id === rowId)) {
  process.stderr.write(`run-row: unknown row id ${JSON.stringify(rowId)} (known: ${ROWS.map((r) => r.id).join(', ')})\n`);
  process.exit(2);
}
if (!EVENTS.includes(event)) {
  process.stderr.write(`run-row: --event must be one of ${EVENTS.join('|')}\n`);
  process.exit(2);
}

// Provision with the CLI, not with a second implementation: the path is what
// the config's launchTarget consumes, and provisioning is what fails when a
// vendor artifact is unavailable or mis-pinned.
const provisioned = execFileSync('node', [`${here}provision.mjs`, rowId], { encoding: 'utf8' }).trim();

const env = { ...process.env, MATRIX_EVENT: event, MATRIX_ROWS: rowId };
if (provisioned) env.MATRIX_EXECUTABLE_PATH = provisioned;

execFileSync(
  'npx',
  ['playwright', 'test', '--config', `${here}playwright.config.ts`, '--grep-invert', 'forced TURN relay'],
  { stdio: 'inherit', env },
);
