# Task 11 Report

## Status: DONE

**Commit:** `3cf2cad` — `test(fs-matrix): integrity and import-boundary gates, README, npm scripts`

**Base:** `a035814` (previous HEAD)

## Files created/modified

| File | Action |
|------|--------|
| `test/freeswitch-matrix/no-src-imports.test.mjs` | Created — import boundary gate |
| `test/freeswitch-matrix/matrix-integrity.test.mjs` | Created — integrity gate |
| `test/freeswitch-matrix/README.md` | Created — run idioms, artifact locations, FS-image bump procedure |
| `package.json` | Modified — 4 new `test:matrix:*` scripts |
| `vitest.config.ts` | Modified — narrowed include to `*.unit.test.ts` for freeswitch-matrix |

## Step 5 verification output

### `npm run test:matrix:unit` (without docker)
```
 Test Files  2 passed (2)
      Tests  10 passed (10)
```

### `npm run test:matrix:integrity` (without docker)
```
ok 1 - every MATRIX_STEPS spec file exists on disk
ok 2 - manifest maps to exactly six unique spec files
ok 3 - fs-conf base tree has no __*__ port tokens (overlay files excluded)
ok 4 - no committed tls/*.key files
ok 5 - no committed tls/*.pem files
ok 6 - page.ts and spec files import no packages/**/src and no @sip-worker value imports
# pass 6
```

### `npm run test:matrix:infra` (with docker)
```
 Test Files  2 passed (2)
      Tests  4 passed (4)
```

### `npm test` (plain vitest, no docker)
```
 Test Files  81 passed (81)
      Tests  1291 passed | 1 skipped (1292)
```
Matrix infra tests (fsboot, fsctl) excluded from default suite. Matrix unit tests (rms, conf) still run.

### `npm run typecheck`
Clean — no errors.

## Self-review

- The integrity gate excludes overlay-originated files (sip_profiles/ws-test.xml) from the port-token scan because those files intentionally carry `__SIP_PORT__` / `__WS_PORT__` / `__WSS_PORT__` tokens that are rendered at materialize time by `materialize.mjs`.
- The boundary gate scans `page.ts` and all `*.spec.ts` files in the matrix directory, using the exact WS2 regexes (value import of `@sip-worker/*`, import from `packages/**/src`).
- The `vitest.config.ts` change narrows `test/freeswitch-matrix/**/*.test.ts` to `*.unit.test.ts`, preventing docker infra tests from breaking plain `npm test`.

## Deviations

- **vitest.config.ts (sanctioned extra scope):** Narrowed the root vitest include from `test/freeswitch-matrix/**/*.test.ts` to `test/freeswitch-matrix/**/*.unit.test.ts`. This prevents `fsboot.infra.test.ts` and `fsctl.infra.test.ts` from running during plain `npm test` (which times out without docker and leaks orphan FS containers). The matrix unit tests (`rms.unit.test.ts`, `conf.unit.test.ts`) still run in the default suite.
- **Port-token gate adjustment:** The brief stated "the committed fs-conf tree was rendered token-free at commit time," but `fs-conf/sip_profiles/ws-test.xml` (an overlay-originated template file) does contain `__SIP_PORT__` tokens in the committed tree. The gate excludes overlay-originated files from the token scan, which is the correct semantic: the check validates that no *other* committed config files leak unreplaced tokens, while overlay templates (rendered by `materialize.mjs` at runtime) are intentionally tokenized.

## Fix round 1

**Commit:** `582da0d` — `test(fs-matrix): harden integrity gate and fix README artifacts`

Four findings addressed:

### Important — TLS gate vacuous (matrix-integrity.test.mjs)

The TLS gate previously scanned `test/freeswitch-matrix/tls/`, a path nothing ever creates (certs are minted into per-run tmpdirs by `fsctl.ts`; `materialize.mjs` creates `fs-conf/tls/` at materialize time, not `./tls/`). With `if (!hasTls) return;` the tests 4-5 early-returned unconditionally, never checking anything.

**Fix:** Replaced the `tls/` scan with a recursive scan of the entire matrix directory (`walkDir(__dirname)`) for `.key` and `.pem` files. The gate now always inspects a real file set and asserts `=== 0`. A floor check (`assert.ok(allMatrixFiles.length >= 50)`) ensures the scan is never vacuous.

### Important — Token scan no floor (matrix-integrity.test.mjs)

If `fs-conf/` were deleted or emptied, `fsConfFiles = []` and the token test would pass vacuously with no files to scan.

**Fix:** Added `assert.ok(fsConfFiles.length >= 30, ...)` as a dedicated floor-check test before the token scan (actual count: 41 files). Mirrors the WS2 analog which asserts `>= 10` scenarios present.

### Minor — README recordings path (README.md)

The recordings artifact path stated `test/freeswitch-matrix/recordings/` but recordings are mounted from a per-run tmpdir created by `mkdtempSync('fsrec-')` in `fsctl.ts`.

**Fix:** Corrected to `per-run tmpdir created by fsctl.ts`.

### Minor — README Playwright report (README.md)

The Playwright report artifact stated `test-results/ (default Playwright output)` implying an HTML report, but the config uses `reporter: [['list']]` (no HTML). `test-results/` holds traces/screenshots retained on failure via `trace: retain-on-failure`.

**Fix:** Corrected to `Playwright traces — test-results/ (retained on failure via trace: retain-on-failure; reporter is [['list']], no HTML report)`.

### Verification

- `npm run test:matrix:integrity`: 8/8 pass (was 6/6 before; added 2 floor-check tests).
- Negative test: injected `__SIP_PORT__` into `fs-conf/vars.xml` — gate fails with `port token __SIP_PORT__ found in freeswitch-matrix/fs-conf/vars.xml`. Restored and re-verified green.
- `npm test`: still clean (1291 passed, 1 skipped).
- `npm run typecheck`: clean.
