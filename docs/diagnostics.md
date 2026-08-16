# Diagnostics and resource counters

This document is the truthful contract for the v0.7 diagnostics surface exposed
by `sip-worker`. A `BrowserPhone` exposes a read-only diagnostics facade, and an
injected logger receives a bounded, redacted event stream. The design goal is
that an operator can reconstruct **what happened** (which subsystem, which
code, which bounded context) and **what the phone currently owns** (resource
counts) — without ever leaking credentials, SDP, URIs, or raw browser text.

## The diagnostics facade

```ts
const snapshot: ResourceSnapshot = phone.diagnostics.resources();
```

`PhoneDiagnostics.resources()` snapshots the resources the phone currently
owns, wired to direct owners — the reconnect controller, the runtime's live
call set and pending operations, and the media manager's session/track/device
listeners. Counters are **diagnostic assertions, never mutable control
surfaces**: they report ownership, they do not change it.

## ResourceSnapshot counters

`ResourceSnapshot` is an immutable object with the following numeric fields:

| Counter | Owner / meaning |
| --- | --- |
| `activeSocketGenerations` | Live socket generations in the reconnect controller. |
| `reconnectAttempts` | 1 while a recovery cycle is armed, 0 when recovery is idle (a boolean recovery-lifecycle indicator, not a count of live socket attempts). |
| `reconnectTimers` | Armed reconnect backoff timers. |
| `activeCalls` | Live calls in the runtime's call set. |
| `activeNegotiations` | In-flight signaling negotiations across live calls. |
| `pendingOperations` | In-flight public operations (connect/register/call/control). |
| `timers` | Armed timers owned by the runtime and its calls. |
| `peerConnections` | Live `RTCPeerConnection` instances owned by media sessions. |
| `localTracks` | Live local media tracks owned by media sessions. |
| `lifecycleListeners` | Phone/browser lifecycle subscriptions (the phone's own offline subscription + reconnect lifecycle listeners). |
| `deviceListeners` | Media device (e.g. `devicechange`) listeners. |

After `phone.dispose()` every counter is `0` — the zero-owned-resources
baseline is asserted by `test/browser-phone`.

## Diagnostic codes

`DiagnosticCode` is a closed union. Every code maps to one
`DiagnosticSubsystem` and to a per-code allowlist of context keys. The full
union:

**connection.** `connection.connecting`, `connection.connected`,
`connection.reconnect_attempt`, `connection.reconnect_attempt_failed`,
`connection.reconnected`, `connection.recovery_failed`, `connection.closed`

**registration.** `registration.registering`, `registration.registered`,
`registration.recovering`, `registration.recovery_failed`,
`registration.unregistered`

**call.** `call.established`, `call.recovering`, `call.hold`, `call.resume`,
`call.dtmf_failed`, `call.terminated`, `call.failed`

**media.** `media.failed`

**lifecycle.** `lifecycle.disposed`

## Severities and subsystems

`DiagnosticSeverity` is `'debug' | 'info' | 'warn' | 'error'`.
`DiagnosticSubsystem` is the closed union
`'connection' | 'registration' | 'call' | 'media' | 'lifecycle'`.

## Records and the logger

A `DiagnosticRecord` is an immutable, vendor-neutral object:

```ts
interface DiagnosticRecord {
  readonly timestamp: number;
  readonly severity: DiagnosticSeverity;
  readonly subsystem: DiagnosticSubsystem;
  readonly code: DiagnosticCode;
  readonly connectionId?: string; // opaque local handle
  readonly callId?: string;       // opaque local handle, never the SIP Call-ID
  readonly context?: Readonly<Record<string, string | number | boolean>>;
}
```

Inject a sink through `BrowserPhoneOptions.diagnostics.logger`:

```ts
const phone = new BrowserPhone({
  options: {
    // ...
    diagnostics: {
      logger: (record) => sendToMetrics(record),
    },
  },
  // ...
});
```

## Redaction policy

The v0.7 diagnostics surface is **redacted by construction**. The following
never appear in a diagnostic record, a public error, or a docs example:

- credentials (`username`/`password`), `Authorization` headers
- full SIP URIs and user headers
- SDP bodies and ICE candidates
- IP addresses
- device IDs and device labels
- raw browser exception text

`DiagnosticRecorder` enforces a per-code **allowlist** of context keys; a
context key that is not allowlisted for its code is dropped, and record values
are bounded in size (`MAX_CONTEXT_LENGTH`). This is a release contract — the
tests assert that the redaction allowlists hold across the browser-phone
scenarios.

## Related documents

- [Browser phone guide (v0.7)](../docs/browser-phone.md)
- [Browser media guide (v0.5)](../docs/browser-media.md)
