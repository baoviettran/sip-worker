# sip-worker

A from-scratch TypeScript SIP stack with registration, calls, worker-supervised
recovery, deterministic liveness, and verified packed ESM/CommonJS/TypeScript
exports. This is the v1 release candidate.

Every behavior documented here is exercised by the release-candidate smoke gate
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
        clock,
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

## v1 recovery rule

On a worker death, registration is **restored** (same Call-ID, advanced CSeq)
but in-flight calls are **not** reconstructed. The pending registration promise
rejects with `WorkerRestartError`, the replacement boots from the retained
snapshot and re-registers, and any dialogs that existed at death are the
application's to recreate.

## Project

- `npm run typecheck` – tsc over `src` and `test`
- `npm test` – vitest suite (all virtual-clock deterministic; no real-time waits)
- `npm run build` – tsup emitting ESM `.js`, CommonJS `.cjs`, and `.d.ts` per subpath
- `npm run test:package` – installs the packed tarball into fresh ESM, CommonJS,
  and TypeScript consumers and exercises every advertised subpath
