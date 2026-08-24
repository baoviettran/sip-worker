# SIPp protocol corpus (v0.9 WS2)

Protocol-level interoperability evidence for the SIP stack by running committed
SIPp scenarios against the real `UserAgent` from `sip-worker/node`, packed from
release tarballs (never `packages/**/src`).

## Requirements

- Docker with the pinned image already pulled (see below).
- Node >= 20, npm workspace dependencies installed (`npm ci`).

## Image pin

```
pbertera/sipp@sha256:063e8e9c8ecf54552e8efc3c363007afbfd3cae5a0f3f037db1c2e7fa4cd0349
```

SIPp 3.5.1. The spec's primary `ghcr.io/restcomm/sipp` is registry-denied for
every tag; this is the spec's documented fallback, pinned by digest.

## Running

```sh
npm run test:sipp              # all scenarios (packs tarballs, boots docker)
npm run test:sipp -- register-auth   # one scenario by name
npm run test:sipp:unit         # driver unit tests (no docker)
npm run test:sipp:infra        # config + integrity + boundary tests (no docker)
```

Every run packs fresh `@sip-worker/core` and `@sip-worker/node` tarballs into
`test/sipp/fixtures/` (gitignored) and boots docker SIPp on loopback with
`--network host`. A scenario passes only when both the SIPp exit code and the
driver's UA-level assertions pass (fail-not-skip).

## Scenario index

| Scenario | Role | Transport | Proves |
|---|---|---|---|
| register-basic | UAS | udp | REGISTER → 200; registered state |
| register-auth | UAS | udp | 401 → Digest retry → 200; wrong-password → `REGISTRATION_FAILED` |
| register-refresh | UAS | udp | re-REGISTER before expiry; >= 3 wire REGISTERs |
| invite-outgoing | UAS | udp + tcp | INVITE → 180/200 → ACK → confirmed; BYE → terminated |
| invite-incoming | UAC | udp | `Invitation.answer()` → established; remote BYE → terminated |
| cancel-race | UAC | udp | CANCEL → 200/487 → invitation terminated, never confirmed |
| retransmissions | UAS | udp | delayed 200 forces >= 2 INVITE sends; exactly one confirmation |
| bye-timeout | UAS | udp | BYE unanswered → F-timer → hangup rejects, session reverts to confirmed |
| malformed | UAS | udp | garbage → `PROTOCOL_ERROR` event; registration still succeeds |
| reconnect | UAS | udp | new transport + fresh REGISTER restores registration, monotonic CSeq |
