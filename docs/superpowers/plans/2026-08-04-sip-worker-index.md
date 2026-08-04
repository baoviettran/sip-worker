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

## Execution Order

1. [x] [Plan 01 — Codec and package](./2026-08-04-01-codec-and-package.md)
2. [ ] [Plan 02 — Transport and ingress](./2026-08-04-02-transport-and-ingress.md)
3. [ ] [Plan 03 — Transactions and dialogs](./2026-08-04-03-transactions-and-dialogs.md)
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
