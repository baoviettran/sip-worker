# Changelog

All notable changes to this project are documented in this file, following
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). The project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.5.0] - 2026-08-14

### Added

- **Real WebRTC media foundation.** `sip-worker` (browser) adds a
  `BrowserUserAgent` composition root that ties the core SIP user agent to a
  real `RTCPeerConnection` audio session, and exposes a typed `ua.media` facade:
  `listDevices`, `prepare`, `selectMicrophone`, `attachRemoteAudio`,
  `setAudioOutput`. One active media call per user agent; a busy UA answers a
  second incoming INVITE with **486 Busy Here** before any media is acquired.
- **Coded media errors.** Media failures surface as `MediaError` with a 12-value
  `MediaErrorCode` union (`MEDIA_ERROR_CODES`), documented in
  [docs/media-errors.md](docs/media-errors.md). No SDP, device ID, credential,
  or stack data reaches a public event or error.
- **`answer()` migration.** `Invitation.answer(localSdp)` becomes `answer()`:
  the core invitation applies the remote offer and creates the local answer via
  its media controller. Documented in
  [docs/migrations/0.3-to-0.5.md](docs/migrations/0.3-to-0.5.md).
- **ICE restart.** `BrowserUserAgent.restartIce()` forces an ICE restart on the
  sole confirmed active call.
- **Real three-engine media gate.** Two-way audio is verified on Chromium,
  Firefox, and WebKit/Safari against the built and packed tarball with a
  synthetic in-page peer (`npm run test:browser-media`).

### Security

- 0.5.0 is a **real browser WebRTC media foundation**, not a completed v1
  production product and not production-ready for general real-audio deployment.
  Working deployments require HTTPS (secure context for `getUserMedia`), WSS
  signaling, short-lived TURN credentials, a permissive Permissions Policy, and
  autoplay-gesture handling — all documented in
  [docs/browser-media.md](docs/browser-media.md). Interop evidence against
  production media stacks still gates the 1.0 framing; see
  [SECURITY.md](SECURITY.md).

## [0.3.0] - 2026-08-12

### Added

- **Package-boundary release.** The single 0.2.0 package is split into three
  npm workspaces: browser `sip-worker`, environment-neutral `@sip-worker/core`,
  and Node `@sip-worker/node`. The repository root is now a private workspace
  orchestrator and is never packed or published.
- **Clean pre-1.0 import break.** `sip-worker/transport/node` is removed with no
  compatibility shim. `sip-worker/messages`, `/stream`, `/transactions`,
  `/dialogs`, `/auth`, `/ua`, `/media`, `/bridge`, and the browser part of
  `/reliability` moved to `@sip-worker/core`; Node transports and native
  liveness moved to `@sip-worker/node`; the browser transport moved to
  `sip-worker/transport`. See the
  [migration guide](docs/migrations/0.2-to-0.3.md) for the exact map.
- **Enforced environment boundaries.** Core imports no Node, DOM, WebSocket,
  Worker, timer, or crypto global; browser and Node depend exactly on
  `@sip-worker/core@0.3.0`. Enforced by static import audits, a Node-clean
  bundled browser fixture, packed-consumer tests, and per-package API reports.
- **Dual ESM/CommonJS output** with `.d.ts`/`.d.cts` per package and per public
  subpath, proven by fresh tarball consumers.

### Security

- 0.3.0 remains a signaling-only prototype, not production-ready for general
  deployment. This release does not claim WebRTC compatibility, WSS production
  readiness, or SIP interoperability — those are tracked in the browser v1.0
  roadmap. See [SECURITY.md](SECURITY.md).

## [0.2.0] - 2026-08-12

### Added

- **Typed public event surface** on the `UserAgent`: `registrationStateChanged`,
  `callStateChanged`, `incomingCall`, and `failed` (replacing the earlier
  `stateChanged` shorthand).
- **Browser v1.0 production roadmap** linking real media, WSS, and interop work:
  `docs/superpowers/specs/2026-08-12-browser-v1-production-roadmap-design.md`.

### Fixed

- **Bounded auth state.** `AuthManager` nonce counters are capped at 64 and
  per-exchange retry state settles, replacing the earlier unbounded-map
  limitation. No claim of general memory safety is made beyond the tested
  lifecycle boundaries.
- **Fail-closed UDP peer identity.** UDP handling now resolves to an explicit
  allowlist rather than trusting ambient peers.
- **Observer isolation.** A throwing observer no longer breaks other subscribers.
- **Lifecycle resource baselines.** Repeated registration/call/teardown cycles
  return timing and state resources to baseline.

### Security

- 0.2.0 remains a signaling-only prototype, not production-ready for general
  deployment. This milestone does not claim WebRTC compatibility, WSS
  production readiness, or SIP interoperability — those are tracked in the
  browser v1.0 roadmap. See [SECURITY.md](SECURITY.md).

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

[0.5.0]: https://github.com/baoviettran/sip-worker/releases/tag/v0.5.0
[0.3.0]: https://github.com/baoviettran/sip-worker/releases/tag/v0.3.0
[0.2.0]: https://github.com/baoviettran/sip-worker/releases/tag/v0.2.0
[0.1.0]: https://github.com/baoviettran/sip-worker/releases/tag/v0.1.0
