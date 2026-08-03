# sip-worker — SIP Protocol Stack Design

**Date:** 2026-08-03
**Status:** Approved for v1 (protocol corrections from review applied)

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
is designed so those features slot in without refactoring the components.

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
- Digest authentication (RFC 7616/8760: MD5 for legacy interoperability,
  SHA-256 preferred) so `REGISTER`/`INVITE` can answer real 401/407
  challenges.

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

### Component dependency graph

The stack is best described as a **component dependency graph**, not five strict
vertical layers. The dependencies are:

```
shared types / wire codec
        ↑
messages and transport adapters
        ↑
transactions
        ↑
dialogs
        ↑
UA, registration and sessions

media bridge   ───── used by sessions (side port, not a layer above UA)
digest primitives ── used by UA request construction
```

Each component still has one clear purpose and a well-defined interface, but
the dependency rule is precise rather than hierarchical: a component may depend
on what is *below* it in the graph, and the graph above reflects actual
dependencies (transactions send through transport; TCP framing reaches into the
message header parser; media and digest are side components, not vertical
layers).

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
  messages/      wire codec + typed headers (parse/serialize)
  stream/        byte-level framing (SipStreamDecoder, Content-Length)
  transactions/  RFC 3261 §17 + RFC 6026 state machines + timers
  dialogs/       dialog state (Call-ID, tags, CSeq, route set)
  transport/     Transport interface + per-env impls
    node/        UDP, TCP, WS (over injected dgram/net/ws)
    browser/     WS (native WebSocket)
  auth/          digest primitives (MD5, SHA-256, qop)
  ua/            UserAgent + registration + call sessions
  media/         MediaHandler split (worker + main-thread side)
```

Subpath exports keep the dependency graph visible in the public API (e.g.
`sip-worker/transport/node` vs `sip-worker/transport/browser`). A monorepo is
deferred — YAGNI until there is a reason to split.

---

## Wire codec — messages

The base of everything and the most reusable, testable component. Pure: no
networking, no media, no transactions.

### Message model

A SIP message is a **request** (method + request-target) or a **response**
(status-code + reason). Both share a start line, a header set, and an optional
body. The body is stored as **bytes**, matching the byte transport, so
`Content-Length` is computed from the encoded body octets rather than from a
character count:

```ts
type SipMessage =
  | { kind: 'request'; method: string; uri: string; headers: Headers; body: Uint8Array }
  | { kind: 'response'; statusCode: number; reasonPhrase: string; headers: Headers; body: Uint8Array };
```

Textual bodies are handled through helpers rather than raw string fields:

```ts
message.bodyText('utf-8');                       // decode the body bytes
message.withTextBody(sdp, 'application/sdp');    // set a UTF-8 text body + Content-Type
```

The serializer produces a `Uint8Array` and derives `Content-Length` from the
encoded body bytes. v1 supports only UTF-8 textual bodies (SDP is an opaque
string); binary bodies are not in scope, but the byte model leaves room for them
without a future breaking change.

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

Acceptance rules must be explicit and covered by tests:
- **Compact header aliases** (e.g. `f`/`From`, `t`/`To`, `i`/`Call-ID`,
  `v`/`Via`, `m`/`Contact`).
- **Comma-separated vs. repeated headers** — a `Headers` multimap value may be a
  comma-separated list; quoted commas inside a value must not split it.
- **Folded headers** (continuation lines).
- **IPv6 URIs** in `Via`/`Contact` (bracket form).
- **Duplicate `Content-Length`** and **conflicting lengths** — reject or resolve
  deterministically.
- **CRLF rules** — tolerate lone `\n` on input, emit strict `\r\n` on output.
- **Maximum header/body sizes** — bounded to avoid unbounded memory growth.
- **Serializer protection against header injection** — reject `\r`/`\n` in
  header values rather than emitting them into the wire string.

### Serializer

Typed message → exact wire string. Round-trips with the parser (property-level
tests).

### v1 method coverage

`REGISTER`, `INVITE`, `ACK`, `BYE`, `CANCEL`, `OPTIONS`, plus the v1 response
codes. `SUBSCRIBE`, `NOTIFY`, `MESSAGE`, `REFER`, `INFO` are add-only later.

**Excluded in v1:** body parsing (SDP is opaque), `multipart`/`message/sip`
wrapping, compression.

---

## Transactions

RFC 3261 §17, as updated by RFC 6026. The **hardest** component — the state
machines with all timers and retransmissions. This is what gives SIP its
transactional behavior: retransmission handling, request–response matching,
duplicate filtering, and timeouts. (It does *not* provide general
exactly-once application semantics.)

### Two families, four machines

Each request type has a client (outgoing) and server (incoming) machine, and
INVITE and non-INVITE behave differently. The machines follow RFC 3261 §17 as
updated by RFC 6026 (which adds the `Accepted` state and Timers L/M so that
INVITE state survives a 2xx and retransmitted INVITEs are not treated as new
requests):

- `ClientTransaction` (INVITE) — INVITE client, Timer A (retransmission, T1),
  Timer B (timeout, 64×T1), Timer D (response wait: ≥32s unreliable, 0s
  reliable); RFC 6026 Timer M (cleanup after 2xx) and the `Accepted` state.
- `ServerTransaction` (INVITE) — INVITE server, Timer G (retransmission of
  INVITE responses 300–699), Timer H (timeout waiting for ACK to a non-2xx
  final response), Timer I (cleanup after ACK); RFC 6026 Timer L and the
  `Accepted` state.
- `ClientTransaction` (non-INVITE) — Timer E (retransmission), Timer F (timeout),
  Timer K (response cleanup).
- `ServerTransaction` (non-INVITE) — Timer J (response cleanup).

`CANCEL` and `OPTIONS` are parsed at the wire codec and handled at the UA layer,
but get no dedicated transaction machines in v1 — the non-INVITE client
transaction covers them.

### Timers

RFC T1 (default 500ms), T2 (4s), T4 (5s), and the derived A–K timers (plus the
RFC 6026 L/M). All wall-clock values are **configurable** so tests can run at a
scaled virtual clock — deterministic timer testing is essential here.

**Reliable-transport behavior must be explicit.** WebSocket is the primary v1
transport and is reliable, so the retransmission timers must be disabled there
rather than repeatedly re-sending requests:

- **Timer A (retransmit INVITE):** only for unreliable transports.
- **Timer E (retransmit non-INVITE):** only for unreliable transports.
- **Timer G (retransmit INVITE responses 300–699):** only for unreliable
  transports.
- **Timer D:** zero for reliable transports.
- **Timers I, J, K:** zero or transport-dependent expiry per the RFC rules.
- **Timers B, F, H, L, M remain necessary** on reliable transports — a reliable
  connection guarantees delivery of bytes, not a SIP response, so timeouts
  still apply.

Without this statement, an implementation could incorrectly retransmit SIP
requests over WebSocket.

### Message vs. transaction

The transaction receives a **typed message** and produces **transaction
events** (accepted, trying, provisional, success, failure, timeout,
transport-error). The UA layer consumes these events. Transactions never touch
the wire themselves — they hand a message to the transport and receive
responses back.

### Two distinct ACK behaviors

The spec must distinguish the two ACK forms, which are handled differently:

- **ACK for a 300–699 response** — generated as part of INVITE transaction
  handling (the server transaction's `Confirmed` state; the client transaction
  sends the ACK, still within the transaction).
- **ACK for a 2xx response** — generated by the **UA/dialog layer** as a
  separate request (a new in-dialog request), *not* handled as an ordinary
  client transaction.

This matters for authentication: when an INVITE receives a 401 or 407, the
client must **ACK that final non-2xx response** before sending the authenticated
INVITE with a new branch and incremented CSeq.

### State

Each instance is a state machine with an explicit `state` field and a
transition table. An injectable clock/timer lets tests drive time
deterministically.

**Excluded in v1:** full response forking, and CANCEL/ACK complexity beyond the
minimal INVITE/ACK pair needed to make a registration + one call correct.

**Known gap — response forking.** Proxies that fork (parallel ringing across a
user's registered devices) produce multiple 2xx responses to one request.
v1 does **not** drop additional 2xx responses (RFC 6026 requires matching 2xx
responses in the `Accepted` state to be passed to the transaction user). The
safe limited-policy: accept the first successful dialog; **ACK every matching
2xx**; detect whether it belongs to the selected dialog; **send BYE for
additional successful dialogs**; and re-send the existing ACK for
retransmissions of an already-handled 2xx. This gives the application a
single-call abstraction without violating protocol behavior. The UA
integration test server must be configured not to fork for the v1 smoke test;
fork handling beyond this policy is deferred.

---

## Dialogs

An INVITE call cannot be implemented cleanly without dialog state, so a
`dialogs/` component sits between transactions and the UA. A dialog owns:

- Call-ID.
- Local and remote tags.
- Local and remote URIs.
- Local CSeq and remote CSeq.
- Remote target (from `Contact`).
- Route set (from `Record-Route`).
- Early or confirmed state.
- Construction of in-dialog requests such as ACK and BYE.

RFC 3261 treats dialogs as a central UA concept for request sequencing and
routing. ACK for a 2xx and subsequent BYE processing depend on dialog state.
`Session` remains the application-facing call abstraction; it contains or
references one or more internal dialogs.

---

## Transport

Sends and receives **raw SIP message bytes**. A thin, injectable interface —
the worker model means the core never imports a socket directly.

### Interface

The transport exchanges **bytes, not strings**, because `Content-Length` is
measured in octets, not JavaScript characters, and SIP can carry binary bodies.
Decoding TCP chunks to strings prematurely (before framing) can mis-frame
around multibyte UTF-8:

```ts
interface Transport {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  send(data: Uint8Array): Promise<void>;
  onData(callback: (data: Uint8Array) => void): Unsubscribe;
  isConnected(): boolean;
}
```

Because it is an interface, the core and all layers above it are
transport-agnostic — they deal in bytes and never know whether the wire is UDP,
TCP, or WebSocket.

### Framing with `SipStreamDecoder`

A pure `stream/` component (`SipStreamDecoder`) turns a byte stream into
complete SIP messages. It buffers bytes, finds the `\r\n\r\n` header terminator,
parses `Content-Length`, and waits for the required number of body octets before
emitting one message. This is the only place that reaches into the message
header parser — and it does so purely to find message boundaries, never to
construct SIP or reason about transaction semantics.

### Per-environment implementations

The actual sockets are injected, so the same `Transport` contract works
everywhere:

- `node/udp.ts` — datagram over an injected `dgram` socket (one datagram = one
  message).
- `node/tcp.ts` — stream over an injected `net` socket, framed by
  `SipStreamDecoder`.
- `node/ws.ts` — over the injected `ws` package.
- `browser/ws.ts` — over the native `WebSocket`.

### WebSocket specifics (RFC 7118)

The WebSocket adapters negotiate the **`sip` WebSocket subprotocol** on
connect. RFC 7118 requires each SIP message to occupy exactly one WebSocket
**message** — multiple SIP messages must not be bundled into one WebSocket
message, and one SIP message must not span multiple WebSocket messages. A single
WebSocket message may internally consist of multiple WebSocket **frames**
(fragmentation happens below the message boundary and is transparent to the
SIP layer). The adapter enforces one-message-per-WebSocket-message on send and
maps each received WebSocket message to exactly one SIP message.

### Key design point

The transport does **not** implement transaction timers or retransmission —
that is the transaction layer's job. Transport is strictly: connect, send
bytes, receive bytes, disconnect. This keeps the components clean and avoids
the classic bug where retransmission logic leaks into transport.

**Excluded in v1:** TLS/DTLS, `sips:` URIs, connection pooling, STUN/TURN. The
first milestone only needs WebSocket (the realistic browser + Node transport
for a client).

---

## UA / Session

The top of the signaling stack. Orchestrates the components below into
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

The registration contract must be precise:
- **Granted expiry** — honor the expiry from the `200` response (not the
  requested value), and refresh before it lapses. When determining the granted
  expiry, the matching `Contact` header's `expires` parameter takes precedence
  over the response-level `Expires` header.
- **Refresh margin** — initiate the refresh at a configured fraction of the
  granted expiry (e.g. half), not at the full expiry.
- **`423 (Interval Too Brief)`** — read `Min-Expires` and retry with an
  acceptable interval.
- **Short granted expiry (no retry)** — a `200 OK` that grants a shorter expiry
  than requested is *not* an error: accept the granted expiry and schedule the
  refresh accordingly. Do not immediately re-issue.
- **Unregister semantics** — send `REGISTER` with `Expires: 0` (a
  contact-removal request), not a bare `BYE`-style teardown.
- **Reconnect behaviour** — on transport loss, re-issue `REGISTER` (and restart
  the refresh timer) rather than silently dropping to unregistered.
- **Call-ID reuse & CSeq progression** — RFC 3261 §10 requires a single
  `Call-ID` for all registrations from a UA instance, with `CSeq` incrementing
  across each `REGISTER`.
- **Listener cleanup** — timers and listeners are torn down on `unregister()`
  and on `disconnect()`, with no leak on repeated register/unregister cycles.

### Digest authentication

An `auth/` component provides **digest primitives** (pure low-level utilities)
and the **UA orchestrates the retry** (a challenged request is completed and
the authenticated retry is a new request with a new branch and a new client
transaction). Baseline: RFC 7616 (modern HTTP Digest) as applied to SIP by
RFC 8760, which replaces the obsolete RFC 2617 reference.

v1 supports:
- **MD5** for legacy interoperability and **SHA-256** as the preferred
  algorithm (RFC 8760 adds SHA-256 and SHA-512/256).
- `qop=auth` handling.
- **Multiple challenges and algorithm selection**.
- Both **401** (`WWW-Authenticate`) and **407** (`Proxy-Authenticate`).
- `stale=true` (re-issue with the new nonce).
- **Nonce-count tracking** per nonce.
- A **configurable maximum retry count**.
- **Redaction of `Authorization`/`Proxy-Authorization` headers from logs**.

Flow: send `REGISTER`/`INVITE` unauthenticated → receive the challenge →
complete the challenged transaction by **ACKing the final non-2xx response**
(for an INVITE 401/407) → compute the digest from the
`WWW-Authenticate`/`Proxy-Authenticate` header → retry the same request as a
**new transaction** with a new branch and an
`Authorization`/`Proxy-Authorization` header. For `REGISTER` and `INVITE`,
CSeq handling follows the relevant retry rules (incremented CSeq; for INVITE,
the ACK precedes the authenticated re-INVITE). The UA holds the credentials and
performs the retry transparently; the app never sees the challenge dance.
This is what makes the "register against a real server" milestone real — most
registrars (including Asterisk) require it.

### Call sessions

A `Session` represents one call, built on the INVITE transaction pair. Public
ops: `invite()`, `answer()`, `reject()`, `hangup()`, and the `state`
transitions (inviting, ringing, early, confirmed, terminated, failed). Two
session types:
- `Inviter` — an outgoing call (uses the INVITE client transaction).
- `Invitation` — an incoming call (uses the INVITE server transaction).

Each session contains or references the **internal dialog(s)** from the
`dialogs/` component (Call-ID, tags, CSeq, route set); the session translates
application call state (inviting, ringing, early, confirmed, terminated,
failed) to and from dialog + transaction events.

### Event API

```ts
ua.on('registered', () => ...);
ua.on('registrationFailed', (e) => ...);
ua.on('incomingCall', (invitation) => ...);   // Invitation
ua.on('callState', (session, state) => ...);
```

### Media wiring

The session carries the **media bridge** (a side component, not a layer above
the UA). The worker side holds the SDP strings, the main-thread side owns the
peer connection. The UA passes SDP through the bridge; it never interprets SDP
itself.

### v1 flow to prove it works

Register → make one call → negotiate a stub SDP through the bridge → accept →
hang up. This exercises every layer once.

**Excluded in v1:** re-INVITE, hold/transfer, DTMF, IM, presence, renegotiation.

---

## Media

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

- **Wire codec (messages):** pure unit tests — parse round-trips, malformed-input
  handling, header edge cases, and the acceptance rules (compact aliases,
  folding, IPv6, duplicate `Content-Length`, CRLF, size limits, header
  injection). No I/O.
- **Auth (digest):** unit tests for the digest computation — known RFC test
  vectors (realm, nonce, cnonce, qop, nc) and the challenge→retry flow, with a
  mock registrar that issues a 401/407 and asserts the retried request carries
  the correct `Authorization`/`Proxy-Authorization`.
- **Transactions:** deterministic timer-driven tests using a **fully virtual
  clock** that advances exact RFC durations (T1, T2, T4, A–K, L/M) rather than
  scaling real time. This avoids changing timer relationships and makes state
  transitions exact. Property tests against the RFC state transitions.
- **Dialogs:** unit tests for dialog state transitions (early/confirmed),
  CSeq sequencing, and ACK/BYE construction.
- **Transport:** integration tests against a loopback server (a local SIP server
  or a mock socket) for each transport, plus `SipStreamDecoder` framing tests
  (multibyte UTF-8 bodies, chunked arrival, `Content-Length` byte counting).
- **UA:** end-to-end tests using a real transport against a mock SIP server (or
  a real one like Asterisk) — the "register + one call" flow as the smoke test.
  The test server must be configured **not to fork** responses (see the
  response-forking note in transactions), and — with digest auth in v1 — will
  require real credentials, so the initial integration target should be a local
  config the test can stand up.
- **Media:** the bridge protocol is tested with an in-memory main-thread mock;
  the real WebRTC handler is tested in a later spec.

---

## Error handling

Three distinct error kinds, distinguished by **type** so the app can branch on
them without string matching:

- **Parse errors** (`ParseError`) — malformed input at the wire codec.
  Structured, with a position; never thrown (returned as a value).
- **Protocol errors** (`SipError`) — SIP responses the UA cannot turn into a
  valid outcome (404, 480, 486, 5xx, and 401/407 after the auth retry is
  exhausted). Carries the status code; surfaced to the app as events.
- **Transport errors** (`TransportError`) — connection failures, timeouts,
  disconnects. Surfaced as `TransportError` events.

Each component maps its errors to the component above it, so the app sees a
clean, typed error surface without reaching into internals.

---

## Success criteria (v1)

1. A `UserAgent` can register and unregister against a real SIP server that
   requires digest auth (proving the 401→retry flow works end-to-end, with
   correct `Call-ID` reuse and `CSeq` progression).
2. A `UserAgent` can place and receive one call, negotiating a stub SDP through
   the media bridge, and hang up cleanly — with a `Dialog` owning the
   Call-ID/tags/CSeq and constructing ACK/BYE.
3. The core runs unmodified in a web worker and in Node.
4. The wire codec, transaction state machines (RFC 3261 + RFC 6026), and dialog
   model pass their full test suites (virtual clock, RFC property tests).
5. The public API exposes typed events and typed errors — no internals leak.
6. The transport carries bytes (not strings) and the WebSocket adapter
   negotiates the `sip` subprotocol per RFC 7118.