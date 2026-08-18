# SIP.js Transaction-Layer Compliance Borrows — RFC 4320 Guard + Transition Assertions

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring three SIP.js lessons into the sip-worker transaction layer: reject non-100 provisional responses to non-INVITE requests (RFC 4320 §4.1), assert every transaction state transition against an RFC transition table so an illegal transition throws instead of silently corrupting state, and cover each transaction's (state × response-class) matrix with an exhaustive test grid.

**Architecture:** A tiny generic `assertTransition(table, from, to)` helper lives in a new `transactions/transitions.ts`. Each of the four transaction classes keeps its RFC transition table next to its state union, and routes every `this.currentState = ...` assignment through a private `setState(next)` that asserts the edge before committing. The RFC 4320 guard rejects `101-199` in `NonInviteServerTransaction.sendResponseAwait` with a `SipError` (mirroring SIP.js's loud throw; the fire-and-forget `sendResponse` wrapper consumes the rejection). A new `response-matrix.test.ts` enumerates every (state × response-class) combination for all four transactions, asserting per cell the resulting state, TU delivery, and wire sends — the SIP.js `transactions.spec.ts` pattern. Nothing is added to the public API.

**Tech Stack:** TypeScript, vitest, the existing `FakeClock`/`FakeTransport` test harness.

**Spec:** `docs/2026-08-18-sipjs-transaction-diff.md` (Findings items 1 and 2), plus the SIP.js reference implementations `src/core/transactions/{invite-client-transaction,invite-server-transaction,non-invite-client-transaction,non-invite-server-transaction}.ts` (stateTransition) and `test/spec/core/transactions.spec.ts` (response-matrix enumeration pattern), and RFC 3261 figures 5–8 / RFC 6026 §8.4–8.7 / RFC 4320 §4.1.

## Global Constraints

- **Environment-neutral core:** `@sip-worker/core` runs in worker, browser main thread, and Node. No `process`, `window`, `NODE_ENV`, `globalThis`-gated behavior, and no new globals. The transition assertion is therefore **always-on** — it throws only on a programming bug, and the existing reentrancy guards (`if (this.currentState !== 'X') return;` after every send/emit) make illegal transitions unreachable in normal operation.
- **No public API change:** `packages/core/src/transactions/index.ts` uses explicit named exports. Do NOT re-export `assertTransition`, `TransitionTable`, or the four `*_TRANSITIONS` tables. The api-extractor report (`npm run test:api`) must stay byte-identical.
- **Determinism:** no real timers; all clock use stays behind the injected `Clock`.
- **Test style:** follow the existing harness in `packages/core/test/transactions/non-invite-server.test.ts` — `FakeClock`, `FakeTransport`, `deriveTimers`, `makeResponse`, `start(h)`.
- **Commits:** conventional messages, one per logical change.

---

### Task 1: Transition-assertion infrastructure

**Files:**
- Create: `packages/core/src/transactions/transitions.ts`
- Test: `packages/core/test/transactions/transitions.test.ts`

**Interfaces:**
- Produces: `export type TransitionTable<S extends string> = Readonly<Record<S, readonly S[]>>` and `export function assertTransition<S extends string>(table: TransitionTable<S>, from: S, to: S): void`. Throws `Error` on an illegal edge; allows self-transitions. Consumed by Tasks 2–5.

- [ ] **Step 1: Write the failing test**

Create `packages/core/test/transactions/transitions.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  assertTransition,
  type TransitionTable,
} from '../../src/transactions/transitions.js';

describe('assertTransition', () => {
  const table = { A: ['B'], B: ['C'], C: [] } as const satisfies TransitionTable<'A' | 'B' | 'C'>;

  it('allows a listed edge', () => {
    expect(() => assertTransition(table, 'A', 'B')).not.toThrow();
  });

  it('allows a self-transition', () => {
    expect(() => assertTransition(table, 'B', 'B')).not.toThrow();
  });

  it('throws on an unlisted edge', () => {
    expect(() => assertTransition(table, 'A', 'C')).toThrow(/invalid transaction state transition: A -> C/);
  });

  it('throws when the source row is missing', () => {
    expect(() => assertTransition({} as TransitionTable<'A'>, 'A', 'B')).toThrow(/invalid transaction state transition: A -> B/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/core/test/transactions/transitions.test.ts`
Expected: FAIL — module `../../src/transactions/transitions.js` cannot be resolved.

- [ ] **Step 3: Write minimal implementation**

Create `packages/core/src/transactions/transitions.ts`:

```ts
/**
 * State-transition assertion for the RFC 3261 transaction state machines.
 *
 * Each transaction routes every state change through `assertTransition` with
 * its RFC transition table (RFC 3261 figures 5-8, RFC 6026 sections 8.4-8.7),
 * so an illegal transition is a loud throw in development and in the test
 * suite instead of silent undefined behavior. The reentrancy guards in the
 * transactions make illegal transitions unreachable in normal operation.
 */

export type TransitionTable<S extends string> = Readonly<Record<S, readonly S[]>>;

/**
 * Assert `from -> to` is an allowed edge in `table`. A self-transition is
 * always allowed. Throws on an illegal edge.
 */
export function assertTransition<S extends string>(
  table: TransitionTable<S>,
  from: S,
  to: S,
): void {
  if (from === to) return;
  const allowed = table[from];
  if (allowed !== undefined && allowed.includes(to)) return;
  throw new Error(`invalid transaction state transition: ${from} -> ${to}`);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/core/test/transactions/transitions.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/transactions/transitions.ts packages/core/test/transactions/transitions.test.ts
git commit -m "feat(core): add transaction state-transition assertion helper"
```

---

### Task 2: INVITE client transaction routes through asserted transitions

**Files:**
- Modify: `packages/core/src/transactions/invite-client.ts:14` (state type), state assignments at `114`, `125`, `141`, `233`
- Test: `packages/core/test/transactions/transitions.test.ts`
- Test: `packages/core/test/transactions/invite-client.test.ts` (regression, unmodified)

**Interfaces:**
- Consumes: `assertTransition`, `TransitionTable` from `./transitions.js` (Task 1).
- Produces: `export const INVITE_CLIENT_TRANSITIONS: TransitionTable<InviteState>` — the RFC 3261 figure 5 / RFC 6026 §8.4 edge set.

- [ ] **Step 1: Write the failing table test**

Append to `packages/core/test/transactions/transitions.test.ts`:

```ts
import { INVITE_CLIENT_TRANSITIONS } from '../../src/transactions/invite-client.js';

describe('INVITE_CLIENT_TRANSITIONS', () => {
  it('contains exactly the RFC edges', () => {
    expect(INVITE_CLIENT_TRANSITIONS).toEqual({
      Calling: ['Proceeding', 'Accepted', 'Completed', 'Terminated'],
      Proceeding: ['Accepted', 'Completed', 'Terminated'],
      Accepted: ['Terminated'],
      Completed: ['Terminated'],
      Terminated: [],
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/core/test/transactions/transitions.test.ts`
Expected: FAIL — `INVITE_CLIENT_TRANSITIONS` is `undefined`.

- [ ] **Step 3: Add the table and route assignments through `setState`**

In `invite-client.ts`, add the import to the existing `./timers.js` import block:

```ts
import { assertTransition, type TransitionTable } from './transitions.js';
```

Immediately after the `InviteState` type (line 14), add the table:

```ts
/** RFC 3261 figure 5 / RFC 6026 §8.4. Terminated is reachable from every state. */
export const INVITE_CLIENT_TRANSITIONS: TransitionTable<InviteState> = {
  Calling: ['Proceeding', 'Accepted', 'Completed', 'Terminated'],
  Proceeding: ['Accepted', 'Completed', 'Terminated'],
  Accepted: ['Terminated'],
  Completed: ['Terminated'],
  Terminated: [],
};
```

Add a private method (place next to `get state()`):

```ts
private setState(next: InviteState): void {
  assertTransition(INVITE_CLIENT_TRANSITIONS, this.currentState, next);
  this.currentState = next;
}
```

Replace the four direct assignments:

| Line | Old | New |
| --- | --- | --- |
| 114 | `this.currentState = 'Proceeding';` | `this.setState('Proceeding');` |
| 125 | `this.currentState = 'Accepted';` | `this.setState('Accepted');` |
| 141 | `this.currentState = 'Completed';` | `this.setState('Completed');` |
| 233 | `this.currentState = 'Terminated';` | `this.setState('Terminated');` |

Leave every `if (this.currentState !== ...)` read unchanged.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run packages/core/test/transactions/transitions.test.ts packages/core/test/transactions/invite-client.test.ts`
Expected: PASS — the table test, plus all existing INVITE client transaction tests (which exercise every transition; a wrong table would throw).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/transactions/invite-client.ts packages/core/test/transactions/transitions.test.ts
git commit -m "feat(core): route INVITE client transactions through asserted transitions"
```

---

### Task 3: INVITE server transaction routes through asserted transitions

**Files:**
- Modify: `packages/core/src/transactions/invite-server.ts:13` (state type), state assignments at `117`, `128`, `163`, `280`
- Test: `packages/core/test/transactions/transitions.test.ts`
- Test: `packages/core/test/transactions/invite-server.test.ts` (regression, unmodified)

**Interfaces:**
- Consumes: `assertTransition`, `TransitionTable` from `./transitions.js` (Task 1).
- Produces: `export const INVITE_SERVER_TRANSITIONS: TransitionTable<InviteServerState>` — RFC 3261 figure 7 / RFC 6026 §8.5–8.7. `InviteServerState` stays a private type; the exported table is typed against it structurally.

- [ ] **Step 1: Write the failing table test**

Append to `packages/core/test/transactions/transitions.test.ts`:

```ts
import { INVITE_SERVER_TRANSITIONS } from '../../src/transactions/invite-server.js';

describe('INVITE_SERVER_TRANSITIONS', () => {
  it('contains exactly the RFC edges', () => {
    expect(INVITE_SERVER_TRANSITIONS).toEqual({
      Proceeding: ['Accepted', 'Completed', 'Terminated'],
      Accepted: ['Terminated'],
      Completed: ['Confirmed', 'Terminated'],
      Confirmed: ['Terminated'],
      Terminated: [],
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/core/test/transactions/transitions.test.ts`
Expected: FAIL — `INVITE_SERVER_TRANSITIONS` is `undefined`.

- [ ] **Step 3: Add the table and route assignments through `setState`**

In `invite-server.ts`, add the import to the existing `./timers.js` import block:

```ts
import { assertTransition, type TransitionTable } from './transitions.js';
```

Immediately after the `InviteServerState` type (line 13), add the table:

```ts
/** RFC 3261 figure 7 / RFC 6026 §8.5-8.7. Terminated is reachable from every state. */
export const INVITE_SERVER_TRANSITIONS: TransitionTable<InviteServerState> = {
  Proceeding: ['Accepted', 'Completed', 'Terminated'],
  Accepted: ['Terminated'],
  Completed: ['Confirmed', 'Terminated'],
  Confirmed: ['Terminated'],
  Terminated: [],
};
```

Add a private method (place next to `get state()`):

```ts
private setState(next: InviteServerState): void {
  assertTransition(INVITE_SERVER_TRANSITIONS, this.currentState, next);
  this.currentState = next;
}
```

Replace the four direct assignments:

| Line | Old | New |
| --- | --- | --- |
| 117 | `this.currentState = 'Accepted';` | `this.setState('Accepted');` |
| 128 | `this.currentState = 'Completed';` | `this.setState('Completed');` |
| 163 | `this.currentState = 'Confirmed';` | `this.setState('Confirmed');` |
| 280 | `this.currentState = 'Terminated';` | `this.setState('Terminated');` |

Leave every `if (this.currentState !== ...)` read unchanged.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run packages/core/test/transactions/transitions.test.ts packages/core/test/transactions/invite-server.test.ts`
Expected: PASS — the table test plus all existing INVITE server transaction tests.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/transactions/invite-server.ts packages/core/test/transactions/transitions.test.ts
git commit -m "feat(core): route INVITE server transactions through asserted transitions"
```

---

### Task 4: Non-INVITE client transaction routes through asserted transitions

**Files:**
- Modify: `packages/core/src/transactions/non-invite-client.ts:14` (state type), state assignments at `107`, `120`, `203`
- Test: `packages/core/test/transactions/transitions.test.ts`
- Test: `packages/core/test/transactions/non-invite-client.test.ts` (regression, unmodified)

**Interfaces:**
- Consumes: `assertTransition`, `TransitionTable` from `./transitions.js` (Task 1).
- Produces: `export const NON_INVITE_CLIENT_TRANSITIONS: TransitionTable<NonInviteState>` — RFC 3261 figure 6.

- [ ] **Step 1: Write the failing table test**

Append to `packages/core/test/transactions/transitions.test.ts`:

```ts
import { NON_INVITE_CLIENT_TRANSITIONS } from '../../src/transactions/non-invite-client.js';

describe('NON_INVITE_CLIENT_TRANSITIONS', () => {
  it('contains exactly the RFC edges', () => {
    expect(NON_INVITE_CLIENT_TRANSITIONS).toEqual({
      Trying: ['Proceeding', 'Completed', 'Terminated'],
      Proceeding: ['Completed', 'Terminated'],
      Completed: ['Terminated'],
      Terminated: [],
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/core/test/transactions/transitions.test.ts`
Expected: FAIL — `NON_INVITE_CLIENT_TRANSITIONS` is `undefined`.

- [ ] **Step 3: Add the table and route assignments through `setState`**

In `non-invite-client.ts`, add the import to the existing `./timers.js` import block:

```ts
import { assertTransition, type TransitionTable } from './transitions.js';
```

Immediately after the `NonInviteState` type (line 14), add the table:

```ts
/** RFC 3261 figure 6. Terminated is reachable from every state. */
export const NON_INVITE_CLIENT_TRANSITIONS: TransitionTable<NonInviteState> = {
  Trying: ['Proceeding', 'Completed', 'Terminated'],
  Proceeding: ['Completed', 'Terminated'],
  Completed: ['Terminated'],
  Terminated: [],
};
```

Add a private method (place next to `get state()`):

```ts
private setState(next: NonInviteState): void {
  assertTransition(NON_INVITE_CLIENT_TRANSITIONS, this.currentState, next);
  this.currentState = next;
}
```

Replace the three direct assignments:

| Line | Old | New |
| --- | --- | --- |
| 107 | `this.currentState = 'Proceeding';` | `this.setState('Proceeding');` |
| 120 | `this.currentState = 'Completed';` | `this.setState('Completed');` |
| 203 | `this.currentState = 'Terminated';` | `this.setState('Terminated');` |

Leave every `if (this.currentState !== ...)` read unchanged.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run packages/core/test/transactions/transitions.test.ts packages/core/test/transactions/non-invite-client.test.ts`
Expected: PASS — the table test plus all existing non-INVITE client transaction tests.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/transactions/non-invite-client.ts packages/core/test/transactions/transitions.test.ts
git commit -m "feat(core): route non-INVITE client transactions through asserted transitions"
```

---

### Task 5: Non-INVITE server transaction — RFC 4320 guard + asserted transitions

**Files:**
- Modify: `packages/core/src/transactions/non-invite-server.ts:13` (state type), `sendResponseAwait` (guard, after line 87), state assignments at `90`, `99`, `173`
- Modify: `packages/core/test/transactions/non-invite-server.test.ts:67`, `92` (180 → 100), plus new guard tests
- Test: `packages/core/test/transactions/transitions.test.ts`

**Interfaces:**
- Consumes: `assertTransition`, `TransitionTable` from `./transitions.js` (Task 1).
- Produces: `export const NON_INVITE_SERVER_TRANSITIONS: TransitionTable<NonInviteServerState>`; changed `sendResponseAwait` contract: a provisional response with status `101-199` **rejects** with `new SipError(0, 'non-INVITE provisional response other than 100 is not allowed (RFC 4320 §4.1)')` (default code `'PROTOCOL_ERROR'`) — nothing is sent and the state is unchanged. This mirrors SIP.js's loud throw; the fire-and-forget `sendResponse` wrapper's existing `.catch(() => {})` consumes the rejection, so the current callers (which all send final responses: 491/481/488) are unaffected. `SipError` is imported from `../errors.js`.

- [ ] **Step 1: Write the failing table test**

Append to `packages/core/test/transactions/transitions.test.ts`:

```ts
import { NON_INVITE_SERVER_TRANSITIONS } from '../../src/transactions/non-invite-server.js';

describe('NON_INVITE_SERVER_TRANSITIONS', () => {
  it('contains exactly the RFC edges', () => {
    expect(NON_INVITE_SERVER_TRANSITIONS).toEqual({
      Trying: ['Proceeding', 'Completed', 'Terminated'],
      Proceeding: ['Completed', 'Terminated'],
      Completed: ['Terminated'],
      Terminated: [],
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/core/test/transactions/transitions.test.ts`
Expected: FAIL — `NON_INVITE_SERVER_TRANSITIONS` is `undefined`.

- [ ] **Step 3: Add the table and route assignments through `setState`**

In `non-invite-server.ts`, add the import to the existing `./timers.js` import block:

```ts
import { assertTransition, type TransitionTable } from './transitions.js';
```

Immediately after the `NonInviteServerState` type (line 13), add the table:

```ts
/** RFC 3261 figure 8. Terminated is reachable from every state. */
export const NON_INVITE_SERVER_TRANSITIONS: TransitionTable<NonInviteServerState> = {
  Trying: ['Proceeding', 'Completed', 'Terminated'],
  Proceeding: ['Completed', 'Terminated'],
  Completed: ['Terminated'],
  Terminated: [],
};
```

Add a private method (place next to `get state()`):

```ts
private setState(next: NonInviteServerState): void {
  assertTransition(NON_INVITE_SERVER_TRANSITIONS, this.currentState, next);
  this.currentState = next;
}
```

Replace the three direct assignments:

| Line | Old | New |
| --- | --- | --- |
| 90 | `this.currentState = 'Proceeding';` | `this.setState('Proceeding');` |
| 99 | `this.currentState = 'Completed';` | `this.setState('Completed');` |
| 173 | `this.currentState = 'Terminated';` | `this.setState('Terminated');` |

Leave every `if (this.currentState !== ...)` read unchanged.

- [ ] **Step 4: Run tests to verify the refactor is inert**

Run: `npx vitest run packages/core/test/transactions/transitions.test.ts packages/core/test/transactions/non-invite-server.test.ts`
Expected: PASS — no behavior change yet.

- [ ] **Step 5: Write the failing RFC 4320 tests**

In `packages/core/test/transactions/non-invite-server.test.ts`, replace the `1xx from Trying sends, moves to Proceeding` test (lines 67–73) with:

```ts
  it('rejects a non-100 provisional (RFC 4320 §4.1), sends nothing', async () => {
    const h = setup();
    start(h);
    await expect(h.tx.sendResponseAwait(response(180))).rejects.toThrow(/non-INVITE/);
    expect(h.tx.state).toBe('Trying');
    expect(h.transport.sent.length).toBe(0);
  });

  it('100 from Trying sends, moves to Proceeding', () => {
    const h = setup();
    start(h);
    h.tx.sendResponse(response(100));
    expect(h.tx.state).toBe('Proceeding');
    expect(h.transport.sent.length).toBe(1);
  });
```

In the `duplicate in Trying/Proceeding/Completed resends the latest response when present` test, change both `response(180)` calls to `response(100)` (the assertions are unchanged — a 100 behaves exactly as the 180 did before the guard).

- [ ] **Step 6: Run tests to verify they fail**

Run: `npx vitest run packages/core/test/transactions/non-invite-server.test.ts`
Expected: FAIL — the new 180 test expects a rejection, but the 180 is currently sent and the promise resolves; the `100 from Trying` test passes already.

- [ ] **Step 7: Add the guard**

In `non-invite-server.ts`, first extend the existing `../errors.js` import to bring in `SipError`:

```ts
import { SipError, TransportError } from '../errors.js';
```

Then in `sendResponseAwait`, immediately after the existing invalid-code guard:

```ts
    const code = response.statusCode;
    if (code < 100 || code > 699) return Promise.resolve();
```

insert:

```ts
    // RFC 4320 §4.1: a non-INVITE request MUST NOT receive a provisional
    // response other than 100. Reject loudly so the TU learns the misuse
    // (mirrors SIP.js's throw); the fire-and-forget sendResponse wrapper
    // consumes the rejection.
    if (code > 100 && code <= 199) {
      return Promise.reject(
        new SipError(0, 'non-INVITE provisional response other than 100 is not allowed (RFC 4320 §4.1)'),
      );
    }
```

- [ ] **Step 8: Run tests to verify they pass**

Run: `npx vitest run packages/core/test/transactions/transitions.test.ts packages/core/test/transactions/non-invite-server.test.ts`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add packages/core/src/transactions/non-invite-server.ts packages/core/test/transactions/non-invite-server.test.ts packages/core/test/transactions/transitions.test.ts
git commit -m "fix(core): enforce RFC 4320 on non-INVITE server transactions and assert transitions"
```

---

### Task 6: Transaction response-matrix coverage

Borrows SIP.js's `transactions.spec.ts` pattern: an exhaustive (state × response-class) grid per transaction, each cell asserting the resulting state, TU delivery, and wire sends. Green on write because Tasks 1–5 already landed — its job is to make any routing or guard regression fail loudly at the exact cell.

**Files:**
- Create: `packages/core/test/transactions/response-matrix.test.ts`

**Interfaces:**
- Consumes: the four `*_TRANSITIONS` tables and `setState` routing (Tasks 2–5) — every cell asserts a routed state — and Task 5's RFC 4320 reject (the `180` cells of the non-INVITE server matrix assert `rejected: true`).
- Produces: a 63-cell regression grid (24 ICT + 18 NICT + 10 IST + 11 NIST). No new production code.

- [ ] **Step 1: Write the matrix tests**

Create `packages/core/test/transactions/response-matrix.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { InviteClientTransaction } from '../../src/transactions/invite-client.js';
import { NonInviteClientTransaction } from '../../src/transactions/non-invite-client.js';
import { InviteServerTransaction } from '../../src/transactions/invite-server.js';
import { NonInviteServerTransaction } from '../../src/transactions/non-invite-server.js';
import { deriveTimers } from '../../src/transactions/timers.js';
import type { TransactionLayerEvent } from '../../src/transactions/types.js';
import type { SipRequestMessage, SipResponseMessage } from '../../src/messages/message.js';
import { Headers, makeRequest, makeResponse } from '../../src/messages/index.js';
import { FakeClock } from '../support/fake-clock.js';
import { FakeTransport } from '../support/fake-transport.js';

const TIMERS = deriveTimers({ T1: 500, T2: 4000, T4: 5000 }, true);

type Class = '1xx' | '2xx' | '3xx' | '4xx' | '5xx' | '6xx';
const CLASS_CODES: Record<Class, number> = { 1xx: 180, 2xx: 200, 3xx: 300, 4xx: 404, 5xx: 500, 6xx: 603 };

interface ClientCell { state: string; tu: number; sends: number }
interface ServerCell { state: string; sends: number }
type RejectCell = ServerCell & { rejected: true };

function makeRequestMsg(method: string): SipRequestMessage {
  return { kind: 'request', method, uri: 'sip:example.com', headers: new Headers(), body: new Uint8Array() };
}

function response(code: number, method: string): SipResponseMessage {
  const headers = new Headers();
  headers.set('CSeq', `1 ${method}`);
  return makeResponse(code, 'x', headers);
}

interface ClientFixture {
  tx: InviteClientTransaction | NonInviteClientTransaction;
  events: TransactionLayerEvent[];
  transport: FakeTransport;
}

function clientFixture(method: string): ClientFixture {
  const clock = new FakeClock();
  const transport = new FakeTransport({ reliable: true, framing: 'datagram' });
  void transport.connect();
  const events: TransactionLayerEvent[] = [];
  const tx = method === 'INVITE'
    ? new InviteClientTransaction({
        request: makeRequestMsg('INVITE'),
        key: 'branch|example.com:5060|INVITE',
        transport, clock, timers: TIMERS, reliable: true,
        emit: (e) => events.push(e),
        buildNon2xxAck: (req) => makeRequest('ACK', req.uri),
      })
    : new NonInviteClientTransaction({
        request: makeRequestMsg(method),
        key: `branch|example.com:5060|${method}`,
        transport, clock, timers: TIMERS, reliable: true,
        emit: (e) => events.push(e),
        buildNon2xxAck: (req) => makeRequest('ACK', req.uri),
      });
  return { tx, events, transport };
}

function runClient(f: ClientFixture, reach: Class | null, then: Class): ClientCell {
  f.tx.start();
  if (reach !== null) f.tx.receive(response(CLASS_CODES[reach], f.tx.request.method));
  const tuBefore = f.events.filter((e) => e.type === 'response').length;
  const sentBefore = f.transport.sent.length;
  f.tx.receive(response(CLASS_CODES[then], f.tx.request.method));
  return {
    state: f.tx.state,
    tu: f.events.filter((e) => e.type === 'response').length - tuBefore,
    sends: f.transport.sent.length - sentBefore,
  };
}

interface ServerFixture {
  tx: InviteServerTransaction | NonInviteServerTransaction;
  transport: FakeTransport;
}

function serverFixture(method: string): ServerFixture {
  const clock = new FakeClock();
  const transport = new FakeTransport({ reliable: true, framing: 'datagram' });
  void transport.connect();
  const tx = method === 'INVITE'
    ? new InviteServerTransaction({
        request: makeRequestMsg('INVITE'),
        key: 'branch|example.com:5060|INVITE',
        transport, clock, timers: TIMERS, reliable: true,
        emit: () => {},
      })
    : new NonInviteServerTransaction({
        request: makeRequestMsg(method),
        key: `branch|example.com:5060|${method}`,
        transport, clock, timers: TIMERS, reliable: true,
        emit: () => {},
      });
  return { tx, transport };
}

async function runInviteServer(reach: number | null, then: number): Promise<ServerCell> {
  const f = serverFixture('INVITE');
  f.tx.receiveRequest(f.tx.request);
  if (reach !== null) await f.tx.sendResponseAwait(response(reach, 'INVITE'));
  const sentBefore = f.transport.sent.length;
  await f.tx.sendResponseAwait(response(then, 'INVITE'));
  return { state: f.tx.state, sends: f.transport.sent.length - sentBefore };
}

async function runNonInviteServer(reach: number | null, then: number): Promise<ServerCell | RejectCell> {
  const f = serverFixture('OPTIONS');
  f.tx.receiveRequest(f.tx.request);
  if (reach !== null) await f.tx.sendResponseAwait(response(reach, 'OPTIONS'));
  const sentBefore = f.transport.sent.length;
  try {
    await f.tx.sendResponseAwait(response(then, 'OPTIONS'));
    return { rejected: false, state: f.tx.state, sends: f.transport.sent.length - sentBefore };
  } catch {
    return { rejected: true, state: f.tx.state, sends: f.transport.sent.length - sentBefore };
  }
}

const INVITE_CLIENT_MATRIX: [string, Class | null, Class, ClientCell][] = [
  ['Calling', null, '1xx', { state: 'Proceeding', tu: 1, sends: 0 }],
  ['Calling', null, '2xx', { state: 'Accepted', tu: 1, sends: 0 }],
  ['Calling', null, '3xx', { state: 'Completed', tu: 1, sends: 1 }],
  ['Calling', null, '4xx', { state: 'Completed', tu: 1, sends: 1 }],
  ['Calling', null, '5xx', { state: 'Completed', tu: 1, sends: 1 }],
  ['Calling', null, '6xx', { state: 'Completed', tu: 1, sends: 1 }],
  ['Proceeding', '1xx', '1xx', { state: 'Proceeding', tu: 1, sends: 0 }],
  ['Proceeding', '1xx', '2xx', { state: 'Accepted', tu: 1, sends: 0 }],
  ['Proceeding', '1xx', '3xx', { state: 'Completed', tu: 1, sends: 1 }],
  ['Proceeding', '1xx', '4xx', { state: 'Completed', tu: 1, sends: 1 }],
  ['Proceeding', '1xx', '5xx', { state: 'Completed', tu: 1, sends: 1 }],
  ['Proceeding', '1xx', '6xx', { state: 'Completed', tu: 1, sends: 1 }],
  ['Accepted', '2xx', '1xx', { state: 'Accepted', tu: 0, sends: 0 }],
  ['Accepted', '2xx', '2xx', { state: 'Accepted', tu: 1, sends: 0 }],
  ['Accepted', '2xx', '3xx', { state: 'Accepted', tu: 0, sends: 0 }],
  ['Accepted', '2xx', '4xx', { state: 'Accepted', tu: 0, sends: 0 }],
  ['Accepted', '2xx', '5xx', { state: 'Accepted', tu: 0, sends: 0 }],
  ['Accepted', '2xx', '6xx', { state: 'Accepted', tu: 0, sends: 0 }],
  ['Completed', '3xx', '1xx', { state: 'Completed', tu: 0, sends: 0 }],
  ['Completed', '3xx', '2xx', { state: 'Completed', tu: 0, sends: 0 }],
  ['Completed', '3xx', '3xx', { state: 'Completed', tu: 0, sends: 1 }],
  ['Completed', '3xx', '4xx', { state: 'Completed', tu: 0, sends: 1 }],
  ['Completed', '3xx', '5xx', { state: 'Completed', tu: 0, sends: 1 }],
  ['Completed', '3xx', '6xx', { state: 'Completed', tu: 0, sends: 1 }],
];

const NON_INVITE_CLIENT_MATRIX: [string, Class | null, Class, ClientCell][] = [
  ['Trying', null, '1xx', { state: 'Proceeding', tu: 1, sends: 0 }],
  ['Trying', null, '2xx', { state: 'Completed', tu: 1, sends: 0 }],
  ['Trying', null, '3xx', { state: 'Completed', tu: 1, sends: 0 }],
  ['Trying', null, '4xx', { state: 'Completed', tu: 1, sends: 0 }],
  ['Trying', null, '5xx', { state: 'Completed', tu: 1, sends: 0 }],
  ['Trying', null, '6xx', { state: 'Completed', tu: 1, sends: 0 }],
  ['Proceeding', '1xx', '1xx', { state: 'Proceeding', tu: 1, sends: 0 }],
  ['Proceeding', '1xx', '2xx', { state: 'Completed', tu: 1, sends: 0 }],
  ['Proceeding', '1xx', '3xx', { state: 'Completed', tu: 1, sends: 0 }],
  ['Proceeding', '1xx', '4xx', { state: 'Completed', tu: 1, sends: 0 }],
  ['Proceeding', '1xx', '5xx', { state: 'Completed', tu: 1, sends: 0 }],
  ['Proceeding', '1xx', '6xx', { state: 'Completed', tu: 1, sends: 0 }],
  ['Completed', '2xx', '1xx', { state: 'Completed', tu: 0, sends: 0 }],
  ['Completed', '2xx', '2xx', { state: 'Completed', tu: 0, sends: 0 }],
  ['Completed', '2xx', '3xx', { state: 'Completed', tu: 0, sends: 0 }],
  ['Completed', '2xx', '4xx', { state: 'Completed', tu: 0, sends: 0 }],
  ['Completed', '2xx', '5xx', { state: 'Completed', tu: 0, sends: 0 }],
  ['Completed', '2xx', '6xx', { state: 'Completed', tu: 0, sends: 0 }],
];

const INVITE_SERVER_MATRIX: [string, number | null, number, ServerCell][] = [
  ['Proceeding', null, 180, { state: 'Proceeding', sends: 1 }],
  ['Proceeding', null, 200, { state: 'Accepted', sends: 1 }],
  ['Proceeding', null, 300, { state: 'Completed', sends: 1 }],
  ['Proceeding', null, 404, { state: 'Completed', sends: 1 }],
  ['Accepted', 200, 180, { state: 'Accepted', sends: 0 }],
  ['Accepted', 200, 200, { state: 'Accepted', sends: 1 }],
  ['Accepted', 200, 300, { state: 'Accepted', sends: 0 }],
  ['Completed', 404, 100, { state: 'Completed', sends: 0 }],
  ['Completed', 404, 200, { state: 'Completed', sends: 0 }],
  ['Completed', 404, 300, { state: 'Completed', sends: 0 }],
];

const NON_INVITE_SERVER_MATRIX: [string, number | null, number, ServerCell | RejectCell][] = [
  ['Trying', null, 100, { state: 'Proceeding', sends: 1 }],
  ['Trying', null, 180, { rejected: true, state: 'Trying', sends: 0 }],
  ['Trying', null, 200, { state: 'Completed', sends: 1 }],
  ['Trying', null, 404, { state: 'Completed', sends: 1 }],
  ['Proceeding', 100, 100, { state: 'Proceeding', sends: 1 }],
  ['Proceeding', 100, 180, { rejected: true, state: 'Proceeding', sends: 0 }],
  ['Proceeding', 100, 200, { state: 'Completed', sends: 1 }],
  ['Completed', 200, 100, { state: 'Completed', sends: 0 }],
  ['Completed', 200, 180, { rejected: true, state: 'Completed', sends: 0 }],
  ['Completed', 200, 200, { state: 'Completed', sends: 0 }],
  ['Completed', 200, 404, { state: 'Completed', sends: 0 }],
];

describe('INVITE client — response matrix (RFC 3261 fig 5 / RFC 6026 §8.4)', () => {
  it.each(INVITE_CLIENT_MATRIX)('%s then %s -> %o', (_label, reach, then, want) => {
    expect(runClient(clientFixture('INVITE'), reach, then)).toEqual(want);
  });
});

describe('non-INVITE client — response matrix (RFC 3261 fig 6)', () => {
  it.each(NON_INVITE_CLIENT_MATRIX)('%s then %s -> %o', (_label, reach, then, want) => {
    expect(runClient(clientFixture('REGISTER'), reach, then)).toEqual(want);
  });
});

describe('INVITE server — TU-response matrix (RFC 3261 fig 7 / RFC 6026 §8.5-8.7)', () => {
  it.each(INVITE_SERVER_MATRIX)('%s then %s -> %o', async (_label, reach, then, want) => {
    expect(await runInviteServer(reach, then)).toEqual(want);
  });
});

describe('non-INVITE server — TU-response matrix (RFC 3261 fig 8 / RFC 4320 §4.1)', () => {
  it.each(NON_INVITE_SERVER_MATRIX)('%s then %s -> %o', async (_label, reach, then, want) => {
    expect(await runNonInviteServer(reach, then)).toEqual(want);
  });
});
```

Note: every fixture uses `reliable: true`, and the clock is never advanced, so no timer fires mid-cell (IST's auto-100 at 200 ms is cancelled by the first `sendResponseAwait`; the IST `Completed`/NIST `Completed` cells arm Timer H/J but the virtual clock never advances past them).

- [ ] **Step 2: Run tests to verify they pass**

Run: `npx vitest run packages/core/test/transactions/response-matrix.test.ts`
Expected: PASS (63 tests). Green on write: the state cells validate Tasks 2–5's `setState` routing, and the NIST `180` cells validate Task 5's rejection. If any cell fails, the routing table or guard it names is wrong.

- [ ] **Step 3: Commit**

```bash
git add packages/core/test/transactions/response-matrix.test.ts
git commit -m "test(core): cover the transaction response matrices end to end"
```

---

### Task 7: Changelog entry + full verification

**Files:**
- Modify: `CHANGELOG.md` (`[Unreleased]` section, currently empty)

**Interfaces:**
- Consumes: the completed transaction-layer changes from Tasks 1–6.

- [ ] **Step 1: Add the Unreleased entry**

In `CHANGELOG.md`, under `## [Unreleased]` add:

```markdown
### Fixed

- **RFC 4320 compliance.** A non-INVITE request (e.g. `OPTIONS`, `BYE`,
  `CANCEL`) is no longer answered with a provisional response other than
  `100 Trying`; the non-INVITE server transaction rejects `101-199` responses
  from the TU with a `PROTOCOL_ERROR` `SipError` and sends nothing.

### Changed

- **Asserted transaction transitions.** The four RFC 3261 transaction state
  machines now route every state change through a transition table check
  (RFC 3261 figures 5-8, RFC 6026), so an illegal transition throws instead of
  silently corrupting transaction state. No behavioral change in valid flows.
```

- [ ] **Step 2: Run the full suite**

Run: `npm run typecheck && npm test && npm run test:architecture && npm run test:api`
Expected: all green. `test:api` proves no public API surface changed.

- [ ] **Step 3: Commit**

```bash
git add CHANGELOG.md
git commit -m "docs(changelog): record RFC 4320 guard and asserted transaction transitions"
```

---

## Self-Review

**Spec coverage.** The diff's Findings item 1 (RFC 4320 guard) is Task 5; item 2 (transition assertions) is Tasks 1–5; the SIP.js test-suite review's enumeration pattern is Task 6 (a 63-cell response matrix across all four transactions). The diff's other items (408-as-timeout, per-to-tag ACK tracking, Accepted-state duplicate INVITE) are deliberately out of scope — they are dialog-layer confirmations, not the transaction-layer changes offered. Each task leaves the suite green with a single logical commit.

**Placeholder scan.** Every step has concrete code, run commands, and expected outcomes. No TBD/TODO. The four transition tables are spelled out fully in each task; no "similar to Task N".

**Type consistency.** `assertTransition(table, from, to)` and `TransitionTable<S>` are defined once in Task 1 and consumed identically in Tasks 2–5. Table names are consistent: `INVITE_CLIENT_TRANSITIONS`, `INVITE_SERVER_TRANSITIONS`, `NON_INVITE_CLIENT_TRANSITIONS`, `NON_INVITE_SERVER_TRANSITIONS`, each typed against its own class's state union. `setState(next)` takes the class's own state type in each file. Task 6's matrix uses the existing harness names verbatim — `makeRequest`/`makeResponse` from `../../src/messages/index.js`, `FakeClock`, `FakeTransport({ reliable, framing })`, `deriveTimers(config, reliable)`, `buildNon2xxAck: (req) => makeRequest('ACK', req.uri)` — all cross-checked against the current test files. Line numbers match the current source (verified against the 0.7.0 tree).

**Edge cases checked.** `Terminated` is a legal target from every state in all four tables because `terminate(error)` may fire from any state on a transport error. The guard range `code > 100 && code <= 199` leaves `100` flowing through the existing `code <= 199 → Proceeding` path, and rejects `180` consistently in Trying, Proceeding, **and** Completed (mirroring SIP.js, whose 4320 check also precedes the state switch). The `duplicate … resends the latest response` test only changes its literal `180` → `100`, keeping its sent-count assertions valid. Task 6's server fixtures never advance the virtual clock, so no IST/NIST timer can fire mid-cell; the NIST `180` reject cells, Task 5's focused guard test, and the changelog entry all describe the same rejection behavior.
