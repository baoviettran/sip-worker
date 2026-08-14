# sip-worker

SIP stack (RFC 3261) browser entry point. This package is owned by the
sip-worker project and exposes the browser `UserAgent` plus common API. Since
0.5.0 it also ships **real WebRTC media**: a `BrowserUserAgent` composition root
with `ua.media` (devices, microphone selection, and remote-audio playback) over
a real `RTCPeerConnection` audio session.

`sip-worker` 0.5.0 is a **real-media foundation**, not a completed v1 production
product. It supports one active call (busy → `486 Busy Here`), non-trickle ICE
only, and no DTMF / SIP INFO / MSRP. It is verified for two-way audio on
Chromium, Firefox, and Playwright WebKit against the built tarball but carries no
interop evidence against production media stacks. `sip-worker` is **Node-free**:
the browser bundle builds with no Node polyfill, and the DOM-typed media surface
is type-only.

See the [browser media guide](../docs/browser-media.md) (setup, security,
permission recovery, TURN, typed media errors) and the
[migration guide](../docs/migrations/0.3-to-0.5.md) for the changes since 0.3.

## Environment boundaries

- **`sip-worker` (browser)** depends only on `@sip-worker/core@0.5.0` exactly.
  The root re-exports the common core API; the browser WebSocket adapter, the
  `BrowserUserAgent`, and the browser media layer live here.
- For the 0.2.0 → 0.3.0 move map see
  [the 0.2-to-0.3 migration](../docs/migrations/0.2-to-0.3.md).

## License

MIT
