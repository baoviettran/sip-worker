# Security Policy

## Supported versions

| Version | Supported |
| ------- | --------- |
| 0.1.x   | :white_check_mark: (active development) |

`sip-worker` is at **0.1.0, a signaling-only prototype**. Only the latest
0.1.x release is supported. There is no 1.x line yet.

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

## Known limitations (0.1.0)

This is a signaling-only prototype, **not production-ready for general
deployment**. Before relying on it for anything carrying real traffic, review
the production-readiness assessment in
[`docs/2026-08-11-production-readiness-review.md`](docs/2026-08-11-production-readiness-review.md).
The highlights that affect security posture:

- **No real media.** `StubMainMediaHandler` returns a fixed SDP string. There is
  no RTP/RTCP, no WebRTC PeerConnection, and no DTLS/SRTP. Calls start and end
  but no audio flows, and there is no media encryption.
- **No TLS/SIPS.** SIP-over-TLS transports and certificate authentication are
  absent; WSS handoff is left to the browser. Plain UDP/TCP carry signaling
  unencrypted.
- **`auth-int` refused, not implemented.** RFC 3261 entity-body integrity
  (`qop=auth-int`) is explicitly rejected rather than silently mishandled.
- **Unbounded `AuthManager` maps.** `nonceCounts` and `retriesByRequest` grow
  without eviction across a UA session. A long-lived UA under sustained
  challenge traffic can grow memory without bound.
- **No interop evidence.** The smoke gate is a self-contained loopback; there is
  no cross-testing against Asterisk, Kamailio, FreeSWITCH, SIP.js, or SIPp.
- **No observability.** No metrics, structured logging, health endpoints, or
  tracing to detect or forensically reconstruct an attack.

The 1.0 framing is gated on a real media adapter plus interop evidence. Treat
0.1.0 accordingly: signaling experiments and tightly-controlled single-peer
trials only.

## Deployment guidance

- Inject your own `Clock` (the code never sleeps on real time).
- Wire a real media handler behind the `MediaPort` — do not ship `StubMainMediaHandler`.
- Put TLS and authenticated transport in front of it until native SIPS/WSS exists.
- Bound `AuthManager` usage or cap challenge traffic on long-lived UAs.