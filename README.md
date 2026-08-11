# sip-worker

A from-scratch TypeScript SIP stack with registration, calls, worker-supervised
recovery, deterministic liveness, and verified packed ESM/CommonJS/TypeScript
exports. **0.1.0 is a signaling-only prototype**: it ships no real media adapter
(no RTP/RTCP, no WebRTC, no DTLS/SRTP) and no interop evidence. A real media
adapter plus interop evidence gate the 1.0 framing.

Every behavior documented here is exercised by the signaling smoke gate
(`test/integration/release-smoke.test.ts`) against the public package root, and
every import below is copied verbatim from a passing packed-consumer fixture
(`test/package/fixtures/`), so each name is proven to resolve from the built
tarball.

## Install

```
npm install sip-worker
```

## Direct Node use (ESM)

```js
import {
  UserAgent,
  AuthManager,
  WorkerMediaController,
  StubMainMediaHandler,
} from 'sip-worker';
import { NodeWebSocketTransport } from 'sip-worker/transport/node';

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

## Worker-supervised use

`WorkerSupervisor` (main thread) heartbeats a `WorkerRuntime` (worker thread),
detects death, and restores registration on a replacement. The recovery snapshot
is the only serializable state carried across restart.

```js
import { WorkerRuntime, WorkerSupervisor } from 'sip-worker';
import { UserAgent } from 'sip-worker';

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
| Node UDP | `sip-worker/transport/node` (`NodeUdpTransport`) | no | datagram |
| Node TCP | `sip-worker/transport/node` (`NodeTcpTransport`) | yes | stream |
| Node WebSocket | `sip-worker/transport/node` (`NodeWebSocketTransport`) | yes | message |
| Browser WebSocket | `sip-worker/transport/browser` (`BrowserWebSocketTransport`) | yes | message |

Node-only adapters stay behind `sip-worker/transport/node`; the browser adapter
is behind `sip-worker/transport/browser`. Importing the root touches none of them
(no browser, worker, socket, timer, or crypto global).

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

Call state progression is observable via the `stateChanged` event: `inviting →
ringing/early → confirmed → terminating → terminated`, and `failed` on error.
Registration state is the getter `registerState` (`unregistered | registering |
registered | failed`).

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

- `npm run typecheck` – tsc over `src` and `test`
- `npm test` – vitest suite (all virtual-clock deterministic; no real-time waits);
  `pretest` runs the documentation-contract gate
- `npm run test:docs` – asserts README links resolve, documented scripts exist,
  and the 0.1.0 signaling-only framing stays honest
- `npm run build` – tsup emitting ESM `.js`, CommonJS `.cjs`, and `.d.ts` per subpath
- `npm run test:package` – installs the packed tarball into fresh ESM, CommonJS,
  and TypeScript consumers and exercises every advertised subpath

## Security status

0.1.0 is a **signaling-only prototype**, not production-ready for general
deployment. It ships no real media (no RTP/RTCP, no WebRTC, no DTLS/SRTP), no
TLS/SIPS transports, no `auth-int`, no streaming/siren (no SIP INFO / DTMF /
RFC 2833 / MSRP), no observability, no high availability (no active/standby,
shared state, or proxy failover), and no interop evidence (the smoke gate is a
self-contained loopback). Its `AuthManager` maps are unbounded. See
[SECURITY.md](SECURITY.md) and
[docs/2026-08-11-production-readiness-review.md](docs/2026-08-11-production-readiness-review.md)
for the complete limits. A real media adapter plus interop evidence gate the
1.0 framing.

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

1. `npm run typecheck` – must pass.
2. `npm test` – full suite (including the smoke and doc-contract gates) must be
   green.
3. `npm run test:package` – packs the tarball and proves every advertised
   subpath resolves for ESM, CommonJS, and TypeScript consumers; the prepack
   gate aborts if `dist` is absent or any export fails to resolve.
4. `npm run build` – produces the versioned `dist/` artifact.
5. Bump the version in `package.json`, add a `[Unreleased] → [X.Y.Z]` entry in
   `CHANGELOG.md`, and tag `vX.Y.Z`.
6. `npm publish` – the `prepack` hook re-runs the build and export-resolution
   gate automatically, so a broken or absent `dist` fails the publish.

CI runs steps 1–3 on every push and pull request
([.github/workflows/ci.yml](.github/workflows/ci.yml)); a separate
[interop workflow](.github/workflows/interop.yml) runs the SIPp-compatible
matrix against provisioned endpoints on schedule or on demand.
