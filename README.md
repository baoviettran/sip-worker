# sip-worker

A from-scratch TypeScript SIP stack with registration, calls, worker-supervised
recovery, deterministic liveness, real browser WebRTC audio, and verified packed
ESM/CommonJS/TypeScript exports. The stack is split into a browser entry point
(`sip-worker`), an environment-neutral core (`@sip-worker/core`), and Node
transports (`@sip-worker/node`).

**0.5.0 adds real browser WebRTC media**: `sip-worker` ships a `BrowserUserAgent`
composition root with a `ua.media` facade (device listing, microphone
selection, and remote-audio playback) over a real `RTCPeerConnection` audio
session, one active call per user agent (a busy UA answers a second incoming
call with **486 Busy Here**). This is a **real-media foundation, not a completed
v1 product**: it still lacks interop evidence against production media stacks,
multi-call concurrency, Trickle ICE, DTMF/SIP INFO/MSRP, SIPS, and
observability. A real media adapter plus interop evidence gate the 1.0 framing —
see the
[browser v1.0 production roadmap](docs/superpowers/specs/2026-08-12-browser-v1-production-roadmap-design.md)
and the [browser media guide](docs/browser-media.md) for the shipped surface and
its exact limitations.

Each staged release is a deliberate pre-1.0 break: 0.3.0 split the single 0.2
package into the three workspaces (see the
[migration guide](docs/migrations/0.2-to-0.3.md) for that import map), and 0.5.0
adds the media surface (see the
[0.3-to-0.5 migration](docs/migrations/0.3-to-0.5.md), notably
`Invitation.answer()` no longer takes a local SDP).

Every behavior documented here is exercised by the signaling smoke gate
(`test/integration/release-smoke.test.ts`) against the public package root, and
every import below is copied verbatim from a passing packed-consumer fixture
(`test/package/fixtures/`), so each name is proven to resolve from the built
tarball.

## Install

For browser use, install the browser root package:

```
npm install sip-worker
```

For Node use, install the core and Node packages:

```
npm install @sip-worker/core @sip-worker/node
```

## Direct Node use (ESM)

```js
import {
  UserAgent,
  AuthManager,
  WorkerMediaController,
  StubMainMediaHandler,
} from '@sip-worker/core';
import { NodeWebSocketTransport } from '@sip-worker/node/transport';

const idGenerator = { branch: () => crypto.randomUUID() };
const authManager = new AuthManager(idGenerator);

// Deterministic media pair: the controller runs on the worker side, the stub
// answers offer/answer/setRemote with a fixed SDP. Wire the real implementation
// behind the same MediaPort in production.
const mediaController = new WorkerMediaController(mediaPort);
new StubMainMediaHandler(mediaPort);

const ua = new UserAgent({
  transport: new NodeWebSocketTransport(ws), // Node UDP/TCP/WebSocket per the matrix
  clock,                                     // inject your Clock (Date.performance.now-based in Node)
  registrarUri: 'sip:registrar.example.com',
  aor: 'sip:alice@example.com',
  contact: '<sip:alice@192.0.2.1:5060>',
  credentials: { username: 'alice', password: 'your-password' },
  idGenerator,
  authManager,
  mediaController,
});

await ua.connect();
await ua.register();   // authenticated REGISTER; resolves when 'registered'
await ua.invite('sip:bob@example.com'); // offer/answer → ACK; resolves when 'confirmed'
await ua.bye();        // BYE/200; resolves when 'terminated'
await ua.unregister(); // Contact * / Expires 0; resolves when 'unregistered'
await ua.disconnect();
```

## Browser media use (ESM)

A real-media call in the browser composes a `BrowserUserAgent` over a
`BrowserWebSocketTransport` and drives audio through the `ua.media` facade. The
transport, clock, and id generators are injected exactly as in Node; media runs
over WebRTC with an app-owned `HTMLMediaElement`:

```js
import { BrowserUserAgent, BrowserWebSocketTransport } from 'sip-worker';

const audio = document.querySelector('audio'); // your element
const ua = new BrowserUserAgent({
  transport: new BrowserWebSocketTransport('wss://sip.example.com/ws'),
  clock,                                    // inject your Clock
  registrarUri: 'sip:registrar.example.com',
  aor: 'sip:alice@example.com',
  contact: 'sip:alice@example.com',
  idGenerator,
  media: {
    iceServers: [ /* short-lived TURN credentials from your backend */ ],
    iceTransportPolicy: 'relay',
    audioConstraints: { echoCancellation: true, noiseSuppression: true },
  },
});

await ua.media.prepare(); // requests microphone permission via a probe stream
await ua.connect();
await ua.register();
await ua.invite('sip:bob@example.com'); // real two-way WebRTC audio
audio.addEventListener('click', () => audio.play()); // autoplay needs a gesture
await ua.bye();
await ua.dispose(); // releases sessions, ports, and the device listener
```

Media failures are typed `MediaError` values with a `code`; every code is
documented in [docs/media-errors.md](docs/media-errors.md). The `answer()`
signature change on incoming calls (no local SDP argument in 0.5) is covered in
the [0.3-to-0.5 migration](docs/migrations/0.3-to-0.5.md).

## Worker-supervised use

`WorkerSupervisor` (main thread) heartbeats a `WorkerRuntime` (worker thread),
detects death, and restores registration on a replacement. The recovery snapshot
is the only serializable state carried across restart.

```js
import { WorkerRuntime, WorkerSupervisor } from '@sip-worker/core';
import { UserAgent } from '@sip-worker/core';

const registration = {
  aor: 'sip:alice@example.com',
  registrar: 'sip:registrar.example.com',
  credentials: { username: 'alice', password: 'your-password' },
  registerExpires: 600,
  contactUri: '<sip:alice@192.0.2.1:5060>',
  callId: 'reg-a',   // preserved across restart
  nextCSeq: 18,      // advanced (never reused) across restart
};

const supervisor = new WorkerSupervisor({
  factory: {
    spawn: () => {
      const runtime = new WorkerRuntime({
        port, // the worker half of a MessageChannel-style boundary
        buildUserAgent: (snapshot) =>
          new UserAgent({
            transport,
            clock,
            registrarUri: snapshot.registrar,
            aor: snapshot.aor,
            contact: snapshot.contactUri,
            credentials: snapshot.credentials,
            idGenerator,
            initialIdentity: { callId: snapshot.callId, nextCSeq: snapshot.nextCSeq },
          }),
      });
      return { port, terminate: () => runtime.close() };
    },
  },
  clock,
  registration,
  heartbeatIntervalMs: 1000,
  heartbeatTimeoutMs: 3000,
});

await supervisor.register(); // rejects with WorkerRestartError if that generation dies
```

## Supported transport matrix

| Transport | Path | Reliable | Framing |
| --- | --- | --- | --- |
| Node UDP | `@sip-worker/node/transport` (`NodeUdpTransport`) | no | datagram |
| Node TCP | `@sip-worker/node/transport` (`NodeTcpTransport`) | yes | stream |
| Node WebSocket | `@sip-worker/node/transport` (`NodeWebSocketTransport`) | yes | message |
| Browser WebSocket | `sip-worker/transport` (`BrowserWebSocketTransport`) | yes | message |

Node-only adapters live in `@sip-worker/node`; the browser adapter is behind
`sip-worker/transport`. The browser root re-exports the common core API, so the
`UserAgent` and errors resolve from `sip-worker` exactly as in 0.2; low-level
protocol modules (messages, transactions, dialogs, auth, streams, media,
bridge) now live in `@sip-worker/core`. Importing the browser root touches no
Node, worker, socket, timer, or crypto global.

## Promise settlement points

All mutating `UserAgent` methods settle the promise that completes their
network exchange — not merely the send:

- `register()` resolves when the peer returns a final 2xx (or throws on a final
  non-2xx / timeout / transport error). A 401/407 challenge is retried with
  `Authorization` automatically while credentials are configured.
- `invite(target)` resolves when the call is **confirmed** (2xx received and ACK
  sent); the SDP offer/answer runs through the media controller. It throws if a
  final non-2xx, timeout, or transport error occurs.
- `bye()` resolves when the BYE 2xx arrives; it throws on a non-2xx, timeout, or
  transport error.
- `unregister()` resolves when the registrar 2xx for `Contact: * / Expires: 0`
  arrives.
- `connect()` resolves once the transport is open and the ingress/transaction
  layer/registrar are wired. `disconnect()` resolves after teardown.
- `UserAgent.register()`'s supervisor equivalent (`WorkerSupervisor.register()`)
  rejects with `WorkerRestartError` if that generation dies first.

State changes are observable through typed events on the `UserAgent`:

- `registrationStateChanged` — emitted when registration state transitions
  (`unregistered | registering | registered | failed`), carrying the new
  registration state.
- `callStateChanged` — emitted on call state progression (`inviting →
  ringing/early → confirmed → terminating → terminated`), carrying the new call
  state.
- `incomingCall` — emitted when an inbound INVITE arrives.
- `failed` — emitted on a failed exchange (e.g. an OPTIONS liveness probe timing
  out surfaces a typed `TransportError` as `failed`).

Additionally, registration state is exposed as the getter `registerState`
(`unregistered | registering | registered | failed`); the `stateChanged` /
`registerState` shorthand from earlier releases is superseded by these named
events.

## Liveness selection

Liveness is an injected `LivenessStrategy` at the `UserAgent` composition root:

- **Node native Ping/Pong** — when a Node WebSocket transport exposes native
  `ping`/`pong` hooks, compose `NodeWebSocketLiveness` over `NativePingSocket`
  (via the `toNativePingSocket` adapter). A missed pong surfaces a single
  `TransportError('liveness timeout')`.
- **SIP OPTIONS** — the default, browser-safe strategy (`OptionsLiveness`),
  chosen when no native socket is available. Probes through the transaction
  layer; a probe timeout or transport error surfaces a typed `TransportError`
  as a `failed` event on the `UserAgent`.

When no `liveness` is supplied, `UserAgent` builds the OPTIONS strategy itself,
so browser usage needs no native socket.

## Recovery rule

On a worker death, registration is **restored** (same Call-ID, advanced CSeq)
but in-flight calls are **not** reconstructed. The pending registration promise
rejects with `WorkerRestartError`, the replacement boots from the retained
snapshot and re-registers, and any dialogs that existed at death are the
application's to recreate.

## Project

The repository root is a private npm-workspace orchestrator. It is never packed
or published; the three workspaces are the release artifacts.

- `npm run typecheck` – tsc -b over the three workspace projects plus the test
  suites
- `npm test` – vitest suite (all virtual-clock deterministic; no real-time waits);
  `pretest` runs the documentation-contract gate
- `npm run test:docs` – asserts README links resolve, documented scripts exist,
  the 0.5.0 workspace framing stays honest, the migration map is complete, and
  the v0.5 browser-media contract (HTTP**S**/WSS, permissions, autoplay,
  Permissions Policy, TURN, every media code, `answer()` migration, tested
  versions, limitations) is truthful
- `npm run test:architecture` – asserts the workspace manifests define the
  approved dependency graph and import boundaries
- `npm run build` – tsup across the core, browser, and Node workspaces emitting
  ESM `.js`, CommonJS `.cjs`, and `.d.ts` per subpath
- `npm run test:package` – packs each workspace tarball into fresh ESM, CommonJS,
  and TypeScript consumers and exercises every advertised subpath

## Security status

0.5.0 is a **real browser WebRTC media foundation**, not a completed v1
production product and not production-ready for general real-audio deployment.
It ships **real WebRTC media** (microphone capture and remote audio over a real
`RTCPeerConnection`) but still lacks no-`TLS/SIPS`, `auth-int` is refused, and
there is no streaming/siren (no SIP INFO / DTMF / RFC 2833 / MSRP), no
observability, no high availability (no active/standby, shared state, or proxy
failover), and no interop evidence against production media stacks (the media
gate is a synthetic in-page peer across three browsers). Media security
requirements for a working deployment — HTTPS, WSS, short-lived TURN
credentials, Permissions Policy, and autoplay-gesture handling — are documented
in [docs/browser-media.md](docs/browser-media.md). `AuthManager` nonce counters
are capped at 64 and its per-exchange retry state settles, bounding challenge
state; no claim of general memory safety is made beyond the tested lifecycle
boundaries. See [SECURITY.md](SECURITY.md) and
[docs/2026-08-11-production-readiness-review.md](docs/2026-08-11-production-readiness-review.md)
for the complete limits. Interop evidence and broader production hardening gate
the 1.0 framing (see the
[browser v1.0 roadmap](docs/superpowers/specs/2026-08-12-browser-v1-production-roadmap-design.md)).

## Startup sequence

The library performs no network activity until you drive it. The canonical
composition order, from a fresh process:

1. `connect()` — opens the transport and wires ingress, the transaction layer,
   and the registrar. Resolves once the transport is open.
2. `register()` — authenticated REGISTER; resolves when `registered`. A 401/407
   challenge is retried with `Authorization` automatically while credentials are
   configured.
3. `invite(target)` — offer/answer through the media controller; resolves when
   the call is `confirmed` (2xx received and ACK sent).
4. `bye()` — resolves when the BYE 2xx arrives.
5. `unregister()` — `Contact: * / Expires: 0`; resolves when `unregistered`.
6. `disconnect()` — graceful teardown.

For worker supervision, `WorkerSupervisor.register()` reproduces steps 1–2 on a
replacement generation if the current one dies; the recovery snapshot is the
only serializable state carried across restart (see [Recovery rule](#recovery-rule)).

## Release procedure

Releases are gated by the local deterministic checks and the packed-consumer
gate. To cut a release:

1. `npm run test:docs` and `npm run test:architecture` – must pass.
2. `npm run typecheck` – must pass.
3. `npm test` – full suite (including the smoke and doc-contract gates) must be
   green.
4. `npm run build` – produces the versioned `dist/` artifact in each workspace.
5. `npm run test:api` – regenerates and compares the API reports.
6. `npm run test:package` – packs each workspace tarball and proves every
   advertised subpath resolves for ESM, CommonJS, and TypeScript consumers; the
   prepack gate aborts if `dist` is absent or any export fails to resolve.
7. `npm run test:compatibility` – installs all three tarballs together and
   proves class identity and signaling smoke across ESM and CommonJS.
8. Bump the version in each workspace `package.json` (they stay in lockstep
   before 1.0), add a `[Unreleased] → [X.Y.Z]` entry in `CHANGELOG.md`, and tag
   `vX.Y.Z`.
9. `npm publish -w @sip-worker/core && npm publish -w sip-worker && npm publish -w @sip-worker/node` –
   the `prepack` hook re-runs the build and export-resolution gate on each, so a
   broken or absent `dist` fails the publish.

CI runs steps 1–3 on every push and pull request
([.github/workflows/ci.yml](.github/workflows/ci.yml)); a separate
[interop workflow](.github/workflows/interop.yml) runs the SIPp-compatible
matrix against provisioned endpoints on schedule or on demand.
