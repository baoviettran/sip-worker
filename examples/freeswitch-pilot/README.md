# FreeSWITCH pilot softphone

A single-page packed-artifact softphone for manual interop testing against a
FreeSWITCH SIP-over-WSS deployment. This is **not a certification suite** and
**not intended for production use** — it is a tightly controlled internal pilot
for validating the v0.7 browser phone surface against a real PBX.

## Prerequisites

- **Node 20+** (the build and dev server require it)
- **FreeSWITCH** with a SIP-over-WSS profile listening on `wss://` (port 7443
  or equivalent). The profile must accept `1001`-style extensions with the
  password `testpass` (or whatever you configure below).
- **WebRTC codecs**: FreeSWITCH must advertise PCMU/PCMA (or Opus) in its SDP
  offer. The browser negotiates codecs automatically.
- **RTP reachability**: the FreeSWITCH media IP must be reachable from the
  browser. For local testing this is usually `127.0.0.1`; for remote testing
  you need STUN/TURN.
- **STUN/TURN** (optional): if the browser and FreeSWITCH are on different
  networks, configure a TURN relay in the FreeSWITCH profile and enter its
  credentials in the UI's TURN fields.
- **HTTPS page**: the browser phone requires a secure context. `pilot:dev`
  serves over HTTPS with a one-day local certificate. For static deployment
  you need a reverse proxy or a trusted certificate.
- **Trusted WSS certificate**: the WSS endpoint must use a certificate the
  browser trusts. For local testing, add the local CA certificate to your
  browser's trust store (see [Troubleshooting](#troubleshooting) below).
- **Playwright browser** (for automated tests only): install with
  `npx playwright install chromium`.

## Running

### Development server

```sh
npm run pilot:dev
```

Opens `https://127.0.0.1:4400` with a live-reloading build and a built-in
fake SIP server for automated tests. Add `?relay=1` to the URL to activate
the in-page media relay for deterministic testing.

### Static build

```sh
npm run pilot:build
```

Produces a self-contained `dist/` directory. Deploy it behind an HTTPS reverse
proxy that terminates TLS for both the page and the WSS endpoint.

### Automated tests

```sh
npm run test:pilot
```

Runs typecheck, unit tests, and the full Playwright acceptance gate (13
scenarios) without external credentials or a real FreeSWITCH. The test gate
uses a fake SIP server and in-page media relay.

## Configuration

| Field            | Description                                      | Example                      |
|------------------|--------------------------------------------------|------------------------------|
| WSS URL          | `wss://` endpoint for SIP signaling              | `wss://pbx.example.com:7443` |
| SIP Domain       | SIP domain for registration and calls            | `pbx.example.com`            |
| Extension        | SIP extension number                             | `1001`                       |
| Password         | SIP authentication password                      | `testpass`                   |
| TURN URL         | STUN/TURN server URL (optional)                  | `stun:stun.example.com:3478` |
| TURN Username    | TURN credential username (optional)              | `user123`                    |
| TURN Password    | TURN credential password (optional)              | `secret456`                  |

### Tester label

The "Environment" field is a free-text label (e.g. `FreeSWITCH 1.10.11 on
Ubuntu 22.04`) that appears in the downloaded JSON evidence. It is stored
**only in the browser's memory** — never sent to any server.

### Credential non-persistence

All SIP and TURN credentials are held in memory only — JavaScript variables
that are never persisted to `localStorage`, `sessionStorage`, cookies, or any
server. Closing the tab or reloading the page clears them. The evidence JSON
**redacts** passwords and TURN credentials before download.

## One phone, one call

The pilot enforces a strict one-phone/one-call model:
- Only one `BrowserPhone` instance can be active at a time.
- Only one call (incoming or outgoing) can be active at a time.
- A second call attempt is rejected with a busy response.

## Registration expiry and refresh

The built-in registrar refreshes registration automatically at 75% of the
expiry interval (default 60s). This differs from SIP.js, which uses a
configurable `refresh` option. The pilot exposes the expiry via the UI but the
refresh timing is internal.

## Incoming local hangup limitation

Local incoming hangup is not supported in v0.7: the "Hangup" button is
**disabled** for established incoming calls. The only way to end an incoming
call is for the remote party to send BYE. Attempting local hangup returns an
`INVALID_STATE` error. This limitation is planned for a later release.

## Manual testing scenarios

The evidence panel tracks 14 scenarios. Each scenario must be run through
**20 consecutive cycles** (call → verify → hangup) on a **separate network**
for the TURN scenario. A scenario is marked "pass" only when all 20 cycles
complete without error.

| #  | Scenario                        | What to verify                                     |
|----|---------------------------------|----------------------------------------------------|
| 1  | authenticated-registration      | Register succeeds, status shows "registered"        |
| 2  | outgoing-two-way-audio          | Both sides hear audio after answer                  |
| 3  | incoming-answer-remote-bye      | Answer incoming call, remote hangs up               |
| 4  | incoming-reject                 | Reject incoming call, status shows terminal state   |
| 5  | outgoing-cancel                 | Cancel outgoing INVITE before answer                |
| 6  | local-and-remote-hangup         | Both local and remote hangup work                   |
| 7  | mute-unmute                     | Mute silences local, unmute restores                |
| 8  | hold-resume                     | Hold sends remote hold, resume restores             |
| 9  | rfc4733-dtmf                    | DTMF digits received by remote                      |
| 10 | wss-registration-recovery       | Drop WSS, verify re-registration on reconnect       |
| 11 | call-network-recovery           | Drop network mid-call, verify recovery              |
| 12 | stun-turn-nonlocal              | TURN relay works across separate networks           |
| 13 | repeated-call-cycles            | 20 consecutive calls without resource leaks         |
| 14 | zero-resource-dispose           | Dispose leaves zero active counters                 |

### Zero-resource criterion

After disposing the phone, the resource snapshot must show zero for all
counters: active calls, pending operations, active negotiations, armed timers,
media sessions, and open ports.

## Evidence

- **Copy**: copies the JSON evidence (including build metadata, scenario
  statuses, and diagnostic events) to the clipboard. Passwords and TURN
  credentials are **redacted**.
- **Download**: saves the same JSON to a file.
- The JSON includes `buildMetadata` with the packed-artifact version and build
  timestamp.

### Not general certification

The evidence produced by this pilot is **manual evidence** (interop testing),
not a general certification. It proves the phone worked against one specific
FreeSWITCH deployment under controlled conditions. It does not prove
interoperability with all SIP implementations.

## Troubleshooting

### TLS trust errors

If the browser shows `NET::ERR_CERT_AUTHORITY_INVALID`:
1. Find the CA certificate (printed by `pilot:dev` in the terminal output).
2. Add it to your browser's certificate trust store.
3. Restart the browser.

### 401 / 407 authentication errors

- Verify the extension and password match the FreeSWITCH user directory.
- Check that the SIP domain matches the FreeSWITCH `realm` setting.
- Ensure the WSS URL points to the correct SIP-over-WSS profile.

### No audio / silent audio

- Check that FreeSWITCH is advertising PCMU/PCMA or Opus in its SDP.
- Verify RTP reachability (try `stun:` if on different networks).
- On Chrome, ensure the page has a user gesture before audio plays (click
  anywhere on the page first).

### NAT / TURN issues

- If the browser and FreeSWITCH are on different networks, configure a TURN
  relay in FreeSWITCH and enter its credentials in the UI.
- Test with `stun:` first; use `turn:` only if STUN is blocked.

### DTMF not received

- Ensure FreeSWITCH is configured for RFC 2833 (telephone-event) DTMF.
- Check that the `telephone-event` codec is in the SDP offer/answer.

### Reconnection issues

- The phone reconnects automatically on network recovery (up to 20 consecutive
  failures). Check the "Connection" status in the UI.
- If reconnection fails, reload the page and re-enter credentials.

### Non-zero resource counters after dispose

- Ensure only one phone instance was active.
- Check the browser console for leaked media streams or ports.
- Close any other tabs that might be holding WebRTC connections.
