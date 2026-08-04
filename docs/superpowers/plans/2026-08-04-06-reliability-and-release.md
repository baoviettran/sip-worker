# Reliability and Release Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the completed SIP call stack into a recoverable, environment-safe package with deterministic liveness, worker restart, malformed-input tolerance, and verified ESM/CommonJS/type exports.

**Architecture:** Liveness is an injected strategy at the UserAgent composition root: Node WebSocket deployments may supply native Ping/Pong, while browser deployments use SIP OPTIONS transactions. A main-thread supervisor owns worker heartbeat and replacement, and restores registration continuity from an explicit serializable snapshot of the existing UserAgent options and identity. Release tests exercise public package artifacts rather than source paths.

**Tech Stack:** TypeScript, Vitest, virtual clock, Node worker threads, browser-compatible message ports, tsup package fixtures.

## Global Constraints

- Requires Plans 01–05 green.
- Liveness uses the injected `Clock`; tests never wait in real time.
- Node WebSocket Ping/Pong is enabled only when the injected socket exposes native ping/pong hooks.
- Browser WebSocket code never calls or emulates protocol-level Ping/Pong.
- SIP OPTIONS liveness runs through `TransactionLayer`, with at most one probe transaction outstanding.
- Worker protocol messages are structured-clone-safe and contain no class instances, callbacks, or sockets; credentials are confined to recovery bootstrap data and redacted from errors and events.
- A worker death rejects all pending operations before replacement; live calls are not reconstructed in v1.
- Registration continuity preserves Call-ID and advances CSeq; it never reuses a CSeq.
- Tolerance tests may accept or reject malformed input, but parsing must never throw or hang.
- Release acceptance imports the packed tarball in isolated ESM and CommonJS consumers and compiles its declarations.

---

### Task 1: Node WebSocket Ping/Pong liveness

**Files:**
- Create: `src/reliability/liveness.ts`
- Create: `src/reliability/node-ws-liveness.ts`
- Create: `src/reliability/index.ts`
- Create: `test/reliability/node-ws-liveness.test.ts`
- Modify: `src/transport/node/ws.ts`

**Interfaces:**
- Consumes: injected Clock, native Node WebSocket ping/pong adapter, disconnect callback.
- Produces: common `LivenessStrategy` lifecycle and typed timeout failure.

- [ ] **Step 1: Write failing virtual-clock tests**

Test start sends no immediate probe, the interval sends one native ping, matching pong clears its deadline, the next interval can ping again, and a missed pong emits one `TransportError` then stops. Also test idempotent start/stop, no overlapping pings, late pong after stop, and listener cleanup.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/reliability/node-ws-liveness.test.ts`

Expected: FAIL because the reliability modules are absent.

- [ ] **Step 3: Implement the narrow capability boundary**

```ts
export interface LivenessStrategy {
  start(): void;
  stop(): void;
}

export interface NativePingSocket {
  ping(payload: Uint8Array): void;
  onPong(listener: (payload: Uint8Array) => void): () => void;
}
```

`NodeWebSocketLiveness` generates one nonce per probe period, sends it with `ping`, and accepts only the matching pong. It owns exactly one scheduled probe timer and one deadline timer. On timeout it stops first, then reports `new TransportError('liveness timeout')`. `NodeWebSocketTransport` adapts the optional injected `ws` implementation to `NativePingSocket`; it does not widen the shared Transport interface.

- [ ] **Step 4: Verify**

Run: `npx vitest run test/reliability/node-ws-liveness.test.ts test/transport/node-ws.test.ts && npm run typecheck && npm test`

Expected: PASS with no application data frames used as Ping/Pong.

- [ ] **Step 5: Commit**

```bash
git add src/reliability src/transport/node/ws.ts test/reliability test/transport/node-ws.test.ts
git commit -m "feat: add native Node WebSocket liveness"
```

### Task 2: Browser-safe SIP OPTIONS liveness

**Files:**
- Create: `src/reliability/options-liveness.ts`
- Create: `test/reliability/options-liveness.test.ts`
- Modify: `src/reliability/index.ts`
- Modify: `src/ua/user-agent.ts`

**Interfaces:**
- Consumes: TransactionLayer, Clock, request factory, liveness failure callback.
- Produces: environment-neutral `LivenessStrategy` selected when native Ping/Pong is unavailable.

- [ ] **Step 1: Write failing OPTIONS probe tests**

Test a probe period builds OPTIONS with a fresh Via branch and monotonically increasing CSeq, sends it through a non-INVITE client transaction, treats any final response as peer liveness, and schedules the next probe. Test transaction timeout/transport error reports one liveness failure, provisional responses do not complete a probe, a slow probe prevents overlap, and stop unsubscribes from the owned probe without scheduling another.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/reliability/options-liveness.test.ts`

Expected: FAIL because OPTIONS liveness is absent.

- [ ] **Step 3: Implement transaction-owned probes**

`OptionsLiveness` schedules a probe only while started and connected. It asks the injected request factory for a complete OPTIONS request, subscribes to transaction-layer events for the returned client transaction, and clears its outstanding slot only on final response or terminal failure. It never writes directly to WebSocket and never treats SIP traffic as a protocol-level WebSocket pong. `UserAgent` accepts an optional injected `LivenessStrategy` and defaults to OPTIONS; the Node composition root explicitly supplies `NodeWebSocketLiveness` when its adapter exposes `NativePingSocket`.

- [ ] **Step 4: Verify**

Run: `npx vitest run test/reliability/options-liveness.test.ts test/ua/user-agent.test.ts && npm run typecheck && npm test`

Expected: PASS in a test environment with no `window`, `WebSocket`, or Node `ws` global.

- [ ] **Step 5: Commit**

```bash
git add src/reliability src/ua/user-agent.ts test/reliability test/ua/user-agent.test.ts
git commit -m "feat: add SIP OPTIONS liveness strategy"
```

### Task 3: Worker heartbeat, replacement, and registration continuity

**Files:**
- Create: `src/bridge/worker-protocol.ts`
- Create: `src/bridge/worker-runtime.ts`
- Create: `src/bridge/worker-supervisor.ts`
- Create: `src/bridge/index.ts`
- Create: `test/bridge/worker-supervisor.test.ts`
- Create: `test/integration/worker-recovery.test.ts`

**Interfaces:**
- Consumes: serializable commands/events, injected WorkerFactory, Clock, registration snapshot.
- Produces: heartbeat detection, typed restart events, replacement worker bootstrap.

- [ ] **Step 1: Write failing supervisor tests**

Test bootstrap → ping(nonce) → pong(nonce), ignored stale nonce, missed deadline, `workerDied`, rejection of pending commands, old-worker listener teardown, one replacement, bootstrap with registration snapshot, reconnect/register, then `workerRestarted`. Assert a snapshot with Call-ID `reg-a` and next CSeq 18 produces replacement REGISTER CSeq 18 and advances persisted next CSeq to 19.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/bridge/worker-supervisor.test.ts test/integration/worker-recovery.test.ts`

Expected: FAIL because worker bridge modules are absent.

- [ ] **Step 3: Define and implement the serializable protocol**

```ts
export interface RegistrationSnapshot {
  readonly aor: string;
  readonly registrar: string;
  readonly credentials: { readonly username: string; readonly password: string };
  readonly registerExpires: number;
  readonly contactUri: string;
  readonly displayName?: string;
  readonly callId: string;
  readonly nextCSeq: number;
}

export type SupervisorToWorker =
  | { type: 'bootstrap'; generation: number; registration: RegistrationSnapshot }
  | { type: 'heartbeatPing'; generation: number; nonce: string };

export type WorkerToSupervisor =
  | { type: 'ready'; generation: number }
  | { type: 'heartbeatPong'; generation: number; nonce: string }
  | { type: 'registrationIdentity'; generation: number; callId: string; nextCSeq: number }
  | { type: 'registered'; generation: number };

export type SupervisorEvent =
  | { type: 'workerDied'; generation: number; error: WorkerRestartError }
  | { type: 'workerRestarted'; generation: number };
```

The supervisor retains the private recovery snapshot, updates only Call-ID and next CSeq from `registrationIdentity`, rejects every deferred belonging to the dead generation with `WorkerRestartError`, emits `workerDied`, terminates/detaches that worker, and creates one new generation. `WorkerRuntime` restores registration options, identity, and sequence state from bootstrap, then performs ordinary connect/register; it never echoes credentials in events or errors. Calls and dialogs end with the old generation and must be recreated by the application.

- [ ] **Step 4: Verify**

Run: `npx vitest run test/bridge test/integration/worker-recovery.test.ts && npm run typecheck && npm test`

Expected: PASS with deterministic event order and no duplicate REGISTER CSeq.

- [ ] **Step 5: Commit**

```bash
git add src/bridge test/bridge test/integration/worker-recovery.test.ts
git commit -m "feat: recover registration after worker failure"
```

### Task 4: Malformed-message tolerance corpus

**Files:**
- Create: `test/fixtures/tolerance/bare-lf.sip`
- Create: `test/fixtures/tolerance/folded-header.sip`
- Create: `test/fixtures/tolerance/duplicate-content-length.sip`
- Create: `test/fixtures/tolerance/invalid-start-line.sip`
- Create: `test/fixtures/tolerance/truncated-body.sip`
- Create: `test/fixtures/tolerance/non-utf8-body.sip`
- Create: `test/fixtures/tolerance/oversized-header.sip`
- Create: `test/messages/tolerance-corpus.test.ts`

**Interfaces:**
- Consumes: public byte parser and explicit parser limits.
- Produces: documented accept/reject classification with a never-throw invariant.

- [ ] **Step 1: Add fixtures and a failing classification table**

The table marks bare LF and obsolete folded headers as accepted compatibility inputs; invalid start line, conflicting duplicate Content-Length, truncated body, and oversized headers as rejected `ParseError`; non-UTF-8 body as accepted byte content. For every fixture, call the parser inside `expect(() => parse(bytes)).not.toThrow()` and separately assert the result classification and byte offset when rejected.

- [ ] **Step 2: Run to expose policy gaps**

Run: `npx vitest run test/messages/tolerance-corpus.test.ts`

Expected: FAIL only for classifications not yet supported; no fixture may crash or hang the runner.

- [ ] **Step 3: Make the smallest parser corrections**

Modify `src/messages/parser.ts` or `src/stream/decoder.ts` only where the corpus reveals a mismatch. Preserve raw body bytes, normalize accepted line folding to one space, reject conflicting Content-Length values, and return the first known bad byte offset.

- [ ] **Step 4: Verify**

Run: `npx vitest run test/messages test/stream && npm run typecheck && npm test`

Expected: PASS for the fixed classification table and all earlier codec tests.

- [ ] **Step 5: Commit**

```bash
git add src/messages/parser.ts src/stream/decoder.ts test/fixtures/tolerance test/messages/tolerance-corpus.test.ts
git commit -m "test: define malformed SIP tolerance policy"
```

### Task 5: Public exports and packed-consumer matrix

**Files:**
- Modify: `src/index.ts`
- Modify: `src/auth/index.ts`
- Modify: `src/transactions/index.ts`
- Modify: `src/dialogs/index.ts`
- Modify: `src/transport/index.ts`
- Modify: `src/ua/index.ts`
- Modify: `src/media/index.ts`
- Modify: `src/reliability/index.ts`
- Modify: `src/bridge/index.ts`
- Modify: `package.json`
- Modify: `tsup.config.ts`
- Modify: `test/package/exports.test.mjs`
- Create: `test/package/fixtures/esm/package.json`
- Create: `test/package/fixtures/esm/index.mjs`
- Create: `test/package/fixtures/cjs/package.json`
- Create: `test/package/fixtures/cjs/index.cjs`
- Create: `test/package/fixtures/types/tsconfig.json`
- Create: `test/package/fixtures/types/index.ts`

**Interfaces:**
- Consumes: every public barrel created by Plans 01–06.
- Produces: matching import/require/types entries for root and documented subpaths.

- [ ] **Step 1: Write a failing packed-artifact test**

Extend the Node package test to run `npm pack --json`, install the resulting tarball into fresh temporary ESM, CommonJS, and TypeScript consumer directories, and execute/compile their fixtures. Assert `.`, `./messages`, `./stream`, `./transport/node`, `./transport/browser`, `./transactions`, `./dialogs`, `./auth`, `./ua`, `./media`, `./reliability`, and `./bridge` resolve without importing source files.

- [ ] **Step 2: Run to verify failure**

Run: `npm run test:package`

Expected: FAIL until every subpath has matching runtime and declaration artifacts.

- [ ] **Step 3: Align barrels, build entries, and export conditions**

For each subpath, generate ESM `.js`, CommonJS `.cjs`, and `.d.ts`, then map `types`, `import`, and `require` to files that exist in the tarball. Keep Node-only adapters behind explicit subpaths and confirm importing the root in an empty Node process touches no browser, worker, socket, timer, or crypto global.

- [ ] **Step 4: Verify**

Run: `npm run build && npm run test:package && npm test && npm run typecheck`

Expected: PASS for installed tarball consumers, not merely workspace aliases.

- [ ] **Step 5: Commit**

```bash
git add src package.json tsup.config.ts test/package
git commit -m "build: verify public package exports"
```

### Task 6: Release-candidate smoke gate

**Files:**
- Create: `test/integration/release-smoke.test.ts`
- Modify: `README.md`

**Interfaces:**
- Consumes: only public package APIs and deterministic test adapters.
- Produces: one release gate covering the supported v1 lifecycle and recovery boundaries.

- [ ] **Step 1: Write the release smoke scenarios**

Scenario A imports the public root, performs authenticated REGISTER, outgoing authenticated INVITE, offer/answer, ACK, BYE/200, and unregister. Scenario B receives and answers a call, stops TU 2xx retransmission on ACK, then handles BYE. Scenario C proves native Ping/Pong timeout and OPTIONS timeout each surface typed failure. Scenario D kills a worker and proves re-registration with preserved Call-ID/increased CSeq while the old session promise rejects.

- [ ] **Step 2: Run the focused release gate**

Run: `npx vitest run test/integration/release-smoke.test.ts`

Expected: PASS with trace `registered → inviting → confirmed → terminated → unregistered` and no open handles.

- [ ] **Step 3: Document only verified public behavior**

Add minimal ESM examples for direct Node use and worker-supervised use, the supported transport matrix, promise settlement points, liveness selection, and the v1 recovery rule that registration is restored but calls are not. Every import in README must be copied from a passing packed-consumer fixture.

- [ ] **Step 4: Run final acceptance from a clean install**

Run:

```bash
npm ci
npm run typecheck
npm test
npm run build
npm run test:package
```

Expected: every command exits 0; tests report no unhandled rejection/open handle, and the packed ESM/CommonJS/type fixtures all pass.

- [ ] **Step 5: Commit**

```bash
git add README.md test/integration/release-smoke.test.ts
git commit -m "test: gate the SIP worker release candidate"
```
