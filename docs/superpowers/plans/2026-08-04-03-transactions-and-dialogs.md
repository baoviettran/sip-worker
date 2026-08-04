# Transactions and Dialogs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the four RFC 3261 transaction machines updated by RFC 6026, automatic branch matching, both ACK paths, and dialog routing/CSeq state.

**Architecture:** Separate INVITE/non-INVITE client/server classes share only timer bookkeeping and serialization helpers; transition tables remain visible and independently tested. `TransactionCoordinator` owns branch registration and non-2xx ACKs. `Dialog` owns 2xx ACK and later in-dialog requests.

**Tech Stack:** TypeScript, Vitest, Plan 02 `Clock`/`Transport`, virtual time only.

## Global Constraints

- Requires Plans 01–02 green.
- Timer defaults: T1=500ms, T2=4000ms, T4=5000ms.
- Timer D is 0 reliable and `max(32000, 64*T1)` unreliable.
- Timers L and M are always `64*T1`, including reliable transports.
- Timers I/J/K are 0 reliable and T4/64*T1/T4 respectively when unreliable.
- Non-2xx ACK reuses the INVITE branch and numeric CSeq; 2xx ACK uses a new branch and the INVITE numeric CSeq.
- Transaction matching is installed before the first transport send.
- Every timer callback checks current state and every termination clears all owned timers.

---

### Task 1: Clock adapter, timer configuration, and event types

**Files:**
- Create: `src/transactions/timers.ts`
- Create: `src/transactions/types.ts`
- Create: `test/transactions/timers.test.ts`

**Interfaces:**
- Consumes: Plan 02 `Clock`, `TransportCapabilities`, and codec messages.
- Produces: `TimerConfig`, derived timer functions, transaction keys/states/events, and `ClientTransaction` interface.

- [ ] **Step 1: Write failing timer-derivation tests**

```ts
expect(deriveTimers(DEFAULT_TIMERS, true)).toMatchObject({ D: 0, I: 0, J: 0, K: 0, L: 32000, M: 32000 });
expect(deriveTimers(DEFAULT_TIMERS, false)).toMatchObject({ D: 32000, I: 5000, J: 32000, K: 5000 });
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/transactions/timers.test.ts`

Expected: FAIL because transaction timer types are absent.

- [ ] **Step 3: Define exact types**

```ts
export interface TimerConfig { readonly T1: number; readonly T2: number; readonly T4: number; }
export const DEFAULT_TIMERS: TimerConfig = { T1: 500, T2: 4000, T4: 5000 };
export interface DerivedTimers extends TimerConfig { readonly B: number; readonly D: number; readonly F: number; readonly H: number; readonly I: number; readonly J: number; readonly K: number; readonly L: number; readonly M: number; }
export type TransactionKey = `${string}|${string}`; // top Via branch | CSeq method
export interface ClientTransaction { readonly key: TransactionKey; readonly request: SipRequestMessage; readonly state: string; }
export type TransactionLayerEvent =
  | { type: 'response'; transaction: ClientTransaction; response: SipResponseMessage }
  | { type: 'request'; transaction: ServerTransaction; request: SipRequestMessage }
  | { type: 'statelessRequest'; request: SipRequestMessage }
  | { type: 'timeout'; key: TransactionKey }
  | { type: 'transportError'; key: TransactionKey; error: TransportError }
  | { type: 'terminated'; key: TransactionKey };
```

`deriveTimers` sets B/F/H/L/M to `64*T1`, D as specified above, and I/J/K by reliability. Export helpers `schedule`, `cancel`, and `cancelAll` that use injected `Clock` numeric IDs.

- [ ] **Step 4: Verify**

Run: `npx vitest run test/transactions/timers.test.ts && npm run typecheck && npm test`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/transactions test/transactions/timers.test.ts
git commit -m "feat: define exact SIP transaction timers and events"
```

### Task 2: INVITE and non-INVITE client machines

**Files:**
- Create: `src/transactions/invite-client.ts`
- Create: `src/transactions/non-invite-client.ts`
- Create: `test/transactions/invite-client.test.ts`
- Create: `test/transactions/non-invite-client.test.ts`

**Interfaces:**
- Consumes: timer/event types, serialized transport send.
- Produces: client state machines with `start()`, `receive(response)`, `terminate(error?)`.

- [ ] **Step 1: Write failing table-driven tests**

INVITE client matrix:

| State | Input | Action | Next |
|---|---|---|---|
| Calling | Timer A, unreliable | resend; interval doubles without a T2 cap | Calling |
| Calling/Proceeding | Timer B | emit timeout | Terminated |
| Calling | 1xx | cancel A; emit response | Proceeding |
| Calling/Proceeding | 2xx | cancel A/B; emit; start M | Accepted |
| Accepted | matching 2xx | emit every response; do not restart M | Accepted |
| Calling/Proceeding | 300–699 | cancel A/B; send non-2xx ACK; emit; start D | Completed |
| Completed | repeated final | resend cached ACK; do not emit response | Completed |
| Accepted/Completed | M/D | terminate | Terminated |

Non-INVITE client matrix:

| State | Input | Action | Next |
|---|---|---|---|
| Trying | Timer E, unreliable | resend; `min(2*interval,T2)` | Trying |
| Trying | 1xx | emit; set E interval T2 | Proceeding |
| Proceeding | Timer E, unreliable | resend at T2 | Proceeding |
| Trying/Proceeding | Timer F | emit timeout | Terminated |
| Trying/Proceeding | 200–699 | cancel E/F; emit; start K | Completed |
| Completed | Timer K | terminate | Terminated |

- [ ] **Step 2: Run tests to verify failure**

Run: `npx vitest run test/transactions/*client.test.ts`

Expected: FAIL because machines are absent.

- [ ] **Step 3: Implement one timer slot per RFC timer**

Both constructors receive `{ request, key, transport, clock, timers, reliable, emit, buildNon2xxAck }`. `start()` performs the first send exactly once, then arms timeout/retransmit timers. Promise rejections from every send emit `transportError` and terminate. Response methods ignore nonmatching CSeq methods and invalid status codes. The INVITE machine caches the generated ACK bytes when first entering Completed.

- [ ] **Step 4: Verify exact boundaries**

Run: `npx vitest run test/transactions/*client.test.ts && npm run typecheck && npm test`

Expected: PASS; assertions cover one millisecond before and exactly at every timer.

- [ ] **Step 5: Commit**

```bash
git add src/transactions/*client.ts test/transactions/*client.test.ts
git commit -m "feat: implement RFC SIP client transactions"
```

### Task 3: INVITE and non-INVITE server machines

**Files:**
- Create: `src/transactions/invite-server.ts`
- Create: `src/transactions/non-invite-server.ts`
- Create: `test/transactions/invite-server.test.ts`
- Create: `test/transactions/non-invite-server.test.ts`

**Interfaces:**
- Consumes: Task 1 types and transport.
- Produces: server machines with `receiveRequest`, `sendResponse`, and state-specific duplicate and retransmission routing.

- [ ] **Step 1: Write failing server transition tests**

INVITE server matrix:

| State | Input | Action | Next |
|---|---|---|---|
| initial | INVITE | emit request; arm 200ms automatic-100 timer | Proceeding |
| Proceeding | repeated INVITE | resend cached response if present | Proceeding |
| Proceeding | automatic-100 timer with no TU response | send/cache 100 Trying | Proceeding |
| Proceeding | 1xx from TU | send/cache | Proceeding |
| Proceeding | 2xx from TU | send; start L | Accepted |
| Accepted | repeated INVITE | pass request to TU so it can resend 2xx | Accepted |
| Accepted | 2xx from TU | send | Accepted |
| Proceeding | 300–699 from TU | send/cache; start G unreliable and H | Completed |
| Completed | repeated INVITE | resend cached final | Completed |
| Completed | matching ACK | cancel G/H; start I | Confirmed |
| Completed | Timer G | resend; double interval to T2 | Completed |
| Completed | Timer H | emit timeout; terminate | Terminated |
| Accepted/Confirmed | L/I | terminate | Terminated |

Non-INVITE server matrix: initial request → Trying/emit; 1xx → Proceeding/send; final → Completed/send/start J; duplicate in Trying/Proceeding/Completed resends the latest response when present; J terminates.

- [ ] **Step 2: Run tests to verify failure**

Run: `npx vitest run test/transactions/*server.test.ts`

Expected: FAIL because machines are absent.

- [ ] **Step 3: Implement and cancel Timer H on ACK**

Server constructors receive the same dependencies as clients except ACK construction. The INVITE server owns a separate 200ms automatic-100 timer and cancels it on any TU response. Reliable transports never arm G and use zero I/J, but always arm H/L. Every response send failure emits `transportError` without prematurely discarding INVITE server state; RFC timers still terminate it.

- [ ] **Step 4: Verify**

Run: `npx vitest run test/transactions/*server.test.ts && npm run typecheck && npm test`

Expected: PASS, including no Timer H timeout after a matching ACK.

- [ ] **Step 5: Commit**

```bash
git add src/transactions/*server.ts test/transactions/*server.test.ts
git commit -m "feat: implement RFC SIP server transactions"
```

### Task 4: Transaction coordinator, matching, and non-2xx ACK

**Files:**
- Create: `src/transactions/coordinator.ts`
- Create: `src/transactions/ack.ts`
- Create: `src/transactions/index.ts`
- Create: `test/transactions/coordinator.test.ts`
- Create: `test/transactions/ack.test.ts`

**Interfaces:**
- Consumes: all four machines and Plan 02 `MessageSink`.
- Produces: frozen `TransactionLayer`; `buildNon2xxAck(invite,response): SipRequestMessage`.

- [ ] **Step 1: Write failing matching and ACK tests**

```ts
it('tracks before synchronous transport delivery', () => {
  transport.onSend = (bytes) => ingressResponseWithSameBranch(bytes);
  const tx = layer.sendRequest(invite);
  expect(events).toContainEqual(expect.objectContaining({ type: 'response', transaction: tx }));
});

it('builds transaction ACK with original branch and numeric CSeq', () => {
  const ack = buildNon2xxAck(invite, response486);
  expect(topBranch(ack)).toBe(topBranch(invite));
  expect(ack.headers.get('CSeq')).toBe('41 ACK');
  expect(ack.headers.get('To')).toBe(response486.headers.get('To'));
});
```
Also test that an ACK with a fresh 2xx branch emits one `statelessRequest`, creates no server transaction, and remains available for dialog matching.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/transactions/coordinator.test.ts test/transactions/ack.test.ts`

Expected: FAIL because coordinator/ACK builder are absent.

- [ ] **Step 3: Implement RFC matching order**

Client key is top Via branch plus CSeq method. Server key is top Via branch plus request method, except ACK for non-2xx maps to INVITE. `sendRequest` validates the magic-cookie branch, constructs the correct client class, inserts it in the map, then calls `start`. `receive` routes responses to clients; routes duplicate requests and matching non-2xx ACKs to servers; emits unmatched ACKs as `statelessRequest` for dialog/TU matching without creating a transaction; creates a new server transaction for other unmatched requests; drops unmatched responses; removes maps only after `terminated`.

`buildNon2xxAck` copies request URI, top Via unchanged, Route, From, Call-ID, Max-Forwards, and numeric CSeq; replaces To from the final response; drops body and content headers; sets method/CSeq method to ACK.

- [ ] **Step 4: Verify plan transaction gate**

Run: `npx vitest run test/transactions && npm run typecheck && npm test`

Expected: PASS for reliable and unreliable parameterized matrices.

- [ ] **Step 5: Commit**

```bash
git add src/transactions test/transactions
git commit -m "feat: coordinate SIP transactions and non-2xx ACKs"
```

### Task 5: Dialog creation, 2xx ACK, BYE, and route sets

**Files:**
- Create: `src/dialogs/dialog.ts`
- Create: `src/dialogs/header-values.ts`
- Create: `src/dialogs/index.ts`
- Create: `test/dialogs/dialog.test.ts`

**Interfaces:**
- Consumes: INVITE request/2xx response and injected `IdGenerator { branch(): string }`.
- Produces: `Dialog.fromUac(invite,response,idGenerator)`, `createAck(response)`, `createRequest(method)`, `receiveRequest(request)`.

- [ ] **Step 1: Write failing dialog tests**

Test remote tag from To, local tag from From, remote target from Contact, UAC route set as reversed Record-Route order, strict/loose routing, remote CSeq monotonic rejection, ACK numeric CSeq equality, ACK new branch, and BYE incrementing local CSeq exactly once.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/dialogs/dialog.test.ts`

Expected: FAIL because dialog modules are absent.

- [ ] **Step 3: Implement separate ACK and ordinary-request builders**

`createAck` does not mutate `localCSeq`; it uses the INVITE numeric CSeq and method ACK, a fresh Via branch, dialog target/route set, From/To tags, Call-ID, and Max-Forwards. `createRequest` increments local CSeq before constructing BYE/other in-dialog requests. `receiveRequest` rejects a lower/equal remote CSeq except ACK/CANCEL, then updates remote CSeq.

- [ ] **Step 4: Run the plan gate**

Run: `npx vitest run test/transactions test/dialogs && npm run typecheck && npm test && npm run build`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/dialogs test/dialogs src/index.ts
git commit -m "feat: add SIP dialog routing and ACK/BYE construction"
```
