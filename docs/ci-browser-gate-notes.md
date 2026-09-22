# CI browser-gate environment notes

Lessons from making the v0.7 release-gate CI workflows green (commit `057683c`,
2026-08-16). Both gated workflows had **never been green** in CI history, and one
required-check change is still outstanding:

- `.github/workflows/browser-media.yml` — a `rows` job that computes the matrix
  from `test/browser-matrix/rows.mjs`, one `engine` job per row (each named by its
  row `label`, 40-minute timeout), a `publisher` job that fails the run when any
  expected row's report is missing or its observed version is wrong, and the
  `forced-turn-relay` job (ubuntu runner). Pull requests run the three bundled
  rows only; a push to `main` and the nightly `schedule` (`43 3 * * *`) both run
  the full matrix.
- **Branch protection — still to do, and nothing is enforced until it is done.**
  The `three-engine` job is gone, so the required check named `Chromium / Firefox /
  WebKit real audio` no longer exists. Its replacement is one check per row, each
  named by the row's `label` (`Chromium (Playwright bundled, current)`, `Chrome
  (previous stable)`, …), plus `Browser matrix report (completeness gate)`. **Until
  the required list in repo settings is updated, the matrix is not in it: the row
  checks and the completeness gate are not required, so a red matrix does not block
  a merge.** This is a repository-settings change, not a commit — a human makes it, in
  the same change that edits a row.

  **Require only the checks that a pull request actually produces.** The vendor
  rows run on `main` and nightly, never on a pull request, so adding their checks
  to the required list would leave every PR waiting on a job that never starts.
  Require the three bundled rows' checks and `Browser matrix report (completeness
  gate)`; the vendor rows stay covered by the nightly run.
- `.github/workflows/safari-media.yml` — shipping-Safari media + phone
  acceptance (macOS runner).

Every failure below was a **runner-environment gap, not a library defect**:
`git diff` at the end of the work showed **zero changes under `packages/`**. All
fixes live in `.github/workflows/*.yml` and `test/**`. If a browser gate passes
locally but fails in CI, read this list before touching product code.

---

## 1. Firefox audio on GitHub's ubuntu runners

**Symptom:** on firefox only — two-way-audio energy reports
`reason: 'silent-decode'`, and the mute tests fail with
`Expected: < 150, Received: 150`.

**Root cause:** the ubuntu runner has **no audio device**. Headless Firefox's
cubeb finds no output sink and decodes received WebRTC audio to silence;
Chromium/WebKit decode regardless. Locally the dev machine has a real ALSA
card, so the same tests pass 9/9.

**Fix (`.github/workflows/browser-media.yml`, the `engine` and
`forced-turn-relay` jobs):** provision a
PulseAudio null sink (with an ALSA null-PCM fallback) before the Playwright
run, and verify a sink actually exists (fail loudly if neither works).

Two harness changes were needed alongside it:

- `makeSyntheticSource` (test/browser-media/synthetic-peer.ts) — headless
  engines create the AudioContext suspended; a suspended context feeds silence
  into the track. Resume it persistently (bounded ~60s, cleared by `stop()` and
  by the running state), matching `measureEnergy`'s documented pattern.
- The mute calibration must **wait for outbound RTP to actually flow**
  (`waitForRtpGrowth`) instead of sampling immediately after `established` —
  on a slow runner the pre-flow silence collapses the active calibration onto
  its keepalive floor (150 B/s), so `mutedThreshold` equals the muted keepalive
  and `150 < 150` fails.

## 2. Safari certificate trust on GitHub's macos-14 runners

**Symptom:** Safari shows *"This Connection Is Not Private"*; the page never
boots. `security verify-cert -p ssl -c leaf` fails with
`Cert Verify Result: Unknown critical cert extension` plus a Certificate
Transparency error (`Unable to find at least 2 signed certificate timestamps`).

**Root cause:** CT is only enforced for **public** CAs — its appearance proves
the local trust anchor was never consulted. The blocker was the CA cert itself:
macOS's `/usr/bin/openssl` (LibreSSL) encodes
`-addext basicConstraints=critical,CA:TRUE` in a way the Security framework
cannot parse, so the chain dies **before** the trust anchor is reached.
`dump-trust-settings -d` confirmed the CA was present in the admin store while
evaluation still failed — a silent, misleading combination.

**Fix (`test/browser-phone/server.mjs` + `test/browser-media/safari-runner.mjs`):**
- Mint the CA **plain** (`openssl req -x509 ... -subj /CN=sipw-test-ca`, no
  `-addext`). The explicit trust setting, not the certificate's own
  basicConstraints, is what anchors the chain.
- Trust it in the **System admin store**:
  `sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain ca.crt`
  (user-login-keychain trust ops hang headlessly on the runner).
- **Verify** it took effect with `security verify-cert -p ssl -c leaf` — a
  silent trust failure must be reported as the cause, not left as a baffling
  boot error.

## 3. Safari autoplay / Web Audio

**Symptom:** the phone page's synthetic source AudioContext stays
`suspended`; the library PC reports a connected ICE pair, an `audio@live`
sender, but **zero outbound packets** (Safari sends nothing for a
suspended-context track). Recovery scenarios' *fresh* sources stay suspended
even after the controls scenario's source resumed.

**Root cause:** Safari grants autoplay (Web Audio included) only to contexts
created near a real user gesture. A script-dispatched `ac.resume()` rejects
without one, and the grant from a single click does **not** persist to
AudioContexts created later in the page.

**Fix (`test/browser-media/safari-runner.mjs`):** dispatch a **trusted WebDriver
pointer action** (the W3C `/actions` endpoint — treated as a real input, unlike
a synthetic `element.click()`) before the acceptance, and re-dispatch it every
~15s during a long-running acceptance so each later scenario's source gets
activation.

## 4. Intermittent Safari `getStats` hangs

**Symptom:** acceptances hang past every deadline — including ones with a
`Date.now() + timeout` loop, because the deadline only re-checks **after** the
`await` resolves.

**Root cause:** `RTCPeerConnection.getStats()` can hang on Safari in some media
states.

**Fix (both harness pages):** bound every harness `getStats` call with a 10s
`Promise.race` timeout that resolves `null` (read as "no data"):

```js
const stats = await Promise.race([
  pc.getStats(),
  new Promise((resolve) => setTimeout(() => resolve(null), 10000)),
]);
```

The same discipline applies to any await that feeds a deadline loop.

## 5. Remote-browser runner robustness

These apply to any gate that drives a real browser on a hosted runner:

- **Bound every WebDriver HTTP call** (`AbortSignal.timeout`). An unresponsive
  safaridriver (e.g. blocked starting Safari) otherwise holds a fetch open until
  the job timeout — GitHub then retains **no log** for the cancelled run.
- **Bound `execFileSync`** too (it has a `timeout` option). The `sudo security
  remove-trusted-cert` teardown hung 30s+ on the runner.
- **In-process watchdog** that fails the step with `process.exit(1)` — a normal
  failure retains the step log; a job-timeout *cancel* drops all logs.
- **Upload artifacts on `always()`**, mirror progress to a workspace file, and
  scope the artifact glob to include the files that diagnose (cert bundle,
  screenshots, runner log).
- **Poll long-running page acceptances by a completion flag**, not by
  re-invoking the acceptance per poll iteration — each per-call timeout starts a
  *new* concurrent scenario (observed as an `errors` array inflating with one
  object per retry).
- **Stage-mark the harness phases** (`bridge.stage`) and expose the partial
  result (`lastResult`) so a hang names itself instead of reading as an opaque
  earlier phase.

## Diagnosis methodology that worked

1. When a gate passes locally but fails in CI, assume the **environment**
   differs first (audio device, keychain trust, autoplay, stats) before
   suspecting the code.
2. Add one targeted diagnostic (page state, resource timing, getStats counters,
   a stage marker), push it, read the result, then fix the root cause. With
   bounded calls and retained logs each cycle is minutes, not a silent hour.
3. Prove the library is untouched with `git diff <start>..HEAD -- packages/`.

## Verify at first nightly run

The Safari row's report path is verified statically and against the publisher
offline, but two facts need a macOS runner to confirm. One fails loudly; the
other cannot fail loudly, because nothing reads it:

- that the runner's `safaridriver` populates `capabilities.browserVersion` —
  the runner throws when it does not, so a failure here is loud;
- that `test-results/browser-matrix/safari-current.json` appears inside the
  uploaded `safari-media-<run_id>` artifact. This one is silent: the upload sets
  `if-no-files-found: ignore`, so a missing file is a successful upload of
  nothing. Nothing downloads that artifact either — the publisher's expected set
  comes from the row matrix, which excludes the runner-provisioned row, so no
  gate reads a Safari report at all. A missing file leaves no trace beyond this
  note.
