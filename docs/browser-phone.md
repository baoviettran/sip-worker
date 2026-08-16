# sip-worker 0.7.0 Browser Phone (Call Controls and Recovery)

This document is the truthful contract for the v0.7 browser phone surface. 0.7.0
replaces the v0.5 `BrowserUserAgent`+`ua.media` composition with a **product
composition root** (`BrowserPhone`), **per-call ownership** (`BrowserCall`,
`OutgoingBrowserCall`, `IncomingBrowserCall`), **bounded recovery** for the
signaling transport, registration, and established calls, and **real call
controls** — mute, hold/resume, and RFC 4733 DTMF — over the real WebRTC audio
foundation shipped in 0.5.0.

The v0.5 `BrowserUserAgent` still exists as a **deprecated compatibility
wrapper** over the same owners; see the
[0.5-to-0.7 migration](../docs/migrations/0.5-to-0.7.md) and the
[0.7 compatibility note](../docs/compatibility/0.7-browser-phone.md).

**Production position.** Passing v0.7 makes the package suitable for an
**internal beta** or a **tightly controlled non-customer pilot**. It is not
authorized for general customer production: **PBX certification and soak are
v0.9 gates**, and interop evidence against production SIP/VoIP media stacks is
still open. See [Production position](#production-position) below.

## Five-minute setup

The phone owns one signaling transport, one registration, and at most one call.
Construct it once with the production browser bindings, then drive it through
the typed `BrowserPhone`/`BrowserCall` surface:

```ts
import { BrowserPhone } from 'sip-worker';
import type { OutgoingBrowserCall } from 'sip-worker';

const phone = new BrowserPhone({
  options: {
    signaling: {
      url: 'wss://sip.example.com/ws',
      // reconnect defaults apply: 250 ms initial, 5 s max, 8 attempts, 30 s budget
    },
    account: {
      registrarUri: 'sip:registrar.example.com',
      aor: 'sip:alice@example.com',
      contact: 'sip:alice@example.com',
      username: 'alice',
      password: 'your-password',
    },
    media: { holdDirection: 'sendonly' },
  },
  factory: (url, protocols) => new WebSocket(url, protocols),
  lifecycle: {
    isOnline: () => navigator.onLine,
    subscribe: (event, listener) => {
      window.addEventListener(event, listener);
      return () => window.removeEventListener(event, listener);
    },
  },
  mediaEnvironment: createBrowserMediaEnvironment(),
});

await phone.connect();   // resolves when the WSS transport is open and wired
await phone.register();  // resolves when registered (401/407 retried)

const call = phone.createCall('sip:bob@example.com') as OutgoingBrowserCall;
call.on('stateChanged', ({ state }) => updateUi(state));
await call.start();      // resolves when the call is confirmed AND media connected

call.setMuted(true);     // flip the local track enabled flag
await call.hold();       // re-INVITE with a sendonly offer by default
await call.sendDtmf('123#');
await call.resume();     // re-INVITE back to sendrecv
await call.hangup();     // BYE, resolves on 2xx
await phone.unregister();
await phone.dispose();
```

The `signal`/`timeoutMs` operation options apply to every cancellable
operation where the owner accepts them (for example
`call.sendDtmf('1', { signal })`); hold/resume/restartIce/hangup run on the
call's bounded operation path without extra options.

## Composition and ownership

- **`BrowserPhone`** is the production composition root. It wires the WSS
  transport, the reconnect controller, the browser lifecycle host, the media
  environment, the diagnostics recorder, and the core SIP runtime. One phone
  owns at most one live call.
- **`BrowserCall`** is the shared per-call handle. `setMuted`, `hold`, `resume`,
  `sendDtmf`, `restartIce`, and `hangup` live here and delegate to the same
  owner. `hangup()` is an outgoing-call operation in v0.7: on an incoming call
  it rejects `INVALID_STATE` (see
  [Operation settlement points](#operation-settlement-points)).
- **`OutgoingBrowserCall`** adds `start()`, `cancel()`, and `startConfirmed()`
  (the last is deprecated, used by the v0.5 wrapper).
- **`IncomingBrowserCall`** adds `answer()` and `reject(statusCode, reason?)`.

Incoming calls arrive through the phone event surface:

```ts
phone.on('incomingCall', ({ call }) => {
  call.on('stateChanged', ({ state }) => updateUi(state));
  void call.answer(); // or void call.reject(486);
});
```

A second outgoing call while one is active rejects `INVALID_STATE` before any
media is touched; a busy phone answers a second incoming INVITE with **486 Busy
Here**.

## State model

All states are immutable, orthogonal unions committed before observers run.

### ConnectionState

| State | Meaning |
| --- | --- |
| `disconnected` | Transport closed, no recovery armed. |
| `connecting` | Transport connect in progress. |
| `connected` | Transport open and wired. |
| `recovering` | An unexpected transport loss armed bounded reconnection. |
| `failed` | Recovery exhausted; terminal. |
| `disposed` | Phone disposed; terminal. |

### RegistrationState

| State | Meaning |
| --- | --- |
| `unregistered` | No registration, or manually unregistered. |
| `registering` | REGISTER in flight. |
| `registered` | Registrar 2xx committed. |
| `recovering` | Registration recovery in progress after a transport loss. |
| `failed` | Registration recovery failed; terminal for the registration. |

### CallState

| State | Meaning |
| --- | --- |
| `new` | Call handle created, INVITE not yet sent (or not yet answered). |
| `establishing` | INVITE/answer exchange in progress. |
| `established` | Confirmed (2xx + ACK) AND media connected. |
| `terminating` | BYE in flight. |
| `terminated` | Clean terminal state. |
| `failed` | Terminal failure (recovery exhausted, protocol error, etc.). |

### CallSignalingState

| State | Meaning |
| --- | --- |
| `stable` | Dialog healthy. |
| `recovering` | An established call is being validated/recovered in-band. |
| `lost` | Recovery failed; the call is terminated. |

### HoldState

`HoldState` is `{ local: boolean; remote: boolean }` — local and remote hold
are independent. `hold()` sets the local flag after the core negotiation
applies (2xx + ACK + local media direction); a remote re-INVITE that holds the
call flips the remote flag through `holdStateChanged`.

## Error codes

Call/phone failures surface as `SipError` values with a `code` from the
canonical `SipErrorCode` union. The v0.7 recovery/control members:

| Code | Meaning |
| --- | --- |
| `CONNECTION_RECOVERY_EXHAUSTED` | Reconnect budget spent; connection terminal. |
| `REGISTRATION_RECOVERY_FAILED` | Registration could not be restored. |
| `SIGNALING_RECOVERY_FAILED` | An established call could not be recovered. |
| `OPERATION_ABORTED` | A cancellable operation was aborted via its signal. |
| `OPERATION_TIMEOUT` | A bounded operation exceeded its deadline. |
| `OPERATION_IN_PROGRESS` | A duplicate operation was rejected, never queued. |
| `HOLD_NEGOTIATION_FAILED` | The hold/resume re-INVITE exchange failed. |
| `DTMF_UNSUPPORTED` | RFC 4733 telephone-event is not negotiated on this call. |
| `DTMF_FAILED` | The DTMF sequence was invalid or the send failed. |

Media failures keep the v0.5 `MediaError`/`MediaErrorCode` surface documented in
[docs/media-errors.md](../docs/media-errors.md).

## Operation settlement points

Every mutating operation settles when its network/media exchange completes —
not merely when bytes are sent:

- `phone.connect()` — resolves once the transport is open and the ingress,
  transaction layer, registrar, and runtime are wired.
- `phone.register()` — resolves when the registrar returns a final 2xx; a
  401/407 challenge is retried with `Authorization` automatically while
  credentials are configured.
- `phone.unregister()` — `Contact: * / Expires: 0`; resolves when the 2xx
  arrives and disables automatic re-registration for the life of the phone.
- `phone.disconnect()` — cancels in-flight recovery without a terminal failure
  and returns the connection to `disconnected`; automatic recovery is
  suppressed until the next `connect()`.
- `call.start()` / `call.answer()` — resolve when the core invite/answer
  operation completes (120 s default) AND the call's media session reports
  `connected` (bounded by the media operation deadline).
- `call.cancel()` — resolves when the in-flight INVITE is cancelled.
- `call.reject(statusCode, reason?)` — resolves when the non-2xx final is
  settled.
- `call.hold()` / `call.resume()` — resolve after the re-INVITE negotiation
  applies (2xx + ACK + local media direction).
- `call.sendDtmf()` — resolves when the tone buffer drains (final `tonechange`
  with an empty tone and empty buffer).
- `call.restartIce()` — resolves when the ICE-restart re-INVITE applies and
  media reconnects within the bounded deadline.
- `call.hangup()` — on an **outgoing** call, resolves when the BYE 2xx arrives.
  An **incoming** call in v0.7 has no local BYE owner yet: `hangup()` rejects
  canonical `INVALID_STATE`. Terminate an inbound call by rejecting the INVITE
  (`call.reject(status)`) or by letting the remote side BYE; the inbound BYE
  ownership that lets an answered incoming call hang itself up is a later
  milestone.
- `phone.dispose()` — idempotent, non-cancellable; resolves only after every
  local owner/resource count reaches zero.

State changes are observable through typed events (`connectionStateChanged`,
`registrationStateChanged`, `incomingCall`, `failed` on the phone;
`stateChanged`, `signalingStateChanged`, `holdStateChanged`, `mutedChanged`,
`mediaStateChanged`, `remoteAudio`, `mediaFailed`, `failed` on the call).

## WSS policy

WSS is mandatory by default. A `ws://` signaling URL is rejected unless
`signaling.allowInsecureWebSocket` is exactly `true`, and even then it remains
subject to browser mixed-content enforcement (a `ws://` URL on an `https://`
page is blocked by the browser). Run signaling over `wss://` for any real
deployment.

## Reconnect policy

Signaling transport loss arms bounded reconnection. Defaults applied to every
omitted reconnect field:

| Field | Default | Meaning |
| --- | --- | --- |
| `initialDelayMs` | `250` | First retry delay. |
| `maxDelayMs` | `5_000` | Ceiling for the exponential backoff. |
| `maxAttempts` | `8` | Total attempts before recovery fails. |
| `recoveryTimeoutMs` | `30_000` | Total recovery time budget. |

Validation caps: `maxAttempts` ≤ 20, `maxDelayMs` ≤ 30,000, `recoveryTimeoutMs`
≤ 120,000 (and ≥ 1 attempt). The default public operation deadline is 30,000 ms
and call establishment is 120,000 ms; a shorter SIP/media protocol deadline
wins.

## Recovery algorithm

A phone recovers in three layers, each bounded by the reconnect budget:

1. **Connection recovery.** An unexpected transport loss arms the reconnect
   controller, which opens fresh socket generations against the same URL with
   backoff, up to `maxAttempts`/`recoveryTimeoutMs`. Exhaustion surfaces
   `CONNECTION_RECOVERY_EXHAUSTED`.
2. **Registration recovery.** Once the socket is back, an account that was
   already registered re-registers (same Call-ID, advanced CSeq) within the
   recovery budget. Failure surfaces `REGISTRATION_RECOVERY_FAILED`.
3. **Call recovery.** An established call is validated in-band: if media is
   still connected and no browser `offline` was observed, an in-dialog OPTIONS
   proves dialog health (fast path); otherwise ICE servers are refreshed and one
   serialized ICE-restart re-INVITE is driven, then the manager waits for media
   to reconnect within the recovery deadline. Any failure terminates the call
   with signaling `lost` and `SIGNALING_RECOVERY_FAILED`.

A browser `offline` transition observed during recovery is the network-change
evidence that forces the ICE-restart branch even when media still reports
connected. A manual `disconnect()` or `unregister()` cancels in-flight recovery
and suppresses automatic re-registration for the life of the phone.

## Call controls

### Mute

`call.setMuted(true | false)` flips the local track `enabled` flag through the
media session, which owns the flip and emits `mutedChanged`. A terminal call,
or a call that owns no media session, throws canonical `INVALID_STATE`
synchronously. Mute state is preserved through hold, resume, track replacement,
ICE restart, and recovery.

### Hold and resume

`call.hold()` puts the call on local hold with a **`sendonly`** offer by
default; `'inactive'` is the only alternative
(`call.hold('inactive')`). `call.resume()` negotiates back to `sendrecv`.
Public hold state commits and `holdStateChanged` fires only after the core
negotiation applies. A terminal call, or a call already on the requested hold
side, rejects canonical `INVALID_STATE`. `HOLD_NEGOTIATION_FAILED` surfaces if
the re-INVITE exchange fails.

### DTMF

`call.sendDtmf(tones, options?)` sends an RFC 4733 DTMF sequence through the
browser's `RTCDTMFSender`. Constraints:

- Only `0-9`, `A-D`, `*`, and `#` are accepted (upper-case; lowercase is
  rejected); a sequence is at most 255 tones.
- RFC 4733 `telephone-event` must be negotiated on **both** the local and
  remote SDP — the capability check requires both sides. If either side lacks
  the payload, `DTMF_UNSUPPORTED` is returned.
- The library **never falls back** to SIP INFO; there is no SIP INFO / RFC 2833
  fallback path.
- Tone duration defaults to 100 ms (range 40–6000 ms); inter-tone gap defaults
  to 70 ms (minimum 30 ms). `durationMs`/`interToneGapMs` bound a sequence.
- Each sequence is bounded by a 30 s deadline by default and resolves only when
  the tone buffer drains; a duplicate active sequence rejects
  `OPERATION_IN_PROGRESS` and is never queued; an abort signal clears the
  buffer with `insertDTMF('')` and settles `OPERATION_ABORTED` exactly once.

### ICE restart

`call.restartIce()` forces an ICE restart on the confirmed dialog. It is also
driven internally by the call-recovery branch. The refresh path re-fetches ICE
servers through the configured provider (below).

## TURN provider

Media that must work across the public internet needs a TURN relay you control.
You can supply static `iceServers` or an asynchronous
`IceServerProvider`:

```ts
const provider: IceServerProvider = async ({ signal }) => {
  const res = await fetch('/turn-credentials', { signal });
  const { username, password, urls } = await res.json();
  return [{ urls, username, password }];
};
```

- The provider's returned credentials object is **validated** — `username` and
  `password` are required, and every returned server is defensively copied.
- The provider is consulted before offer/answer and before every ICE restart.
  On refresh it serves a **NEW username/password pair** that the phone must
  adopt — the new pair replaces the old configuration, so short-lived
  credentials rotate without a full call teardown.
- Supplying both static `iceServers` and `iceServerProvider` is a
  construction-time error.
- Credentials never appear in public errors or diagnostics.

## Diagnostics and resource counters

The phone exposes a read-only diagnostics facade:

```ts
const snapshot = phone.diagnostics.resources();
// { activeSocketGenerations, reconnectAttempts, reconnectTimers, activeCalls,
//   activeNegotiations, pendingOperations, timers, peerConnections, localTracks,
//   lifecycleListeners, deviceListeners }
```

Every counter is wired to a direct owner (reconnect controller, live call set,
pending operations, media manager session/track/device listeners) and is a
diagnostic assertion, never a mutable control surface. The closed
`DiagnosticCode` union, severities, subsystems, redaction policy, and the
`DiagnosticRecorder` sink are documented in
[docs/diagnostics.md](../docs/diagnostics.md).

## Security requirements

The v0.7 phone inherits the v0.5 real-media security contract; the constraints
below are not optional for a working deployment.

- **HTTPS.** `getUserMedia()` only exists on secure origins. Serve the page over
  `https://`; an insecure origin has no `navigator.mediaDevices`.
- **WSS signaling.** Run the signaling transport over `wss://`. `ws://` requires
  `allowInsecureWebSocket: true` and stays subject to mixed-content
  enforcement.
- **Microphone permission.** The browser prompts on first capture; media
  preparation requests a probe stream that is stopped immediately. Permissions
  are per-origin and per-device and can be revoked.
- **Autoplay gesture.** Playing remote audio is subject to the browser autoplay
  policy; the application must surface a UI affordance and retry within a user
  gesture. `remoteAudio` events hand the app a `MediaStream`; the app owns the
  `<audio>` element.
- **Permissions Policy.** A deployment can block device access with a
  Permissions-Policy header or an iframe `allow` attribute. Configure the policy
  to permit `microphone` for the origins that run the library.

## Browser evidence and the browser-phone acceptance seam

`test/browser-phone` is the **primary real-browser acceptance seam** for v0.7.
It runs the built/packed `sip-worker` bundle against a controllable SIP-over-WSS
endpoint and an in-page synthetic WebRTC peer, and exercises lifecycle,
controls, recovery, and resource baselines. The required engines are
**Chromium, Firefox, and Playwright WebKit** — every engine must pass; no
capability is skipped. The forced-TURN relay cases (static and refreshed coturn
credentials) are gated on a **provisioned coturn in CI** and run in the
forced-TURN relay job.

**Safari truthfulness.** Playwright WebKit is browser-engine automation, not
evidence from shipping Safari. Shipping Safari is a distinct browser with a
distinct runtime; the dedicated macOS Safari workflow remains a **mandatory
macOS release gate** and is not run on Linux. Nothing in this repository claims
shipping Safari was verified on Linux. Treat the engine matrix as Chromium +
Firefox + Playwright WebKit, with shipping Safari still owed on macOS.

## Production position

Passing v0.7 makes the package suitable for an **internal beta** or a **tightly
controlled non-customer pilot**. It does **not** by itself authorize general
customer production. The remaining production path is:

- **PBX certification** — interop against production SIP/VoIP media stacks
  (Asterisk, Kamailio, FreeSWITCH, SIP.js, SIPp) — is a **v0.9 gate**.
- **Soak** — sustained real-traffic validation with observability — is a
  **v0.9 gate**.
- Shipping-Safari verification on macOS is a **mandatory release gate** for the
  browser package.

Until those gates pass, treat v0.7 accordingly: internal beta or a tightly
controlled non-customer pilot over infrastructure you control.

## Related documents

- [Diagnostics and resource counters](../docs/diagnostics.md)
- [0.5-to-0.7 migration guide](../docs/migrations/0.5-to-0.7.md)
- [0.7 compatibility note](../docs/compatibility/0.7-browser-phone.md)
- [Browser media guide (v0.5 real WebRTC media)](../docs/browser-media.md)
- [Media errors](../docs/media-errors.md)
- [Browser v1.0 production roadmap](../docs/superpowers/specs/2026-08-12-browser-v1-production-roadmap-design.md)
