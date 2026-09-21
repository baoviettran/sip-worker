# Supported browser matrix

The engines this project is verified against, and how each one is provisioned.
The rows are declared in [`test/browser-matrix/rows.mjs`](../test/browser-matrix/rows.mjs);
this page is rendered from that table by
`npm run test:browsermatrix:docs`.

| Row | Browser | Engine | Provisioned as | Expected version | Observed version |
| --- | --- | --- | --- | --- | --- |
| `chromium-current` | Chromium (Playwright bundled, current) | chromium | Playwright bundled (rev 1234) | 151.0.7922.34 | — |
| `firefox-current` | Firefox (Playwright bundled, current) | firefox | Playwright bundled (rev 1538) | 153.0 | — |
| `webkit-current` | WebKit (Playwright bundled, Linux Safari proxy) | webkit | Playwright bundled (rev 2336) | 26.5 | — |
| `chrome-current` | Chrome (current stable) | chromium | Chrome for Testing 153.0.8010.52 | 153.0.8010.52 | — |
| `chrome-previous` | Chrome (previous stable) | chromium | Chrome for Testing 152.0.7977.82 | 152.0.7977.82 | — |
| `edge-current` | Edge (current stable) | chromium | Edge stable 153.0.4234.48 (`.deb`) | 153.0.4234.48 | — |
| `edge-previous` | Edge (previous stable) | chromium | Edge stable 152.0.4191.66 (`.deb`) | 152.0.4191.66 | — |
| `firefox-previous` | Firefox (Playwright build, previous) | firefox | Playwright Firefox build rev 1532 | 151.0 | — |
| `safari-current` | Safari (macOS runner, recorded) | webkit | provided by the macOS runner | recorded, not asserted | — |

## What each column means

- **Expected version** is asserted in-suite for every row a job launches:
  `test/browser-matrix/version.spec.ts` fails the row unless the launched
  engine reports exactly this version. The vendor rows are asserted a second
  time at provision time, where `provision.mjs` probes the downloaded binary
  before the suite starts. The three bundled rows are the exception — the
  provisioner does not probe a Playwright build, so what pins them is the
  offline cross-check against `node_modules/playwright-core/browsers.json` in
  the integrity gate, where a Playwright bump fails. A vendor bump is a
  deliberate commit that changes the row table and these assertions together.
- **Observed version** is filled in from the run's `browser-matrix-<row>`
  artifacts, which the publisher downloads by the `browser-matrix-*` pattern
  (`observedVersion` in each row's JSON). Rows rendered from the table alone
  show `—`: no version is claimed that a run did not report. The
  `safari-current` row has no report in that set: the macOS workflow uploads
  its report inside `safari-media-<run_id>` under `test-results/browser-matrix/`,
  and nothing downloads that artifact, so CI never fills this column for it.
- **Playwright WebKit** is the automated engine on Linux, used as the Safari-family
  proxy. It is not real Safari. The `safari-current` row is the real browser, run by
  the macOS workflow, and its version is **recorded** rather than asserted, because
  Safari cannot be pinned on a hosted runner.
- **Firefox** rows are Playwright's own patched, Juggler-speaking Firefox builds.
  Playwright cannot drive upstream Firefox, so a Firefox row is a documented proxy:
  the row names the Playwright build exactly.
- **The Firefox version numbers are Playwright's build numbers, not upstream releases.**
  `firefox-current` reporting 153.0 and `firefox-previous` reporting 151.0 are two builds
  of the same patched browser at different Playwright revisions; upstream Firefox is
  further ahead than both. This is a property of the driver, not a stale pin — no pin of
  this table can move it.
- **The `edge-deb` rows unpack a `.deb`** with `dpkg-deb -x` rather than installing it, so
  no vendored package touches the runner's own browser installation. The extraction does
  not carry the setuid bit Edge's `chrome-sandbox` expects, so those rows are expected to
  require `--no-sandbox`. No row passes that flag today: `launchOptionsFor('chromium')`
  carries only the autoplay and fake-device flags, and `launchTarget` returns the
  executable path alone.

## Runs

- Pull requests run the bundled rows only, so no vendor artifact is downloaded.
- Push to `main` and the nightly schedule run the full matrix, one row per job.
- The forced-TURN relay leg stays a separate job: relaying is engine-agnostic and
  already proven on three engines, and a per-row expansion would cost one coturn
  container per row for no new claim.

