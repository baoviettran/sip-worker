# FreeSWITCH Pilot App Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a secure, configurable, packed-artifact one-page softphone under `examples/freeswitch-pilot/` that exercises a real FreeSWITCH development proxy and exports redacted release evidence.

**Architecture:** Keep configuration validation, redaction, evidence recording, control-state derivation, and media selection as small independently tested modules. Compose them in one browser entry point over the public `BrowserPhone`/`BrowserCall` API, bundle against freshly packed tarballs, and use the existing fake SIP/media relay for deterministic Playwright coverage while keeping real FreeSWITCH execution manual and environment-gated.

**Tech Stack:** TypeScript 5.x, public `sip-worker` 0.7 API, browser DOM/WebRTC/WebSocket APIs, esbuild, Vitest, Playwright, Node.js test/build servers.

## Global Constraints

- Consume only the packed public `@sip-worker/core` and `sip-worker` artifacts at runtime; never import `packages/**/src`.
- Require a complete `wss://` endpoint. Never enable `allowInsecureWebSocket`.
- Keep SIP and TURN credentials in live memory only; never write them to storage, URLs, logs, diagnostics, evidence, or committed fixtures.
- Own at most one `BrowserPhone` and one live `BrowserCall` per page.
- Treat the tester label as local metadata only; v0.7 cannot transmit a SIP `From` display name.
- Use the library-owned REGISTER expiry/refresh lifecycle; v0.7 does not expose the SIP.js `registerExpires` or refresh percentages.
- Auto-answer, predictive metadata, SharedWorker/multi-tab ownership, and dynamic TURN providers remain out of scope.
- An answered `IncomingBrowserCall` cannot locally hang up in v0.7 (`hangup()` rejects `INVALID_STATE`). Disable that button for incoming calls, document the limitation, and still test remote BYE. Do not patch the library as part of this app plan.
- Real FreeSWITCH tests never run from `npm test` or `npm run verify` and never require committed credentials.
- Manual evidence supports an internal pilot; it must not claim general FreeSWITCH certification or production readiness.

---

## File Structure

Create these focused units:

```text
examples/freeswitch-pilot/
  README.md                    operator setup and manual FreeSWITCH matrix
  index.html                   accessible single-page markup
  package.json                 private example metadata
  tsconfig.json                strict standalone typecheck
  src/
    build-info.d.ts            esbuild-injected build metadata declaration
    config.ts                  form parsing and BrowserPhoneOptions mapping
    controls.ts                pure state-to-enabled-controls derivation
    evidence.ts                bounded redacted evidence recorder/export
    main.ts                    one-phone/one-call orchestration and DOM wiring
    media.ts                   selected-microphone environment wrapper
    redaction.ts               shared secret/protocol redaction boundary
    styles.css                 responsive pilot UI

test/freeswitch-pilot/
  build-pilot.mjs              pack, hash, install, and bundle public artifacts
  config.unit.test.ts          config mapping and WSS/ICE validation
  controls.unit.test.ts        state gating, including incoming hangup limit
  evidence.unit.test.ts        schema, bounds, zero-resource verdict, secrets
  markup.unit.test.ts          accessible DOM/test-id contract
  media.unit.test.ts           selected microphone wrapper
  redaction.unit.test.ts       SIP/auth/SDP/ICE/explicit-secret removal
  relay.js                     test-only WSS in-page synthetic media relay
  server.mjs                   static HTTP + fake SIP WSS/control server
  playwright.config.ts         deterministic Chromium pilot gate
  pilot.spec.ts                packed-artifact UI acceptance
```

Modify `package.json`, `README.md`, and `test/package/documentation-contract.test.mjs`.

Do not modify `examples/browser-softphone/` or `test/example/` except to import their existing fake-server classes/helpers from the new test harness.

---

### Task 1: Secure configuration and redaction core

**Files:**
- Create: `examples/freeswitch-pilot/package.json`
- Create: `examples/freeswitch-pilot/tsconfig.json`
- Create: `examples/freeswitch-pilot/src/config.ts`
- Create: `examples/freeswitch-pilot/src/redaction.ts`
- Test: `test/freeswitch-pilot/config.unit.test.ts`
- Test: `test/freeswitch-pilot/redaction.unit.test.ts`

**Interfaces:**
- Produces: `PilotFormValues`, `PilotIceServerInput`, `PilotConfig`, `parsePilotConfig(values)`, `toBrowserPhoneOptions(config, logger, microphoneDeviceId?)`, `safeEndpointSummary(url)`, `redactText(text, secrets)`, and `safeError(error, secrets)`.
- Consumes: public `BrowserPhoneOptions` and `DiagnosticLogger` types from `sip-worker`.

- [ ] **Step 1: Add failing configuration tests**

Create `test/freeswitch-pilot/config.unit.test.ts` with these cases:

```ts
import { describe, expect, it } from 'vitest';
import {
  parsePilotConfig,
  safeEndpointSummary,
  toBrowserPhoneOptions,
  type PilotFormValues,
} from '../../examples/freeswitch-pilot/src/config.js';

const base: PilotFormValues = {
  wssUrl: 'wss://fs-dev.example.test:7443/ws?route=pilot#ignored',
  sipDomain: 'tenant.example.test',
  extension: '1001',
  password: 'top-secret',
  testerLabel: 'dev-freeswitch',
  relayOnly: false,
  iceServers: [],
};

describe('parsePilotConfig', () => {
  it('maps a FreeSWITCH account without a display name', () => {
    const config = parsePilotConfig(base);
    const options = toBrowserPhoneOptions(config, () => {}, 'mic-1');
    expect(options.signaling).toEqual({ url: base.wssUrl });
    expect(options.account).toEqual({
      registrarUri: 'sip:tenant.example.test',
      aor: 'sip:1001@tenant.example.test',
      contact: 'sip:1001@tenant.example.test',
      username: '1001',
      password: 'top-secret',
    });
    expect(options.media).toMatchObject({ microphoneDeviceId: 'mic-1', holdDirection: 'sendonly' });
    expect(options.account).not.toHaveProperty('displayName');
  });

  it.each(['ws://fs.test/ws', 'https://fs.test/ws', 'not-a-url'])('rejects non-WSS endpoint %s', (wssUrl) => {
    expect(() => parsePilotConfig({ ...base, wssUrl })).toThrow(/wss/i);
  });

  it('rejects URL credentials and incomplete TURN credentials', () => {
    expect(() => parsePilotConfig({ ...base, wssUrl: 'wss://user:pass@fs.test/ws' })).toThrow(/credentials/i);
    expect(() => parsePilotConfig({
      ...base,
      iceServers: [{ urls: 'turns:turn.test:5349', username: 'pilot', credential: '' }],
    })).toThrow(/together/i);
  });

  it('maps STUN, TURN, and relay-only mode', () => {
    const config = parsePilotConfig({
      ...base,
      relayOnly: true,
      iceServers: [
        { urls: 'stun:stun.test:3478', username: '', credential: '' },
        { urls: 'turns:turn.test:5349', username: 'pilot', credential: 'turn-secret' },
      ],
    });
    const options = toBrowserPhoneOptions(config, () => {});
    expect(options.media?.iceTransportPolicy).toBe('relay');
    expect(options.media?.iceServers).toHaveLength(2);
  });

  it('removes URL user info, query, and fragment from evidence summaries', () => {
    expect(safeEndpointSummary(base.wssUrl)).toBe('wss://fs-dev.example.test:7443/ws');
  });
});
```

- [ ] **Step 2: Add failing redaction tests**

Create `test/freeswitch-pilot/redaction.unit.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { redactText, safeError } from '../../examples/freeswitch-pilot/src/redaction.js';

describe('pilot redaction boundary', () => {
  it('removes explicit secrets and sensitive protocol material', () => {
    const input = [
      'Authorization: Digest username="1001", response="abc"',
      'sip:1001@tenant.example.test',
      'a=candidate:1 1 UDP 1 192.0.2.10 50000 typ host',
      'v=0\\r\\na=ice-pwd:ice-secret',
      'password=top-secret',
    ].join('\\n');
    const output = redactText(input, ['top-secret', 'ice-secret']);
    expect(output).not.toContain('top-secret');
    expect(output).not.toContain('ice-secret');
    expect(output).not.toContain('1001@');
    expect(output).not.toContain('192.0.2.10');
    expect(output).not.toMatch(/Authorization: Digest/);
  });

  it('returns only a typed code and redacted message for errors', () => {
    const error = Object.assign(new Error('failed for sip:1001@tenant.test with top-secret'), { code: 'REGISTRATION_FAILED' });
    expect(safeError(error, ['top-secret'])).toEqual({
      code: 'REGISTRATION_FAILED',
      message: 'failed for sip:[redacted]@tenant.test with [redacted]',
    });
  });
});
```

- [ ] **Step 3: Run the focused tests and verify red**

Run:

```sh
npx vitest run test/freeswitch-pilot/config.unit.test.ts test/freeswitch-pilot/redaction.unit.test.ts
```

Expected: FAIL because `config.ts` and `redaction.ts` do not exist.

- [ ] **Step 4: Add private example metadata**

Create `examples/freeswitch-pilot/package.json`:

```json
{
  "name": "freeswitch-pilot",
  "version": "0.7.0",
  "private": true,
  "type": "module",
  "description": "Packed-artifact FreeSWITCH interoperability pilot for sip-worker.",
  "dependencies": { "sip-worker": "^0.7.0" }
}
```

Create `examples/freeswitch-pilot/tsconfig.json` with target `ES2020`, module `ESNext`, module resolution `Bundler`, libraries `ES2020`, `DOM`, and `DOM.Iterable`, and strict/noEmit/isolatedModules/noUnusedLocals enabled. Include `src/**/*.ts`.

- [ ] **Step 5: Implement validation and mapping**

In `config.ts`, define the form interfaces exactly as used by the tests. Parse the WSS URL with `new URL()`, require protocol `wss:`, reject URL username/password, trim and require the domain/extension/password, and reject whitespace, `/`, or `@` in the domain and whitespace or `@` in the extension. Accept only `stun:`, `stuns:`, `turn:`, and `turns:` ICE schemes. Require TURN username/credential together. Return frozen copies.

`toBrowserPhoneOptions()` must produce:

```ts
const identity = `sip:${config.extension}@${config.sipDomain}`;
return {
  signaling: { url: config.wssUrl },
  account: {
    registrarUri: `sip:${config.sipDomain}`,
    aor: identity,
    contact: identity,
    username: config.extension,
    password: config.password,
  },
  media: {
    iceServers: config.iceServers,
    iceTransportPolicy: config.relayOnly ? 'relay' : 'all',
    holdDirection: 'sendonly',
    ...(microphoneDeviceId === undefined ? {} : { microphoneDeviceId }),
  },
  diagnostics: { logger },
};
```

`safeEndpointSummary()` returns only protocol, host, port, and path. Implement `redaction.ts` so it replaces explicit secrets longest-first, removes Authorization/Proxy-Authorization lines, SDP/ICE lines and addresses, redacts SIP URI user parts, removes URL query/fragment text, caps messages at 512 characters, and never returns an original error, cause, or stack.

- [ ] **Step 6: Run focused tests and verify green**

Run the Step 3 command. Expected: both files and all cases pass.

- [ ] **Step 7: Commit Task 1**

```sh
git add examples/freeswitch-pilot/package.json examples/freeswitch-pilot/tsconfig.json examples/freeswitch-pilot/src/config.ts examples/freeswitch-pilot/src/redaction.ts test/freeswitch-pilot/config.unit.test.ts test/freeswitch-pilot/redaction.unit.test.ts
git commit -m "feat(example): add secure FreeSWITCH pilot config"
```

---

### Task 2: Bounded release-evidence recorder

**Files:**
- Create: `examples/freeswitch-pilot/src/evidence.ts`
- Test: `test/freeswitch-pilot/evidence.unit.test.ts`

**Interfaces:**
- Consumes: `ResourceSnapshot` and `DiagnosticRecord` from `sip-worker`; Task 1 redaction.
- Produces: `SCENARIOS`, `ScenarioId`, `ScenarioStatus`, `BuildMetadata`, `PilotEnvironment`, `EvidenceReport`, and `EvidenceRecorder` methods `operation()`, `transition()`, `diagnostic()`, `setScenario()`, `addFinding()`, `finalize()`, `report()`, and `toJson()`.

- [ ] **Step 1: Write failing evidence tests**

Use this zero snapshot in `evidence.unit.test.ts`:

```ts
const zero = {
  activeSocketGenerations: 0, reconnectAttempts: 0, reconnectTimers: 0,
  activeCalls: 0, activeNegotiations: 0, pendingOperations: 0, timers: 0,
  peerConnections: 0, localTracks: 0, lifecycleListeners: 0, deviceListeners: 0,
};
```

Assert 14 scenarios, deterministic run ID/time, successful operation/state/diagnostic capture, pass on the zero snapshot, fail on `{ ...zero, timers: 1 }`, removal of an explicit test secret from JSON/findings/errors, and retention of only the newest 500 events after adding 550 transitions.

- [ ] **Step 2: Verify the evidence red phase**

Run `npx vitest run test/freeswitch-pilot/evidence.unit.test.ts`.

Expected: FAIL because `evidence.ts` does not exist.

- [ ] **Step 3: Implement the evidence schema and recorder**

Define exactly:

```ts
export const SCENARIOS = [
  'authenticated-registration', 'outgoing-two-way-audio', 'incoming-answer-remote-bye',
  'incoming-reject', 'outgoing-cancel', 'local-and-remote-hangup', 'mute-unmute',
  'hold-resume', 'rfc4733-dtmf', 'wss-registration-recovery',
  'call-network-recovery', 'stun-turn-nonlocal', 'repeated-call-cycles',
  'zero-resource-dispose',
] as const;
```

Use `ScenarioStatus = 'not-run' | 'pass' | 'fail' | 'blocked'`, finding severities `info | low | medium | high | critical`, and verdicts `incomplete | pass | fail`. Initialize every scenario as `not-run`. Every mutator creates an immutable entry, applies redaction, and retains only 500 newest events. `operation()` records start plus success/failure settlement, stores only `safeError()`, and rethrows failures. `finalize()` fails on a non-zero resource, failed scenario, or high/critical finding; passes only when every scenario is pass/blocked; otherwise remains incomplete. `toJson()` serializes a freshly redacted copy with two-space indentation and never includes the secret list.

- [ ] **Step 4: Verify evidence green**

Run the Step 2 command. Expected: all evidence tests pass.

- [ ] **Step 5: Commit Task 2**

```sh
git add examples/freeswitch-pilot/src/evidence.ts test/freeswitch-pilot/evidence.unit.test.ts
git commit -m "feat(example): add redacted pilot evidence recorder"
```

---

### Task 3: Accessible one-page markup and visual system

**Files:**
- Create: `examples/freeswitch-pilot/index.html`
- Create: `examples/freeswitch-pilot/src/styles.css`
- Test: `test/freeswitch-pilot/markup.unit.test.ts`

**Interfaces:**
- Produces: stable DOM IDs and `data-testid` values consumed by `main.ts` and Playwright.
- Consumes: no runtime module; loads `/main.js` with `defer`.

- [ ] **Step 1: Write a failing markup contract test**

Read `index.html` as text and assert one password-type SIP input, password-type TURN credential inputs, no storage script, and these exact IDs:

```ts
const requiredIds = [
  'pilot-config', 'wss-url', 'sip-domain', 'extension', 'sip-password',
  'tester-label', 'ice-servers', 'add-ice-server', 'relay-only',
  'create-phone', 'connect', 'register', 'unregister', 'disconnect',
  'dispose', 'reset', 'destination', 'call', 'cancel', 'answer', 'reject',
  'hangup', 'mute-toggle', 'hold', 'resume', 'restart-ice', 'dtmf-pad',
  'microphone', 'play-audio', 'connection-state', 'registration-state',
  'call-state', 'signaling-state', 'media-state', 'mute-state', 'hold-state',
  'remote-identity', 'typed-error', 'resources', 'event-log',
  'scenario-checklist', 'evidence-preview', 'copy-evidence', 'download-evidence',
];
```

Run `npx vitest run test/freeswitch-pilot/markup.unit.test.ts`. Expected: FAIL because `index.html` does not exist.

- [ ] **Step 2: Create semantic markup**

Use one `<main>` with six labelled sections: Configuration, Phone lifecycle, Call controls, Media, Live status, and Evidence. Every input has a label. State values use `aria-live="polite"`; typed errors use `role="alert"`; the event log is an `<ol>`; scenarios use native `not-run/pass/fail/blocked` selects plus note fields. Mark the tester label “local only—not sent in SIP.” Set credentials to `type="password" autocomplete="off" data-secret="true"`.

Include `<!-- PILOT_TEST_HOOK -->` immediately before `<script defer src="/main.js"></script>`; Task 5 removes it from production builds and Task 6 replaces it only in test builds.

- [ ] **Step 3: Create the responsive stylesheet**

Use a restrained operations-console design: system sans typography, high-contrast state chips, a two-column desktop grid collapsing below 900px, visible focus rings, clear disabled controls, monospace evidence/resource regions, no remote assets, `prefers-reduced-motion`, and light/dark color-scheme support.

- [ ] **Step 4: Verify markup green**

Run the Step 1 command. Expected: the markup contract passes.

- [ ] **Step 5: Commit Task 3**

```sh
git add examples/freeswitch-pilot/index.html examples/freeswitch-pilot/src/styles.css test/freeswitch-pilot/markup.unit.test.ts
git commit -m "feat(example): add FreeSWITCH pilot page"
```

---

### Task 4: Media selection, control gating, and BrowserPhone orchestration

**Files:**
- Create: `examples/freeswitch-pilot/src/build-info.d.ts`
- Create: `examples/freeswitch-pilot/src/controls.ts`
- Create: `examples/freeswitch-pilot/src/media.ts`
- Create: `examples/freeswitch-pilot/src/main.ts`
- Test: `test/freeswitch-pilot/controls.unit.test.ts`
- Test: `test/freeswitch-pilot/media.unit.test.ts`

**Interfaces:**
- Consumes: Tasks 1–3 and public `BrowserPhone`, `BrowserCall`, `OutgoingBrowserCall`, `IncomingBrowserCall`, `BrowserMediaEnvironment`, and state types.
- Produces: `deriveControls(facts): ControlState`, `createSelectableMediaEnvironment()`, and the browser entry point.

- [ ] **Step 1: Write failing control-state tests**

Define `PilotFacts` with phone existence, connection/registration/call/signaling states, direction, local hold, muted, remote stream, and operation-in-flight. Assert:

```ts
expect(deriveControls(unconfigured)).toMatchObject({ createPhone: true, connect: false, call: false });
expect(deriveControls(registeredIdle)).toMatchObject({ call: true, unregister: true, dispose: true });
expect(deriveControls(outgoingEstablishing)).toMatchObject({ cancel: true, hangup: false });
expect(deriveControls(outgoingEstablished)).toMatchObject({ hangup: true, mute: true, hold: true, restartIce: true });
expect(deriveControls(incomingRinging)).toMatchObject({ answer: true, reject: true });
expect(deriveControls(incomingEstablished)).toMatchObject({ hangup: false, incomingHangupUnsupported: true });
expect(deriveControls(locallyHeld)).toMatchObject({ hold: false, resume: true });
```

Run the focused test and expect module-not-found failure.

- [ ] **Step 2: Implement pure control derivation**

Return an immutable boolean record with one key per action. Require registered/no call for Call; establishing/outgoing for Cancel; established/outgoing for Hangup; established for mute, DTMF, and ICE restart; established/not-held for Hold; established/held for Resume; new/establishing incoming for Answer/Reject. Disable every mutation while an operation is in flight, except keep Dispose enabled whenever a phone exists.

- [ ] **Step 3: Write and implement media-wrapper tests**

With a fake `BrowserMediaEnvironment`, assert `selectMicrophone('mic-2')` makes the next `getUserMedia({ audio: true })` request contain `{ audio: { deviceId: { exact: 'mic-2' } } }`; no selection delegates unchanged. Assert `listMicrophones()` returns only frozen `audioinput` entries.

Implement:

```ts
export interface SelectableMediaEnvironment {
  readonly environment: BrowserMediaEnvironment;
  selectMicrophone(deviceId: string | undefined): void;
  listMicrophones(): Promise<readonly MediaDeviceInfo[]>;
  clear(): void;
}

export function createSelectableMediaEnvironment(): SelectableMediaEnvironment;
```

Delegate peer connection, media stream, capabilities, and device listeners exactly as `examples/browser-softphone/src/main.ts` does.

- [ ] **Step 4: Declare injected build metadata**

Create `build-info.d.ts`:

```ts
declare const __SIP_WORKER_PILOT_BUILD__: Readonly<{
  packageVersion: string;
  gitCommit: string;
  tarballSha256: string;
}>;
```

- [ ] **Step 5: Implement the browser composition root**

`main.ts` must perform this exact flow:

1. Read/validate form values only on Create Phone.
2. Create one `EvidenceRecorder` with explicit SIP/TURN secrets.
3. Create one `BrowserPhone` with real `WebSocket`, browser lifecycle listeners, selected-media environment, mapped options, and the evidence diagnostic sink.
4. Subscribe to every phone and active-call event before network operations.
5. Route every async action through `runOperation(name, action)`, backed by `EvidenceRecorder.operation()`.
6. Track outgoing/incoming direction explicitly; never infer it from method presence.
7. Keep Connect and Register as separate buttons/promises.
8. Gate controls only through `deriveControls()`.
9. Support outgoing Start/Cancel, incoming Answer/Reject, outgoing Hangup, mute toggle, Hold/Resume, ICE Restart, DTMF, Unregister, Disconnect, Dispose, and Reset.
10. Disable incoming local Hangup after answer and render the documented `INVALID_STATE` limitation.
11. Attach `remoteAudio` streams to an app-owned `<audio>`, invoking `play()` only from Play Audio.
12. Render `phone.diagnostics.resources()` every 250ms while a phone exists, stopping the interval during disposal.
13. After disposal, capture the final snapshot, finalize evidence, clear credential inputs/references, then render once.
14. Add/remove ICE rows using DOM creation and `textContent`, never user-controlled `innerHTML`.
15. Copy evidence with `navigator.clipboard.writeText()` and download through an immediately revoked Blob URL.
16. Never call storage APIs, cookies, query-config parsing, or console logging.

Map events exactly:

```text
connectionStateChanged   -> transition("connection", previous, state)
registrationStateChanged -> transition("registration", previous, state)
incomingCall             -> direction=incoming; wireCall(call)
phone failed             -> safe typed error + finding
stateChanged             -> transition("call", previous, state)
signalingStateChanged    -> transition("signaling", previous, state)
holdStateChanged         -> transition("hold", JSON(previous), JSON(state))
mutedChanged             -> transition("mute", previous, muted)
mediaStateChanged        -> transition("media", previous, state)
remoteAudio              -> retain stream only until terminal/reset
mediaFailed/call failed  -> safe typed error + finding
```

- [ ] **Step 6: Run unit tests and strict typecheck**

```sh
npx vitest run test/freeswitch-pilot/controls.unit.test.ts test/freeswitch-pilot/media.unit.test.ts
npm run build -w @sip-worker/core
npm run build -w sip-worker
npx tsc --project examples/freeswitch-pilot/tsconfig.json --noEmit
```

Expected: both unit files pass; TypeScript exits 0 with no unused declarations.

- [ ] **Step 7: Commit Task 4**

```sh
git add examples/freeswitch-pilot/src/build-info.d.ts examples/freeswitch-pilot/src/controls.ts examples/freeswitch-pilot/src/media.ts examples/freeswitch-pilot/src/main.ts test/freeswitch-pilot/controls.unit.test.ts test/freeswitch-pilot/media.unit.test.ts
git commit -m "feat(example): wire the FreeSWITCH pilot phone"
```

---

### Task 5: Packed-artifact build and localhost server

**Files:**
- Create: `test/freeswitch-pilot/build-pilot.mjs`
- Create: `test/freeswitch-pilot/serve-pilot.mjs`
- Modify: `package.json`

**Interfaces:**
- Consumes: `packWorkspaces()`, `makeTempDir()`, `cleanup()`, and `packageRoot` from `test/package/pack-workspaces.mjs`.
- Produces: `buildPilot({ outputDirectory, testMode }): Promise<{ outputDirectory, metadata }>` and root scripts `pilot:typecheck`, `pilot:build`, `pilot:dev`.

- [ ] **Step 1: Add root scripts and verify red**

Add:

```json
"pilot:typecheck": "npm run build -w @sip-worker/core && npm run build -w sip-worker && tsc --project examples/freeswitch-pilot/tsconfig.json --noEmit",
"pilot:build": "node test/freeswitch-pilot/build-pilot.mjs",
"pilot:dev": "node test/freeswitch-pilot/serve-pilot.mjs"
```

Run `npm run pilot:build`. Expected: FAIL because `build-pilot.mjs` does not exist.

- [ ] **Step 2: Implement packed metadata and bundling**

Follow `test/example/build-softphone.mjs`, with these exact differences:

- Install fresh core/browser tarballs in a temp fixture.
- SHA-256 the exact browser tarball bytes with `createHash('sha256')`.
- Read package version from `packages/browser/package.json` and commit via `git rev-parse HEAD`.
- Copy HTML/CSS to `examples/freeswitch-pilot/dist/`.
- Copy pilot TypeScript modules into a temp entry directory so resolution starts outside the workspace.
- Bundle `main.ts` as browser IIFE, ES2020, bundled, no sourcemap.
- Inject `__SIP_WORKER_PILOT_BUILD__` with esbuild `define`.
- Production mode removes `<!-- PILOT_TEST_HOOK -->`.
- Test mode replaces it with a conditional `/relay.js` module import and copies relay/synthetic-peer assets.
- Clean the temp fixture in `finally`; delete only explicit pilot `dist` and generated temp paths.

Export `buildPilot` and run it only when invoked directly.

- [ ] **Step 3: Implement the localhost server**

`serve-pilot.mjs` awaits the production build, serves only its output at `http://127.0.0.1:4400`, sets `cache-control: no-store`, rejects traversal, returns 503 for missing entry assets, handles SIGINT/SIGTERM, and prints only the URL plus HTTPS/WSS guidance—never configuration.

- [ ] **Step 4: Verify packed build and boot artifacts**

```sh
npm run pilot:typecheck
npm run pilot:build
test -f examples/freeswitch-pilot/dist/index.html
test -f examples/freeswitch-pilot/dist/main.js
rg -n "packages/.*/src|top-secret|demo-secret|PILOT_TEST_HOOK" examples/freeswitch-pilot/dist
```

Expected: commands/files succeed; `rg` exits 1 with no forbidden match.

- [ ] **Step 5: Commit Task 5**

Do not add ignored `dist/` output.

```sh
git add package.json test/freeswitch-pilot/build-pilot.mjs test/freeswitch-pilot/serve-pilot.mjs
git commit -m "build(example): pack and serve the FreeSWITCH pilot"
```

---

### Task 6: Deterministic packed-app Playwright gate

**Files:**
- Create: `test/freeswitch-pilot/relay.js`
- Create: `test/freeswitch-pilot/server.mjs`
- Create: `test/freeswitch-pilot/playwright.config.ts`
- Create: `test/freeswitch-pilot/pilot.spec.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: `buildPilot({ testMode: true })`, `SipFakeServer` from `test/example/fake-sip-server.mjs`, `SyntheticPeer` from `test/browser-media/synthetic-peer.ts`, and the pilot DOM contract.
- Produces: deterministic `npm run test:pilot` without real credentials or external FreeSWITCH.

- [ ] **Step 1: Add the failing test scripts**

Add:

```json
"test:pilot:unit": "vitest run test/freeswitch-pilot/*.unit.test.ts",
"test:pilot:browser": "playwright test --config=test/freeswitch-pilot/playwright.config.ts",
"test:pilot": "npm run pilot:typecheck && npm run test:pilot:unit && npm run test:pilot:browser"
```

Run `npm run test:pilot:browser`. Expected: FAIL because the Playwright configuration does not exist.

- [ ] **Step 2: Implement the test-only WSS server**

`server.mjs` must:

- build with `testMode: true`;
- serve static files/control endpoints on `http://127.0.0.1:4400`;
- generate a one-day local CA/leaf certificate using the bounded `openssl` pattern in `test/browser-phone/server.mjs`;
- run `SipFakeServer` upgrades on `wss://127.0.0.1:4401/sip` and `/relay`;
- delegate `/control/**` to the fake server;
- clean the certificate directory and build temp state on exit;
- never accept credentials from environment variables.

Create `relay.js` equivalent to `test/example/relay.js`, but connect to `wss://127.0.0.1:4401/relay`. Copy/inject it only when `testMode` is true.

- [ ] **Step 3: Add Playwright configuration**

Use one Desktop Chrome project, `baseURL: http://127.0.0.1:4400`, `ignoreHTTPSErrors: true`, fake media/UI flags, one worker, no parallelism, CI retry 1, 180-second test timeout, and web server command `node server.mjs` with a 180-second startup timeout.

- [ ] **Step 4: Write packed UI acceptance tests**

Create helpers `fillConfig()`, `createConnectRegister()`, `startOutgoingCall()`, and `assertZeroResources()`. Cover:

1. Reject `ws://` before phone creation and render no password in event/evidence regions.
2. Create, connect, and authenticate-register from entered WSS/domain/extension/password.
3. Outgoing established call: mute/unmute, hold/resume, DTMF, ICE restart, and outgoing hangup.
4. Incoming identity/Answer; Hangup disabled with known limitation; remote BYE termination.
5. Incoming Reject produces documented failed state.
6. Delayed outgoing INVITE can be cancelled.
7. Offline + dropped WSS + online restores connection, registration, call, and stable signaling.
8. Microphone list and selection.
9. Remote audio plays only after Play Audio.
10. Scenario notes/statuses update evidence; Copy/Download includes build metadata and excludes entered SIP/TURN secrets.
11. Unregister then Disconnect returns expected facts.
12. Dispose renders all 11 zero counters and passes zero-resource scenario.
13. Reset clears SIP/TURN credential inputs and returns to unconfigured state.

Reuse existing fake-server control endpoints from `test/example/softphone.spec.ts`; do not implement another SIP state machine.

- [ ] **Step 5: Run and stabilize the complete pilot gate**

```sh
npm run test:pilot
```

Expected: strict typecheck, every pilot unit test, packed build, and every Playwright scenario pass without external network.

- [ ] **Step 6: Commit Task 6**

```sh
git add package.json test/freeswitch-pilot/relay.js test/freeswitch-pilot/server.mjs test/freeswitch-pilot/playwright.config.ts test/freeswitch-pilot/pilot.spec.ts
git commit -m "test(example): prove the FreeSWITCH pilot workflow"
```

---

### Task 7: Operator runbook and documentation contract

**Files:**
- Create: `examples/freeswitch-pilot/README.md`
- Modify: `README.md`
- Modify: `test/package/documentation-contract.test.mjs`

**Interfaces:**
- Consumes: implemented scripts, UI fields, evidence schema, and known v0.7 limitations.
- Produces: truthful operator instructions and machine-checked documentation claims.

- [ ] **Step 1: Add failing documentation assertions**

Extend `documentation-contract.test.mjs` to read the pilot README and assert:

```js
for (const pattern of [
  /npm run pilot:dev/, /npm run pilot:build/, /npm run test:pilot/,
  /wss:\/\//i, /HTTPS|localhost/i, /memory only|in memory/i,
  /FreeSWITCH/i, /manual evidence/i, /not.*certification|not.*production/i,
  /incoming.*hangup.*not supported|incoming.*INVALID_STATE/i,
  /register.*expir|refresh/i, /20 consecutive/i, /ResourceSnapshot|resource counters/i,
]) assert.match(pilotReadme, pattern);
```

Also assert the root README links `examples/freeswitch-pilot/README.md` and all six pilot scripts (`pilot:typecheck`, `pilot:build`, `pilot:dev`, `test:pilot:unit`, `test:pilot:browser`, `test:pilot`) exist.

Run `npm run test:docs`. Expected: FAIL because the pilot README/root link are absent.

- [ ] **Step 2: Write the operator README**

Document:

- Node 20+, installed Playwright browser for tests, trusted WSS certificate, HTTPS/localhost page, FreeSWITCH SIP-over-WSS profile, WebRTC codecs, RTP reachability, and STUN/TURN prerequisites;
- `pilot:dev`, static `pilot:build` deployment, and `test:pilot`;
- exact config mapping and tester-label local-only behavior;
- credential non-persistence and redaction;
- one-tab/one-call restriction;
- built-in registration expiry/refresh difference from SIP.js;
- incoming local hangup limitation;
- all 14 manual scenarios, 20-cycle criterion, separate-network TURN run, and zero-resource criterion;
- entering FreeSWITCH version/environment label and downloading JSON evidence;
- manual interop evidence is not general certification;
- troubleshooting TLS trust, 401/407, codecs, autoplay/silent audio, NAT/TURN, DTMF, reconnect, and non-zero resources.

Never include a real endpoint, extension, password, or TURN credential.

- [ ] **Step 3: Link the pilot from the root README**

Add a “FreeSWITCH pilot” subsection near the reference softphone link. Preserve internal-beta framing and point to the runbook instead of duplicating secrets/configuration.

- [ ] **Step 4: Verify docs green**

Run `npm run test:docs`. Expected: exit 0 and an increased resolved-link count.

- [ ] **Step 5: Commit Task 7**

```sh
git add examples/freeswitch-pilot/README.md README.md test/package/documentation-contract.test.mjs
git commit -m "docs: add the FreeSWITCH pilot runbook"
```

---

### Task 8: Whole-change verification and pilot handoff

**Files:**
- Verify only; modify files only to fix a demonstrated failure with a new red/green cycle.

**Interfaces:**
- Consumes: every prior task.
- Produces: a clean implementation ready for a manual dev-FreeSWITCH run.

- [ ] **Step 1: Run focused pilot verification**

```sh
npm run test:pilot
npm run pilot:build
```

Expected: all unit/browser pilot tests pass and deployable static output is generated from packed tarballs.

- [ ] **Step 2: Re-run existing example and repository gates**

```sh
npm run test:example
npm run verify
```

Expected: existing packed softphone remains green; docs, types, builds, unit/integration, architecture, API, bundle, package, and compatibility gates exit 0.

- [ ] **Step 3: Run safety scans**

```sh
git diff --check
rg -n "localStorage|sessionStorage|indexedDB|document\.cookie|allowInsecureWebSocket|console\.(log|warn|error)" examples/freeswitch-pilot
rg -n "top-secret|demo-secret|Authorization: Digest|a=ice-pwd|a=candidate" examples/freeswitch-pilot/dist/main.js
git status --short
```

Expected: whitespace clean; source scan has no forbidden persistence/insecure/logging use; bundle scan exits 1 with no fixture secret/raw protocol material; only intended source/docs changes are tracked and `dist/` is ignored.

- [ ] **Step 4: Perform the manual FreeSWITCH pilot**

Run `npm run pilot:dev`, enter the existing dev proxy's complete WSS endpoint and a dedicated test extension, then execute all 14 scenarios in Chromium and Firefox. Repeat 20 call cycles, perform one separate-network TURN run, enter exact FreeSWITCH version/environment label, dispose, and download the JSON evidence report.

Store the report in the release evidence system, not git. Review it for secrets before sharing. A failed/blocked scenario or non-zero resource is a release finding, not a result to overwrite.

- [ ] **Step 5: Commit only demonstrated verification corrections**

If verification exposes an issue, return to the task that owns the failing
file, add a regression assertion to that task's named test file, prove red,
apply the correction, prove green, and use that task's explicit `git add`
file list. Commit the correction as
`fix(example): resolve pilot verification finding`. If no correction was
required, do not create an empty commit.
