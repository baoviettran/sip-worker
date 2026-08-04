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

## Plan 03 Handoff (deferred items)

Phase 3 (transactions + dialogs) is merged and pushed. The following were deliberately deferred and are NOT yet fixed. Phase 4 builds on the dialog/transaction layer, so the first item is a real cross-phase concern; the rest are Phase-3-internal polish that is safe to fold in or leave.

**Phase 4 must fold in:**
- `Dialog.makeTopVia` hardcodes the sent-by as `SIP/2.0/UDP 192.0.2.1:5060` (`src/dialogs/dialog.ts`). Phase 4 builds real REGISTER and outbound in-dialog requests, so the sent-by must come from the actual transport/socket rather than a fixed value. Wire the transport's real sent-by (host/port/protocol) into Via construction.

**Phase-3-internal polish (available to fix, not blocking):**
- `forward()` in `src/transactions/coordinator.ts` deletes the key from BOTH client and server maps on one `terminated` event; client/server keys share the `branch|method` shape and can collide (`branch|INVITE`). Harmless in practice (branches are unique per endpoint), but the helper could take the owning map to be precise.
- `buildNon2xxAck` (`src/transactions/ack.ts`) clones the entire header set, a superset of the RFC-required headers (Route, From, Call-ID, Max-Forwards, Via); a targeted copy would be tighter.
- DRY: `cseqMethod` is duplicated in `src/transactions/invite-client.ts` and `src/transactions/non-invite-client.ts`; `contactUri` in `src/dialogs/dialog.ts` re-implements the `<...>` extraction that `extractUri` in `src/dialogs/header-values.ts` already provides.
- `transportError` is dropped if a late send rejects after the transaction already reached `Terminated` (all four machines) — arguably correct, but untested.
- Coverage gaps: a non-ACK duplicate in `Confirmed` is not tested; `sendResponse` as a no-op in `Terminated` is not tested; no reliable-INVITE `Confirmed` test (I=0 never exercised).

## Execution Order

1. [x] [Plan 01 — Codec and package](./2026-08-04-01-codec-and-package.md)
2. [x] [Plan 02 — Transport and ingress](./2026-08-04-02-transport-and-ingress.md)
3. [x] [Plan 03 — Transactions and dialogs](./2026-08-04-03-transactions-and-dialogs.md)
4. [ ] [Plan 04 — Authentication and registration](./2026-08-04-04-auth-and-registration.md)
5. [ ] [Plan 05 — Calls and media](./2026-08-04-05-calls-and-media.md)
6. [ ] [Plan 06 — Reliability and release](./2026-08-04-06-reliability-and-release.md)

## Plan Gates

| Plan | Independent deliverable | Required gate |
|---|---|---|
| 01 | Packable codec library | Parser corpus, byte framing, ESM/CJS/type export checks |
| 02 | Complete-message transport events | Adapter tests plus transport → ingress routing test |
| 03 | RFC transaction/dialog core | Virtual-clock transition matrices for all four machines |
| 04 | Authenticated registration | 401/407, 423, refresh, unregister, reconnect integration |
| 05 | One complete call | INVITE/auth/SDP/ACK/BYE and incoming-call integration |
| 06 | Recoverable release candidate | Liveness, worker restart, tolerance corpus, packed smoke test |

## Final Acceptance Command

```bash
npm ci
npm run typecheck
npm test
npm run build
npm run test:package
```

Expected: every command exits 0; the full integration trace contains `registered → inviting → confirmed → terminated`, and all packed ESM/CommonJS/type fixtures resolve.
