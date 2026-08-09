# SIP Worker Product Readiness Review

**Review date:** 2026-08-07  
**Verdict:** Do not ship as a v1 release candidate. The project is a strong alpha-level SIP signaling engine with good component discipline, but product seams contain P1 release blockers.

## Evidence

- `npm run typecheck` exited 0.
- `npm test` passed 38 files and 402 tests.
- `npm run test:package` exited 0 for the existing build.
- Packing a clean `git archive HEAD` produced only `README.md` and `package.json`; no `dist` artifacts were present.

## Strengths

- Byte-oriented parsing, Content-Length limits, parser tolerance coverage, and deterministic clocks are well designed.
- The core uses injected platform boundaries and has no required runtime dependencies.
- ESM, CommonJS, and TypeScript consumer fixtures already exist.
- Transaction state-machine coverage is strong for nominal single-operation flows.

## P1 Release Blockers

### 1. Operations can settle or fail unrelated transactions

Registrar, Inviter, fork-cleanup BYE, and liveness subscribe to one global transaction event stream, but handlers commonly match only numeric CSeq or accept every timeout/transport error. REGISTER, INVITE, BYE, and OPTIONS can share CSeq values. A response or timeout for one operation can therefore settle or fail another.

Evidence: `src/ua/registrar.ts:238`, `src/ua/inviter.ts:175`, `src/ua/inviter.ts:319`, `src/ua/inviter.ts:348`.

Required fix: bind every operation to its returned `TransactionKey`; validate Call-ID, CSeq number, and CSeq method before settling.

### 2. In-dialog proxy routing is inverted

`Dialog` applies loose and strict Record-Route rules in reverse. RFC 3261 §12.2.1.1 requires a loose route to retain the remote target as Request-URI and use the complete route set in Route; strict routing starts at the first route and appends the remote target last. Existing tests encode the inversion.

Evidence: `src/dialogs/dialog.ts:208`, `src/dialogs/dialog.ts:222`, `test/dialogs/dialog.test.ts:95`.

### 3. Outbound Via is transport-incorrect and often unroutable

REGISTER, dialog-created ACK/BYE, and default OPTIONS hardcode UDP; Registrar and Dialog ignore `viaAddress`. TCP and WebSocket traffic consequently claims to be UDP, and UDP responses can target reserved documentation address `192.0.2.1:5060`.

Evidence: `src/ua/registrar.ts:204`, `src/ua/inviter.ts:151`, `src/dialogs/dialog.ts:27`, `src/ua/user-agent.ts:334`.

### 4. Incoming and outgoing call termination is unsafe or missing

Incoming BYE validation checks only Call-ID, not dialog tags or remote CSeq; a guessed/replayed request can end a call. Conversely, outgoing calls do not handle a valid remote BYE at all.

Evidence: `src/ua/invitation.ts:205`, `src/ua/user-agent.ts:355`, `src/ua/inviter.ts:175`.

### 5. Disconnect leaves promises, listeners, and timers alive

`disconnect()` detaches transport handling before teardown. Registrar disposal does not reject an active operation, and active invitations/inviters have no disposal path. TransactionLayer also lacks terminal transport-loss propagation.

Evidence: `src/ua/user-agent.ts:275`, `src/ua/registrar.ts:386`, `src/transactions/coordinator.ts:63`.

### 6. Authentication retries are not bounded correctly

Retry identity includes CSeq while each retry increments CSeq, defeating the retry budget. Inviter never settles AuthManager state. Authenticated 423 and redirect paths copy stale Authorization values onto changed requests.

Evidence: `src/ua/registrar.ts:275`, `src/ua/registrar.ts:297`, `src/ua/registrar.ts:316`, `src/ua/inviter.ts:279`.

### 7. Credentials alone do not authenticate INVITE

UserAgent creates an implicit AuthManager for Registrar only. Inviter receives only an explicitly supplied `options.authManager`, so credentials-only configuration fails INVITE 401/407 challenges.

Evidence: `src/ua/user-agent.ts:151`, `src/ua/user-agent.ts:249`.

### 8. Worker recovery claims are unproven and inaccurate

README calls `supervisor.register()` without `start()`, so it rejects immediately. The release smoke test repeats that sequence and falsely attributes the already-rejected promise to worker death. Identity is reported only after a successful registration, permitting CSeq reuse after a crash immediately following a send. Worker registration failures have no supervisor protocol outcome.

Evidence: `README.md:79`, `README.md:105`, `src/bridge/worker-supervisor.ts:121`, `src/bridge/worker-runtime.ts:100`, `test/integration/release-smoke.test.ts:578`.

### 9. Publishing from a clean checkout creates a nonfunctional package

`dist` is ignored and no lifecycle hook builds it before pack/publish. A clean tree package contains two files while every export points into absent `dist` artifacts.

Evidence: `package.json:5`, `package.json:73`, `.gitignore:2`.

### 10. Public class identity differs between official subpaths

Independent `tsup` bundles duplicate exported classes. A `TransportError` from `sip-worker/transport/node` fails `instanceof TransportError` imported from `sip-worker`.

Evidence: `tsup.config.ts:3`, `tsup.config.ts:19`.

### 11. UDP admits messages from unconfigured peers

UDP configuration limits sends but inbound `rinfo` is ignored, permitting any reachable source to inject SIP messages or guessed responses.

Evidence: `src/transport/node/udp.ts:25`, `src/transport/node/udp.ts:54`.

## Important P2 Work

- Snapshot and cache client retransmit bytes; caller mutation currently changes retransmissions.
- Fix branchless server-transaction matching and include Via sent-by.
- Serialize duplicate 2xx handling before awaiting ACK send.
- Preserve completed TCP frames when a later frame in the same chunk is malformed; replace quadratic stream buffering.
- Correct public call-event typings and type `incomingCall`.
- Parse bare Contact URIs and quoted Record-Route values.
- Treat all valid 1xx responses as provisional.
- Add media deadlines, cancellation, and per-session cleanup.
- Export the advertised native Ping/Pong adapter.
- Add license, security policy, supported-runtime policy, CI, external interop, and release process.

## Product Positioning

Until these blockers are resolved, describe the project as a signaling-only alpha, not a release candidate or production telephony library. The shipped media handler is a fixed SDP stub and does not carry audio.

## Recommended Delivery Sequence

1. Phase 08 — Protocol correctness: ownership, matching, retransmission, proxy routing, and timers.
2. Phase 09 — Call lifecycle and auth: remote BYE/CANCEL, dialog validation, cleanup, and bounded Digest flows.
3. Phase 10 — Transport resilience: Via/rport, UDP peer validation, loss propagation, liveness and deadlines.
4. Phase 11 — Worker/media reliability: durable CSeq checkpoints, failure protocol, supervisor lifecycle, bounded media operations.
5. Phase 12 — Release productization: clean-tree packaging, singleton exports, CI, documentation, and external interoperability.

The detailed specifications and execution plans for those phases are in `docs/superpowers/specs/2026-08-07-08-*` through `2026-08-07-12-*` and `docs/superpowers/plans/2026-08-07-08-*` through `2026-08-07-12-*`.
