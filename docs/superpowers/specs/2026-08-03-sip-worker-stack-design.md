# sip-worker — SIP Protocol Stack Design

**Date:** 2026-08-03
**Status:** Approved for v1

## Overview

`sip-worker` is a from-scratch, TypeScript implementation of the Session
Initiation Protocol (SIP, RFC 3261) as a client stack. It is a standalone,
environment-agnostic library that runs unmodified in a web worker, browser main
thread, and Node.js. The first milestone proves the stack end-to-end with a
working registration and a single call.

**Scope boundary.** This spec covers the **v1 slice only** — the full stack
architecture, but only the features needed to register and make one call. The
broader SIP feature set (IM, presence, hold/transfer, DTMF, renegotiation,
real WebRTC media) is explicitly deferred to follow-up specs. The architecture
is designed so those features slot in without refactoring the layers.

**Relationship to sip.js-worker.** `sip-worker` is **standalone and unrelated**
to the existing `sip.js-worker` project. It does not wrap or reimplement
SIP.js. It does, however, deliberately inherit one proven architecture decision
from that project: **signaling runs in a worker and WebRTC media runs in the
main thread**, connected by a serializable bridge. Rationale: real WebRTC media
(`getUserMedia`, `RTCPeerConnection`, ICE) cannot run in a worker, so the
boundary is forced by the platform, not by preference.

## Goals

- A clean, layered, from-scratch SIP stack in TypeScript.
- Environment-agnostic core: runs in worker, browser main thread, and Node.
- First milestone: working registration + one call over a real transport.
- Clean API surface exposing typed events, not internals.
- Heavily tested, especially the message parser and transaction state machines.

## Non-Goals (v1)

- Real WebRTC media (shipped as a stub that emits minimal valid audio SDP).
- IM (`MESSAGE`), presence (`SUBSCRIBE`/`NOTIFY`), transfer (`REFER`).
- Hold/unhold, DTMF, renegotiation, multi-party.
- TLS/DTLS, `sips:` URIs, connection pooling, STUN/TURN.
- SIP body parsing (SDP is an opaque string), multipart, compression.
- Anything beyond the four core methods (`REGISTER`, `INVITE`, `ACK`, `BYE`),
  plus `CANCEL`/`OPTIONS` support where the transaction layer needs it.

---

## Architecture

### Layer model

Five strict layers. Each depends only on the layer below it (and the shared
type definitions). No layer reaches across:

```
Layer 1  messages/      Typed message model + parser + serializer
Layer 2  transactions/  RFC 3261 §17 state machines + timers
Layer 3  transport/     Injectable Transport interface + per-env impls
Layer 4  ua/            UserAgent + call sessions (registration + call flows)
Layer 5  media/         MediaHandler split (worker-side + main-thread-side)
```

### The worker model

The library has **zero import-time side effects**. Nothing touches
`window`, `navigator`, `document`, `localStorage`, or a global `WebSocket` at
module load. Consequently, all I/O — transport, media, and timers — is injected
through interfaces. The core never imports a socket or a media API directly.

A core that does not touch globals runs identically in a worker, browser main
thread, and Node. The "worker-friendly" and "environment-agnostic" requirements
collapse into one rule: **the core is pure and injectable by construction.**

### Package layout

One publishable npm package with strict internal layering, exposed as subpath
exports so consumers can import a slice directly:

```
src/
  messages/      Layer 1 — parse/serialize, typed headers
  transactions/  Layer 2 — RFC 3261 state machines + timers
  transport/     Layer 3 — Transport interface + per-env impls
    node/        UDP, TCP, WS (over injected dgram/net/ws)
    browser/     WS (native WebSocket)
  ua/            Layer 4 — registration + call session logic
  media/         Layer 5 — MediaHandler split (worker + main-thread side)
```

Subpath exports keep the layering visible in the public API (e.g.
`sip-worker/transport/node` vs `sip-worker/transport/browser`). A monorepo is
deferred — YAGNI until there is a reason to split.

---

## Layer 1 — Message layer

The base of everything and the most reusable, testable slice. Pure: no
networking, no media, no transactions.

### Message model

A SIP message is a **request** (method + request-target) or a **response**
(status-code + reason). Both share a start line, a header set, and an optional
body:

```ts
type SipMessage =
  | { kind: 'request'; method: string; uri: string; headers: Headers; body: string }
  | { kind: 'response'; statusCode: number; reasonPhrase: string; headers: Headers; body: string };
```

### Headers

A `Headers` collection is a **case-insensitive, multimap** keyed by header
name — `Call-ID`, `From`, `To`, `Via`, `CSeq`, `Contact` are all
case-insensitive and can repeat. `Headers` is a map from lowercased name to an
array of values, preserving origin order. Common headers get typed accessors
(`from()`, `to()`, `callId()`, `via()`, `cseq()`, `contact()`) that parse the
raw value into a dedicated type.

### Parser

Hand-written, streaming-friendly, tolerant of the RFC's whitespace
flexibility. Returns a typed message or a structured parse error (with a
position) — it **never throws** on malformed input. This layer is where most
SIP interop bugs live, so it is the most heavily tested.

### Serializer

Typed message → exact wire string. Round-trips with the parser (property-level
tests).

### v1 method coverage

`REGISTER`, `INVITE`, `ACK`, `BYE`, `CANCEL`, `OPTIONS`, plus the v1 response
codes. `SUBSCRIBE`, `NOTIFY`, `MESSAGE`, `REFER`, `INFO` are add-only later.

**Excluded in v1:** body parsing (SDP is opaque), `multipart`/`message/sip`
wrapping, compression.

---

## Layer 2 — Transaction layer

RFC 3261 §17. The **hardest** layer — the state machines with all timers and
retransmissions. This is what makes SIP's transactional semantics (reliable
delivery, exactly-once requests) correct.

### Two families, four machines

Each request type has a client (outgoing) and server (incoming) machine, and
INVITE and non-INVITE behave differently:

- `ClientTransaction` (INVITE) — INVITE client, Timer A/B (retransmission,
  T1/T2 backoff) and Timer D (10×T1 response wait).
- `ServerTransaction` (INVITE) — INVITE server, Timer G (2xx retransmission),
  Timer H (timeout), Timer I (ACK wait).
- `ClientTransaction` (non-INVITE) — Timer E/F (retransmission, timeout).
- `ServerTransaction` (non-INVITE) — Timer J (response cleanup).

`CANCEL` and `OPTIONS` are parsed at Layer 1 and handled at Layer 4, but get no
dedicated transaction machines in v1 — the non-INVITE client transaction covers
them.

### Timers

RFC T1 (default 500ms), T2 (4s), T4 (5s), and the derived A–K timers. All
wall-clock values are **configurable** so tests can run at 1/1000× speed —
deterministic timer testing is essential here.

### Message vs. transaction

The transaction receives a **typed message** and produces **transaction
events** (accepted, trying, provisional, success, failure, timeout,
transport-error). The UA layer consumes these events. Transactions never touch
the wire themselves — they hand a message to the transport and receive
responses back.

### State

Each instance is a state machine with an explicit `state` field and a
transition table. An injectable clock/timer lets tests drive time
deterministically.

**Excluded in v1:** response forking (single branch only), and CANCEL/ACK
complexity beyond the minimal INVITE/ACK pair needed to make a registration +
one call correct.

---

## Layer 3 — Transport layer

Sends and receives **raw SIP message strings**. A thin, injectable interface —
the worker model means the core never imports a socket directly.

### Interface

```ts
interface Transport {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  send(message: string): Promise<void>;
  onMessage(cb: (msg: string) => void): void;
  isConnected(): boolean;
}
```

Because it is an interface, the core and all layers above it are
transport-agnostic — they deal in strings and never know whether the wire is
UDP, TCP, or WebSocket.

### Per-environment implementations

The actual sockets are injected, so the same `Transport` contract works
everywhere:

- `node/udp.ts` — datagram over an injected `dgram` socket.
- `node/tcp.ts` — stream over an injected `net` socket (SIP-over-TCP framing
  via `Content-Length`-based message delimiting).
- `node/ws.ts` — over the injected `ws` package.
- `browser/ws.ts` — over the native `WebSocket`.

### Key design point

The transport does **not** implement transaction timers or retransmission —
that is the transaction layer's job. Transport is strictly: connect, send a
string, receive a string, disconnect. This keeps the layers clean and avoids
the classic bug where retransmission logic leaks into transport.

**Excluded in v1:** TLS/DTLS, `sips:` URIs, connection pooling, STUN/TURN. The
first milestone only needs WebSocket (the realistic browser + Node transport
for a client).

---

## Layer 4 — UA / Session layer

The top of the signaling stack. Orchestrates the layers below into
registration and call flows, and exposes a clean event API.

### UserAgent

One per account. Owns:
- The transport (injected).
- Registration state (non-registered, registering, registered, unregistered,
  failed).
- A `UserAgentOptions` config (URI, credentials, display name, register
  expiry).

### Registration

`REGISTER` → `200` loop, with refresh on expiry. Public ops: `register()`,
`unregister()`. Exposes `registerState` events.

### Call sessions

A `Session` represents one call, built on the INVITE transaction pair. Public
ops: `invite()`, `answer()`, `reject()`, `hangup()`, and the `state`
transitions (inviting, ringing, early, confirmed, terminated, failed). Two
session types:
- `Inviter` — an outgoing call (uses the INVITE client transaction).
- `Invitation` — an incoming call (uses the INVITE server transaction).

### Event API

```ts
ua.on('registered', () => ...);
ua.on('registrationFailed', (e) => ...);
ua.on('incomingCall', (invitation) => ...);   // Invitation
ua.on('callState', (session, state) => ...);
```

### Media wiring

The session carries the **media bridge** (Layer 5). The worker side holds the
SDP strings, the main-thread side owns the peer connection. The UA passes SDP
through the bridge; it never interprets SDP itself.

### v1 flow to prove it works

Register → make one call → negotiate a stub SDP through the bridge → accept →
hang up. This exercises every layer once.

**Excluded in v1:** re-INVITE, hold/transfer, DTMF, IM, presence, renegotiation.

---

## Layer 5 — Media layer

Because "signaling in worker, media in main thread" is the chosen architecture,
the media interface is **split in two**, connected by a serializable bridge
type.

### Worker side — `MediaHandlerWorker`

Holds no live media — only the current **SDP offer/answer** as strings and the
caller's preferences. Must be 100% `postMessage`-serializable (structured
clone).

### Main-thread side — `MediaHandlerMain`

Owns `RTCPeerConnection`, `getUserMedia`, ICE, and the audio graph. Exposes the
same ops to the application.

### The bridge

A typed message protocol over `postMessage` (or injected main-thread access).
The worker sends SDP descriptions; the main thread consumes them for the peer
connection and returns negotiated SDP. Only serializable data crosses.

### v1 stub

Both sides ship as stubs that emit a minimal valid audio SDP so calls complete
at the signaling level. The real WebRTC handler is a follow-up spec.

Everything below this boundary is worker-transport-aware but media-agnostic —
it deals in call state transitions and SDP as opaque strings.

---

## Testing

The stack is heavily layered, so testing is layered too:

- **Layer 1 (messages):** pure unit tests — parse round-trips, malformed-input
  handling, header edge cases. No I/O.
- **Layer 2 (transactions):** deterministic timer-driven tests. The injectable
  clock runs at 1/1000× speed, so the full retransmission/timeout behavior is
  testable in milliseconds. Property tests against the RFC state transitions.
- **Layer 3 (transport):** integration tests against a loopback server (a local
  SIP server or a mock socket) for each transport.
- **Layer 4 (UA):** end-to-end tests using a real transport against a mock SIP
  server (or a real one like Asterisk) — the "register + one call" flow as the
  smoke test.
- **Layer 5 (media):** the bridge protocol is tested with an in-memory
  main-thread mock; the real WebRTC handler is tested in a later spec.

---

## Error handling

Three distinct error kinds, distinguished by **type** so the app can branch on
them without string matching:

- **Parse errors** (`ParseError`) — malformed input at Layer 1. Structured, with
  a position; never thrown (returned as a value).
- **Protocol errors** (`SipError`) — SIP responses you cannot handle (401/403
  auth, 404, 480, 486, 5xx). Carries the status code; surfaced to the app as
  events.
- **Transport errors** (`TransportError`) — connection failures, timeouts,
  disconnects. Surfaced as `TransportError` events.

Each layer maps its errors to the layer above, so the app sees a clean, typed
error surface without reaching into internals.

---

## Success criteria (v1)

1. A `UserAgent` can register and unregister against a real SIP server.
2. A `UserAgent` can place and receive one call, negotiating a stub SDP through
   the media bridge, and hang up cleanly.
3. The core runs unmodified in a web worker and in Node.
4. The message parser and transaction state machines pass their full test
   suites (deterministic timers, RFC property tests).
5. The public API exposes typed events and typed errors — no internals leak.