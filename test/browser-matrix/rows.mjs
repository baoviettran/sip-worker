// test/browser-matrix/rows.mjs — the v0.9 browser matrix row table.
//
// The single source of truth, read by the provisioner (provision.mjs), the
// row-driven Playwright config, the CI `rows` job (this file's CLI), and the
// integrity gate. Plain ESM with no imports, for the same reason
// test/matrix-shared/playwright-config-guard.mjs is .mjs: `node --test` and a
// GitHub Actions step both read it with no build step, and the root package is
// already `"type": "module"`.
//
// Pins are fixed here and bumped deliberately: a vendor bump is a commit that
// changes this table AND the expected-version assertion together. Nothing
// follows vendor releases on its own.
//
// Provision kinds (all four exercised against @playwright/test 1.62.0 by the
// 2026-09-21 spike):
//   bundled    Playwright's own build. No executablePath is ever set for it.
//   cft        Chrome for Testing zip.
//   pw-firefox Playwright's Firefox build at a DIFFERENT revision than the
//              pinned driver ships. Playwright drives only its own patched,
//              Juggler-speaking builds; the runner's stock Firefox (155) is
//              not driveable. This row is a documented proxy.
//   edge-deb   Microsoft Edge stable .deb, unpacked with `dpkg-deb -x`.
//   runner     Nothing is provisioned: the macOS runner's Safari, recorded by
//              safari-runner.mjs. Such a row is never launched by a row job.
//
// Revision -> version is NOT linear and must never be assumed: Playwright's
// firefox rev 1538 reports 153.0 while rev 1532 reports 151.0. Each row
// therefore carries the pin (what is fetched) and expectedVersion (what must be
// reported) as separate fields.
//
// `product` and `stability` exist for one reason: the table is not "one row per
// engine". Chromium legitimately carries three current/previous rows — the
// Playwright bundled build, plus Chrome and Edge as their own products — so the
// invariant the table satisfies is one row per (product, stability). That is the
// refinement of the spec's "one row per engine per stability label", which the
// engine field alone cannot express (see rows.unit.test.ts).
//
// The bundled rows' pins are cross-checked OFFLINE against
// node_modules/playwright-core/browsers.json by the integrity gate, so a
// Playwright bump fails there instead of silently re-labelling the matrix.
import { fileURLToPath } from 'node:url';

export const ENGINES = ['chromium', 'firefox', 'webkit'];
export const EVENTS = ['pr', 'main', 'nightly'];

export const ROWS = [
  {
    id: 'chromium-current',
    product: 'chromium',
    stability: 'current',
    engine: 'chromium',
    // Playwright's own chromium IS a Chrome for Testing build (same
    // chrome-linux64/chrome layout), so this row needs no special handling —
    // only the revision it must be at.
    provision: { kind: 'bundled', pin: '1234' },
    expectedVersion: '151.0.7922.34',
    label: 'Chromium (Playwright bundled, current)',
    triggers: ['pr', 'main', 'nightly'],
  },
  {
    id: 'firefox-current',
    product: 'firefox',
    stability: 'current',
    engine: 'firefox',
    provision: { kind: 'bundled', pin: '1538' },
    expectedVersion: '153.0',
    label: 'Firefox (Playwright bundled, current)',
    triggers: ['pr', 'main', 'nightly'],
  },
  {
    id: 'webkit-current',
    product: 'webkit',
    stability: 'current',
    engine: 'webkit',
    // Linux's Safari-family proxy, and the only Safari-family coverage a Linux
    // runner can give. It is NOT real Safari — see safari-current.
    provision: { kind: 'bundled', pin: '2336' },
    expectedVersion: '26.5',
    label: 'WebKit (Playwright bundled, Linux Safari proxy)',
    triggers: ['pr', 'main', 'nightly'],
  },
  {
    id: 'chrome-current',
    product: 'chrome',
    stability: 'current',
    engine: 'chromium',
    provision: { kind: 'cft', pin: '153.0.8010.52' },
    expectedVersion: '153.0.8010.52',
    label: 'Chrome (current stable)',
    triggers: ['main', 'nightly'],
  },
  {
    id: 'chrome-previous',
    product: 'chrome',
    stability: 'previous',
    engine: 'chromium',
    // Corroborated by the ubuntu-latest runner image's own preinstalled Chrome,
    // which is this same milestone. That binary is NOT used — decision 6.
    provision: { kind: 'cft', pin: '152.0.7977.82' },
    expectedVersion: '152.0.7977.82',
    label: 'Chrome (previous stable)',
    triggers: ['main', 'nightly'],
  },
  {
    id: 'edge-current',
    product: 'edge',
    stability: 'current',
    engine: 'chromium',
    // KNOWN RISK, verify at first run: `dpkg-deb -x` does not preserve the
    // setuid bit Edge's chrome-sandbox needs, so this row may require
    // `--no-sandbox` (or a pinned apt install of the same version instead of an
    // extraction). The spike host launched the extracted build, but the spike
    // host is not the runner.
    provision: { kind: 'edge-deb', pin: '153.0.4234.48' },
    expectedVersion: '153.0.4234.48',
    label: 'Edge (current stable)',
    triggers: ['main', 'nightly'],
  },
  {
    id: 'edge-previous',
    product: 'edge',
    stability: 'previous',
    engine: 'chromium',
    provision: { kind: 'edge-deb', pin: '152.0.4191.66' },
    expectedVersion: '152.0.4191.66',
    label: 'Edge (previous stable)',
    triggers: ['main', 'nightly'],
  },
  {
    id: 'firefox-previous',
    product: 'firefox',
    stability: 'previous',
    engine: 'firefox',
    // Playwright 1.61's Firefox (rev 1532 -> 151.0), driven by the pinned 1.62
    // driver. A documented proxy: Playwright cannot drive upstream Firefox.
    provision: { kind: 'pw-firefox', pin: '1532' },
    expectedVersion: '151.0',
    label: 'Firefox (Playwright build, previous)',
    triggers: ['main', 'nightly'],
  },
  {
    id: 'safari-current',
    product: 'safari',
    stability: 'current',
    engine: 'webkit',
    // The macOS runner provides Safari; the row records the version it observed
    // (safari-runner.mjs) and asserts nothing. Pinning Safari on a hosted runner
    // is not possible, so `expectedVersion: null` is the honest encoding.
    provision: { kind: 'runner' },
    expectedVersion: null,
    label: 'Safari (macOS runner, recorded)',
    triggers: ['pr', 'main', 'nightly'],
  },
];

/** Rows whose triggers cover the event, runner-provisioned rows included. */
export function rowsForEvent(event) {
  if (!EVENTS.includes(event)) throw new Error(`unknown event: ${event} (events: ${EVENTS.join('|')})`);
  return ROWS.filter((row) => row.triggers.includes(event));
}

/**
 * The CI matrix entries for an event: rowsForEvent minus the rows another
 * workflow provisions. `label` is the job's DISPLAY NAME, which is what branch
 * protection matches — renaming a label is a branch-protection change.
 */
export function rowMatrixForEvent(event) {
  return rowsForEvent(event)
    .filter((row) => row.provision.kind !== 'runner')
    .map((row) => ({ id: row.id, label: row.label }));
}

/**
 * The rows this run may launch. Throws — never returns a subset — because a
 * silently empty or silently narrowed project list reports a green run that
 * tested something other than what was asked for.
 */
export function selectRows(ids, allowed = ROWS) {
  const known = new Map(ROWS.map((row) => [row.id, row]));
  const allowedIds = new Set(allowed.map((row) => row.id));
  const picked = [];
  for (const id of ids) {
    const row = known.get(id);
    if (!row) throw new Error(`unknown row id: ${id} (known: ${[...known.keys()].join(', ')})`);
    if (!allowedIds.has(id)) {
      throw new Error(`row ${id} is not selected for this event (selectable: ${[...allowedIds].join(', ')})`);
    }
    picked.push(row);
  }
  if (picked.length === 0) {
    throw new Error('no rows selected: a run with an empty project list would report green while testing nothing');
  }
  return picked;
}

/**
 * The launch target for a row, from the environment the provisioner filled in.
 * Enforces locked decision 6 in both directions: a bundled row must NOT be
 * handed an external path (it would launch a build the row did not pin), and a
 * vendor row MUST be handed one (otherwise Playwright launches its own bundled
 * build and the version assertion fails for the wrong reason).
 */
export function launchTarget(row, env = process.env) {
  const executablePath = env.MATRIX_EXECUTABLE_PATH ?? '';
  if (row.provision.kind === 'bundled') {
    if (executablePath) {
      throw new Error(
        `row ${row.id} is bundled: MATRIX_EXECUTABLE_PATH=${executablePath} would have launched a different build than the row pins`,
      );
    }
    return {};
  }
  if (row.provision.kind === 'runner') {
    throw new Error(`row ${row.id} is provisioned by the macOS workflow; it is never launched by a row job`);
  }
  if (!executablePath) {
    throw new Error(
      `row ${row.id} (${row.provision.kind} ${row.provision.pin}) needs MATRIX_EXECUTABLE_PATH from provision.mjs; ` +
        'without it Playwright would launch its own bundled build and the version assertion would fail for the wrong reason',
    );
  }
  return { executablePath };
}

/** The two `$GITHUB_OUTPUT` lines the CI `rows` job writes. */
export function githubOutputs(event) {
  const matrix = rowMatrixForEvent(event);
  return {
    ids: `ids=${JSON.stringify(matrix.map((entry) => entry.id))}`,
    matrix: `matrix=${JSON.stringify({ include: matrix })}`,
  };
}

// CLI: `node test/browser-matrix/rows.mjs --event pr` prints the two
// $GITHUB_OUTPUT lines and nothing else, so a step can append stdout to
// $GITHUB_OUTPUT verbatim.
if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  const eventIndex = process.argv.indexOf('--event');
  const event = eventIndex === -1 ? 'nightly' : process.argv[eventIndex + 1];
  try {
    const out = githubOutputs(event);
    process.stdout.write(`${out.ids}\n${out.matrix}\n`);
  } catch (error) {
    process.stderr.write(`rows: ${error.message}\n`);
    process.exit(1);
  }
}
