# FreeSWITCH call-matrix harness

Playwright-driven integration tests that boot a real FreeSWITCH container,
exercise sip-worker's WebRTC / SIP stack against it, and assert audio,
registration, controls, DTMF, and recovery end-to-end.

## Run idioms

### Without docker (fast, no infra)

```bash
npm run test:matrix:unit        # vitest: rms + conf unit tests
npm run test:matrix:integrity   # node --test: boundary + integrity gates
```

### With docker (requires a running FreeSWITCH image)

```bash
npm run test:matrix:infra       # vitest: fsboot + fsctl infra tests
npm run test:matrix:page        # playwright: full spec suite
```

Or run a single spec:

```bash
npx playwright test --config=test/freeswitch-matrix/playwright.config.ts \
  test/freeswitch-matrix/register.spec.ts
```

## Fail-not-skip

Every test in this harness is a hard assertion.  A missing dependency,
a failed FreeSWITCH boot, or a dropped WebSocket will **fail** the test,
never skip it.  Skipped tests hide real regressions.

## Artifact locations

| Artifact | Path |
|----------|------|
| Recorded audio WAVs | `/recordings/` inside the FreeSWITCH container (mounted from `test/freeswitch-matrix/recordings/`) |
| FreeSWITCH config (committed) | `test/freeswitch-matrix/fs-conf/` |
| FreeSWITCH config (overlay) | `test/freeswitch-matrix/fs-conf.overlay/` |
| Bundled page entry | `test/freeswitch-matrix/dist/` (built by `build-matrix.mjs`) |
| Playwright report | `test-results/` (default Playwright output) |

## FS-image bump procedure

1. Edit `FS_IMAGE` in `test/freeswitch-matrix/materialize.mjs` to the new
   digest-pinned image reference.
2. Run `node test/freeswitch-matrix/materialize.mjs` (requires docker).
   This pulls the new image, extracts the vanilla config, prunes it,
   merges the overlay, and writes the committed `fs-conf/` tree.
3. Review the diff in `fs-conf/` and `fs-conf.overlay/`.
4. Run the integrity gate to confirm the tree is clean:

   ```bash
   npm run test:matrix:integrity
   ```

5. Run the infra and page tests with docker to validate:

   ```bash
   npm run test:matrix:infra
   npm run test:matrix:page
   ```
