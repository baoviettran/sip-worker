# Security Policy

## Supported versions

| Version | Supported |
| ------- | --------- |
| 0.5.x   | :white_check_mark: (active development) |

`sip-worker` is at **0.5.0, a real browser WebRTC media foundation**. The 0.5
line is the workspace split into `sip-worker` (browser), `@sip-worker/core`
(environment-neutral core), and `@sip-worker/node` (Node transports), with
`0.5.0` adding a real WebRTC media layer to the browser package. Only the latest
0.5.x release is supported. There is no 1.x line yet.

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

The 0.5.0 workspace split introduces a hard environment boundary:

- **`sip-worker` (browser)** depends only on `@sip-worker/core@0.5.0`. The root
  re-exports the common core API; the browser WebSocket adapter, the
  `BrowserUserAgent`, and the (DOM-typed, internally WebRTC) media layer live
  here. Importing the browser root touches no `navigator`, `RTCPeerConnection`,
  `document`, or `globalThis`; the browser media environment resolves lazily.
- **`@sip-worker/core`** is environment-neutral. It imports no Node, DOM,
  WebSocket, Worker, timer, or crypto global. It owns the coded media
  error/controller contract (`MediaError`, `WorkerMediaController`) but
  fabricates no media.
- **`@sip-worker/node`** depends only on `@sip-worker/core@0.5.0`. It owns the
  Node UDP/TCP/WebSocket transports and native ping/pong liveness.

This boundary is enforced by static import audits and a bundled browser fixture
that must build without Node polyfills. See
[`docs/browser-media.md`](docs/browser-media.md) and the
[migration guide](docs/migrations/0.3-to-0.5.md).

## Known limitations (0.5.0)

0.5.0 is a **real browser WebRTC media foundation**, **not** production-ready
for general real-audio deployment and not a completed v1 product. Before relying
on it for anything carrying real traffic, review the production-readiness
assessment in
[`docs/2026-08-11-production-readiness-review.md`](docs/2026-08-11-production-readiness-review.md)
and the
[browser v1.0 production roadmap](docs/superpowers/specs/2026-08-12-browser-v1-production-roadmap-design.md).
The highlights that affect security posture:

- **Real media, one call at a time.** 0.5.0 ships real WebRTC audio negotiated
  by a real `RTCPeerConnection`, but supports one active call per
  `BrowserUserAgent`; a second incoming call is answered **486 Busy Here**.
- **TURN credentials are application-supplied.** The application provides
  `iceServers`. Deployments must issue **short-lived TURN credentials** from
  their own backend; never embed long-lived credentials in client code.
- **Transport security.** SIP-over-TLS transports and certificate
  authentication are absent; WSS handoff is left to the browser. Plain
  UDP/TCP carry signaling unencrypted. A working deployment uses HTTPS for the
  page and WSS for signaling.
- **Media encryption is WebRTC-managed.** DTLS/SRTP come from the browser's
  `RTCPeerConnection`, not from library code. Verified two-way audio runs on
  Chromium, Firefox, and WebKit/Safari (synthetic in-page peer).
- **`auth-int` refused, not implemented.** RFC 3261 entity-body integrity
  (`qop=auth-int`) is explicitly rejected rather than silently mishandled.
- **Bounded auth state.** `AuthManager` nonce counters are capped at 64 and
  per-exchange retry state settles, so challenge state does not grow without
  bound across a session. This bounds the `AuthManager`'s own state; no claim of
  general memory safety is made beyond the tested lifecycle boundaries.
- **No interop evidence.** The staged media gate is a synthetic in-page peer
  across the three engines; there is no cross-testing against Asterisk,
  Kamailio, FreeSWITCH, SIP.js, or SIPp.
- **No observability.** No metrics, structured logging, health endpoints, or
  tracing to detect or forensically reconstruct an attack.
- **No streaming/siren.** No SIP INFO / DTMF / RFC 2833 / MSRP.
- **No high availability.** No active/standby, shared state, or proxy failover.
- **No Trickle ICE / no device auto-fallback.** ICE candidates are bundled
  non-trickle; an active-track device failure is terminal and observable.

The 1.0 framing is gated on interop evidence against production stacks (see the
[browser v1.0 production roadmap](docs/superpowers/specs/2026-08-12-browser-v1-production-roadmap-design.md)).
Treat 0.5.0 accordingly: controlled browser-to-browser trials over a TURN relay
you control.

## Deployment guidance

- Inject your own `Clock` (the code never sleeps on real time).
- Serve the page over **HTTPS** and run signaling over **WSS**: `getUserMedia`
  requires a secure context.
- Provide **short-lived TURN credentials** from your backend. Prefer
  `iceTransportPolicy: 'relay'` for TURN-only deployments.
- Handle the browser autoplay policy: play remote audio within a user gesture.
- Check the Permissions Policy for the deployment origin so `microphone` is
  permitted.
- Put TLS and authenticated transport in front of signaling until native
  SIPS/WSS exists.
- `AuthManager` nonce counters are capped at 64 and per-exchange retry state
  settles, so no external bounding of challenge state is required.
