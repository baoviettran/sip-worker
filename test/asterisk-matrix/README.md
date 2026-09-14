# Asterisk call-matrix harness

Playwright-driven integration tests that boot a real Asterisk container,
exercise sip-worker's WebRTC / SIP stack against it, and assert registration,
inbound and outbound calls, controls, DTMF, and recovery end-to-end.

The ten steps, what each asserts, and the design decisions behind them are in
[the design spec](../../docs/superpowers/specs/2026-09-14-v0.9-asterisk-matrix-design.md).
This file only covers how to run it.

## What you need

**Docker.** Every step below except `unit` and `integrity` boots a real
container. The image is pinned by DIGEST — never a floating tag — and the
reference lives in exactly one place, `AST_IMAGE` in `conf.ts`:

```
andrius/asterisk@sha256:5c96c8f7a17688c79452a4a2a56864b4a7570f4c4276fc353db51e38111bb9c3
```

The same string is repeated in `.github/workflows/asterisk-matrix.yml` so the
digest a given CI run used is greppable at the CI layer, and
`matrix-integrity.test.mjs` fails if the two ever disagree.

The container runs with `--network host`, and that is not a convenience: the
committed config binds the WSS transport, the HTTP/WSS server, and the AMI port
to `127.0.0.1` only (the matrix is loopback-only), and host networking is what
lets a loopback bind inside the container be the browser's loopback outside it.
Ports are not fixed — `astctl.ts` reserves free loopback ports per run and
renders them into the config. The one fixed range is RTP, `20102-20202`
(`ast-conf/rtp.conf`), deliberately distinct from the FreeSWITCH matrix's
`20000-20100` because both containers share one host network.

## Run idioms

### Without docker (fast, no infra)

```bash
npm run test:astmatrix:unit        # vitest: RMS, STUN, config surface, profile, AMI framing
npm run test:astmatrix:integrity   # node --test: integrity + boundary gates
```

### With docker (requires a running docker daemon)

```bash
npm run test:astmatrix:infra       # vitest: the Asterisk boot gate
npm run test:astmatrix:page        # playwright: the spec suite
npm run test:astmatrix             # all four, in that order
```

`MATRIX_MODE` selects the slice both the specs and the browser projects are
drawn from: `pr` runs Chromium alone with `audio.spec.ts` structurally excluded
(`testMatch`), while `nightly` (or unset) runs Chromium + Firefox including the
audio proof. The PR slice excludes the audio spec because GitHub-hosted runners
have no audio device; the nightly job provisions a PulseAudio null sink for
Firefox, whose WebRTC stack will not enumerate an audio device without one.
Registering a browser the CI job did not install fails every test with
"Executable doesn't exist", so the two must stay in step.

Or run a single spec:

```bash
npx playwright test --config=test/asterisk-matrix/playwright.config.ts \
  test/asterisk-matrix/register.spec.ts
```

## What CI runs

| Script | PR job | Nightly job |
|--------|--------|-------------|
| `test:astmatrix:unit` | yes | yes |
| `test:astmatrix:integrity` | yes | yes |
| `test:astmatrix:infra` | yes | no (the page step boots the container through its own `globalSetup`, so a second boot would buy no coverage) |
| `test:astmatrix:page` | yes, `MATRIX_MODE=pr`, Chromium | yes, `MATRIX_MODE=nightly`, Chromium + Firefox |

## Fail-not-skip

Every test in this harness is a hard assertion. A missing dependency, a failed
Asterisk boot, or a dropped WebSocket will **fail** the test, never skip it.
Skipped tests hide real regressions, and so do gates that cannot fail — which is
why the integrity gate carries floor checks on how much it walked and not only
on what it found.

## Artifact locations

| Artifact | Path |
|----------|------|
| Asterisk container log (redacted) + AMI transcripts | `artifacts/` at the repo root (`asterisk.log`, `ami-*.log`; written by `stopAsterisk` before container removal) |
| Asterisk config (committed template) | `test/asterisk-matrix/ast-conf/` |
| Asterisk config (per-run, rendered) | a host-private temp dir — ports substituted, TLS written in |
| Bundled page entry | `test/asterisk-matrix/dist/` (built by `build-matrix.mjs`) |
| Playwright traces | `test-results/` (retained on failure via `trace: retain-on-failure`; reporter is `[['list']]`, no HTML report) |

## Secrets and key material

The only credential this harness uses is `matrix-pass-2026` — the SIP endpoint
password for `1000` in `ast-conf/pjsip.conf` and the AMI secret in
`ast-conf/manager.conf`. Both are committed constants; no GitHub secret is
referenced anywhere in the workflow. The container log and the AMI transcript
are redacted at source on the way out.

TLS is **minted per run**, by `test/matrix-shared/mint-tls.ts`, into a
host-private temp dir, and never committed — `matrix-integrity.test.mjs` fails
if any `.key` or `.pem` appears anywhere in the Asterisk or shared trees.

## Image bump procedure

1. Edit `AST_IMAGE` in `test/asterisk-matrix/conf.ts` to the new digest-pinned
   reference.
2. Update the digest comment in `.github/workflows/asterisk-matrix.yml` to
   match.
3. Run the integrity gate to confirm the two agree and the tree is clean:

   ```bash
   npm run test:astmatrix:integrity
   ```

4. Run the infra and page tests with docker to validate the new image:

   ```bash
   npm run test:astmatrix:infra
   npm run test:astmatrix:page
   ```
