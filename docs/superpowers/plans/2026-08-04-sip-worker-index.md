# SIP Worker v1 Implementation Plan Index

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver a from-scratch TypeScript SIP client that registers with Digest authentication and completes one bidirectional call in Node, a browser main thread, or a web worker.

**Architecture:** Six dependency-ordered plans build the wire codec, typed transport ingress, RFC transactions/dialogs, authenticated registration, call/media flow, and reliability/release gates. Each plan exposes exact interfaces and must pass its own tests plus all earlier tests before the next plan starts.

**Tech Stack:** TypeScript 5.x strict ESM, Vitest, tsup, Node 22+, modern browsers/workers, zero required runtime dependencies, optional injected `ws` for Node WebSocket.

## Global Constraints

- Zero import-time side effects; environment APIs are injected and used only after construction.
- `Transport.send` and transport data events carry `Uint8Array`; no string transport boundary.
- Parsing malformed input returns `ParseError` with a byte offset and never throws.
- The serializer is the only codec operation allowed to throw, and only for programmer errors such as header injection.
- `Headers.append` adds a value; `Headers.set` replaces all values for a name.
- `Content-Length` is recomputed from body bytes and appears exactly once on serialization.
- All timer-driven behavior uses an injected clock; tests never sleep in real time.
- Reliable/unreliable behavior comes from `Transport.capabilities`, not caller-supplied guesses.
- Every public operation promise resolves at its documented protocol outcome, not when bytes are merely queued.
- Every advertised package export has a source barrel, build entry, runtime artifact, and declaration artifact.
- Each task ends with a focused test, full regression test, typecheck, and commit.

---

## Frozen Cross-Plan Interfaces

Plan 01 defines these codec contracts:

```ts
export interface SipRequestMessage {
  readonly kind: 'request';
  readonly method: string;
  readonly uri: string;
  readonly headers: Headers;
  readonly body: Uint8Array;
}

export interface SipResponseMessage {
  readonly kind: 'response';
  readonly statusCode: number;
  readonly reasonPhrase: string;
  readonly headers: Headers;
  readonly body: Uint8Array;
}

export type SipMessage = SipRequestMessage | SipResponseMessage;
export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: ParseError };
```

Plan 02 defines the only transport boundary:

```ts
export interface TransportCapabilities {
  readonly reliable: boolean;
  readonly framing: 'datagram' | 'stream' | 'message';
}

export type TransportEvent =
  | { readonly type: 'connected' }
  | { readonly type: 'data'; readonly data: Uint8Array }
  | { readonly type: 'disconnected'; readonly error?: TransportError }
  | { readonly type: 'error'; readonly error: TransportError };

export interface Transport {
  readonly capabilities: TransportCapabilities;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  send(data: Uint8Array): Promise<void>;
  subscribe(listener: (event: TransportEvent) => void): () => void;
  isConnected(): boolean;
}
```

Plan 03 defines timer and transaction ownership:

```ts
export interface Clock {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): number;
  clearTimeout(id: number): void;
}

export interface TransactionLayer {
  sendRequest(request: SipRequestMessage): ClientTransaction;
  receive(message: SipMessage): void;
  subscribe(listener: (event: TransactionLayerEvent) => void): () => void;
}
```

The layer registers the top Via branch before the first send and removes it on termination. It creates non-2xx ACKs with the original INVITE branch. Dialog/session code creates 2xx ACKs with the INVITE numeric CSeq and a new branch.

## Plan 04 Handoff (deferred items)

Phase 4 (authentication + registration) is merged and pushed. The following were deliberately deferred and are NOT yet fixed.

**Cross-phase concern resolved:**
- `Dialog.makeTopVia` hardcodes the sent-by as `SIP/2.0/UDP 192.0.2.1:5060` (`src/dialogs/dialog.ts`). Verified: REGISTER does NOT flow through `Dialog.makeTopVia` (it builds its own Via in `Registrar`). Only in-dialog requests (ACK/BYE/INVITE) use it. This is a Phase 5 concern when building outbound INVITE/ACK/BYE.

**Phase 5 must address (highest priority first):**

*Authentication (highest priority):*
- `authorization.ts:44-54` quoted values not backslash-escaped — a username/realm containing `"` or `\` produces a malformed quoted-string. Fix early in Phase 5 if user-supplied display names appear in credentials.
- `digest.ts:66` qop typed `'auth' | 'auth-int'` but only `auth` formula implemented. If Phase 5 needs entity-body integrity, add the `auth-int` HA2 (`H(method:uri:H(entity-body))`) and stop stripping it in `selectChallenge`/`AuthManager.retry`.
- `challenge.test.ts:438` malformed-escape test doesn't actually exercise malformed-escape path (error raised is missing-nonce). Test correctness issue only; the malformed-escape code path is correct.

*Registrar/UA:*
- `registrar.ts:202-204` every statusCode >= 300 treated as hard SipError — RFC 3261 10.2 defines 3xx as followable redirects, recoverable not nonrecoverable. Phase 5 redirect handling task should address this.
- `user-agent.ts` `disconnect()` doesn't explicitly cancel registrar's refresh timer — sets `this.registrar = undefined` without calling `registrar.onTransportDisconnected()` or `cancelRefresh()`. The registrar's `clock.setTimeout` handle leaks until the FakeClock is GC'd. Call `registrar.onTransportDisconnected()` in `disconnect()` before nilling the reference, or give `Registrar` an explicit `dispose()`.
- `manager.ts` `retriesByRequest` and `nonceCounts` maps grow unboundedly across a long-lived UA session. The UA constructs one `AuthManager` per `UserAgent` and the Registrar keys `requestId` as `callId:cseq`, so each CSeq gets a fresh budget entry and the map grows by one entry per outbound REGISTER. Phase 5 should either construct-per-exchange or add eviction before adding INVITE auth retries on the same manager instance.
- `manager.ts:300-308` `nextVia` reconstructs Via from transport+sent-by+bare `;rport`, dropping other original params (`;comp`, `;transport`, `;received`). Phase 5 transport-diverse work (TLS/SCTP) should preserve these on auth retries.
- `manager.ts:290` missing-CSeq fallback hardcodes method `INVITE` — only fires on malformed requests lacking CSeq (never in the REGISTER path).
- `manager.ts:219-221` renderer line-split assumes exactly `": "` — safe because `renderAuthorization` always emits `Header: value`, but convention-couples two modules.

*Challenge parser robustness:*
- `challenge.ts:176` unquoted multi-word values split on whitespace; `:159-166` boundary heuristic breaks on a param hypothetically named `digest`; `:199-200` missing-realm/nonce error offsets hardcoded 0. Edge-case parser robustness items. The parser handles every RFC-conformant challenge in the test suite including quoted commas and multiple challenges. These are defensive-hardening items for a hardened-parser task, not merge blockers.

*Coordinator/events:*
- `coordinator.ts:53` `forward()` — a subscriber that throws propagates through the layer, breaking unrelated consumers. Internal API; the Registrar's subscriber never throws. A per-listener try/catch isolation is a defensive improvement for when external subscribers (dialogs, Phase 5 INVITE handling) attach to the same event stream.
- `events.ts` `TypedEventEmitter` uses `Function`/`unknown[]` erasing payload types internally. The overload-based `RegistrationEventEmitter` interface preserves types at the call site; the implementation class internally erases. Consumers get typed events via the interface. Cosmetic only.
- Event types (`RegistrationEvent`, `RegistrationEventEmitter`, `RegistrationStateChangedEvent`, `RegistrationFailedEvent`) not re-exported from `src/index.ts`. `RegistrationIdentity` and `RegisterState` are lifted. Phase 5 should add the event types to `src/index.ts` when the event surface is finalized for Plan 06 recovery.

*Test coverage:*
- `hash.test.ts:19` MD5 test label says "448-bit … abcdefghijklmnopqrstuvwxyz" — that string is 26 bytes = 208 bits, single-block. The 448-bit/two-block vector is the SHA-256 case below it. Test-description-only bug; expected value correct.
- `digest.test.ts` throw tests don't assert the error message and miss the `cnonce`-present/`nc`-missing combination; the code path is identical so neither is load-bearing.
- `manager.test.ts` stale=true tests don't discriminate budget consumption (both pass whether stale consumes budget; no boundary case), and stale path never tested with a genuinely NEW nonce so the nc-reset branch is untested.

**Phase-3-internal polish (still available to fix, not blocking):**
- `forward()` in `src/transactions/coordinator.ts` deletes the key from BOTH client and server maps on one `terminated` event; client/server keys share the `branch|method` shape and can collide (`branch|INVITE`). Harmless in practice (branches are unique per endpoint), but the helper could take the owning map to be precise.
- `buildNon2xxAck` (`src/transactions/ack.ts`) clones the entire header set, a superset of the RFC-required headers (Route, From, Call-ID, Max-Forwards, Via); a targeted copy would be tighter.
- DRY: `cseqMethod` is duplicated in `src/transactions/invite-client.ts` and `src/transactions/non-invite-client.ts`; `contactUri` in `src/dialogs/dialog.ts` re-implements the `<...>` extraction that `extractUri` in `src/dialogs/header-values.ts` already provides.
- `transportError` is dropped if a late send rejects after the transaction already reached `Terminated` (all four machines) — arguably correct, but untested.
- Coverage gaps: a non-ACK duplicate in `Confirmed` is not tested; `sendResponse` as a no-op in `Terminated` is not tested; no reliable-INVITE `Confirmed` test (I=0 never exercised).

## Execution Order

1. [x] [Plan 01 — Codec and package](./2026-08-04-01-codec-and-package.md)
2. [x] [Phase 1 Codec Follow-up Fixes](./2026-08-04-phase-1-codec-follow-up-fixes.md)
3. [x] [Plan 02 — Transport and ingress](./2026-08-04-02-transport-and-ingress.md)
4. [x] [Plan 03 — Transactions and dialogs](./2026-08-04-03-transactions-and-dialogs.md)
5. [x] [Plan 04 — Authentication and registration](./2026-08-04-04-auth-and-registration.md)
6. [x] [Plan 05 — Calls and media](./2026-08-04-05-calls-and-media.md)
7. [x] [Plan 06 — Reliability and release](./2026-08-04-06-reliability-and-release.md)
8. [ ] [Leftover Hardening](./2026-08-07-leftover-hardening.md)

## Plan Gates

| Plan | Independent deliverable | Required gate |
|---|---|---|
| 01 | Packable codec library | Parser corpus, byte framing, ESM/CJS/type export checks |
| 02 | Complete-message transport events | Adapter tests plus transport → ingress routing test |
| 03 | RFC transaction/dialog core | Virtual-clock transition matrices for all four machines |
| 04 | Authenticated registration | 401/407, 423, refresh, unregister, reconnect integration |
| 05 | One complete call | INVITE/auth/SDP/ACK/BYE and incoming-call integration |
| 06 | Recoverable release candidate | Liveness, worker restart, tolerance corpus, packed smoke test |
| 07 | Leftover hardening (Plan 07 file) | Auth quoted/redirect/lifecycle fixes; viaAddress; parser hardening; green regressions |

## Final Acceptance Command

```bash
npm ci
npm run typecheck
npm test
npm run build
npm run test:package
```

Expected: every command exits 0; the full integration trace contains `registered → inviting → confirmed → terminated`, and all packed ESM/CommonJS/type fixtures resolve.
