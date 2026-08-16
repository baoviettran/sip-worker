# Security Policy

## Supported versions

| Version | Supported |
| ------- | --------- |
| 0.7.x   | :white_check_mark: (active development) |

`sip-worker` is at **0.7.0, an internal-beta browser phone**. The 0.7 line is
the workspace split into `sip-worker` (browser), `@sip-worker/core`
(environment-neutral core), and `@sip-worker/node` (Node transports), with
`0.7.0` adding the browser phone surface (per-call ownership, bounded recovery,
and call controls — mute, hold/resume, RFC 4733 DTMF) over the real WebRTC
media added in 0.5.0. Only the latest 0.7.x release is supported. There is no
1.x line yet.

## Reporting a vulnerability

Vulnerabilities should be reported privately, not as public issues. Open a
GitHub issue with the `security` label, or file a report via the repository's
security advisories page. Please include:

- The affected `sip-worker` version and the Node/browser runtime.
- A minimal reproduction (transport, registrar behavior, and the messages
  involved).
- The observed impact and any suggested mitigation.

You should receive a response within 14 days. Public disclosure is coordinated
after a fix ships.

## Environment boundaries

The 0.7.0 workspace split keeps the hard environment boundary introduced by
0.3.0:

- **`sip-worker` (browser)** depends only on `@sip-worker/core@0.7.0`. The root
  re-exports the common core API; the browser WebSocket adapter, the
  `BrowserPhone`/`BrowserCall` product surface, the (deprecated) `BrowserUserAgent`,
  and the (DOM-typed, internally WebRTC) media layer live here. Importing the
  browser root touches no `navigator`, `RTCPeerConnection`, `document`, or
  `globalThis`; the browser media environment resolves lazily and the phone's
  browser seams are injected.
- **`@sip-worker/core`** is environment-neutral. It imports no Node, DOM,
  WebSocket, Worker, timer, or crypto global. It owns the coded media
  error/controller contract (`MediaError`, `WorkerMediaController`) but
  fabricates no media.
- **`@sip-worker/node`** depends only on `@sip-worker/core@0.7.0`. It owns the
  Node UDP/TCP/WebSocket transports and native ping/pong liveness.

This boundary is enforced by static import audits and a bundled browser fixture
that must build without Node polyfills. See
[`docs/browser-phone.md`](docs/browser-phone.md), the
[`docs/browser-media.md`](docs/browser-media.md), and the
[migration guide](docs/migrations/0.5-to-0.7.md).

## Known limitations (0.7.0)

0.7.0 is an **internal-beta browser phone**, **not** authorized for general
customer production and not a completed v1 product. Before relying on it for
anything carrying real traffic, review the production-readiness assessment in
[`docs/2026-08-11-production-readiness-review.md`](docs/2026-08-11-production-readiness-review.md),
the
[browser v1.0 production roadmap](docs/superpowers/specs/2026-08-12-browser-v1-production-roadmap-design.md),
and the limitations stated in
[`docs/browser-phone.md`](docs/browser-phone.md). The highlights that affect
security posture:

- **Internal-beta position.** v0.7 is suitable for an internal beta or a
  tightly controlled non-customer pilot. PBX certification and soak are v0.9
  gates; shipping Safari on macOS is a mandatory release gate.
- **Real media, one call at a time.** 0.7.0 ships real WebRTC audio and real
  call controls, but one `BrowserPhone` owns at most one call; a busy phone
  answers a second incoming INVITE **486 Busy Here**, and a second outgoing
  call rejects `INVALID_STATE`.
- **TURN credentials are application-supplied.** The application provides
  `iceServers` or an `iceServerProvider`. Deployments must issue **short-lived
  TURN credentials** from their own backend; never embed long-lived credentials
  in client code. The provider's credentials object is validated and the phone
  adopts the new pair on refresh.
- **Transport security.** SIP-over-TLS transports and certificate
  authentication are absent; WSS handoff is left to the browser. WSS is
  mandatory by default; `ws:` requires `allowInsecureWebSocket: true` and stays
  subject to browser mixed-content enforcement. Plain UDP/TCP carry signaling
  unencrypted.
- **Media encryption is WebRTC-managed.** DTLS/SRTP come from the browser's
  `RTCPeerConnection`, not from library code. Verified two-way audio and
  controls run on Chromium, Firefox, and Playwright WebKit (synthetic in-page
  peer); shipping Safari is a separate macOS gate.
- **`auth-int` refused, not implemented.** RFC 3261 entity-body integrity
  (`qop=auth-int`) is explicitly rejected rather than silently mishandled.
- **Bounded auth state.** `AuthManager` nonce counters are capped at 64 and
  per-exchange retry state settles, so challenge state does not grow without
  bound across a session. This bounds the `AuthManager`'s own state; no claim of
  general memory safety is made beyond the tested lifecycle boundaries.
- **Recovery is bounded, not infinite.** Connection/registration/call recovery
  runs inside a bounded reconnect budget (8 attempts / 30 s default, capped at
  20 attempts / 120 s); exhaustion surfaces a canonical error code rather than
  retrying forever.
- **DTMF is RFC 4733 only.** There is no SIP INFO / MSRP streaming/siren path;
  DTMF uses negotiated `telephone-event` on both SDP sides and never falls back
  to SIP INFO.
- **No interop evidence.** The staged gate is a synthetic in-page peer across
  the three engines; there is no cross-testing against Asterisk, Kamailio,
  FreeSWITCH, SIP.js, or SIPp (PBX certification is a v0.9 gate).
- **No observability.** No metrics, structured logging, health endpoints, or
  tracing to detect or forensically reconstruct an attack (the diagnostics
  recorder is a bounded, redacted event stream, not a full observability stack).
- **No high availability.** No active/standby, shared state, or proxy failover.
- **No Trickle ICE / no device auto-fallback.** ICE candidates are bundled
  non-trickle; an active-track device failure is terminal and observable.

The 1.0 framing is gated on interop evidence against production stacks (see the
[browser v1.0 production roadmap](docs/superpowers/specs/2026-08-12-browser-v1-production-roadmap-design.md)).
Treat 0.7.0 accordingly: internal beta or a tightly controlled non-customer
pilot over a TURN relay you control.

## Deployment guidance

- Inject your own `Clock` (the code never sleeps on real time).
- Serve the page over **HTTPS** and run signaling over **WSS**: `getUserMedia`
  requires a secure context, and `ws:` requires `allowInsecureWebSocket: true`.
- Provide **short-lived TURN credentials** from your backend (static
  `iceServers` or an `iceServerProvider`). Prefer `iceTransportPolicy: 'relay'`
  for TURN-only deployments.
- Handle the browser autoplay policy: play remote audio within a user gesture.
- Check the Permissions Policy for the deployment origin so `microphone` is
  permitted.
- Put TLS and authenticated transport in front of signaling until native
  SIPS/WSS exists.
- `AuthManager` nonce counters are capped at 64 and per-exchange retry state
  settles, so no external bounding of challenge state is required.
