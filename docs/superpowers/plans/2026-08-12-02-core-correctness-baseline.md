# Milestone 1 — 0.2.x Core Correctness Baseline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce a trustworthy 0.2.0 signaling baseline by fixing every confirmed whole-library review defect, establishing stable machine-readable errors, and proving lifecycle cleanup before package extraction or WebRTC work begins.

**Architecture:** Keep the current single-package layout throughout this milestone. Add a small shared error-code contract first, then repair each ownership boundary in place: authentication state, supervisor generations, registrar refreshes, UserAgent connection/call events, UDP peer validation, and observer fan-out. Finish by aligning the release documents and packed API with the verified implementation.

**Tech Stack:** TypeScript 5.x strict ESM, Vitest 2.x, injected `Clock`, tsup, Node 20/22, npm packed-consumer fixtures.

## Global Constraints

- Do not extract `@sip-worker/core`, `sip-worker`, or `@sip-worker/node` in this milestone; package separation begins in 0.3.x.
- Preserve zero import-time side effects and the injected environment boundaries.
- Preserve the `Uint8Array` transport boundary and deterministic injected-clock tests.
- Every public operation must settle exactly once at its documented protocol or lifecycle outcome.
- Every timer, listener, transaction subscription, deferred operation, worker generation, and media session must have one terminal cleanup path.
- Event observers must not corrupt committed protocol state or prevent internal subscribers from running.
- Public failures introduced or modified here must carry a stable `SipErrorCode` value.
- Write a failing regression before changing production code for each defect.
- Do not weaken or delete an existing assertion to make a regression pass.
- Do not add real WebRTC, package workspaces, browser reconnection policy, or new product features; those belong to later roadmap milestones.
- Each task ends with its focused tests, `npm run typecheck`, and a review-sized commit.

---

## File Structure

### New files

- `src/error-codes.ts` — stable `SipErrorCode` string union used by public library errors.
- `test/errors.test.ts` — constructor and export contract for coded errors.

### Existing files changed by responsibility

- `src/errors.ts`, `src/error-codes.ts`, `src/index.ts`, public operation sites, and their tests — coded error implementation, operational classification, and packed public surface.
- `src/auth/manager.ts`, `test/auth/manager.test.ts` — RFC hexadecimal Digest nonce count.
- `src/bridge/worker-supervisor.ts`, `test/bridge/worker-supervisor.test.ts` — stop/start generation ownership and waiter settlement.
- `src/ua/registrar.ts`, `src/ua/user-agent.ts`, `test/ua/registrar.test.ts`, `test/ua/user-agent.test.ts` — background refresh reporting, concurrent connect ownership, and no-media INVITE rejection.
- `src/ua/events.ts`, `src/ua/index.ts`, `src/ua/invitation.ts`, `src/ua/session.ts`, `test/package/fixtures/types/index.ts`, `test/ua/user-agent.test.ts` — truthful public call/registration event API.
- `src/transport/node/udp.ts`, `test/transport/node-udp.test.ts` — resolved UDP peer identity.
- `src/transport/node/tcp.ts`, `src/transport/node/udp.ts`, `src/transport/node/ws.ts`, `src/transport/browser/ws.ts`, `src/ua/events.ts`, `test/transport/*.test.ts`, `test/ua/user-agent.test.ts` — observer isolation.
- `test/support/fake-clock.ts`, `test/support/fake-transport.ts`, lifecycle tests — observable resource counts and repeated-cycle assertions.
- `package.json`, `package-lock.json`, `README.md`, `SECURITY.md`, `CHANGELOG.md`, `docs/2026-08-11-production-readiness-review.md`, `docs/superpowers/plans/2026-08-04-sip-worker-index.md` — verified 0.2.0 status and roadmap linkage.

---

### Task 1: Stable public error codes

**Files:**
- Create: `src/error-codes.ts`
- Create: `test/errors.test.ts`
- Modify: `src/errors.ts:1-9`
- Modify: `src/index.ts:1`
- Modify: `test/package/fixtures/types/index.ts:5-40`
- Modify: `src/auth/manager.ts`, `src/ua/registrar.ts`, `src/ua/user-agent.ts`, `src/ua/inviter.ts`, `src/ua/invitation.ts`, `src/ua/dialog-set.ts`
- Modify: `src/media/worker-controller.ts`, `src/bridge/worker-protocol.ts`
- Modify: `test/auth/manager.test.ts`, `test/ua/registrar.test.ts`, `test/ua/user-agent.test.ts`, `test/ua/inviter.test.ts`, `test/ua/invitation.test.ts`, `test/media/bridge.test.ts`, `test/bridge/worker-supervisor.test.ts`

**Interfaces:**
- Consumes: existing `SipError`, `ParseError`, and `TransportError` constructors.
- Produces:

```ts
export type SipErrorCode =
  | 'AUTHENTICATION_FAILED'
  | 'AUTHENTICATION_UNSUPPORTED'
  | 'CALL_FAILED'
  | 'CONNECTION_FAILED'
  | 'INVALID_STATE'
  | 'LIFECYCLE_ABORTED'
  | 'MEDIA_UNAVAILABLE'
  | 'PROTOCOL_ERROR'
  | 'REGISTRATION_FAILED'
  | 'TIMEOUT'
  | 'TRANSPORT_FAILED'
  | 'WORKER_CLOSED'
  | 'WORKER_REGISTRATION_FAILED'
  | 'WORKER_RESTARTED';

export class SipError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
    readonly code: SipErrorCode = 'PROTOCOL_ERROR',
    options?: ErrorOptions,
  );
}

export class ParseError extends Error {
  readonly code = 'PROTOCOL_ERROR' as const;
}

export class TransportError extends Error {
  readonly code = 'TRANSPORT_FAILED' as const;
}
```

- Backward compatibility: existing two-argument `new SipError(statusCode, message)` and two-argument `new TransportError(message, cause)` calls continue to compile and behave as before.

- [ ] **Step 1: Write the failing runtime and type tests**

Create `test/errors.test.ts`:

```ts
import { describe, expect, expectTypeOf, it } from 'vitest';
import { ParseError, SipError, TransportError } from '../src/errors.js';
import type { SipErrorCode } from '../src/error-codes.js';

describe('public error codes', () => {
  it('assigns stable default and explicit codes without breaking old constructors', () => {
    expect(new SipError(486, 'Busy').code).toBe('PROTOCOL_ERROR');
    expect(new SipError(0, 'closed', 'LIFECYCLE_ABORTED').code).toBe('LIFECYCLE_ABORTED');
    expect(new ParseError(4, 'bad').code).toBe('PROTOCOL_ERROR');
    expect(new TransportError('down').code).toBe('TRANSPORT_FAILED');
  });

  it('retains a standard Error cause on coded SipError values', () => {
    const cause = new Error('socket');
    expect(new SipError(0, 'registration failed', 'REGISTRATION_FAILED', { cause }).cause).toBe(cause);
  });

  it('exports a closed code union', () => {
    expectTypeOf<'TIMEOUT'>().toMatchTypeOf<SipErrorCode>();
    // @ts-expect-error arbitrary strings are not public error codes
    const invalid: SipErrorCode = 'anything';
    void invalid;
  });
});
```

In `test/package/fixtures/types/index.ts`, import `TransportError` as a value and
`SipErrorCode` as a type from `sip-worker`, then add:

```ts
const code: SipErrorCode = 'REGISTRATION_FAILED';
void new SipError(0, 'failed', code);
void new TransportError('transport failed');
```

- [ ] **Step 2: Run the focused tests to verify red**

Run:

```bash
npx vitest run test/errors.test.ts
npm run typecheck
```

Expected: FAIL because `src/error-codes.ts` and `.code` do not exist.

- [ ] **Step 3: Implement the coded error contract**

Create `src/error-codes.ts` with the exact union in the Interfaces block. Update
`src/errors.ts`:

```ts
import type { SipErrorCode } from './error-codes.js';

export class SipError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
    readonly code: SipErrorCode = 'PROTOCOL_ERROR',
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'SipError';
  }
}

export class ParseError extends Error {
  readonly code = 'PROTOCOL_ERROR' as const;
  constructor(readonly offset: number, message: string) {
    super(message);
    this.name = 'ParseError';
  }
}

export class TransportError extends Error {
  readonly code = 'TRANSPORT_FAILED' as const;
  constructor(message: string, readonly cause?: unknown) {
    super(message, { cause });
    this.name = 'TransportError';
  }
}
```

Export `SipErrorCode` from `src/index.ts`:

```ts
export type { SipErrorCode } from './error-codes.js';
```

- [ ] **Step 4: Classify existing public failure paths**

Replace default-coded operational failures with the following stable mapping. Preserve
status codes, messages, and causes; this task adds machine-readable meaning without
changing control flow.

| Failure path | Code |
|---|---|
| malformed SIP or Digest input | `PROTOCOL_ERROR` |
| unsupported Digest algorithm or qop | `AUTHENTICATION_UNSUPPORTED` |
| missing credentials or exhausted authentication budget | `AUTHENTICATION_FAILED` |
| disposed UA, registrar, inviter, or invitation | `LIFECYCLE_ABORTED` |
| duplicate or illegal operation for the current state | `INVALID_STATE` |
| transport disconnect or transaction transport error | `TRANSPORT_FAILED` |
| registrar final rejection | `REGISTRATION_FAILED` |
| INVITE, CANCEL, ACK, or BYE failure | `CALL_FAILED` |
| transaction or media deadline | `TIMEOUT` |
| closed media port, media reply error, or media post failure | `MEDIA_UNAVAILABLE` |

Add `readonly code` to `MediaTimeoutError`, `WorkerRestartError`,
`WorkerRegistrationError`, and `WorkerClosedError` using `TIMEOUT`,
`WORKER_RESTARTED`, `WORKER_REGISTRATION_FAILED`, and `WORKER_CLOSED`
respectively. Use coded `SipError` values for other media failures. Wrap an unknown
connection-composition failure as `CONNECTION_FAILED`, but preserve an existing
`TransportError` or coded `SipError` unchanged.

Extend representative existing tests so they assert codes for: unsupported and
exhausted authentication, registrar rejection and transport loss, disposed and
illegal call operations, an INVITE rejection, media timeout and closed-port failure,
and all three worker error classes.

- [ ] **Step 5: Run focused and regression verification**

Run:

```bash
npx vitest run test/errors.test.ts
npm run typecheck
npm run test:package
npm test
```

Expected: all commands exit 0; the full suite still reports 41 or more passing
test files and no failures.

- [ ] **Step 6: Commit**

```bash
git add src/error-codes.ts src/errors.ts src/index.ts src/auth/manager.ts src/ua/registrar.ts src/ua/user-agent.ts src/ua/inviter.ts src/ua/invitation.ts src/ua/dialog-set.ts src/media/worker-controller.ts src/bridge/worker-protocol.ts test/errors.test.ts test/auth/manager.test.ts test/ua/registrar.test.ts test/ua/user-agent.test.ts test/ua/inviter.test.ts test/ua/invitation.test.ts test/media/bridge.test.ts test/bridge/worker-supervisor.test.ts test/package/fixtures/types/index.ts
git commit -m "feat: add stable public error codes"
```

---

### Task 2: RFC-compliant Digest nonce counts

**Files:**
- Modify: `src/auth/manager.ts:326-336`
- Modify: `test/auth/manager.test.ts:402-445`

**Interfaces:**
- Consumes: `AuthManager.retry(context): SipRequestMessage | AuthFailure`.
- Produces: the Digest `nc` field is exactly eight lowercase hexadecimal digits; values 1, 9, 10, 15, and 16 render as `00000001`, `00000009`, `0000000a`, `0000000f`, and `00000010`.

- [ ] **Step 1: Add the failing tenth-use regression**

Append under `AuthManager state bounding`:

```ts
it('renders nonce-count as eight hexadecimal digits after nine uses', () => {
  const f = fixture();
  const manager = new AuthManager(f.ids());
  const headers = buildResponseHeaders(REALM, 'reused-nonce');
  const counts: string[] = [];

  for (let index = 1; index <= 16; index += 1) {
    const result = manager.retry(f.context({
      requestId: `hex-${index}`,
      response: makeResponse(401, 'Unauthorized', headers),
    })) as SipRequestMessage;
    counts.push(result.headers.get('Authorization')!.match(/nc=([0-9a-f]{8})/)![1]!);
  }

  expect(counts[8]).toBe('00000009');
  expect(counts[9]).toBe('0000000a');
  expect(counts[14]).toBe('0000000f');
  expect(counts[15]).toBe('00000010');
});
```

- [ ] **Step 2: Run the regression to verify red**

Run:

```bash
npx vitest run test/auth/manager.test.ts -t "hexadecimal digits"
```

Expected: FAIL because the tenth count is `00000010` instead of `0000000a`.

- [ ] **Step 3: Implement hexadecimal formatting**

In `nextNonceCount`, replace the return expression with:

```ts
return next.toString(16).padStart(8, '0');
```

- [ ] **Step 4: Run focused tests and typecheck**

Run:

```bash
npx vitest run test/auth/manager.test.ts test/auth/digest.test.ts test/auth/authorization.test.ts
npm run typecheck
```

Expected: all commands exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/auth/manager.ts test/auth/manager.test.ts
git commit -m "fix: encode digest nonce counts as hexadecimal"
```

---

### Task 3: Worker supervisor stop ownership

**Files:**
- Modify: `src/bridge/worker-supervisor.ts:165-187,404-412`
- Modify: `test/bridge/worker-supervisor.test.ts:300-450`

**Interfaces:**
- Consumes: `WorkerSupervisor.start()`, `stop()`, `close()`, and `register()`.
- Produces: `stop()` rejects every waiter owned by the stopped generation with `WorkerRestartError(generation, 'worker supervisor stopped')`, detaches and terminates that generation exactly once, clears timers, and permits `start()` to spawn a fresh generation.
- `close()` after `stop()` remains idempotent and does not terminate the already-stopped worker twice.

- [ ] **Step 1: Add failing stop/waiter/worker tests**

Add to `test/bridge/worker-supervisor.test.ts`:

```ts
it('rejects pending register waiters and terminates the generation on stop', async () => {
  const h = setup();
  h.supervisor.start();
  const generation = h.supervisor.generation;
  const worker = h.factory.current;
  const pending = h.supervisor.register();

  h.supervisor.stop();

  await expect(pending).rejects.toMatchObject({
    name: 'WorkerRestartError',
    generation,
    message: 'worker supervisor stopped',
  });
  expect(worker.terminated).toBe(true);
  expect(worker.port.listenerCount).toBe(0);
  expect(h.factory.terminated).toBe(1);
  expect(h.clock.pending()).toBe(0);
});

it('starts a fresh generation after stop without retaining old waiters', async () => {
  const h = setup();
  h.supervisor.start();
  const oldWaiter = h.supervisor.register();
  h.supervisor.stop();
  await expect(oldWaiter).rejects.toBeInstanceOf(WorkerRestartError);

  h.supervisor.start();
  const generation = h.supervisor.generation;
  const next = h.supervisor.register();
  h.factory.current.port.deliver({ type: 'registered', generation });
  await expect(next).resolves.toBeUndefined();
  expect(h.factory.count).toBe(2);

  h.supervisor.close();
  expect(h.factory.terminated).toBe(2);
});
```

- [ ] **Step 2: Run the stop regressions to verify red**

Run:

```bash
npx vitest run test/bridge/worker-supervisor.test.ts -t "terminates the generation on stop|fresh generation after stop"
```

Expected: FAIL because the old worker is not terminated and the first waiter remains pending.

- [ ] **Step 3: Implement generation teardown on stop**

Change `stop()` to capture the live generation, detach it, terminate it, clear the
reference, and reject only that generation's waiters:

```ts
stop(): void {
  if (!this.started) return;
  this.started = false;
  this.clearPing();
  this.clearDeadline();
  this.outstandingNonce = undefined;

  const current = this.current;
  this.current = undefined;
  if (current !== undefined) {
    current.detach();
    current.worker.terminate();
    this.rejectGenerationWaiters(
      current.gen,
      new WorkerRestartError(current.gen, 'worker supervisor stopped'),
    );
  }
  this.restartTimestamps.length = 0;
}
```

Extract the repeated generation rejection loop from `death()` into:

```ts
private rejectGenerationWaiters(gen: number, error: WorkerRestartErrorType): void {
  const toReject = [...this.waiters].filter((waiter) => waiter.gen === gen);
  for (const waiter of toReject) {
    this.waiters.delete(waiter);
    waiter.reject(error);
  }
}
```

Use this helper from both `stop()` and `death()`.

- [ ] **Step 4: Run bridge tests and typecheck**

Run:

```bash
npx vitest run test/bridge/worker-supervisor.test.ts test/integration/worker-recovery.test.ts
npm run typecheck
```

Expected: all commands exit 0; all worker lifecycle tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/bridge/worker-supervisor.ts test/bridge/worker-supervisor.test.ts
git commit -m "fix: settle supervisor generations on stop"
```

---

### Task 4: Observable background registration refresh failures

**Files:**
- Modify: `src/ua/registrar.ts:19-49,118-134,404-410`
- Modify: `src/ua/user-agent.ts:201-216`
- Modify: `test/ua/registrar.test.ts:498-515`
- Modify: `test/ua/user-agent.test.ts:300-410`

**Interfaces:**
- Consumes: `RegistrarOptions` and `Registrar.register()`.
- Produces: optional `RegistrarOptions.onBackgroundFailure?: (error: Error) => void`.
- A scheduled refresh always attaches a rejection handler. Its failure changes registrar state to `failed` and calls `onBackgroundFailure` exactly once; no rejected refresh promise is left unobserved.
- `UserAgent` maps that callback to its public `failed` event with the current registration identity.

- [ ] **Step 1: Add failing Registrar refresh failure test**

Extend the registrar test harness options with an `onBackgroundFailure` callback,
then add:

```ts
it('reports a scheduled refresh failure through the background callback', async () => {
  const failures: Error[] = [];
  const h = setup({ onBackgroundFailure: (error) => failures.push(error) });
  await completeRegister(h, [{ status: 200, over: { expires: '2' } }]);

  h.clock.advance(1000);
  await flush();
  h.clock.advance(32000);
  await flush();

  expect(h.registrar.state).toBe('failed');
  expect(failures).toHaveLength(1);
  expect(failures[0]).toMatchObject({ code: 'REGISTRATION_FAILED' });
});
```

- [ ] **Step 2: Add failing UserAgent propagation test**

Add a UA test that connects and completes a 2-second registration, advances to
the refresh and transaction timeout, and records `failed` events:
First extend `respondTo` with `expires?: string`; when present, set the response
`Expires` header before serializing the response.

```ts
options: { challenge?: boolean; contact?: string; expires?: string } = {},
// after Contact handling
if (options.expires !== undefined) headers.set("Expires", options.expires);
```

```ts
it('emits failed when an automatic registration refresh fails', async () => {
  const { ua, transport, clock } = setup();
  const failures: Error[] = [];
  ua.on('failed', (event) => failures.push(event.error));
  await ua.connect();

  const registration = ua.register();
  await flush();
  const request = lastRequest(transport, 'REGISTER');
  respondTo(transport, request, 200, { expires: '2' });
  await registration;

  clock.advance(1000);
  await flush();
  clock.advance(32000);
  await flush();

  expect(failures).toContainEqual(expect.objectContaining({ code: 'REGISTRATION_FAILED' }));
  await ua.disconnect();
});
```

The explicit `Expires: 2` response and default `refreshFraction: 0.5` make the
refresh fire at exactly 1,000 ms; the subsequent 32,000 ms crosses Timer F.

- [ ] **Step 3: Run focused tests to verify red**

Run:

```bash
npx vitest run test/ua/registrar.test.ts -t "background callback"
npx vitest run test/ua/user-agent.test.ts -t "automatic registration refresh fails"
```

Expected: FAIL because `RegistrarOptions` has no callback and the refresh rejection is not forwarded.

- [ ] **Step 4: Implement owned refresh rejection handling**

Add to `RegistrarOptions` and `Registrar`:

```ts
readonly onBackgroundFailure?: (error: Error) => void;
```

Store it with a no-op default. Replace the timer callback with:

```ts
this.refreshTimer = this.clock.setTimeout(() => {
  if (this.stateValue !== 'registered' || this.disposed) return;
  void this.register().catch((reason: unknown) => {
    const error = reason instanceof Error
      ? new SipError(0, reason.message, 'REGISTRATION_FAILED', { cause: reason })
      : new SipError(0, String(reason), 'REGISTRATION_FAILED');
    try {
      this.onBackgroundFailure(error);
    } catch {
      // A reporting observer cannot create a second unhandled rejection.
    }
  });
}, this.refreshMs * 1000);
```

Pass the callback from `UserAgent.connect()`:

```ts
onBackgroundFailure: (error) => this.emit('failed', {
  type: 'failed',
  error,
  identity: this.identity ?? { callId: '', nextCSeq: 1 },
}),
```

- [ ] **Step 5: Run focused tests and typecheck**

Run:

```bash
npx vitest run test/ua/registrar.test.ts test/ua/user-agent.test.ts test/integration/registration.test.ts
npm run typecheck
```

Expected: all commands exit 0 with no unhandled-rejection warning.

- [ ] **Step 6: Commit**

```bash
git add src/ua/registrar.ts src/ua/user-agent.ts test/ua/registrar.test.ts test/ua/user-agent.test.ts
git commit -m "fix: report automatic registration refresh failures"
```

---

### Task 5: Concurrent UserAgent connection ownership

**Files:**
- Modify: `src/ua/user-agent.ts:83-100,151-224,350-393`
- Modify: `test/ua/user-agent.test.ts:67-95,300-430`

**Interfaces:**
- Consumes: `UserAgent.connect(): Promise<void>` and `disconnect(): Promise<void>`.
- Produces: one private `connectPromise?: Promise<void>` representing the only active composition attempt. Concurrent callers receive the same promise object; composition occurs once; a failure clears the slot for diagnostic consistency but the one-shot transport still determines whether a later attempt can succeed.

- [ ] **Step 1: Make the delayed transport count connection calls**

Add to `DelayedConnectTransport`:

```ts
connectCalls = 0;

override async connect(): Promise<void> {
  this.connectCalls += 1;
  await new Promise<void>((resolve) => {
    this.release = resolve;
  });
  await super.connect();
}
```

- [ ] **Step 2: Add the failing concurrent-connect regression**

```ts
it('shares one promise and composes one stack across concurrent connect calls', async () => {
  const transport = new DelayedConnectTransport({ reliable: true, framing: 'stream' });
  const liveness = new RecordingLiveness();
  const { ua } = setup({ transport, liveness });

  const first = ua.connect();
  const second = ua.connect();

  expect(second).toBe(first);
  expect(transport.connectCalls).toBe(1);
  transport.releaseConnect();
  await Promise.all([first, second]);
  expect(liveness.calls).toEqual(['start']);

  await ua.disconnect();
  expect(liveness.calls).toEqual(['start', 'stop']);
});
```

- [ ] **Step 3: Run the regression to verify red**

Run:

```bash
npx vitest run test/ua/user-agent.test.ts -t "concurrent connect calls"
```

Expected: FAIL because the two async wrapper promises differ and the setup path can run twice.

- [ ] **Step 4: Implement one shared connect promise**

Change `connect()` from an `async` method into a promise-returning guard:

```ts
connect(): Promise<void> {
  if (this.disconnected) {
    return Promise.reject(new SipError(0, 'UserAgent has been disconnected', 'LIFECYCLE_ABORTED'));
  }
  if (this.connected) return Promise.resolve();
  if (this.connectPromise !== undefined) return this.connectPromise;

  const attempt = this.connectOnce();
  this.connectPromise = attempt;
  void attempt.then(
    () => {
      if (this.connectPromise === attempt) this.connectPromise = undefined;
    },
    () => {
      if (this.connectPromise === attempt) this.connectPromise = undefined;
    },
  );
  return attempt;
}
```

Move the existing body into `private async connectOnce(): Promise<void>`. Keep
the existing disconnect-wins checks. Do not add a second composition path.

- [ ] **Step 5: Run the full UA lifecycle suite and typecheck**

Run:

```bash
npx vitest run test/ua/user-agent.test.ts test/integration/call.test.ts test/integration/registration.test.ts
npm run typecheck
```

Expected: all commands exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/ua/user-agent.ts test/ua/user-agent.test.ts
git commit -m "fix: serialize user agent connection setup"
```

---

### Task 6: Complete and truthful UserAgent event API

**Files:**
- Modify: `src/ua/events.ts`
- Modify: `src/ua/index.ts`
- Modify: `src/index.ts`
- Modify: `src/ua/invitation.ts:40`
- Modify: `test/ua/user-agent.test.ts`
- Modify: `test/package/fixtures/types/index.ts:25-40,106-108,196-202`

**Interfaces:**
- Consumes: `RegisterState`, `SessionState`, `Invitation`, and existing runtime event names.
- Produces:

```ts
export interface RegistrationStateChangedEvent {
  readonly type: 'registrationStateChanged';
  readonly state: RegisterState;
  readonly identity: RegistrationIdentity;
}

export interface CallStateChangedEvent {
  readonly type: 'callStateChanged';
  readonly state: SessionState;
  readonly identity: RegistrationIdentity;
}

export interface IncomingCallEvent {
  readonly type: 'incomingCall';
  readonly invitation: Invitation;
}

export interface UserAgentFailedEvent {
  readonly type: 'failed';
  readonly error: Error;
  readonly identity: RegistrationIdentity;
}

export interface UserAgentEventMap {
  readonly registrationStateChanged: RegistrationStateChangedEvent;
  readonly callStateChanged: CallStateChangedEvent;
  readonly incomingCall: IncomingCallEvent;
  readonly failed: UserAgentFailedEvent;
}

export interface UserAgentEventEmitter {
  on<K extends keyof UserAgentEventMap>(event: K, listener: (value: UserAgentEventMap[K]) => void): void;
  off<K extends keyof UserAgentEventMap>(event: K, listener: (value: UserAgentEventMap[K]) => void): void;
  once<K extends keyof UserAgentEventMap>(event: K, listener: (value: UserAgentEventMap[K]) => void): void;
}

/** @deprecated Use UserAgentFailedEvent. */
export type RegistrationFailedEvent = UserAgentFailedEvent;
export type RegistrationEvent = RegistrationStateChangedEvent | UserAgentFailedEvent;
/** @deprecated Use UserAgentEventEmitter. */
export type RegistrationEventEmitter = UserAgentEventEmitter;
```

- `UserAgent.on/off/once` are generic over `keyof UserAgentEventMap`.
- Use type-only imports for `Invitation`, `RegistrationIdentity`, `RegisterState`, and `SessionState` so the event module introduces no runtime cycle.
- Preserve `RegistrationFailedEvent`, `RegistrationEvent`, and `RegistrationEventEmitter` as deprecated type aliases for source migration.
- `Invitation`, `SessionState`, `SessionEvent`, and all event types are exported from `sip-worker` and `sip-worker/ua`.
- Runtime no longer overloads one `stateChanged` name with incompatible registration and call states.

- [ ] **Step 1: Add failing package type assertions**

Update the type fixture imports and replace the old registration emitter block:

```ts
import type {
  CallStateChangedEvent,
  IncomingCallEvent,
  Invitation,
  RegistrationStateChangedEvent,
  SessionState,
  UserAgentEventEmitter,
} from 'sip-worker';

const emitter: UserAgentEventEmitter = new UserAgent(uaOptions);
emitter.on('registrationStateChanged', (event: RegistrationStateChangedEvent) => {
  const state: RegisterState = event.state;
  void state;
});
emitter.on('callStateChanged', (event: CallStateChangedEvent) => {
  const state: SessionState = event.state;
  void state;
});
emitter.on('incomingCall', (event: IncomingCallEvent) => {
  const invitation: Invitation = event.invitation;
  void invitation;
});
// @ts-expect-error call state is not a RegisterState
emitter.on('callStateChanged', (event: RegistrationStateChangedEvent) => void event);
```

- [ ] **Step 2: Add failing runtime event-shape tests**

In `test/ua/user-agent.test.ts`, assert registration emits
`registrationStateChanged`, an outgoing INVITE emits `callStateChanged`, and an
incoming INVITE emits `{ type: 'incomingCall', invitation }` rather than the raw
object. Preserve the existing SIP response helpers and cleanly disconnect at the
end of each test.

- [ ] **Step 3: Run type and runtime tests to verify red**

Run:

```bash
npm run typecheck
npx vitest run test/ua/user-agent.test.ts -t "registrationStateChanged|callStateChanged|incomingCall event"
```

Expected: FAIL because the current event surface only types registration events
and emits call states through `stateChanged`.

- [ ] **Step 4: Implement a typed generic emitter**

Replace `src/ua/events.ts` internals with a generic event map:

```ts
type Listener<T> = (event: T) => void;

export class TypedEventEmitter<Events extends object = UserAgentEventMap> {
  private readonly listeners = new Map<keyof Events, Set<Listener<Events[keyof Events]>>>();

  on<K extends keyof Events>(event: K, listener: Listener<Events[K]>): void {
    const set = this.listeners.get(event) ?? new Set<Listener<Events[keyof Events]>>();
    set.add(listener as Listener<Events[keyof Events]>);
    this.listeners.set(event, set);
  }

  off<K extends keyof Events>(event: K, listener: Listener<Events[K]>): void {
    this.listeners.get(event)?.delete(listener as Listener<Events[keyof Events]>);
  }

  once<K extends keyof Events>(event: K, listener: Listener<Events[K]>): void {
    const wrapper: Listener<Events[K]> = (value) => {
      this.off(event, wrapper);
      listener(value);
    };
    this.on(event, wrapper);
  }

  protected emit<K extends keyof Events>(event: K, value: Events[K]): void {
    for (const listener of [...(this.listeners.get(event) ?? [])]) {
      try {
        listener(value);
      } catch {
        // User observers cannot corrupt an already-committed state transition.
      }
    }
  }
}
```

Declare `UserAgent extends TypedEventEmitter<UserAgentEventMap> implements UserAgentEventEmitter`.
Change the two registration emissions to `registrationStateChanged`, session
emissions to `callStateChanged`, and incoming-call emission to:

```ts
this.emit('incomingCall', { type: 'incomingCall', invitation });
```

Export the types and `Invitation` from both barrels.

- [ ] **Step 5: Run UA, package type, and regression verification**

Run:

```bash
npx vitest run test/ua/user-agent.test.ts test/integration/call.test.ts test/integration/release-smoke.test.ts
npm run typecheck
npm run test:package
```

Expected: all commands exit 0; packed TypeScript consumers compile the new event surface.

- [ ] **Step 6: Commit**

```bash
git add src/ua/events.ts src/ua/user-agent.ts src/ua/invitation.ts src/ua/index.ts src/index.ts test/ua/user-agent.test.ts test/package/fixtures/types/index.ts
git commit -m "fix: expose truthful typed user agent events"
```

---

### Task 7: Final SIP response when media is unavailable

**Files:**
- Modify: `src/ua/user-agent.ts:526-545`
- Modify: `test/ua/user-agent.test.ts`

**Interfaces:**
- Consumes: inbound initial INVITE routing and `requestResponse()`.
- Produces: an initial INVITE received without a configured media controller receives `488 Not Acceptable Here`; no `Invitation` is created and no `incomingCall` event is emitted.

- [ ] **Step 1: Allow the UA test harness to omit media**

Add `media?: boolean` to `setup()` options and include `mediaController` only
when `options.media !== false`.

- [ ] **Step 2: Add the failing no-media response test**

```ts
it('answers an incoming INVITE with 488 when media is unavailable', async () => {
  const { ua, transport } = setup({ media: false });
  const incoming: unknown[] = [];
  ua.on('incomingCall', (event) => incoming.push(event));
  await ua.connect();

  transport.emitData(serializeMessage(makeIncomingInvite()));
  await flush();

  const response = lastResponse(transport);
  expect(response.statusCode).toBe(488);
  expect(response.reasonPhrase).toBe('Not Acceptable Here');
  expect(incoming).toHaveLength(0);
  await ua.disconnect();
});
```

Use the test file's existing incoming INVITE builder or extract the repeated
headers into `makeIncomingInvite()`.

- [ ] **Step 3: Run the regression to verify red**

Run:

```bash
npx vitest run test/ua/user-agent.test.ts -t "488 when media is unavailable"
```

Expected: FAIL because the current code only writes `console.warn` and sends no response.

- [ ] **Step 4: Send the final response and remove console output**

Replace the no-media branch with:

```ts
if (mediaController === undefined) {
  this.layer?.sendResponse(
    transaction.key,
    this.requestResponse(request, 488, 'Not Acceptable Here'),
  );
  return;
}
```

- [ ] **Step 5: Run incoming-call tests and typecheck**

Run:

```bash
npx vitest run test/ua/user-agent.test.ts test/ua/invitation.test.ts test/integration/call.test.ts
npm run typecheck
```

Expected: all commands exit 0 and no library `console.warn` is emitted.

- [ ] **Step 6: Commit**

```bash
git add src/ua/user-agent.ts test/ua/user-agent.test.ts
git commit -m "fix: reject calls when media is unavailable"
```

---

### Task 8: Resolved UDP peer identity

**Files:**
- Modify: `src/transport/node/udp.ts:25-101`
- Modify: `test/transport/node-udp.test.ts:69-145`
- Modify: `test/package/fixtures/types/index.ts:60-67,216-220`

**Interfaces:**
- Consumes: injected `DatagramSocketLike` and configured remote host/port.
- Produces:

```ts
export interface NodeUdpTransportOptions {
  readonly localPort: number;
  readonly remoteHost: string;
  readonly remotePort: number;
  readonly remoteAddresses?: readonly string[];
}
```

- When `remoteAddresses` is supplied, inbound datagrams are accepted only when
  `rinfo.port === remotePort` and `rinfo.address` is in that exact allowlist.
- When it is omitted, `remoteHost` must be a literal IPv4 or IPv6 address and is
  used as the single allowed address. A hostname without `remoteAddresses` throws
  `TypeError("remoteAddresses is required when remoteHost is a hostname")` from
  the constructor. This fail-closed 0.2 contract avoids spoofable port-only
  matching; automatic DNS resolution and refresh move to `@sip-worker/node` in
  0.3.x.

- [ ] **Step 1: Add failing hostname/address tests**

Add:

```ts
it('accepts a resolved address for a configured hostname', async () => {
  const socket = new FakeDatagramSocket();
  const transport = new NodeUdpTransport(socket, {
    localPort: 5060,
    remoteHost: 'sip.example.test',
    remotePort: 5070,
    remoteAddresses: ['192.0.2.10'],
  });
  const data: TransportEvent[] = [];
  transport.subscribe((event) => data.push(event));
  await connect(socket, transport);

  socket.emit('message', new Uint8Array([1]), { address: '192.0.2.10', port: 5070 });
  socket.emit('message', new Uint8Array([2]), { address: '192.0.2.11', port: 5070 });

  expect(data.filter((event) => event.type === 'data')).toEqual([
    { type: 'data', data: new Uint8Array([1]) },
  ]);
});
```

Also change the existing configured-peer test to use a literal IP and add:

```ts
it("fails closed when a hostname has no resolved-address allowlist", () => {
  expect(() => new NodeUdpTransport(new FakeDatagramSocket(), {
    localPort: 5060,
    remoteHost: "sip.example.test",
    remotePort: 5070,
  })).toThrow("remoteAddresses is required when remoteHost is a hostname");
});
```

Update every existing source fixture/test constructor that deliberately uses a
hostname to pass the deterministic address `remoteAddresses: ["192.0.2.10"]`.

- [ ] **Step 2: Run UDP tests to verify red**

Run:

```bash
npx vitest run test/transport/node-udp.test.ts
```

Expected: FAIL because `remoteAddresses` is not part of the options and hostname
comparison still expects the literal host string.

- [ ] **Step 3: Implement explicit peer matching**

Add private normalized allowlist state:

```ts
private readonly remoteAddresses: ReadonlySet<string>;
```

Initialize it in the constructor:

```ts
const configured = options.remoteAddresses
  ?? (isIP(options.remoteHost) !== 0 ? [options.remoteHost] : undefined);
if (configured === undefined || configured.length === 0) {
  throw new TypeError("remoteAddresses is required when remoteHost is a hostname");
}
this.remoteAddresses = new Set(configured);
```

Implement:

```ts
private isFromConfiguredPeer(rinfo: unknown): boolean {
  if (typeof rinfo !== "object" || rinfo === null) return false;
  const info = rinfo as { address?: unknown; port?: unknown };
  if (info.port !== this.options.remotePort || typeof info.address !== "string") return false;
  return this.remoteAddresses.has(info.address);
}
```

Import `isIP` from `node:net` and use `isIP(options.remoteHost) !== 0` for the
literal-address check. Document the fail-closed hostname requirement beside the
option; socket injection remains unchanged.

- [ ] **Step 4: Run transport and type verification**

Run:

```bash
npx vitest run test/transport/node-udp.test.ts test/transport/contract.test.ts
npm run typecheck
npm run test:package
```

Expected: all commands exit 0; the packed type fixture accepts `remoteAddresses`.

- [ ] **Step 5: Commit**

```bash
git add src/transport/node/udp.ts test/transport/node-udp.test.ts test/package/fixtures/types/index.ts
git commit -m "fix: match udp peers by resolved address"
```

---

### Task 9: Observer isolation across public event boundaries

**Files:**
- Modify: `src/transport/node/tcp.ts:254-256`
- Modify: `src/transport/node/udp.ts:258-260`
- Modify: `src/transport/node/ws.ts:318-320`
- Modify: `src/transport/browser/ws.ts:304-306`
- Modify: `test/transport/node-tcp.test.ts`
- Modify: `test/transport/node-udp.test.ts`
- Modify: `test/transport/node-ws.test.ts`
- Modify: `test/transport/browser-ws.test.ts`
- Modify: `test/ua/user-agent.test.ts`

**Interfaces:**
- Consumes: all transport `subscribe()` methods and the generic `TypedEventEmitter` from Task 6.
- Produces: every listener registered at a public fan-out boundary is invoked from a snapshot; a listener throw is swallowed after the remaining listeners receive the same event; unsubscribe during delivery affects only later emissions.

- [ ] **Step 1: Reverse the existing throw-propagation expectations**

Where adapter tests currently expect `socket.emit(...)` to throw
`'subscriber failed'`, change them to assert no throw, then assert a later
recording listener received the `error` or `disconnected` event and the pending
operation settled.

Add the same contract to browser and Node WebSocket tests if absent:

```ts
transport.subscribe(() => { throw new Error('observer failed'); });
transport.subscribe((event) => observed.push(event));
expect(() => socket.emitFailure(new Error('boom'))).not.toThrow();
expect(observed.some((event) => event.type === 'error')).toBe(true);
```

- [ ] **Step 2: Add a UserAgent observer isolation regression**

Register a throwing `registrationStateChanged` listener before a recording one,
complete registration, and assert `register()` resolves and the recording
listener receives `registered`.

- [ ] **Step 3: Run focused tests to verify red**

Run:

```bash
npx vitest run test/transport/node-tcp.test.ts test/transport/node-udp.test.ts test/transport/node-ws.test.ts test/transport/browser-ws.test.ts test/ua/user-agent.test.ts -t "observer|subscriber"
```

Expected: FAIL in adapter tests because the current emit loops propagate observer exceptions.

- [ ] **Step 4: Isolate transport observers**

Use the same implementation in all four adapters:

```ts
private emit(event: TransportEvent): void {
  for (const listener of [...this.listeners]) {
    try {
      listener(event);
    } catch {
      // An application observer cannot block transport lifecycle delivery.
    }
  }
}
```

Task 6 already applies the equivalent behavior to `TypedEventEmitter`.

- [ ] **Step 5: Run all transport, UA, and type tests**

Run:

```bash
npx vitest run test/transport test/ua/user-agent.test.ts
npm run typecheck
```

Expected: all commands exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/transport/node/tcp.ts src/transport/node/udp.ts src/transport/node/ws.ts src/transport/browser/ws.ts test/transport test/ua/user-agent.test.ts
git commit -m "fix: isolate public event observers"
```

---

### Task 10: Repeated lifecycle resource assertions

**Files:**
- Modify: `src/media/worker-controller.ts`
- Modify: `test/support/fake-transport.ts:16-101`
- Modify: `test/ua/user-agent.test.ts`
- Modify: `test/bridge/worker-supervisor.test.ts`
- Modify: `test/media/bridge.test.ts`

**Interfaces:**
- Consumes: existing `FakeClock.pending()`, fake transport, supervisor, and media harnesses.
- Produces: test-only `FakeTransport.listenerCount(): number` and repeated lifecycle gates proving resource counts return to baseline.

- [ ] **Step 1: Expose the fake transport listener count**

Add:

```ts
listenerCount(): number {
  return this.listeners.size;
}
```

- [ ] **Step 2: Add repeated UserAgent lifecycle test**

Because real transports are one-shot, construct a fresh UA/transport per cycle:

```ts
it('returns timers and listeners to baseline across repeated UA lifecycles', async () => {
  for (let cycle = 0; cycle < 25; cycle += 1) {
    const h = setup({ liveness: new RecordingLiveness() });
    await h.ua.connect();
    expect(h.transport.listenerCount()).toBeGreaterThan(0);
    await h.ua.disconnect();
    expect(h.transport.listenerCount()).toBe(0);
    expect(h.clock.pending()).toBe(0);
  }
});
```

- [ ] **Step 3: Add repeated supervisor stop/start/close resource test**

Run 25 start/register/registered/stop cycles on one supervisor, assert each old
worker is terminated with zero port listeners and `clock.pending() === 0` after
each stop, then close and assert no waiter remains pending.

- [ ] **Step 4: Add repeated media request/close resource test**

Using the existing media harness and `FakeClock`, repeat create-offer completion
and `closeSession` across 25 distinct session IDs. Assert the controller's test
observable pending count and clock timer count return to zero. If the controller
lacks a test observable, add:

```ts
get pendingRequestCount(): number {
  return this.pending.size;
}
```

and export it only as a readonly diagnostic getter on the existing class.

- [ ] **Step 5: Run lifecycle tests**

Run:

```bash
npx vitest run test/ua/user-agent.test.ts test/bridge/worker-supervisor.test.ts test/media/bridge.test.ts
npm run typecheck
```

Expected: all commands exit 0; every repeated cycle returns timers, listeners,
pending media requests, and worker ports to zero/baseline.

- [ ] **Step 6: Commit**

```bash
git add test/support/fake-transport.ts test/ua/user-agent.test.ts test/bridge/worker-supervisor.test.ts test/media/bridge.test.ts src/media/worker-controller.ts
git commit -m "test: enforce lifecycle resource baselines"
```

---

### Task 11: 0.2.0 documentation and release contract

**Files:**
- Modify: `package.json:2-4`
- Modify: `package-lock.json`
- Modify: `README.md:123-194`
- Modify: `SECURITY.md:3-61`
- Modify: `CHANGELOG.md`
- Modify: `docs/2026-08-11-production-readiness-review.md`
- Modify: `docs/superpowers/plans/2026-08-04-sip-worker-index.md`
- Modify: `test/package/documentation-contract.test.mjs`

**Interfaces:**
- Consumes: verified implementation and tests from Tasks 1-10.
- Produces: version `0.2.0`, accurate limitations, a link to the browser v1.0 roadmap, updated event names, and no claim that bounded AuthManager state is unbounded.
- The package remains explicitly pre-1.0 and signaling-only; this milestone does not claim production readiness.

- [ ] **Step 1: Update the documentation contract test first**

Change the fixed version assertion to `0.2.0` and add checks:

```js
assert.match(readme, /browser-v1-production-roadmap-design\.md/);
for (const [name, text] of [['README.md', readme], ['SECURITY.md', security]]) {
  assert.doesNotMatch(text, /AuthManager maps are unbounded|Unbounded `AuthManager` maps/i, `${name} contains stale AuthManager limitation`);
}
assert.match(readme, /registrationStateChanged/);
assert.match(readme, /callStateChanged/);
```

Read `SECURITY.md` in the contract setup.

- [ ] **Step 2: Run the docs test to verify red**

Run:

```bash
npm run test:docs
```

Expected: FAIL because package version and documents still describe 0.1.0 and old event names.

- [ ] **Step 3: Update version metadata**

Run:

```bash
npm version 0.2.0 --no-git-tag-version
```

Expected: `package.json` and `package-lock.json` both report `0.2.0`; no commit or tag is created.

- [ ] **Step 4: Update README, security, readiness, index, and changelog**

Make these exact policy changes:

- Keep “signaling-only” and “not production-ready” prominent.
- Replace the unbounded-map limitation with: nonce counters are capped at 64 and
  per-exchange retry state is settled; no claim of general memory safety is made
  beyond tested lifecycle boundaries.
- Document `registrationStateChanged`, `callStateChanged`, `incomingCall`, and
  `failed` separately.
- Link `docs/superpowers/specs/2026-08-12-browser-v1-production-roadmap-design.md`.
- Add a `0.2.0` changelog entry listing the correctness fixes without claiming
  WebRTC, WSS production readiness, or interoperability.
- Mark the old Phase 12 execution checkbox complete only if its own original
  release-productization gates are truly satisfied; otherwise leave it unchanged
  and add the browser roadmap as the successor track.
- Annotate the dated 0.1 readiness review with a short “superseded facts” note
  pointing to 0.2.0 rather than rewriting its historical baseline.

- [ ] **Step 5: Run docs, type, package, and full regression gates**

Run:

```bash
npm run test:docs
npm run typecheck
npm test
npm run test:package
```

Expected: every command exits 0; documentation contract reports version 0.2.0,
and packed ESM/CommonJS/TypeScript consumers pass.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json README.md SECURITY.md CHANGELOG.md docs/2026-08-11-production-readiness-review.md docs/superpowers/plans/2026-08-04-sip-worker-index.md test/package/documentation-contract.test.mjs
git commit -m "docs: publish the 0.2 correctness contract"
```

---

### Task 12: Milestone review and release-candidate verification

**Files:**
- Review: all files changed by Tasks 1-11
- Create: `docs/reviews/2026-08-12-0.2-core-correctness-review.md`

**Interfaces:**
- Consumes: complete 0.2.0 implementation and roadmap acceptance gate.
- Produces: an evidence ledger containing exact commands, results, known limitations, and a go/no-go verdict for beginning the 0.3 package-separation design.

- [ ] **Step 1: Inspect the complete milestone diff**

Run:

```bash
git diff 512feec..HEAD --stat
git diff 512feec..HEAD -- src test package.json README.md SECURITY.md CHANGELOG.md
git status --short
```

Expected: only Milestone 1 changes plus the pre-existing untracked `.claude/`;
no package extraction or WebRTC implementation.

- [ ] **Step 2: Run static contract scans**

Run:

```bash
rg -n -F -e "console." -e "void this.register()" -e "toString().padStart(8" src
rg -n -e "emit.*stateChanged|on.*stateChanged" src
rg -n "AuthManager maps are unbounded|Unbounded `AuthManager` maps|v1 release candidate" README.md SECURITY.md docs package.json
```

Expected: no unconditional library console calls, no unhandled refresh pattern,
no decimal nonce formatting, no ambiguous runtime `stateChanged` event, and no
stale unbounded-map or v1-candidate claim. Historical plan text may match only
when clearly labeled as historical; document any intentional match.

- [ ] **Step 3: Run the complete acceptance command from a clean dependency tree**

Run:

```bash
npm ci
npm run typecheck
npm test
npm run build
npm run test:package
```

Expected: every command exits 0; no unhandled rejection or open-handle warning;
packed ESM/CommonJS/TypeScript fixtures pass.

- [ ] **Step 4: Write the evidence review**

Create `docs/reviews/2026-08-12-0.2-core-correctness-review.md` after the commands finish. Use these exact sections:

1. `# 0.2.0 Core Correctness Review`
2. `## Scope` stating this is Milestone 1 and contains no package split or WebRTC work.
3. `## Verification Evidence` with one row each for npm version, install, types, tests, build, and package. Copy the actual command, exit status, and test counts from Step 3.
4. `## Task Closure` with one row for every implementation Task 1-11. Each row names the task, its focused regression or documentation check, the actual implementing commit from `git log --oneline 512feec..HEAD`, and PASS or FAIL from fresh output.
5. `## Remaining Limitations` stating: signaling-only; no real WebRTC audio; no production WSS policy; no Asterisk/FreeSWITCH interoperability evidence; no production browser support claim.
6. `## Verdict` containing `GO — begin the 0.3 package-separation design` only if every gate passed. Otherwise write `NO-GO`, the exact failing command, and the observed failure.

Do not copy example status words or invented counts; every value in the review must come from Step 3 output and repository history.

- [ ] **Step 5: Verify the review document and commit**

Run:

```bash
test -s docs/reviews/2026-08-12-0.2-core-correctness-review.md
! rg -n "TBD|TODO|commit hash|PASS/FAIL|exit code|npm version printed" docs/reviews/2026-08-12-0.2-core-correctness-review.md
git diff --check
```

Expected: all commands exit 0.

Then commit:

```bash
git add docs/reviews/2026-08-12-0.2-core-correctness-review.md
git commit -m "docs: record the 0.2 correctness review"
```

---

## Milestone Exit Criteria

Milestone 1 is complete only when all of the following are true:

- Digest nonce counts use RFC hexadecimal formatting beyond nine uses.
- `WorkerSupervisor.stop()` settles all old-generation waiters and terminates its worker.
- Automatic registration refresh failures are observed and emitted exactly once.
- Concurrent `UserAgent.connect()` calls share one composition attempt.
- Registration, call, incoming-call, and failure events have truthful exported types.
- An incoming INVITE without media receives a final 488 response.
- UDP hostname configurations can validate explicit resolved addresses and no longer compare a hostname to numeric `rinfo.address`.
- Throwing public observers cannot block internal or later listener delivery.
- Repeated UA, supervisor, and media lifecycles return resource counts to baseline.
- Documentation accurately describes 0.2.0 and links the browser v1.0 roadmap.
- The clean install, typecheck, full test, build, and packed-consumer gates all pass.
- The 0.2 review records a GO verdict with evidence before any 0.3 package-separation work begins.
