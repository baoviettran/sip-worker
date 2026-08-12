# Browser-First v1.0 Production Roadmap Design

**Date:** 2026-08-12
**Starting point:** `sip-worker` 0.1.0
**Target:** A production-grade browser SIP audio SDK that can be integrated into a real customer-facing product.

## Product Goal

Version 1.0 is not defined by feature count or unit-test coverage. It is reached
when an application developer can install `sip-worker`, connect it to supported
SIP infrastructure, and operate secure incoming and outgoing browser audio calls
under ordinary production conditions.

The SDK must provide real WebRTC media, predictable recovery, a stable typed API,
safe diagnostics, documented deployment requirements, and interoperability
evidence. A demo that only exchanges SIP messages or fixed SDP does not satisfy
the v1.0 goal.

## Product Scope

### In scope for browser v1.0

- Secure SIP signaling over WSS.
- Digest-authenticated registration and registration refresh.
- Incoming and outgoing audio calls.
- Ring, answer, reject, cancel, hang up, remote hangup, and call failure flows.
- Real browser audio through `RTCPeerConnection` and DTLS-SRTP.
- ICE with configurable STUN and TURN servers.
- Microphone discovery and selection, output selection where the browser supports
  it, mute, hold/resume, and DTMF.
- Recovery from WebSocket loss, browser online/offline transitions, registrar
  expiry, and recoverable network changes.
- Typed state and error events suitable for driving a product UI.
- Structured, redacted logging and diagnostic hooks.
- Tested packaging for modern browser bundlers and workers.
- Published compatibility and interoperability evidence.

### Explicitly out of scope for browser v1.0

- Video calls.
- Conferencing or an SFU/MCU.
- SIP messaging, MSRP, presence, or a general chat system.
- A SIP proxy, registrar, PBX, or other server implementation.
- Production Node media.
- Mobile native SDKs.
- A complete softphone UI. The repository supplies an example application, not a
  reusable design system.

These exclusions keep v1.0 achievable without weakening the audio-call contract.

## Package Architecture

The project becomes a monorepo containing three independently publishable
packages:

```text
@sip-worker/core
    shared, environment-neutral SIP protocol and state machines
        ↑                                      ↑
sip-worker                              @sip-worker/node
browser SDK                             optional Node adapters
WSS + WebRTC                            UDP/TCP/WS and future server integrations
```

### `@sip-worker/core`

Owns the byte codec, stream framing, transactions, dialogs, Digest
authentication, registration logic, call state machines, transport interfaces,
clock interfaces, error taxonomy, and environment-neutral tests.

It must have no import-time side effects and no dependency on DOM, WebRTC, Node,
socket, worker, timer, or crypto globals. Environment capabilities enter through
explicit interfaces.

### `sip-worker`

Is the browser-first product package and the package a web application normally
installs. It owns:

- Browser WSS transport and reconnect orchestration.
- WebRTC audio and device management.
- Browser lifecycle and network-change integration.
- A high-level `UserAgent` API composed over `@sip-worker/core`.
- Browser-oriented diagnostics and public documentation.

Importing this package must never pull Node built-ins into a browser bundle.

### `@sip-worker/node`

Owns Node UDP, TCP, WebSocket, and future TLS adapters. It depends on
`@sip-worker/core`, is versioned and released independently, and does not block
the browser package's v1.0 release. It must not duplicate the SIP codec,
transaction, dialog, authentication, or UA state machines.

### Repository and versioning

All packages remain in one repository so protocol changes, contract tests, and
release compatibility can be reviewed together. Each package declares an exact
supported range for `@sip-worker/core`. A compatibility test installs the packed
artifacts together before publication.

During migration, the existing 0.1 API remains available long enough to publish
a documented upgrade path. Package extraction must not be mixed with unrelated
protocol changes.

## Public Browser API Principles

The browser package exposes product-level concepts rather than requiring an
application to assemble transaction internals.

- Public operations settle at their documented outcome: registration accepted,
  call confirmed, call ended, or failure—not merely when bytes are sent.
- Connection, registration, and call state are separate typed state machines.
- Incoming calls have a public `Invitation` type with `answer()` and `reject()`.
- Every operation supports bounded completion and cancellation where user action
  can abandon it.
- Cleanup is explicit and idempotent. `dispose()` releases WSS listeners, timers,
  media tracks, peer connections, device listeners, and pending operations.
- Event listeners cannot corrupt internal protocol processing when they throw.
- Errors have stable machine-readable codes and retain a safe causal chain.
- Browser credentials remain application-owned and are never persisted by
  default.

A minimal product integration should follow this shape:

```ts
const phone = new BrowserPhone({
  signaling: { url: 'wss://sip.example.com/ws' },
  account: { uri: 'sip:alice@example.com', username: 'alice', password },
  media: { iceServers },
  diagnostics: { logger },
});

await phone.connect();
await phone.register();

phone.on('incomingCall', async (call) => {
  await call.answer();
});

const call = await phone.call('sip:bob@example.com');
call.setMuted(true);
await call.sendDtmf('1');
await call.hangup();

await phone.dispose();
```

Names in this example express the intended usability contract; their exact
signatures are frozen in the milestone-specific API design before implementation.

## Runtime and Deployment Model

The browser connects only through WSS to a SIP WebSocket endpoint. Browsers do
not connect directly to SIP UDP, TCP, or TLS sockets. Production deployments
therefore require a SIP proxy/PBX with RFC 7118-compatible WebSocket support and
a certificate trusted by the browser.

Audio uses WebRTC. The application supplies STUN/TURN configuration appropriate
to its deployment. TURN is a production requirement for users behind networks
where direct ICE connectivity fails; the SDK must report whether a call used a
relay so operators can diagnose connectivity.

The example deployment includes:

- A browser application served over HTTPS.
- A WSS-capable SIP proxy or PBX.
- A TURN service with time-limited credentials recommended for production.
- Asterisk and FreeSWITCH reference configurations for supported scenarios.
- An application-owned backend for issuing SIP and TURN credentials when the
  product cannot safely embed long-lived secrets in the browser.

## Reliability and Error Model

### Signaling recovery

WSS reconnect uses bounded exponential backoff with jitter and explicit terminal
states. Only one connection attempt may exist at a time. After reconnection, the
SDK restores registration with a monotonically increasing CSeq and does not claim
to restore a call whose dialog state cannot be safely reconstructed.

If signaling drops during an established call, media behavior and the recovery
deadline are explicit. The SDK reports `recovering`, attempts bounded signaling
recovery, and either returns to `confirmed` or terminates the call with a typed
reason. It never leaves the application waiting indefinitely.

### Media recovery

ICE state changes are observable. Recoverable network changes trigger a bounded
ICE restart when supported by the peer and signaling path. Permission denial,
missing devices, TURN authentication failure, negotiation failure, and media
timeout have distinct error codes and remediation text.

### Resource ownership

Every timer, event subscription, transaction, deferred operation, media track,
audio element attachment, and peer connection has one owner and one terminal
cleanup path. Repeated connect/register/call/dispose cycles must not grow retained
resource counts.

## Security and Privacy Contract

- Production signaling requires `wss:`. Plain `ws:` requires an explicit
  development-only opt-in and is rejected in secure production contexts.
- Browser media uses WebRTC DTLS-SRTP; the SDK does not provide an unencrypted
  RTP fallback.
- Logs redact credentials, Digest headers, TURN secrets, full SDP, IP addresses,
  phone numbers, and user-provided header values by default.
- Applications can opt into carefully scoped diagnostic fields, but secret
  values remain non-loggable.
- Parser size limits, transaction limits, retry limits, and concurrency limits
  are documented and enforced to resist hostile peers.
- Dependencies are locked, audited in CI, and covered by an actionable security
  reporting and patch policy.
- The threat model covers malicious SIP messages, credential exposure, browser
  cross-origin constraints, untrusted remote media descriptions, resource
  exhaustion, and dependency compromise.
- The documentation explains that WSS and DTLS-SRTP protect transport legs but
  do not by themselves provide end-to-end identity verification across an
  arbitrary SIP network.

## Observability Contract

The SDK emits structured diagnostic records through an injected logger. Records
include timestamp, severity, subsystem, safe event code, connection identifier,
call identifier generated for diagnostics, and bounded contextual fields.

It exposes counters or hooks from which a product can derive:

- WSS connection attempts, failures, and reconnect duration.
- Registration attempts, failures, expiry, and refresh latency.
- Call setup outcome and setup duration.
- ICE candidate type, relay usage, connection time, and failure category.
- Active calls, media tracks, peer connections, pending operations, and timers.

Logging is disabled or minimal by default and never uses unconditional
`console.log`, `console.warn`, or `console.error` in library code.

## Delivery Roadmap

Each milestone produces an independently testable release. A milestone is closed
only when its documented acceptance gate passes; unfinished work is not carried
silently into the next version.

### Milestone 1 — 0.2.x: Core correctness baseline

Purpose: make the existing implementation safe enough to become the shared core.

Deliverables:

- Resolve all confirmed whole-library review findings, including Digest nonce
  count hexadecimal formatting, supervisor stop semantics, refresh rejection
  handling, incoming-call rejection without media, event typing, UDP peer
  identity, concurrent connection ownership, and listener isolation.
- Replace inaccurate security and readiness statements with current evidence.
- Add resource-count assertions for repeated lifecycle operations.
- Define stable error codes for transport, registration, call, media, and
  lifecycle failures.

Gate:

- Focused regression for every confirmed defect.
- Full typecheck, unit, integration, package, and deterministic lifecycle suites.
- No unhandled rejection or open handle in failure-path tests.

### Milestone 2 — 0.3.x: Package separation

Purpose: create the architectural boundary without changing product behavior.

Deliverables:

- Extract `@sip-worker/core`, `sip-worker`, and `@sip-worker/node` in one
  workspace.
- Keep shared runtime class identity across supported exports.
- Provide a migration guide from the 0.1 package layout.
- Add browser bundle audits that reject Node built-ins and import-time global
  access.

Gate:

- Clean tarballs install into isolated ESM and TypeScript consumers.
- A browser production bundle builds without Node polyfills.
- Core contract tests run against both browser and Node adapters.
- Package compatibility and API-report checks pass.

### Milestone 3 — 0.5.x: Real WebRTC audio

Purpose: replace fixed SDP with actual two-way browser audio.

Deliverables:

- `RTCPeerConnection` media adapter with offer/answer and remote-description
  sequencing.
- Microphone permission, acquisition, selection, replacement, and cleanup.
- Remote audio track delivery and output selection where supported.
- Configurable ICE servers, trickle policy chosen for SIP compatibility, ICE
  gathering deadlines, TURN support, and ICE restart.
- Codec policy centered on Opus plus required WebRTC audio compatibility.

Gate:

- Automated two-way audio test using browser automation and a controllable media
  endpoint.
- Permission denial, no-device, negotiation failure, ICE failure, timeout, and
  teardown tests.
- Repeated calls leave zero live tracks and peer connections after disposal.

### Milestone 4 — 0.7.x: Product call controls and recovery

Purpose: supply the behavior a real softphone application needs.

Deliverables:

- Mute/unmute, hold/resume with correct SDP signaling, and RFC 4733 DTMF through
  WebRTC sender capabilities; SIP INFO may be offered only as an explicit
  interoperable fallback.
- Bounded WSS reconnect and registration restoration.
- Browser online/offline and visibility lifecycle handling without false success.
- Stable typed connection, registration, invitation, call, media, and diagnostic
  events.
- Abort/cancellation and deadline semantics for public asynchronous operations.
- Structured logging, resource counters, and an example softphone application.

Gate:

- Network interruption and recovery scenarios settle predictably.
- UI-level example tests cover outgoing, incoming, rejected, cancelled, failed,
  and remote-ended calls.
- Public API documentation contains no internal transaction assembly.

### Milestone 5 — 0.9.x: Interoperability and operational proof

Purpose: replace self-contained confidence with evidence from realistic systems.

Deliverables:

- Versioned Asterisk and FreeSWITCH test environments and configurations.
- SIPp scenarios for registration, authentication, refresh, outgoing/incoming
  INVITE, CANCEL races, retransmissions, BYE, malformed traffic, timeout, and
  reconnect behavior.
- NAT tests for direct, STUN-assisted, and TURN-relayed media.
- Browser matrix on the current and previous stable Chrome, Edge, and Firefox,
  plus current Safari on macOS.
- Load and eight-hour soak suites with explicit resource ceilings.
- Deployment, troubleshooting, security, migration, and operations guides.

Gate:

- Required CI jobs fail if infrastructure, scenarios, browser execution, or
  assertions are missing; they never report a successful skip.
- Asterisk and FreeSWITCH both pass the supported call matrix.
- Two-way audio is programmatically verified, not judged only by SIP traces.
- The soak test completes without upward trends in timers, listeners, pending
  operations, tracks, peer connections, or authentication state.

### Milestone 6 — 1.0.0: Supported browser product

Purpose: publish the stable production contract.

Deliverables:

- Freeze and review the supported public API and semantic-versioning policy.
- Publish compatibility, interoperability, security, and performance reports.
- Publish a complete example application and reference deployment.
- Complete an independent security review and resolve all release-blocking
  findings.
- Run a release-candidate period using the packed artifact in a real staging
  product before publishing 1.0.0.

Gate:

- Every v1.0 acceptance criterion below is backed by a reproducible test or a
  reviewed artifact.
- There are no open critical or high-severity correctness/security findings and
  no undocumented production limitations within the declared scope.
- The exact npm tarball promoted to 1.0.0 passes all gates.

## v1.0 Acceptance Matrix

| Area | Required evidence |
| --- | --- |
| Secure registration | WSS registration, Digest challenge, refresh, unregister, reconnect, and certificate-failure tests |
| Outgoing calls | Ring, early media, answer, two-way audio, cancel, failure, DTMF, hold/resume, and hangup tests |
| Incoming calls | Ring, answer, reject, cancel, two-way audio, remote BYE, and simultaneous-race tests |
| Media | Microphone selection, permission denial, STUN, TURN relay, ICE restart, mute, cleanup, and audio-level verification |
| Browser support | Current and previous Chrome/Edge/Firefox plus current Safari; published exceptions require an explicit support decision before RC |
| Interoperability | Passing Asterisk and FreeSWITCH matrices plus SIPp protocol/failure corpus |
| Resilience | WSS loss, offline/online, registrar timeout, worker failure where used, call recovery deadline, and idempotent disposal |
| Security | Threat model, dependency audit, malicious-input limits, redaction tests, WSS enforcement, DTLS-SRTP evidence, and independent review |
| Operability | Structured diagnostic hooks, resource counters, troubleshooting guide, and safe error taxonomy |
| Longevity | Eight-hour connected soak with repeated calls and no retained-resource upward trend |
| Distribution | Clean, reproducible tarballs; browser bundle without Node polyfills; public API and example compile against packed artifacts |

## Testing Strategy

Testing is layered so fast deterministic checks remain useful while real-system
tests supply the evidence simulation cannot.

1. Unit tests validate codecs, parsers, state machines, SDP policy helpers, and
   error mapping with injected clocks and deterministic fakes.
2. Contract tests run every transport and media adapter against shared ownership,
   settlement, cancellation, and cleanup rules.
3. Browser integration tests use real browser APIs and synthetic audio to verify
   media flow without manual listening.
4. Interoperability tests run packed packages against versioned Asterisk,
   FreeSWITCH, SIPp, and TURN environments.
5. Failure tests introduce packet delay/loss, WSS disconnects, offline events,
   permission denial, expired credentials, and malformed SIP messages.
6. Soak and load tests measure resource counts and call outcomes over time.

CI separates fast pull-request checks from provisioned integration jobs, but all
required release jobs are mandatory for a release candidate. A missing external
environment is a failed release prerequisite, not a successful test result.

## Compatibility Policy

- The supported browser matrix is published for every minor and major release.
- v1.x follows semantic versioning for the documented public API.
- Deprecated public APIs remain available for at least one minor release with a
  migration path unless a security issue requires faster removal.
- SIP/PBX behaviors outside the published interoperability matrix are best-effort
  until reproduced and added to that matrix.
- `@sip-worker/node` maintains its own support table and release status; its
  readiness does not alter browser `sip-worker` guarantees.

## Documentation Required Before 1.0

- Five-minute browser setup using a packed release.
- Architecture and package-selection guide.
- Public API reference and complete call-state diagrams.
- Asterisk and FreeSWITCH WSS/WebRTC configuration guides.
- HTTPS, certificate, STUN, TURN, NAT, and credential-provisioning guidance.
- Error-code and troubleshooting reference.
- Security model, privacy/redaction behavior, and vulnerability policy.
- Upgrade guide from 0.1 and between all prerelease milestones.
- Known limitations stated as precise unsupported behavior, not broad disclaimers.

## Roadmap Governance

- Each milestone receives a separate design and implementation plan. The roadmap
  is not executed as one large change.
- Work proceeds in dependency order: correctness, boundaries, real media,
  product behavior, operational proof, then API freeze.
- A phase cannot be marked complete while its gate is skipped or represented only
  by a future workflow placeholder.
- New scope enters v1.0 only when it is necessary for the declared browser audio
  product; otherwise it is scheduled after 1.0.
- Production claims cite fresh test, interoperability, soak, or review evidence.

## Immediate Next Step

Create the Milestone 1 (`0.2.x Core Correctness Baseline`) implementation plan.
It begins with regressions for the confirmed whole-library review findings and
ends with a trustworthy core baseline before any package movement or WebRTC work.
