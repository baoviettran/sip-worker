# Security Policy

## Supported versions

| Version | Supported |
| ------- | --------- |
| 0.3.x   | :white_check_mark: (active development) |

`sip-worker` is at **0.3.0, a signaling-only prototype**. The 0.3 line is the
workspace split into `sip-worker` (browser), `@sip-worker/core`
(environment-neutral core), and `@sip-worker/node` (Node transports). Only the
latest 0.3.x release is supported. There is no 1.x line yet.

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

The 0.3.0 workspace split introduces a hard environment boundary:

- **`sip-worker` (browser)** depends only on `@sip-worker/core`. Its root
  re-exports the common core API; only the browser WebSocket adapter lives here.
- **`@sip-worker/core`** is environment-neutral. It imports no Node, DOM,
  WebSocket, Worker, timer, or crypto global.
- **`@sip-worker/node`** depends only on `@sip-worker/core`. It owns the Node
  UDP/TCP/WebSocket transports and native ping/pong liveness.

This boundary is enforced by static import audits and a bundled browser fixture
that must build without Node polyfills. See the
[migration guide](docs/migrations/0.2-to-0.3.md) for the exact package mapping.

## Known limitations (0.3.0)

This is a signaling-only prototype, **not production-ready for general
deployment**. Before relying on it for anything carrying real traffic, review
the production-readiness assessment in
[`docs/2026-08-11-production-readiness-review.md`](docs/2026-08-11-production-readiness-review.md)
and the
[browser v1.0 production roadmap](docs/superpowers/specs/2026-08-12-browser-v1-production-roadmap-design.md).
The highlights that affect security posture:

- **No real media.** `StubMainMediaHandler` returns a fixed SDP string. There is
  no RTP/RTCP, no WebRTC PeerConnection, and no DTLS/SRTP. Calls start and end
  but no audio flows, and there is no media encryption.
- **No TLS/SIPS.** SIP-over-TLS transports and certificate authentication are
  absent; WSS handoff is left to the browser. Plain UDP/TCP carry signaling
  unencrypted.
- **`auth-int` refused, not implemented.** RFC 3261 entity-body integrity
  (`qop=auth-int`) is explicitly rejected rather than silently mishandled.
- **Bounded auth state.** `AuthManager` nonce counters are capped at 64 and
  per-exchange retry state settles, so challenge state does not grow without
  bound across a session. This bounds the `AuthManager`'s own state; no claim of
  general memory safety is made beyond the tested lifecycle boundaries.
- **No interop evidence.** The smoke gate is a self-contained loopback; there is
  no cross-testing against Asterisk, Kamailio, FreeSWITCH, SIP.js, or SIPp.
- **No observability.** No metrics, structured logging, health endpoints, or
  tracing to detect or forensically reconstruct an attack.
- **No streaming/siren.** No SIP INFO / DTMF / RFC 2833 / MSRP.
- **No high availability.** No active/standby, shared state, or proxy failover.

The 1.0 framing is gated on a real media adapter plus interop evidence (see the
[browser v1.0 production roadmap](docs/superpowers/specs/2026-08-12-browser-v1-production-roadmap-design.md)).
Treat 0.3.0 accordingly: signaling experiments and tightly-controlled
single-peer trials only.

## Deployment guidance

- Inject your own `Clock` (the code never sleeps on real time).
- Wire a real media handler behind the `MediaPort` — do not ship `StubMainMediaHandler`.
- Put TLS and authenticated transport in front of it until native SIPS/WSS exists.
- `AuthManager` nonce counters are capped at 64 and per-exchange retry state
  settles, so no external bounding of challenge state is required.