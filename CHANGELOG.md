# Changelog

All notable changes to this project are documented in this file, following
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). The project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Release-hygiene contract: `LICENSE` (MIT), `SECURITY.md`, `CHANGELOG.md`,
  `.github/workflows/ci.yml`, and `.github/workflows/interop.yml`.
- Package metadata: `engines`, `repository`, `support`, `keywords`, `license`,
  and `publishConfig` (public).
- `npm run test:docs` documentation-contract gate (README links resolve,
  documented scripts exist, 0.1.0 framing is honest), wired into `pretest`.

## [0.1.0] - 2026-08-11

### Added

- **Signaling-only prototype.** RFC 3261 client/server transactions, dialogs,
  Digest authentication, registration (with redirects and `Retry-After`),
  INVITE/BYE/CANCEL/ACK lifecycle, and OPTIONS liveness.
- **Transports.** UDP, TCP, and WebSocket with correct framing for Node
  (`sip-worker/transport/node`) and the browser (`sip-worker/transport/browser`).
- **Auth.** Challenge/response, stale-nonce retry, 423 (interval-too-short),
  `qop=auth`, MD5-sess. `auth-int` is explicitly refused rather than silently
  wrong.
- **Worker-supervised recovery.** `WorkerRuntime`/`WorkerSupervisor` with
  generation-safe restart; restored registration preserves Call-ID and advances
  CSeq; in-flight calls are not reconstructed.
- **Media bridge.** `WorkerMediaController`/`StubMainMediaHandler` with
  deterministic offer/answer. The stub returns a fixed SDP — no real RTP/RTCP,
  no PeerConnection, no DTLS/SRTP.
- **Verified packed exports.** tsup emits ESM/CJS/`.d.ts` per public subpath; a
  prepack gate and packed-consumer fixtures prove the tarball resolves.
- **Deterministic tests.** All timer-driven behavior runs on an injected
  virtual clock; no real-time sleeps.

### Security

- This is a signaling-only prototype, not production-ready for general
  deployment. See [SECURITY.md](SECURITY.md) for the exact limits (no real
  media, no TLS/SIPS, `auth-int` unimplemented, unbounded `AuthManager` maps, no
  observability). A real media adapter plus interop evidence gate the 1.0
  framing.

[0.1.0]: https://github.com/baoviettran/sip-worker/releases/tag/v0.1.0
