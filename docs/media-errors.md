# Media errors (v0.5)

Every browser media failure surfaces as a `MediaError` — a subclass of `Error`
carrying a `code` from the `MediaErrorCode` union and a fixed human `message`.
`MediaError` is the typed, reconstructible error crossing the core/browser
boundary. It carries **no SDP, no device ID, no credential, no stack, and no raw
browser message** (the original cause is kept only in memory, non-enumerable,
for debugging). `code` is always one of the 14 codes below; an unknown/out-of-union
code in a reply is reconstructed as `INTERNAL_ERROR`.

On a `BrowserUserAgent`, media failures arrive on the `mediaFailed` typed event
(`{ sessionId, error }`) and as rejections from the `ua.media` facade and
`restartIce()`. `restartIce()` signaling failures are `SipError` with
`INVALID_STATE`, not `MediaError`. Use `error.code` to drive user-facing
troubleshooting; see the running example in
[`docs/browser-media.md`](./browser-media.md).

## The 14 codes

| Code | When it surfaces | Recovery |
|---|---|---|
| `PERMISSION_DENIED` | The user or the Permissions Policy blocked capture (`NotAllowedError` from `getUserMedia`, or a revoked site permission). | Re-run `prepare()` within a user gesture after the user re-grants in site settings. Check `navigator.permissions.query({ name: 'microphone' })`; if `denied`, guide to the browser permission UI. |
| `DEVICE_NOT_FOUND` | No matching device exists (`NotFoundError`): a selected `microphoneDeviceId` no longer exists, or no device satisfies the constraints. | Refresh with `listDevices()` and let the user pick an existing device. |
| `DEVICE_UNAVAILABLE` | The device exists but is unusable or held by another application (`NotReadableError`), or a stream arrived with no usable audio track. | Close other apps using the mic and reselect. v0.5 does not auto-fallback on unplug; the failure is terminal. |
| `CONSTRAINT_UNSATISFIED` | No device can satisfy `audioConstraints` (`OverconstrainedError`). | Loosen constraints (e.g. drop an unsupported capability) and retry. |
| `NEGOTIATION_FAILED` | Media negotiation failed — for example no primary audio codec is usable against the browser's capabilities. | Confirm the peer offers a supported codec (`opus`, `PCMU`, `PCMA`); check `codecPreference`. |
| `REMOTE_DESCRIPTION_REJECTED` | The remote SDP offer/answer was rejected during negotiation. | Verify the peer's SDP is a valid, compatible offer/answer. |
| `ICE_GATHERING_TIMEOUT` | ICE gathering did not finish before `iceGatheringTimeoutMs` (default 8 s). | Check the STUN/TURN reachability and credential validity; try `iceTransportPolicy: 'relay'`. |
| `ICE_CONNECTION_FAILED` | ICE could not establish the media connection (existing candidates failed). | Verify STUN/TURN configuration, NAT traversal, and that both ends share reachable candidates. Consider `restartIce()`. |
| `OUTPUT_SELECTION_UNSUPPORTED` | `setSinkId` is missing on the element/device. | Capability-gate output selection; do not expose a device switcher when unsupported. |
| `PLAYBACK_FAILED` | `element.play()` rejected (commonly autoplay policy). | Play within a user gesture; on rejection surface UI and retry on click. |
| `ABORTED` | The operation was aborted (its `AbortSignal` fired, or `dispose()` ran). | Re-run the operation on a live `BrowserUserAgent`. |
| `INVALID_STATE` | A media operation is illegal for the current session state, such as overlapping negotiation or using a closed session. | Wait for the current operation to settle or create a live session; do not retry concurrently. |
| `MEDIA_OPERATION_TIMEOUT` | A browser media command exceeded the configured operation deadline. | Treat the operation as failed, close the affected call, verify device and network health, then start a fresh session. |
| `INTERNAL_ERROR` | Any unexpected/unknown failure. | Retry; if persistent, capture the local client environment and file a bug (no SDP/device data in the surfaced error). |

## Programmatic reference

```ts
class MediaError extends Error {
  readonly code: MediaErrorCode;
  readonly message: string;
  readonly sessionId?: string;
  readonly operation?: string;
  constructor(
    code: MediaErrorCode, message: string,
    sessionId?: string, operation?: string, options?: ErrorOptions,
  );
}
```

`MEDIA_ERROR_CODES` is the readonly tuple of the 14 codes; `MediaErrorCode` is
the union. Both are exported from core and re-exported from the browser root.
All 14 messages are fixed and safe; never interpolate a raw exception message
into UI text derived from `MediaError`.
