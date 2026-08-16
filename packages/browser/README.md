# sip-worker

SIP stack (RFC 3261) browser entry point. This package is owned by the
sip-worker project and exposes the browser `UserAgent` plus common API. Since
0.5.0 it ships **real WebRTC media**; since 0.7.0 it adds the **browser phone
product surface**: a `BrowserPhone` composition root, per-call ownership
(`BrowserCall`, `OutgoingBrowserCall`, `IncomingBrowserCall`), bounded
WSS/registration/call recovery, and call controls — mute, hold/resume, and
RFC 4733 DTMF — over a real `RTCPeerConnection` audio session.

`sip-worker` 0.7.0 is an **internal-beta browser phone**, not a completed v1
production product. One phone owns at most one live call (busy → `486 Busy
Here`); it is suitable for an internal beta or a tightly controlled non-customer
pilot, while PBX certification and soak remain v0.9 gates. Non-trickle ICE only.
It is verified on Chromium, Firefox, and Playwright WebKit against the built
tarball but carries no interop evidence against production media stacks.
`sip-worker` is **Node-free**: the browser bundle builds with no Node polyfill,
and the DOM-typed phone/media surface is import-time side-effect free.

The v0.5 `BrowserUserAgent` + `ua.media` surface remains available as a
**deprecated compatibility wrapper** over the same phone runtime.

See the [browser phone guide](../docs/browser-phone.md) (setup, states, error
codes, recovery, controls, TURN, limitations), the
[diagnostics guide](../docs/diagnostics.md) (resource counters and diagnostic
codes), the [browser media guide](../docs/browser-media.md) (v0.5 real media
setup and security), and the
[migration guide](../docs/migrations/0.5-to-0.7.md) for the changes since 0.5.

## Environment boundaries

- **`sip-worker` (browser)** depends only on `@sip-worker/core@0.7.0` exactly.
  The root re-exports the common core API; the browser WebSocket adapter, the
  `BrowserPhone`/`BrowserCall` surface, the deprecated `BrowserUserAgent`, and
  the browser media layer live here.
- For the 0.2.0 → 0.3.0 move map see
  [the 0.2-to-0.3 migration](../docs/migrations/0.2-to-0.3.md).

## License

MIT
