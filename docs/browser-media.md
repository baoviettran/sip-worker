# sip-worker 0.5.0 Browser Media (Real WebRTC Audio)

This document is the truthful contract for the v0.5 browser media surface. 0.5.0
replaces the fixed-SDP media stub with a **real, two-way WebRTC audio
foundation**: `sip-worker` now captures the microphone, negotiates WebRTC media,
and plays remote audio in a supported browser. It is a **foundation**, not a
completed v1 product. Interop with production SIP/VoIP media stacks, WSS
production roll-out, and a full multi-party scenario are still open and are
tracked in the
[browser v1.0 production roadmap](../superpowers/specs/2026-08-12-browser-v1-production-roadmap-design.md).
Treat 0.5.0 accordingly: controlled browser-to-browser trials over a TURN relay
you control.

The `BrowserUserAgent` composition root ties the core SIP user agent to the
browser media layer. It exposes a typed `ua.media` facade:

```ts
interface BrowserMedia {
  listDevices(): Promise<readonly BrowserAudioDevice[]>;
  prepare(options?: PrepareMediaOptions): Promise<void>;
  selectMicrophone(deviceId: string | undefined): Promise<void>;
  attachRemoteAudio(
    element: HTMLMediaElement,
    options?: { readonly outputDeviceId?: string; readonly play?: boolean },
  ): Promise<() => void>;
  setAudioOutput(element: HTMLMediaElement, deviceId: string): Promise<void>;
}
```

## Security requirements

v0.5 brings real media and real device/permission surface. The constraints
below are not optional for a working deployment.

- **HTTPS.** `getUserMedia()` only exists on secure origins. Serve the page over
  `https://` (or a secure context such as `https://127.0.0.1` during local
  development). An insecure origin has no `navigator.mediaDevices` and media
  operations fail with `INTERNAL_ERROR` ("Missing browser global
  'navigator.mediaDevices'").
- **WSS signaling.** Run the SIP signaling transport over `wss://`. Media
  credentials and device grants ride on a page that also carries SIP signaling;
  keep that channel encrypted.
- **Microphone permission.** The browser prompts on first capture. `prepare()`
  requests and checks permission with a probe stream that is stopped
  immediately. Permissions are per-origin and per-device; a user can revoke them
  later. See [Permission recovery](#permission-recovery).
- **Autoplay gesture.** Playing remote audio is subject to the browser autoplay
  policy. An `attachRemoteAudio(..., { play: true })` that is rejected because
  the page has no user gesture resolves to `PLAYBACK_FAILED`; the application
  must surface a UI affordance and retry with the user gesture.
- **Permissions Policy.** A deployment can block device access with a
  Permissions-Policy header or an iframe `allow` attribute. If the document's
  `camera`/`microphone` feature is disabled, `listDevices()` returns an empty
  list and `prepare()` fails with `PERMISSION_DENIED`. Configure the policy to
  permit `microphone` for the origins that run the library.

## TURN backend

WebRTC media that must work across the public internet needs a TURN relay you
control. `BrowserMediaOptions.iceServers` and `iceTransportPolicy` configure the
`RTCPeerConnection`.

- Provide **short-lived TURN credentials** from your backend — a username and
  a time-limited credential your TURN server issues (e.g. a TURN REST API
  `/turn` secret-based ticket). Do not hard-code long-lived credentials in
  client code. The library copies `iceServers` defensively so a credential
  cannot be mutated after negotiation starts.
- `iceTransportPolicy: 'relay'` forces relay-only candidates (no host or srflx
  candidates leak). Use it for TURN-only deployments and relay verification.
  The placeholder shape:

  ```ts
  const media = {
    iceServers: [
      { urls: 'turns:turn.example.com', username: '<issued-username>', credential: '<short-lived-credential>' },
    ],
    iceTransportPolicy: 'relay',
  };
  ```

  Replace `turn.example.com`, `<issued-username>`, and `<short-lived-credential>`
  with values from your TURN backend. Never ship real credentials, device IDs, or
  SDP in this README or in committed examples.

## Setup

```bash
npm install sip-worker
```

### Outgoing call (application-owned audio, teardown in `finally`)

The application owns the `HTMLMediaElement`. The facade never creates a DOM
node and never touches an element past the session it serves.

```ts
import {
  BrowserUserAgent,
  BrowserWebSocketTransport,
} from 'sip-worker';

const audio = document.querySelector<HTMLAudioElement>('#remote-audio')!;

const ua = new BrowserUserAgent({
  transport: new BrowserWebSocketTransport('wss://sip.example.com/ws'),
  clock: { now: Date.now, setTimeout, clearTimeout },
  registrarUri: 'sip:registrar.example.com',
  aor: 'sip:alice@example.com',
  contact: 'sip:alice@example.com',
  idGenerator: { branch: () => crypto.randomUUID() },
  authManager: undefined, // or inject an AuthManager
  media: {
    iceServers: [{ urls: 'turns:turn.example.com', username: '<issued-username>', credential: '<short-lived-credential>' }],
    iceTransportPolicy: 'relay',
    iceGatheringTimeoutMs: 8_000,
    mediaOperationTimeoutMs: 30_000,
    audioConstraints: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  },
});

async function call(target: string): Promise<void> {
  let detach: (() => void) | undefined;
  try {
    await ua.media.prepare(); // permission + probe, gets you a capture grant
    await ua.connect();
    await ua.register();
    await ua.invite(target);

    // Once the remote stream is available, attach it to your app-owned
    // element. Convoy the result of a gesture-aware play() back to the user.
    ua.on('remoteAudio', ({ stream }) => {
      audio.srcObject = stream;
    });
    detach = await ua.media.attachRemoteAudio(audio);

    // Play only after a user gesture so the autoplay policy allows it.
    const onGesture = () => {
      void audio.play().catch(() => { /* surface UI: PLAYBACK_FAILED-style */ });
      audio.removeEventListener('click', onGesture);
    };
    audio.addEventListener('click', onGesture);

    // Await the call lifecycle (e.g. a hangup UI), then tear down:
    await ua.bye();
  } finally {
    detach?.();
    await ua.dispose(); // idempotent; releases sessions, ports, and listeners
  }
}
```

### Incoming call

`Invitation.answer()` is the 0.5 change: it no longer takes a local SDP argument;
the core invitation asks the media controller to apply the remote offer and
create the local answer, then sends `200 OK`.

```ts
ua.on('incomingCall', async ({ invitation }) => {
  try {
    await invitation.answer(); // CRUCIAL: 0.3 passed localSdp here; 0.5 takes none
    const detach = await ua.media.attachRemoteAudio(audio, { play: true });
    audio.addEventListener('click', () => void audio.play());
    // hold until BYE; then detach in finally
  } finally {
    // element teardown is your job
  }
});
```

The one-call rule: `BrowserUserAgent` supports **one active media call**. If a
second incoming INVITE arrives while a call is active, the core UA rejects it at
the SIP level with **486 Busy Here** before any media is acquired.

## Permission recovery

`PERMISSION_DENIED` means the browser refused the grant. Recovery steps:

1. Call `ua.media.listDevices()` and refresh the shown list on `deviceChanged`
   (labels/device IDs are blank until a capture grant exists — that is browser
   privacy behavior, not a bug).
2. Detect a previous denial by checking the page permission state
   (`navigator.permissions.query({ name: 'microphone' })`); if `denied`, guide
   the user to the browser site-settings panel to re-grant.
3. Re-run `ua.media.prepare()` within a user gesture after the user re-grants.
   A fresh `prepare()` requests the grant again.

`DEVICE_UNAVAILABLE` means the chosen device is unplugged or held by another
application (e.g. an unmuted OS conference). Suggest reconnecting or selecting
another device. v0.5 does **not** auto-fall back after an unplug: an active-track
failure is observable and terminal.

## Remote audio output

- `setAudioOutput(element, deviceId)` selects the output via `element.setSinkId()`.
  It rejects with `OUTPUT_SELECTION_UNSUPPORTED` when the browser lacks that
  capability. **Capability-gated output**: always feature-detect `setSinkId`
  availability before exposing a device switcher.
- `attachRemoteAudio(element, options)` assigns the active remote stream,
  optionally selects an output, and calls and awaits `element.play()` only when
  `options.play === true`. A rejected `play()` is reported as `PLAYBACK_FAILED`,
  never as success. It returns an idempotent detach and also detaches on session
  cleanup while the element still refers to that session's stream.

## Typed troubleshooting

Media failures surface as typed `MediaError` values with a `code` from the
12-value `MediaErrorCode` union, on the `mediaFailed` event and as rejections.
Memoize the mapping: the code table [`docs/media-errors.md`](./media-errors.md)
documents `PERMISSION_DENIED`, `DEVICE_NOT_FOUND`, `DEVICE_UNAVAILABLE`,
`CONSTRAINT_UNSATISFIED`, `NEGOTIATION_FAILED`, `REMOTE_DESCRIPTION_REJECTED`,
`ICE_GATHERING_TIMEOUT`, `ICE_CONNECTION_FAILED`, `OUTPUT_SELECTION_UNSUPPORTED`,
`PLAYBACK_FAILED`, `ABORTED`, and `INTERNAL_ERROR`, each with when it surfaces
and what to do. The four media events are `mediaStateChanged`, `remoteAudio`,
`mediaFailed`, and
`deviceChanged`, all sharing one typed surface with the core SIP events
(`registrationStateChanged`, `callStateChanged`, `incomingCall`, `failed`).
`no SDP, device ID, credential, or raw constraint ever reaches a public event or
error`. Use `on('mediaFailed', ({ error }) => error.code)` and the code table
below to drive user-facing messages.

`restartIce()` forces an ICE restart on the sole confirmed active call. It
rejects with `INVALID_STATE` (a signaling `SipError`, not a `MediaError`) when
there is not exactly one confirmed call.

## Tested versions

Automated, real three-engine WebRTC audio coverage runs against the **built and
packed** `sip-worker` tarball via Playwright using a synthetic peer and synthetic
oscillator audio in-page (no real OS mic). Tested engine families:

- **Chromium** (Playwright Desktop Chrome) — autoplay via launch arg.
- **Firefox** (Playwright Desktop Firefox) — autoplay via user prefs.
- **WebKit / Safari** (Playwright Desktop Safari) — autoplay handled in-page by
  the injected media adapter.

Language/runtime: **Node >= 20**, TypeScript target ES2022 with `dom` lib, the
package set pinned at **0.5.0** (browser `sip-worker`, core `@sip-worker/core`,
node `@sip-worker/node`, all `0.5.0`). DOM types are type-only; the browser
package stays Node-free and import-safe. Browser-engine WebRTC media
availability and media capabilities vary; verify against your target browsers.

## Limitations (0.5.0)

- **Foundation, not v1.** 0.5.0 delivers a real-media foundation: one active
  call, one browser audio session. It is not a completed v1 production product,
  is not certified for interop with production media stacks, and makes no
  general-production claim for real audio deployments.
- **One call at a time.** A second incoming call is answered with `486 Busy
  Here`; there is no multi-line/media-call concurrency.
- **Non-trickle ICE only.** ICE candidates are gathered and bundled into the SDP
  offer/answer; Trickle ICE and ICE restoration across a transport drop are
  deferred.
- **No DTMF / SIP INFO / RFC 2833 / MSRP.** No in-band DTMF, telephone-event
  signaling, or media-streaming beyond audio is shipped in 0.5.0.
- **No auto-fallback on device unplug** during an active call; the failure is
  terminal and observable.
- **No SIPS; WSS remains browser-managed.** Signaling-over-TLS certificate
  authentication and native SIPS are still absent.
- **No observability** endpoints, metrics, or structured logs are shipped.
- **No interop evidence** against Asterisk, FreeSWITCH, Kamailio, SIP.js, or
  SIPp is shipped in 0.5.0.

See also the
[`0.5-browser-media` compatibility note](../compatibility/0.5-browser-media.md)
and the [migration guide](../migrations/0.3-to-0.5.md).
