# Reference Softphone

A framework-free browser example for the packed `@sip-worker/browser` SDK
(v0.7 call controls). It imports **only the packed public `sip-worker`
artifact** — never workspace source — and demonstrates the full product
contract: connect → register → call → controls → unregister → dispose.

## What it shows

- **Phone lifecycle** — `BrowserPhone.connect()` / `register()` /
  `unregister()` / `dispose()`, rendered from the typed
  `connectionState` / `registrationState` facts.
- **Call subtypes** — `OutgoingBrowserCall` (`start`, `cancel`, `hangup`) and
  `IncomingBrowserCall` (`answer`, `reject`), driven through the public
  `createCall()` and `incomingCall` event.
- **Call controls on real media** — mute, hold / resume, and RFC 4733 DTMF via
  `setMuted`, `hold`, `resume`, `sendDtmf`; the call, signaling, and hold
  states are the typed public states (`call-state`, `call-signaling`,
  `call-muted`, `call-hold`).
- **Device / audio façade** — the app wraps
  `createBrowserMediaEnvironment()` so its `getUserMedia` commits an exact
  microphone (`deviceId: { exact }`) after the user picks a device, and it owns
  the `<audio>` element: remote audio is attached from the `remoteAudio` event
  and `play()` is invoked only from a button click (autoplay-safe).
- **Typed errors & diagnostics** — call/phone failures render their code and
  message (`call-error`), and `phone.diagnostics.resources()` is rendered so
  owned resources (socket generations, peer connections, tracks) are visible.

## Run

```sh
# from the repo root: build the pack fixture, bundle, and serve on :4200
node test/example/build-softphone.mjs

# or run the full Playwright gate (builds + serves + tests)
npm run test:example
```

The example has no runtime dependency beyond the bundled `sip-worker` artifact.
Credentials are held in memory only; nothing is persisted or logged.
