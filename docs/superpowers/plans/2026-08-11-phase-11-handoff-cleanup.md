# Phase 11 Handoff Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the four deferred items from the Phase 11 handoff in one risk-ordered TDD phase, before release productization (Phase 12) begins.

**Architecture:** Four isolated fixes, each behind a witnessed red test. Item 1 bounds media requests by default when a clock is present. Item 2 makes a failed generation reject a subsequent `register()` instead of parking it. Item 3 replaces a credential-redaction regex that leaks values past `:` / `=` separators. Item 4 extends the packed type consumer. Each task ends with focused-then-full verification and its own commit.

**Tech Stack:** TypeScript strict ESM, Vitest, FakeClock, tsup. No new runtime dependencies.

## Global Constraints

- Every production change follows a witnessed red test and ends with focused-plus-full verification, matching Plans 01–11 discipline.
- No real-time sleeps; all timer-driven behavior uses the injected `Clock` / `FakeClock`.
- Existing public exports and signatures remain unchanged except the deliberate behavior changes in Items 1 and 2.
- Each task ends with a focused test, full regression (`npm test`), `npm run typecheck`, and a commit.

---

### Task A: Bound media requests by a default deadline when a clock is present

**Files:**
- Modify: `src/media/worker-controller.ts:65-77` (constructor deadline default)
- Test: `test/media/bridge.test.ts` (the `WorkerMediaController bounded lifecycle` describe block)

**Interfaces:**
- Consumes: `WorkerMediaControllerOptions` (`clock?: Clock`, `deadlineMs?: number`), `WorkerMediaController(port, options?)`, `FakeClock` (`advance`, `pending`), and the test helpers `makeBridge`, `firstDelivered`, `expectPending`.
- Produces: when a `Clock` is supplied but `deadlineMs` is omitted/non-finite, pending requests reject with `MediaTimeoutError` after a default of `1000` ms. When no `Clock` is supplied, requests remain unbounded (never timed out).

- [ ] **Step 1: Write the failing tests**

Append to `test/media/bridge.test.ts` inside the `describe('WorkerMediaController bounded lifecycle', ...)` block (after the existing tests):

```ts
it('bounds pending requests by a default deadline when a clock is present but deadlineMs is omitted', async () => {
  const clock = new FakeClock();
  const { controller } = makeBridge({ clock }); // no deadlineMs → default 1000ms
  const offer = controller.createOffer('session-default');
  // Before the default deadline: still pending.
  clock.advance(999);
  await expectPending(offer);
  // At/after 1000ms: rejects with a typed timeout error.
  clock.advance(1);
  await expect(offer).rejects.toBeInstanceOf(MediaTimeoutError);
  await expect(offer).rejects.toThrow(/createOffer.*session-default/);
});

it('keeps media requests unbounded when no clock is present', async () => {
  const { controller } = makeBridge(); // no clock, no deadline
  const offer = controller.createOffer('session-unbounded');
  // No deadline timer exists, so a pending request must not reject on a fake
  // advance — but there is no clock to advance. Assert the pending request
  // stays pending and the controller has no armed timer by closing it.
  await expectPending(offer);
  controller.close();
  await expect(offer).rejects.toThrow(/media port closed/);
  await expect(offer).rejects.not.toBeInstanceOf(MediaTimeoutError);
});
```

> The second test is the integration-path guard: the common `new WorkerMediaController(port)` form (no clock) must stay unbounded, so a future harness that threads a clock into an integration test cannot silently flip the default.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/media/bridge.test.ts -t "default deadline\|unbounded when no clock"`
Expected: FAIL — the first test never rejects (the default is `Infinity`), and the second may pass trivially (it already never times out). The first test is the load-bearing red; the second is a regression guard that passes both before and after.

- [ ] **Step 3: Implement the default deadline**

In `src/media/worker-controller.ts`, change the constructor deadline resolution (lines 69-71):

```ts
    this.clock = options?.clock;
    const configured = options?.deadlineMs;
    // When a clock is present, bound pending requests by a default deadline so
    // a missing media reply rejects in bounded time. Without a clock no timer
    // can be armed, so unbounded remains the only correct value.
    this.deadlineMs =
      this.clock !== undefined && (configured === undefined || !Number.isFinite(configured))
        ? DEFAULT_MEDIA_DEADLINE_MS
        : configured === undefined || !Number.isFinite(configured)
          ? Number.POSITIVE_INFINITY
          : configured;
```

Add a module-level constant near the top of the file (after the imports):

```ts
/** Default deadline (ms) for pending media requests when a clock is present. */
const DEFAULT_MEDIA_DEADLINE_MS = 1000;
```

> `armDeadline` (line ~150) already returns early unless both `this.clock` is defined AND `this.deadlineMs` is finite, so the new default arms a timer only when a clock exists. The `clearDeadline` finalizer is correct either way.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/media/bridge.test.ts`
Expected: PASS — both new tests and the entire existing serialization/bounded-lifecycle suite pass.

- [ ] **Step 5: Full verification**

Run: `npm test`
Expected: all tests pass (including `release-smoke`, which constructs the controller with no clock and stays unbounded).

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/media/worker-controller.ts test/media/bridge.test.ts
git commit -m "fix: bound media requests by default when a clock is present"
```

---

### Task B: Reject `register()` after `registrationFailed` instead of parking it

**Files:**
- Modify: `src/bridge/worker-supervisor.ts` (`register()` at 217-228, `onRegistrationFailed` at 311-323, add a failed-generation field near line 132)
- Test: `test/bridge/worker-supervisor.test.ts` (the `WorkerSupervisor registration failure` describe block at line 372)

**Interfaces:**
- Consumes: `WorkerSupervisor.register(): Promise<void>`, `WorkerRegistrationError`, `WorkerSupervisor.stop()`, `WorkerSupervisor.start()`, and the harness helpers `setup`, `boot`, `expectPending`.
- Produces: after a `registrationFailed` on the current generation, a subsequent `register()` on that same generation rejects immediately with a `WorkerRestartError` (message noting the generation already failed) instead of parking a waiter. A `stop()`/`start()` cycle spawns a fresh generation and `register()` proceeds normally.

- [ ] **Step 1: Write the failing tests**

Append to the `describe('WorkerSupervisor registration failure', ...)` block in `test/bridge/worker-supervisor.test.ts`:

```ts
it('rejects a second register() on the same generation after registrationFailed', async () => {
  const h = setup();
  const gen = h.factory.current.bootstrap?.generation;
  expect(gen).toBe(1);
  const first = h.supervisor.register();
  await expectPending(first);
  h.factory.current.port.deliver({
    type: 'registrationFailed',
    generation: gen!,
    error: { name: 'Error', message: 'authentication failed for [redacted]' },
  });
  await expect(first).rejects.toBeInstanceOf(WorkerRegistrationError);
  // The worker is still alive and heartbeating — but a retry on the same
  // generation must fail loudly, not park a waiter that only resolves on death.
  const second = h.supervisor.register();
  await expect(second).rejects.toBeInstanceOf(WorkerRestartError);
  await expect(second).rejects.toMatchObject({ generation: gen });
});

it('allows register() on a fresh generation after stop/start even if the previous one failed', async () => {
  const h = setup();
  const gen = h.factory.current.bootstrap?.generation;
  expect(gen).toBe(1);
  const first = h.supervisor.register();
  await expectPending(first);
  h.factory.current.port.deliver({
    type: 'registrationFailed',
    generation: gen!,
    error: { name: 'Error', message: 'authentication failed for [redacted]' },
  });
  await expect(first).rejects.toBeInstanceOf(WorkerRegistrationError);
  // stop() then start() spawns a fresh generation (nextGen increments).
  h.supervisor.stop();
  h.supervisor.start();
  expect(h.supervisor.generation).toBeGreaterThan(gen!);
  // A register() on the new generation proceeds normally: parks, then resolves
  // on the new generation's `registered`.
  const retry = h.supervisor.register();
  await expectPending(retry);
  h.factory.current.port.deliver({ type: 'registered', generation: h.supervisor.generation });
  await expect(retry).resolves.toBeUndefined();
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/bridge/worker-supervisor.test.ts -t "second register() after registrationFailed\|fresh generation after stop/start"`
Expected: FAIL — the first test's `second` promise hangs (the waiter parks), so the assertion never fires; the second test's `retry` on the new generation is not affected by the failure state (no guard exists yet).

- [ ] **Step 3: Implement the failed-generation guard**

In `src/bridge/worker-supervisor.ts`:

1. Add a field near the other private state (line ~132, after `restartTimestamps`):

```ts
  /** Generation whose registration failed; a retry on it rejects immediately. */
  private registrationFailedGen = -1;
```

2. In `onRegistrationFailed` (line ~311), set the field before emitting:

```ts
  private onRegistrationFailed(gen: number, cause: SerializedError): void {
    this.registrationFailedGen = gen;
    const error: WorkerRegistrationErrorType = new WorkerRegistrationError(gen, cause);
    // ...(existing rejection loop unchanged)...
  }
```

3. In `register()` (line ~217), add a guard after the `closed` / `not-started` checks:

```ts
    const gen = this.current?.gen ?? 0;
    if (!this.started || gen === 0) {
      return Promise.reject(new WorkerRestartError(gen, 'supervisor not started'));
    }
    if (gen === this.registrationFailedGen) {
      return Promise.reject(new WorkerRestartError(gen, `generation ${gen} already failed to register; stop()/start() to reset`));
    }
    return new Promise<void>((resolve, reject) => {
      this.waiters.add({ gen, resolve, reject });
    });
```

> The stop/start reset works for free: `stop()` drops `current` (→ generation 0) and `start()` calls `spawn()`, which increments `nextGen` to a fresh number (`spawn()` at 231-243). The new generation is never equal to `registrationFailedGen`, so `register()` passes the guard. No explicit reset is required.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/bridge/worker-supervisor.test.ts -t "second register() after registrationFailed\|fresh generation after stop/start"`
Expected: PASS — the second `register()` rejects immediately with `WorkerRestartError`; the stop/start retry resolves on the new generation's `registered`.

- [ ] **Step 5: Full verification**

Run: `npm test`
Expected: all tests pass, including the existing registration-failure and stop/start suites (which this change does not regress).

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/bridge/worker-supervisor.ts test/bridge/worker-supervisor.test.ts
git commit -m "fix: reject register() after registrationFailed instead of parking"
```

---

### Task C: Redact credential values past `:` / `=` separators

**Files:**
- Modify: `src/bridge/worker-runtime.ts:32-39` (`REDACTED`, `CREDENTIAL_PATTERN`, `redactString`)
- Test: `test/bridge/worker-supervisor.test.ts` (the `WorkerRuntime credential redaction` describe block at line 724)

**Interfaces:**
- Consumes: `WorkerRuntime.redact` path exercised indirectly through the existing `WorkerRuntime` + port-capture harness in the redaction describe block (`redactString` is module-private; tests observe redacted errors through `WorkerRuntime`).
- Produces: `CREDENTIAL_PATTERN = /(password|credentials)\s*[:=]?\s*[^,;)}"\s]+/gi` with whole-match replacement `[redacted]`. The credential value (including an internal `:` such as `bob:secret`) is removed; a bare keyword with no value is left unchanged.

- [ ] **Step 1: Add the failing tests**

Append to the `describe('WorkerRuntime credential redaction', ...)` block in `test/bridge/worker-supervisor.test.ts`. These use the same `WorkerRuntimePortCapture` + `WorkerRuntime` harness pattern as the existing test at line 744 — a `UserAgent` whose `register` rejects with a message carrying the credential, run through `WorkerRuntime`, asserting the surfaced error is redacted.

```ts
it('redacts a password value that follows a colon separator', async () => {
  const port = new WorkerRuntimePortCapture();
  const clock = new FakeClock();
  const ua = new UserAgent({
    transport: new FakeTransport({ reliable: true, framing: 'stream' }),
    clock,
    registrarUri: 'sip:r.example.com',
    aor: 'sip:a@example.com',
    contact: '<sip:a@192.0.2.1:5060>',
    credentials: { username: 'alice', password: 'hunter2' },
    idGenerator: makeIdGen(),
  });
  const uaShim = new Proxy(ua, {
    get(target, prop) {
      if (prop === 'register') {
        return () => Promise.reject(new Error('authentication failed for password: hunter2'));
      }
      const value = Reflect.get(target, prop);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const runtime = new WorkerRuntime({ port, buildUserAgent: () => uaShim as unknown as UserAgent });
  const snapshotWithSecret: RegistrationSnapshot = {
    aor: 'sip:a@example.com',
    registrar: 'sip:r.example.com',
    credentials: { username: 'alice', password: 'hunter2' },
    registerExpires: 600,
    contactUri: '<sip:a@192.0.2.1:5060>',
    callId: 'reg-a',
    nextCSeq: 18,
  };
  port.push({ type: 'bootstrap', generation: 1, registration: snapshotWithSecret });
  let error: unknown;
  try {
    await runtime.ready();
  } catch (e) {
    error = e;
  }
  const message = (error as Error).message;
  // The colon-separated secret must be gone, not just the keyword.
  expect(message).not.toContain('hunter2');
  expect(message).toContain('[redacted]');
  runtime.close();
});

it('redacts a credentials value with an internal colon (bob:secret)', async () => {
  const port = new WorkerRuntimePortCapture();
  const clock = new FakeClock();
  const ua = new UserAgent({
    transport: new FakeTransport({ reliable: true, framing: 'stream' }),
    clock,
    registrarUri: 'sip:r.example.com',
    aor: 'sip:a@example.com',
    contact: '<sip:a@192.0.2.1:5060>',
    credentials: { username: 'alice', password: 'x' },
    idGenerator: makeIdGen(),
  });
  const uaShim = new Proxy(ua, {
    get(target, prop) {
      if (prop === 'register') {
        return () => Promise.reject(new Error('stored credentials=bob:secret'));
      }
      const value = Reflect.get(target, prop);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const runtime = new WorkerRuntime({ port, buildUserAgent: () => uaShim as unknown as UserAgent });
  const snapshotWithSecret: RegistrationSnapshot = {
    aor: 'sip:a@example.com',
    registrar: 'sip:r.example.com',
    credentials: { username: 'alice', password: 'x' },
    registerExpires: 600,
    contactUri: '<sip:a@192.0.2.1:5060>',
    callId: 'reg-a',
    nextCSeq: 18,
  };
  port.push({ type: 'bootstrap', generation: 1, registration: snapshotWithSecret });
  let error: unknown;
  try {
    await runtime.ready();
  } catch (e) {
    error = e;
  }
  const message = (error as Error).message;
  expect(message).not.toContain('bob:secret');
  expect(message).not.toContain('secret');
  expect(message).toContain('[redacted]');
  runtime.close();
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/bridge/worker-supervisor.test.ts -t "colon separator\|internal colon"`
Expected: FAIL — the current regex `/(password|credentials)[^,:;)}"]*/gi` stops the value scan at `:` / `=`, so `hunter2` and `secret` remain in the surfaced message.

- [ ] **Step 3: Implement the corrected regex**

In `src/bridge/worker-runtime.ts`, replace the constant and the replacement (lines 32-39):

```ts
/** Redact credentials from any message surfaced by the runtime. */
const REDACTED = '[redacted]';
/**
 * Patterns a credential-bearing field and its value. Consumes the keyword, an
 * optional `:` / `=` / space separator, and the value as a run of characters
 * excluding structural delimiters (`, ; ) } "`) and whitespace. The value may
 * itself contain `:` (e.g. `credentials=bob:secret`), so the scan does not stop
 * at a colon. A bare keyword with no bound value (e.g. `myPassword`) is left
 * unchanged. A value containing whitespace truncates at the first space — the
 * conservative choice to avoid over-redacting following prose.
 */
const CREDENTIAL_PATTERN = /(password|credentials)\s*[:=]?\s*[^,;)}"\s]+/gi;

/** Replace credential-bearing substrings with the redaction token. */
function redactString(value: string): string {
  return value.replace(CREDENTIAL_PATTERN, REDACTED);
}
```

> The replacement is the whole match (`REDACTED`), not `$1: [redacted]` — the old form appended `: [redacted]` after the matched token and left the value in plaintext. The accompanying `carriesCredentials` and `redactOptional` helpers (lines 41-50) are unchanged; they only gate whether `redactString` runs.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/bridge/worker-supervisor.test.ts -t "colon separator\|internal colon\|redacted"`
Expected: PASS — both new tests and the existing redaction tests (the space-separated `password SuperSecret123` form still redacts) pass.

- [ ] **Step 5: Full verification**

Run: `npm test`
Expected: all tests pass.

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/bridge/worker-runtime.ts test/bridge/worker-supervisor.test.ts
git commit -m "fix: redact credential values past : and = separators"
```

---

### Task D: Exercise the media options constructor form in packed consumers

**Files:**
- Modify: `test/package/fixtures/types/index.ts` (media section at lines 367-374)

**Interfaces:**
- Consumes: exports from `sip-worker/media`: `WorkerMediaController` (value), `MediaTimeoutError` (value), `WorkerMediaControllerOptions` (type), `MediaRequestMessage` (type), `MediaPort` (type), `MediaCommand` (type).
- Produces: the packed `types` consumer compiles against the value import of `MediaTimeoutError`, the type imports of `WorkerMediaControllerOptions` and `MediaRequestMessage`, and the two-argument constructor form `new MediaCls(port, opts)`. No source change expected — all symbols are already exported from `src/media/index.ts`.

- [ ] **Step 1: Write the failing fixture changes**

In `test/package/fixtures/types/index.ts`, extend the media imports (lines 107-112). Add `MediaTimeoutError` to the value import and add `WorkerMediaControllerOptions`, `MediaRequestMessage` to the type import:

```ts
import {
  WorkerMediaController as MediaCls,
  StubMainMediaHandler,
  STUB_SDP,
  MediaTimeoutError,
} from 'sip-worker/media';
import type {
  MediaCommand,
  MediaPort,
  MediaReply,
  MediaRequestMessage,
  WorkerMediaControllerOptions,
} from 'sip-worker/media';
```

Then extend the media section (replacing lines 367-374) to reference the value, the two types, and the two-argument constructor form:

```ts
// ---- media ----
void new MediaCls({} as MediaPort);
void new MediaCls({} as MediaPort, {} as WorkerMediaControllerOptions);
void new StubMainMediaHandler({} as MediaPort);
void STUB_SDP;
declare const mediaCmd: MediaCommand;
declare const mediaReply: MediaReply;
declare const mediaReq: MediaRequestMessage;
declare const mediaTimeout: MediaTimeoutError;
declare const mediaOpts: WorkerMediaControllerOptions;
void mediaCmd;
void mediaReply;
void mediaReq;
void mediaTimeout;
void mediaOpts;
```

- [ ] **Step 2: Run the package gate to verify it compiles**

Run: `npm run build && npm run test:package`
Expected: PASS — the fixture compiles against the installed tarball, proving `MediaTimeoutError`, `WorkerMediaControllerOptions`, and `MediaRequestMessage` resolve and the two-argument constructor form type-checks. (If the tarball already exports all three, this step passes immediately; the edit is the regression coverage.)

- [ ] **Step 3: Confirm no source change is needed**

Run: `npm run typecheck`
Expected: clean with no `src/` edits. If the fixture fails to resolve any symbol, add the missing re-export to `src/media/index.ts` and re-run `npm run build` — but per the checked exports, all three are already present, so no change is expected.

- [ ] **Step 4: Commit**

```bash
git add test/package/fixtures/types/index.ts
git commit -m "test: exercise media options constructor form in packed consumers"
```

---

### Task E: Close the Phase 11 handoff in the index and track this phase

**Files:**
- Modify: `docs/superpowers/plans/2026-08-04-sip-worker-index.md` (the Phase 11 Handoff section and the Execution Order)

**Interfaces:**
- Consumes: git history proving items 1–4 of this phase are done.
- Produces: the index no longer lists the four items as deferred, and this plan is added to the Execution Order as a completed entry.

- [ ] **Step 1: Remove the four closed handoff items**

In `docs/superpowers/plans/2026-08-04-sip-worker-index.md`, in the `## Phase 11 Handoff (deferred items)` section, the four items are now closed by Tasks A–D. Replace the section with a note that the cleanup phase closed them, or delete the four bullet items and leave a pointer. Prefer leaving a short pointer:

```markdown
## Phase 11 Handoff (deferred items)

These four items were closed by the [Phase 11 Handoff Cleanup](./2026-08-11-phase-11-handoff-cleanup.md) plan:
1. Media deadline default at the Node composition root — closed (bounded by default when a clock is present).
2. `register()` after `registrationFailed` — closed (rejects immediately; stop/start resets).
3. Credential redaction regex — closed (values past `:` / `=` removed).
4. Package type fixture media overload — closed (two-argument constructor form exercised).
```

- [ ] **Step 2: Add the cleanup plan to the Execution Order**

In the `## Execution Order` list, add an entry after Phase 11 (line 158) and before Phase 12, marked complete:

```markdown
13. [x] [Phase 11 Handoff Cleanup](./2026-08-11-phase-11-handoff-cleanup.md)
14. [ ] [Phase 12 — Release productization](./2026-08-07-12-release-productization.md)
```

Renumber the existing Phase 12 entry from 13 to 14.

- [ ] **Step 3: Verify the docs render**

Read both sections to confirm valid Markdown and that the pointer names the cleanup plan file correctly.

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/plans/
git commit -m "docs: close phase 11 handoff and track cleanup phase"
```

---

## Final Acceptance

Run, in order:

```bash
npm ci
npm run typecheck
npm test
npm run build
npm run test:package
```

Expected: every command exits 0; the release-smoke trace (`registered → inviting → confirmed → terminated → unregistered`) still passes; no new open handles or unhandled rejections; packed ESM/CommonJS/type fixtures resolve, including the new media-overload references (Task D).

## Task Order

A → B → C → D → E