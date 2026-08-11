# Phase 11 Handoff Cleanup Design

**Goal:** Close the four deferred items from the Phase 11 handoff in one
risk-ordered TDD phase, before release productization (Phase 12) begins.

**Outcome:** Media requests are bounded by a default deadline whenever a clock
is present; a second `register()` after `registrationFailed` fails loudly
instead of hanging; credential redaction removes the credential value (closing a
real disclosure gap, not a cosmetic one); and the packed type consumer exercises
the media options constructor form.

## Scope

Four items, all currently deferred in `docs/superpowers/plans/2026-08-04-sip-worker-index.md`:

1. **Media deadline is opt-in only.** `WorkerMediaController` bounds missing
   replies only when a consumer injects a `Clock` + `deadlineMs`; the default is
   unbounded (`Infinity`).
2. **`register()` after `registrationFailed` parks a waiter.** The worker stays
   alive post-failure, so a subsequent `register()` hangs until heartbeat death
   or `close()`.
3. **Credential redaction regex leaks values.**
   `/(password|credentials)[^,:;)}"]*/gi` over-redacts (`myPassword` →
   `myPassword: [redacted]`) and, more seriously, **leaves credential values in
   plaintext past `:` / `=` separators** (`password: hunter2` →
   `password: [redacted]: hunter2`; `credentials=bob:secret` →
   `credentials: [redacted]:secret`). This is a correctness bug, not cosmetic.
4. **Package type fixture doesn't exercise the media options constructor form.**
   `test/package/fixtures/types/index.ts` constructs `new MediaCls({} as MediaPort)`
   but never references `MediaTimeoutError` / `WorkerMediaControllerOptions` /
   `MediaRequestMessage` or the two-argument constructor form.

No new modules, no new runtime dependencies. All edits stay in `src/media/*`,
`src/bridge/*`, `test/*`, and docs.

Residual polish candidates were checked and already closed by the
leftover-hardening phase (shared `cseqMethod`, `contactUri` delegating to
`extractUri`, hash test label). Nothing additional to add.

## Global Constraints

- Every production change follows a witnessed red test and ends with
  focused-plus-full verification, matching Plans 01–11 discipline.
- No real-time sleeps; all timer-driven behavior uses the injected `Clock` /
  `FakeClock`.
- Existing public exports and signatures remain unchanged except the
  deliberate behavior changes in Items 1 and 2 (documented below).
- Each task ends with a focused test, full regression (`npm test`),
  `npm run typecheck`, and a commit.

---

## Item 1 — Media deadline default (approach B)

### Behavior change

In `WorkerMediaController`'s constructor, when a `Clock` is provided but
`deadlineMs` is omitted or non-finite, use a bounded default of `1000` ms
instead of `Infinity`. When no `Clock` is provided, stay unbounded as today.

### Rationale

`armDeadline` (`src/media/worker-controller.ts`) already returns early unless
both `clock` is defined AND `deadlineMs` is finite. So the only state that
changes is "clock present + deadline omitted". Bounding in that state makes the
Phase 11 acceptance ("missing media replies reject before a configurable
deadline") hold by default whenever it is *possible* to arm a timer — the honest
reading of "wire a default at the Node composition root". With no clock, no
timer can arm, so unbounded remains the only correct value.

### Safety

Verified: every `new WorkerMediaController(...)` outside `test/media/bridge.test.ts`
(`test/integration/release-smoke.test.ts:89`, `test/ua/inviter.test.ts:137`,
`test/ua/invitation.test.ts:107`, `test/ua/user-agent.test.ts:127`) is
constructed **without a clock**, so approach B's default never activates there.
The `bridge.test.ts` constructions that pass a clock always pass an explicit
`deadlineMs`. **No existing test breaks.** The finalizer (`clearDeadline`) is
correct either way.

### Files

- Modify: `src/media/worker-controller.ts` (constructor default)
- Test: `test/media/bridge.test.ts`

### Tests

- A request with clock present and deadline omitted rejects with
  `MediaTimeoutError` after the bounded default (advance `999` → pending,
  advance `1` → rejects).
- A request with no clock remains unbounded: no timer armed, advancing a
  `FakeClock` does not reject the pending request (the integration-path guard —
  asserts the common `new WorkerMediaController(port)` form stays unbounded so a
  future regression that threads a clock into an integration harness cannot
  silently flip the default).

---

## Item 2 — `register()` after `registrationFailed`

### Behavior change

Make a worker generation un-registerable after a registration failure: a
subsequent `register()` on the same generation rejects immediately with a clear
error instead of parking a waiter that only resolves at heartbeat death or
`close()`. A `stop()`/`start()` cycle resets the generation and allows
re-registration.

### Mechanism

Generation state, the waiter set, and `register()` all live in
`src/bridge/worker-supervisor.ts` (`register()` at 217–228, the `waiters` set
at 127, `onRegistrationFailed` at 311–323). `worker-runtime.ts` is not involved.

Track the failed generation: add a `registrationFailedGen: number` field (or a
`Set<number>`) set in `onRegistrationFailed`. In `register()`, after the
existing `closed` / `not-started` guards, reject immediately when
`this.current?.gen === this.registrationFailedGen`.

The stop/start reset works for free: `stop()` drops `current` (→ generation 0)
and `start()` calls `spawn()`, which increments `nextGen` to a **fresh
generation number** (worker-supervisor.ts:232–233). The new generation is never
equal to the stored failed gen, so `register()` proceeds normally. No explicit
reset of the failed-gen field is required, though clearing it in `stop()` is
fine for tidiness.

### Files

- Modify: `src/bridge/worker-supervisor.ts`
- Test: `test/bridge/worker-supervisor.test.ts`

### Tests

- After `registrationFailed` (worker still alive and heartbeating), a second
  `register()` on the same generation rejects promptly with a clear error (not a
  hang).
- A `stop()`/`start()` cycle spawns a fresh generation and a subsequent
  `register()` proceeds normally (resolves on `registered`).

---

## Item 3 — Credential redaction regex

### Behavior change

Replace `CREDENTIAL_PATTERN` in `src/bridge/worker-runtime.ts:34` so it removes
the credential **value**, not just the keyword tail. The current
`/(password|credentials)[^,:;)}"]*/gi` with replacement `$1: [redacted]` appends
`: [redacted]` after the matched token and stops the value scan at `:` / `=`,
leaving the real secret in plaintext past the separator.

### Verified replacement

```ts
const CREDENTIAL_PATTERN = /(password|credentials)\s*[:=]?\s*[^,;)}"\s]+/gi;
// replacement: '[redacted]'  (whole match → token, not $1: token)
```

This consumes the keyword, an optional `:` / `=` / space separator, and the
value as a run of characters excluding structural delimiters (`, ; ) } "`) and
whitespace. Verified against the case set:

| Input | Current (buggy) | Fixed |
|---|---|---|
| `password: hunter2` | `password: [redacted]: hunter2` (leaks) | `[redacted]` |
| `password=hunter2` | `password: [redacted]` (leaks `hunter2`? — keeps `$1` only) | `[redacted]` |
| `credentials=bob:secret` | `credentials: [redacted]:secret` (leaks `secret`) | `[redacted]` |
| `credentials: bob:secret` | `credentials: [redacted]:secret` (leaks) | `[redacted]` |
| `authentication failed for password SuperSecret123` | `authentication failed for password: [redacted]` (leaks) | `authentication failed for [redacted]` |
| `myPassword` | `myPassword: [redacted]` (mangled) | `myPassword` (left alone — no value bound) |
| `password: p1, password: p2` | `password: [redacted], password: [redacted]` (leaks both) | `[redacted], [redacted]` |

The existing test (`worker-supervisor.test.ts:744`) uses the space-separated
form `password SuperSecret123`, which the current regex removes by luck (space
is in its scan class). The `:` / `=` leak is **currently untested** — the new
tests close that.

### Known limitation

A credential value containing whitespace (e.g. `password: my secret`) truncates
at the first space (`[redacted] secret`). This is the conservative choice:
consuming arbitrary following prose after a non-binding gap would over-redact
unrelated text. A sentence like `the credentials are bob:hunter2` (two-word gap,
no binding separator) leaves `bob:hunter2` in place — no regex can distinguish a
bound field value from following prose without a binding `:` / `=` / immediate
space. Document this; do not attempt to close it.

### Files

- Modify: `src/bridge/worker-runtime.ts` (`CREDENTIAL_PATTERN` and the
  `redactString` replacement)
- Test: `test/bridge/worker-supervisor.test.ts` (`describe('WorkerRuntime
  credential redaction')` block at line 724)

### Tests

- `password: hunter2` → `[redacted]` (the secret value is gone).
- `credentials=bob:secret` → `[redacted]` (internal `:` consumed; `secret` gone).
- `myPassword` (bare, no separator/value) → unchanged (no `: [redacted]`
  artifact appended).
- The existing space-separated case still redacts: `password SuperSecret123`
  → contains `[redacted]`, not `SuperSecret123`.
- No stray ` : ` artifact remains in any redacted output.

---

## Item 4 — Media-overload package fixture

### Behavior change

Extend `test/package/fixtures/types/index.ts` to exercise the media API surface
the fixture currently skips: `MediaTimeoutError` (value), `WorkerMediaControllerOptions`
and `MediaRequestMessage` (types), and the two-argument constructor form
`new MediaCls(port, options)`. Test-only, additive; no source change expected
(all referenced symbols are already exported from `src/media/index.ts`).

### Files

- Modify: `test/package/fixtures/types/index.ts`

### Tests

- The `types` fixture compiles against the new references (the value import of
  `MediaTimeoutError`, the type imports of `WorkerMediaControllerOptions` and
  `MediaRequestMessage`, and the `new MediaCls(port, opts)` call).
- `npm run test:package` passes (ESM, CommonJS, and types consumers).

---

## Task Order & Commits

A. **Media deadline default** — `fix: bound media requests by default when a clock is present`
B. **Post-`registrationFailed` register()** — `fix: reject register() after registrationFailed instead of parking`
C. **Redaction regex** — `fix: redact credential values past : and = separators`
D. **Media-overload package fixture** — `test: exercise media options constructor form in packed consumers`
E. **Docs drift** — close the four handoff items in the index, add this phase —
   `docs: close phase 11 handoff and track cleanup phase`

## Final Acceptance

```bash
npm ci
npm run typecheck
npm test
npm run build
npm run test:package
```

Expected: every command exits 0; the release-smoke trace
(`registered → inviting → confirmed → terminated → unregistered`) still passes;
no new open handles or unhandled rejections; packed ESM/CommonJS/type fixtures
resolve, including the new media-overload references.
