# Production Readiness Review — 0.1.0

**Date:** 2026-08-11
**Scope:** Full-stack assessment of `src/` against production deployment, before Phase 12 (release productization) work begins.
**Verdict:** Not production-ready for general use. Production-ready for a tightly-controlled single-peer trial **with signaling only**. The released artifact should be framed as **0.1.0, a signaling-only prototype** — see the amended Phase 12 Global Constraint and commit `42dc946`.

> **Superseded facts (0.2.0):** This review was written against 0.1.0 on
> 2026-08-11 and its baseline is preserved unchanged. Read alongside 0.2.0, two
> entries on page are superseded: the "Unbounded maps" gap in the table below no
> longer holds (nonce counters are capped at 64 and per-exchange retry state
> settles), and the public event surface is now the named `registrationStateChanged`,
> `callStateChanged`, `incomingCall`, and `failed` events. The overall verdict —
> signaling-only, not production-ready — still stands for 0.2.0. See the
> [0.2.0 changelog](../CHANGELOG.md) and the
> [browser v1.0 production roadmap](superpowers/specs/2026-08-12-browser-v1-production-roadmap-design.md).

## Baseline
- `npm run typecheck`: pass
- `npm test`: **606/606, 41 files**, including `test/integration/release-smoke.test.ts` (`registered → inviting → confirmed → terminated → unregistered`)
- Phase 11 cleanup ledger: all tasks + whole-phase review clean, nothing parked
- `main` clean, in sync with `origin/main`

## Production-grade today
- **Signaling (complete).** RFC 3261 client/server transactions, dialogs, Digest auth, registration with redirects and `Retry-After`, INVITE/BYE/CANCEL/ACK lifecycle, OPTIONS liveness, worker supervision, end-to-end smoke gate.
- **Transports.** UDP, TCP, WebSocket with correct framing; Node and browser build targets.
- **Auth.** Challenge/response, stale-nonce retry, 423 (interval-too-short), qop=auth, MD5-sess. `auth-int` is explicitly refused rather than silently wrong. Credential redaction correctness fix is in current code.
- **Reliability.** Worker restart with generation-safe recovery, bounded media deadlines, WebSocket native ping/pong liveness, OPTIONS liveness, transport reconnection.

## Falls short for production
| Gap | Impact |
|---|---|
| **No real media** | `StubMainMediaHandler` returns a fixed SDP string. No RTP/RTCP, no WebRTC PeerConnection, no DTLS/SRTP. Calls start and end but no audio flows. Signaling-only. |
| **No interop evidence** | No cross-testing against Asterisk, Kamailio, FreeSWITCH, SIP.js, or SIPp scenarios. The smoke test is self-contained loopback. |
| **No TLS** | SIPS/TLS transports and certificate auth absent; WSS handoff left to the browser. |
| **No `auth-int`** | Entity-body integrity rejected, not implemented. RFC 3261 gap. |
| **No observability** | No metrics, structured logging, health endpoints, or tracing. |
| **Unbounded maps** | `AuthManager.nonceCounts` / `retriesByRequest` grow without eviction across a UA session (documented in the Phase 4 handoff). |
| **No streaming/siren** | No SIP INFO / DTMF / RFC 2833 / MSRP. |
| **Single-transport session** | No per-dialog transport diversity. |
| **No high availability** | No active/standby, shared state, or proxy failover. |

## Consequence for release
`package.json` correctly reads `0.1.0`. The prior *"v1 release candidate"* framing (README line 5) overstates the artifact and is to be corrected in Phase 12 Task 2. A 1.0 framing is gated on a real media adapter plus interop evidence.

## Priorities to close before any general deployment
1. Real media adapter (RTP/WebRTC/DTLS-SRTP) — the v1.0 gate.
2. Interop testing against a real SIP endpoint (Asterisk/IP-PBX) and SIPp.
3. Observability (metrics + structured logging).
4. TLS for SIP-over-TLS / authenticated WebSocket.
5. AuthManager map eviction.
