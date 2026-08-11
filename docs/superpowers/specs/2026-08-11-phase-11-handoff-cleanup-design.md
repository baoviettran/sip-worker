# Phase 11 Handoff Cleanup Design

**Goal:** Close the four deferred items from the Phase 11 handoff in one
risk-ordered TDD phase, before release productization (Phase 12) begins.

**Outcome:** Media requests are bounded by a default deadline whenever a clock
is present; a second `register()` after `registrationFailed` fails loudly
instead of hanging; credential redaction emits clean output; and the packed
type consumer exercises the media options overload.

## Scope

Four items, all currently deferred in `docs/superpowers/plans/2026-08-04-sip-worker-index.md`:

1. **Media deadline is opt-in only.** `WorkerMediaController` bounds missing
   replies only when a consumer injects a `Clock` + `deadlineMs`; the default is
   unbounded (`Infinity`).
2. **`register()` after `registrationFailed` parks a waiter.** The worker stays
   alive post-failure, so a subsequent `register()` hangs until heartbeat death
   or `close()`.
3. **Credential redaction regex is cosmetically mangled.**
   `/(password|credentials)[^,:;)}"]*/gi` over-redacts (`myPassword` → `my: [redacted]`)
   and leaves a stray ` : [redacted]` artifact.
4. **Package type fixture doesn't exercise the media options overload.**
   `test/package/fixtures/types/index.ts` constructs `new MediaCls({} as MediaPort)`
   but never references `MediaTimeoutError` / `WorkerMediaControllerOptions` /
   `MediaRequestMessage` or the optional constructor overload.

No new modules, no new runtime dependencies. All edits stay in `src/media/*`,
`src/bridge/*`, `src/ua/*`, `test/*`, and docs.

Residual polish candidates were checked and already closed by the
leftover-hardening phase (shared `cseqMethod`, `contactUri` delegating to
`extractUri`, hash test label). Nothing additional to add.

## Global Constraints

- Every production change follows a witnessed red test and ends with
  focused-plus-full verification, matching Plans 01–11 discipline.
- No real-time sleeps; all timer-driven behavior uses the injected `Clock` /
  `FakeClock`.
- Existing public exports and signatures remain unchanged except the
  deliberate behavior change in Item 1 (documented below).
- Each task ends with a focused test, full regression (`npm test`),
  `npm run typecheck`, and a commit.

---

## Item 1 — Media deadline default (approach B)

### Behavior change

In `WorkerMediaController`'s constructor, when a `Clock` is provided but
`deadlineMs` is omitted or non-finite, use a bounded default of `1000` ms
instead of `Infinity`. When no `Clock` is provided, stay unbounded as today.

### Rationale

`armDeadline` already returns early unless both `clock` is defined AND
`deadlineMs` is finite. So the only state that changes is "clock present +
deadline omitted". Bounding in that state makes the Phase 11 acceptance
("missing media replies reject before a configurable deadline") hold by default
whenever it is *possible* to arm a timer — which is the honest reading of
"wire a default at the Node composition root". With no clock, no timer can arm,
so unbounded remains the only correct value.

### Safety

Every existing test that constructs a controller with a clock passes an
explicit `deadlineMs` (`test/media/bridge.test.ts`), so **no existing test
breaks**. The finalizer (`clearDeadline`) is correct either way.

### Files

- Modify: `src/media/worker-controller.ts` (constructor default)
- Test: `test/media/bridge.test.ts`

### Tests

- A request with clock present and deadline omitted rejects with
  `MediaTimeoutError` after the bounded default (advance `999` → pending,
  advance `1` → rejects).
- A request with no clock remains unbounded: no timer armed, `clock.pending()`
  is `0` (or the equivalent no-timer assertion).

---

## Item 2 — `register()` after `registrationFailed`

### Behavior change

Make a worker generation un-registerable after a registration failure: a
subsequent `register()` on the same generation rejects immediately with a clear
error instead of parking a waiter that only resolves at heartbeat death or
`close()`. A `stop()`/`start()` cycle resets the generation and allows
re-registration.

### Rationale

The deferral note already documents "do not retry `register()` after
`registrationFailed` without a `stop()`/`start()` cycle". Turning that guidance
into a loud, immediate failure is strictly safer than a silent hang and matches
the note's intent.

### Files

- Modify: `src/bridge/worker-supervisor.ts` (and/or `worker-runtime.ts` depending
  on where the generation state lives)
- Test: `test/bridge/worker-supervisor.test.ts`

### Tests

- After `registrationFailed` (worker still alive and heartbeating), a second
  `register()` on the same generation rejects promptly with a clear error.
- A `stop()`/`start()` cycle resets the generation and a subsequent
  `register()` proceeds normally.

---

## Item 3 — Credential redaction regex

### Behavior change

Tighten `WorkerRuntime.redact`'s `CREDENTIAL_PATTERN` so it consumes only the
credential value, not a trailing word, and leaves no stray ` : [redacted]`
artifact. The security property (credential value always removed) is unchanged;
only readability improves.

### Files

- Modify: `src/bridge/worker-runtime.ts` (the `CREDENTIAL_PATTERN` constant and
  `redactString`)
- Test: `test/bridge/worker-runtime.test.ts` (or wherever redaction is tested)

### Tests

- A field named `myPassword` redacts the password value without mangling the
  `my` prefix into `my: [redacted]`.
- `password` and `credentials` values are still fully removed.
- No stray ` : ` artifact remains in the redacted output.

---

## Item 4 — Media-overload package fixture

### Behavior change

Extend `test/package/fixtures/types/index.ts` to exercise the media API surface
the fixture currently skips: `MediaTimeoutError`, `WorkerMediaControllerOptions`,
`MediaRequestMessage`, and the optional-constructor overload. Test-only,
additive; no source change expected.

### Files

- Modify: `test/package/fixtures/types/index.ts`

### Tests

- The `types` fixture compiles against the new references.
- `npm run test:package` passes (ESM, CommonJS, and types consumers).

---

## Task Order & Commits

A. **Media deadline default** — `fix: bound media requests by default when a clock is present`
B. **Post-`registrationFailed` register()** — `fix: reject register() after registrationFailed instead of parking`
C. **Redaction regex** — `fix: scope credential redaction to the value, not a trailing word`
D. **Media-overload package fixture** — `test: exercise media options overload in packed consumers`
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