# FreeSWITCH Pilot App Design

**Date:** 2026-08-17

**Status:** Approved for implementation planning

## Purpose

Add a standalone, single-page pilot softphone under
`examples/freeswitch-pilot/`. The app connects the public `sip-worker` v0.7
browser API to an existing FreeSWITCH development proxy, exposes the essential
phone and call operations, and produces redacted, reproducible interoperability
evidence.

The pilot has two jobs:

1. Give an operator a safe page for exercising a real FreeSWITCH account.
2. Record structured evidence that can support a library release decision.

The app complements, rather than modifies, the deterministic
`examples/browser-softphone/` fixture. It consumes a packed public artifact so
the exercised code has the same package boundary as an external consumer.

## Scope

### Included

- Runtime entry of the WSS endpoint, SIP domain, extension, password, and an
  optional local tester label.
- Optional static STUN/TURN servers and an ICE relay-only mode.
- Connection, registration, unregister, disconnect, and disposal controls.
- Outgoing calls and incoming answer/reject.
- Cancel, local/remote hangup observation, mute/unmute, hold/resume, ICE
  restart, and RFC 4733 DTMF.
- Microphone selection and app-owned remote audio playback.
- Typed state, error, diagnostic, and exact resource-counter presentation.
- A guided scenario checklist and redacted JSON evidence export.
- Deterministic UI/application tests and a separately gated real-FreeSWITCH
  pilot procedure.
- Static output suitable for an internal HTTPS host, plus a localhost
  development server.

### Excluded

- SharedWorker or multi-tab call ownership.
- More than one live call per phone.
- Configurable REGISTER expiry or refresh percentages.
- SIP `From` display-name customization.
- Automatic inbound answer.
- Predictive-call metadata such as `extra_interact_card_id`.
- Persisted accounts, passwords, TURN credentials, or call history.
- A backend credential service or dynamic TURN credential provider.
- A claim of general PBX certification or production readiness.

If the existing FreeSWITCH environment requires an excluded SIP.js behavior,
the pilot records it as a compatibility finding. It must not silently emulate
or work around that behavior.

## FreeSWITCH Configuration Mapping

The operator supplies the complete WSS URL. The app does not infer a path,
scheme, or port.

| Pilot input | `BrowserPhoneOptions` value |
| --- | --- |
| WSS endpoint | `signaling.url` |
| SIP domain | `account.registrarUri = sip:<domain>` |
| Extension | `account.aor = sip:<extension>@<domain>` |
| Extension | `account.contact = sip:<extension>@<domain>` |
| Extension | `account.username` |
| Decoded SIP password | `account.password` |
| Tester label | Local UI/evidence metadata only; never sent in SIP |
| ICE server rows | `media.iceServers` |
| Relay-only switch | `media.iceTransportPolicy = relay` |
| Default ICE mode | `media.iceTransportPolicy = all` |

The current SIP.js application requests a 120-second registration, custom
refresh percentages, and a SIP display name. `BrowserPhone` does not expose
those settings in v0.7, so the pilot uses the library-owned registration expiry
and refresh lifecycle and does not transmit a display name. Failure against a
FreeSWITCH policy requiring the SIP.js values is release evidence for a missing
compatibility capability.

## Architecture

### Repository boundary

Create a new `examples/freeswitch-pilot/` application. Its expected
responsibilities are:

- `index.html`: accessible form, controls, state regions, event log, scenario
  checklist, and evidence actions.
- `src/main.ts`: application composition, phone/call ownership, state-driven
  controls, and DOM wiring.
- `src/config.ts`: input parsing, validation, normalization, and conversion to
  `BrowserPhoneOptions`.
- `src/evidence.ts`: redacted evidence model, scenario tracking, serialization,
  and report download/copy support.
- `src/redaction.ts`: one conservative secret-redaction boundary shared by
  logs, errors, and evidence.
- `src/media.ts`: microphone selection and the browser media-environment
  wrapper.
- `src/styles.css`: responsive single-page presentation.
- `README.md`: local use, internal deployment, FreeSWITCH prerequisites,
  scenario execution, and evidence interpretation.

The exact file split may be refined during implementation planning, but the
configuration, evidence, redaction, and media responsibilities must remain
independently testable.

### Runtime ownership

One page owns at most one `BrowserPhone`. That phone owns at most one live
`BrowserCall`, matching the v0.7 contract. Reconfiguration requires a full
dispose before constructing another phone.

The app state progresses through these ownership phases:

```text
unconfigured
  -> configured
  -> connected
  -> registered
  -> establishing or incoming
  -> established
  -> terminated or failed
  -> registered
  -> unregistered
  -> disposed
```

The library's typed facts remain authoritative. The UI never invents a
successful state from a button click; it updates controls and evidence only
after the matching promise settles or event commits.

### Phone construction

Construction uses only public exports:

- `BrowserPhone`
- `BrowserPhoneOptions`
- `createBrowserMediaEnvironment`
- public call and event types

The browser seams use `WebSocket`, `navigator.onLine`, window lifecycle
listeners, and a media-environment wrapper for the selected microphone. The
app subscribes to all phone and active-call state/failure events before it
starts the first network operation.

### Audio ownership

The app owns one remote `<audio>` element. A `remoteAudio` event installs its
stream, but playback starts only from a trusted operator gesture. This keeps
the flow valid under browser autoplay policy.

Microphone enumeration occurs after permission is granted. Selecting a device
causes future `getUserMedia` calls to request that exact `deviceId`; it does not
mutate an active track behind the library's ownership boundary.

## One-Page User Interface

The page contains six compact regions:

1. **Configuration**: WSS, domain, extension, password, local tester label,
   ICE servers, relay-only mode, and validation results. The tester label is
   visibly marked as local-only and is not a SIP display name.
2. **Phone lifecycle**: create/connect, register, unregister, disconnect,
   dispose, and reset.
3. **Call controls**: target URI/extension, call, cancel, answer, reject,
   hangup, mute, hold, resume, ICE restart, and DTMF keypad.
4. **Media**: microphone selection, remote-audio readiness, and an explicit
   Play Audio action.
5. **Live status**: connection, registration, call, signaling, media, mute,
   hold, remote identity, typed error, and the exact 11 resource counters.
6. **Evidence**: scenario checklist, current run metadata, findings, JSON
   preview, copy, and download.

Controls are state-gated. For example, Register is enabled only after a
connection; Hold only on an established, non-held call; Resume only on a
locally held call; and Dispose remains available whenever the phone exists.
Invalid operations are still caught and rendered if an event races a UI state
change.

## Configuration and Credential Safety

- The page requires `wss://`; it never sets
  `signaling.allowInsecureWebSocket`.
- The page must be served from HTTPS or the browser's localhost secure-context
  exception.
- Password and TURN credential fields use password controls.
- Credentials live only in the current JavaScript object graph.
- Reset and dispose remove credential values from application state and input
  elements.
- The app never writes configuration to local storage, session storage,
  IndexedDB, cookies, query strings, fragments, or service-worker caches.
- Passwords, authorization values, raw SIP messages, SDP, and ICE credentials
  never enter logs or evidence.
- TURN username and credential are accepted only as a complete pair.
- Static ICE servers and relay-only mode are pilot inputs; there is no dynamic
  provider in this scope.
- Diagnostic rendering uses the library's redacted records and passes all text
  through the pilot's conservative redaction boundary.

Configuration validation rejects malformed WSS/SIP/ICE values before phone
construction. Validation errors name the field and safe reason without
echoing secrets.

## Errors, Recovery, and Cleanup

Every operator action runs through a common operation boundary that records:

- operation name;
- start and settlement time;
- success or failure;
- typed error code when present;
- redacted message.

The event log is bounded so an extended pilot cannot grow memory without a
limit. It records committed connection, registration, call, signaling, media,
mute, and hold transitions.

WSS loss is left to the library's bounded reconnect and registration-recovery
policy. The UI displays recovery transitions and prevents a second manual
connection attempt from racing the owned recovery cycle.

Dispose is always the terminal cleanup operation. After it settles, the app
captures the final resource snapshot and evaluates all 11 counters against
zero. Cleanup failure or a non-zero counter is an evidence failure, even when
the call itself succeeded.

## Release Evidence

### Report contents

Each evidence run has a random local run identifier and includes:

- schema version;
- `sip-worker` package version, Git commit, and packed-artifact hash when the
  build provides them;
- browser name/version, operating system, and timestamp;
- operator-entered FreeSWITCH version and non-secret environment label;
- WSS host/port/path and SIP domain, with user info, query values, fragments,
  and credentials removed;
- configured ICE mode and selected local/remote candidate types when safely
  observable;
- timestamped state transitions and operation settlements;
- per-scenario pass/fail/blocked status and redacted notes;
- compatibility findings;
- final resource snapshot;
- overall verdict.

The report excludes passwords, authorization headers, raw SIP messages, SDP,
ICE candidates/addresses, TURN usernames, TURN credentials, phone numbers
beyond the configured test identifiers, and media contents.

### Scenario matrix

The guided checklist covers:

1. Authenticated registration and unregister.
2. Outgoing call with two-way audio.
3. Incoming answer and remote hangup.
4. Incoming reject.
5. Outgoing cancel.
6. Local and remote hangup.
7. Mute/unmute with operator-confirmed audio behavior.
8. Hold/resume with two-way audio recovery.
9. RFC 4733 DTMF observed by FreeSWITCH or a controlled peer.
10. WSS interruption and registration recovery.
11. Call recovery after a network interruption.
12. STUN/TURN operation from a non-local network.
13. Repeated call cycles.
14. Dispose with all 11 resource counters equal to zero.

Operator-observed audio and FreeSWITCH-side facts are explicitly labeled as
manual assertions. The report must not present them as measurements made by
the library.

### Evidence strength

A redacted manual report from the development proxy is real interoperability
evidence, but it is not a general FreeSWITCH certification. Release-gate
strength additionally requires automation against a pinned FreeSWITCH
version/configuration. That automation is a later v0.9 hardening task and can
reuse the scenario names and evidence schema defined here.

## Build and Test Strategy

The repository exposes these intended commands:

```sh
npm run pilot:dev
npm run pilot:build
npm run test:pilot
```

- `pilot:dev` packs the browser library and dependencies, bundles the pilot,
  and serves it from localhost.
- `pilot:build` produces deployable static output from the packed public
  artifact.
- `test:pilot` runs deterministic application tests without external
  FreeSWITCH credentials.

Tests cover:

- configuration normalization and rejection;
- complete-pair validation for TURN credentials;
- WSS-only policy;
- credential non-persistence and redaction;
- state-gated controls;
- phone/call event rendering;
- operation settlement and typed error rendering;
- bounded event history;
- evidence schema, serialization, and secret scans;
- final zero-resource evaluation;
- packed-artifact build and browser boot.

Real FreeSWITCH execution is environment-gated, manual in the first version,
and excluded from ordinary `npm test` and `npm run verify`. No credentials or
environment endpoints are committed.

## Pilot Acceptance Criteria

The first pilot is acceptable when:

- every essential scenario passes in current Chromium and Firefox;
- one run from a separate network demonstrates TURN successfully;
- 20 consecutive call cycles return to the idle resource baseline;
- WSS loss restores registration without a page refresh;
- disposal ends with all 11 resource counters at zero;
- no unresolved critical or high-severity finding remains;
- the evidence report contains no secret or disallowed raw protocol/media
  material;
- the exact package hash, Git commit, browser versions, FreeSWITCH version,
  and environment label are attached to the release record.

These criteria authorize an internal or controlled pilot only. They do not
change v0.7's documented production-readiness position.

## Follow-on Work

Results from the pilot drive, rather than pre-judge, later work. Expected v0.9
candidates include configurable registration expiry when FreeSWITCH evidence
requires it, pinned FreeSWITCH automation, broader PBX/SBC/NAT matrices,
multi-tab ownership, predictive metadata exposure, load testing, and soak
testing.
