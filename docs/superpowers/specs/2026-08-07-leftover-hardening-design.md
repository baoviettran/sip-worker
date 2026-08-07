# Leftover Hardening Design

**Date:** 2026-08-07
**Status:** Approved (brainstorming)
**Scope:** One consolidated implementation plan — Plan 07 — that closes every documented leftover from the Plan 04 Handoff and phase-3 internal polish lists, plus a `viaAddress` option and docs drift found during the leftover scan.

## Context

Plans 01–06 are complete and green (Execution Order all `[x]`, 367 tests passing, `npm ci && npm run typecheck && npm test && npm run build && npm run test:package` all exit 0). Phase 6 is done. The open work is the set of deliberately-deferred items recorded in `docs/superpowers/plans/2026-08-04-sip-worker-index.md` under "Plan 04 Handoff (deferred items)" and "Phase-3-internal polish", plus two items the scan surfaced that the index under-weighted.

A full scan of all six plan files, the phase-1 follow-up plan, `src/`, `test/`, and git history confirmed:

- **Phase 1–6 are genuinely done.** Old plan files keep unchecked `- [ ]` Step checkboxes, but those are implementation checklists; the index Execution Order marks all six `[x]` and the code/tests exist.
- **The phase-1 codec follow-up plan was fully implemented** (commits `9bfe75a` "reject orphan stream header continuations", `fb99b08` "consume all valid batched stream frames", `8cb88ba` "report exact Content-Length error offsets", `ab996ff` "align continuation framing validation") — but its plan file still has zero `[x]` and it is missing from the index Execution Order. This is docs drift, not code work.
- **A real code TODO the index under-weighted:** `user-agent.ts:237` and `:369` carry `// TODO: extract from transport` for a hardcoded `viaAddress: '192.0.2.1:5060'` used by both `Inviter` and `Invitation` (and the OPTIONS liveness factory at `:326`). The index only flagged the `Dialog.makeTopVia` path; the Inviter/Invitation paths are the bigger surface. The scan also established that **sent-by cannot be extracted from any Transport**: TCP's `NodeTcpTransportOptions` has only the remote `host`/`port`; UDP's `NodeUdpTransportOptions` has `localPort` but no local host/interface; browser WS holds the URL privately; Node WS exposes only `readyState`/`protocol`. So the honest resolution is a caller-supplied option, not transport inference.

## Goal

Turn the completed SIP stack into a hardened, drift-free codebase by closing every documented leftover in a single dependency-ordered plan, each task landing behind a witnessed red test and a full green regression.

## Architecture

No new modules. All edits are inside two existing areas — `src/auth/*` (authorization, digest, manager, challenge) and `src/ua/*` plus `src/transactions/coordinator.ts` and `src/transactions/ack.ts` — plus `src/index.ts` exports, test-only fixes, and plan/index docs. The work is grouped into three risk-descending tiers that share one plan file:

1. **Wire correctness** — defects that can produce a malformed or non-interoperable header on the wire today.
2. **Registrar / UA lifecycle** — defects in registration state, timer ownership, and memory growth across a long-lived UA.
3. **Parser robustness, test hardening, docs, viaAddress** — defensive parser hardening, closing test-honesty gaps, phase-3 polish, the caller-owned sent-by option, and reconciling the docs.

## Tech Stack

TypeScript 5.x strict ESM, Vitest, virtual clock (`Clock`/`FakeClock`), tsup, Node 22+. No new runtime dependencies.

## Global Constraints

- Every production change follows a witnessed red test and ends with focused-plus-full verification, matching the Plans 01–06 discipline.
- No real-time sleeps; all timer-driven behavior uses the injected `Clock`.
- Tolerance/parser tests stay inside `expect(() => parse(...)).not.toThrow()`; parsing never throws or hangs.
- Existing public exports and signatures remain unchanged except the deliberate, additive `viaAddress?: string` on `UserAgentOptions` and the new event-type re-exports.
- Each task ends with a focused test, full regression (`npm test`), `npm run typecheck`, and a commit.

---

## Task Detail

### Tier 1 — Wire correctness (highest priority)

#### Task A — Escape auth quoted-strings

**Files:** `src/auth/authorization.ts`, `test/auth/authorization.test.ts`

**Defect:** `renderAuthorization` quotes `username`, `realm`, `nonce`, `uri`, `response`, `cnonce`, `opaque` but never backslash-escapes `\` or `"` inside them (RFC 2617 3.2.2 `quoted-string` / `quoted-pair`). A username or realm containing `"` or `\` produces a malformed quoted-string on the wire.

**Fix:** Add a private `escapeQuoted(s: string): string` that backslash-escapes `\` and `"`, and apply it to every quoted field. The challenge parser already resolves backslash escapes (`src/auth/challenge.ts` `commitParam`), so escaped output round-trips and interoperates. Header name, scheme, and unquoted tokens (`algorithm`, `qop`, `nc`) are unchanged.

**Red test:** `renderAuthorization` with username `a"b\c` emits `username="a\"b\\c"`; a field containing a literal `"` parses back to the original value through the existing challenge parser.

#### Task B — Implement `auth-int` HA2

**Files:** `src/auth/digest.ts`, `src/auth/challenge.ts`, `src/auth/manager.ts`, `test/auth/digest.test.ts`

**Defect:** `DigestParams.qop` is typed `'auth' | 'auth-int'` and `renderAuthorization` emits `qop=auth-int` unquoted, but `computeDigest` only implements the `auth` HA2 (`H(method:uri)`). A server challenging `qop=auth-int` would receive a response computed with the wrong HA2.

**Fix:** In `computeDigest`, when `qop === 'auth-int'`, compute `ha2 = h(\`${method}:${uri}:${h(entityBody)}\`)` using the retried request's body bytes. Stop stripping `auth-int` in `selectChallenge` and `AuthManager.retry` so an `auth-int` challenge is honored. `DigestParams` gains a `body?: Uint8Array` used only for `auth-int`; without it, `auth-int` throws (parity with the existing nc/cnonce-missing `TypeError`).

**Red test:** an RFC 2617 `auth-int` standard vector asserts the documented `response`; a challenge with `qop=auth-int` is selected and retried, not dropped.

#### Task C — Preserve Via params on auth retry

**Files:** `src/auth/manager.ts`, `test/auth/manager.test.ts`

**Defect:** `nextVia` (`manager.ts:265`) reconstructs the retry Via from only `transport + sentBy + ;rport`, dropping `;comp`, `;received`, `;transport`, and any other original params. Transport-diverse retries (TLS/SCTP, symmetric response routing) lose correctness.

**Fix:** Parse the original top Via, splice in a fresh `branch=<new>`, and keep every other param verbatim. Only the branch is replaced.

**Red test:** a retried request whose original Via carried `;received=10.0.0.1;comp=sigcomp;transport=tls;rport` retains all of them with only the branch changed.

#### Task D — Missing-CSeq method fix

**Files:** `src/auth/manager.ts`, `test/auth/manager.test.ts`

**Defect:** `nextCSeq` (`manager.ts:255`) falls back to `'1 INVITE'` when a request lacks a CSeq header. The fallback hardcodes `INVITE`; a non-INVITE retry without CSeq would be mis-stamped.

**Fix:** Fall back to `'1 <request.method>'` using the retried request's method. (Only fires on malformed requests lacking CSeq, never in the REGISTER path.)

**Red test:** a retry after a CSeq-less `SUBSCRIBE` carries `1 SUBSCRIBE`, not `1 INVITE`.

#### Task E — Decouple manager from the `": "` convention

**Files:** `src/auth/manager.ts`, `test/auth/manager.test.ts`

**Defect:** `manager.ts:184` splits `renderAuthorization`'s output at `": "` to recover the header name and value. This convention-couples two modules and would mis-split a value containing `": "`.

**Fix:** Split only on the first `:` (header name is everything before, value everything after with a single leading space trimmed), or have `renderAuthorization` return the name and value separately. No behavior change for conformant output.

**Red test:** a field value containing `": "` routes to the correct header name with the value intact.

#### Task F — Isolate `forward()` listeners

**Files:** `src/transactions/coordinator.ts`, `test/transactions/coordinator.test.ts`

**Defect:** `forward()` (`coordinator.ts:82`) calls each subscriber directly; a throwing subscriber propagates through the layer and breaks unrelated consumers. Once external subscribers (dialogs, INVITE handling) attach to the same event stream, one bad listener can corrupt the transaction layer.

**Fix:** Wrap each subscriber call in a try/catch. A throwing listener is isolated; the layer continues dispatching to the rest.

**Red test:** a subscriber that throws does not prevent a second subscriber from receiving the event, and the layer keeps processing subsequent events.

### Tier 2 — Registrar / UA lifecycle

#### Task G — 301/302 REGISTER redirect

**Files:** `src/ua/registrar.ts`, `test/ua/registrar.test.ts`

**Defect:** `registrar.ts:242` treats every `statusCode >= 300` as a nonrecoverable `SipError`. RFC 3261 §10.2 defines 3xx as followable redirects for REGISTER. A registrar that redirects (load balancer, maintenance) currently fails the registration instead of following it.

**Fix:** Handle **301 Moved Permanently** and **302 Moved Temporarily** (the REGISTER-allowed redirect classes) by extracting the highest-priority `Contact` from the response and re-REGISTERing against that target — single hop, with a loop guard (cap redirect hops at, e.g., 5; a target equal to the current registrarUri, or a repeated target, fails as before). **305/380 and all other ≥300 codes remain hard failures.** The redirect target replaces `registrarUri` for the redirected attempt only; 301 may persist the new target for the UA's lifetime (recorded as a state change), 302 is per-attempt.

**Red test:** a 302 carrying a new `Contact` re-REGISTERs to it and completes `registered`; a 305 fails; a redirect loop (target repeats within the hop cap) fails rather than spinning.

#### Task H — Dispose the registrar refresh timer

**Files:** `src/ua/user-agent.ts`, `src/ua/registrar.ts`, `test/ua/user-agent.test.ts`

**Defect:** `user-agent.ts:293` sets `this.registrar = undefined` in `disconnect()` without notifying the registrar. The registrar's `clock.setTimeout` refresh handle leaks until the `FakeClock` (or production clock) is GC'd. The Plan 04 handoff noted this.

**Fix:** Add an explicit `Registrar.dispose()` that cancels the refresh timer and unsubscribes its transaction-layer listener. Call `registrar.dispose()` in `disconnect()` before nilling the reference. `dispose()` and `onTransportDisconnected()` stay separate: `onTransportDisconnected()` keeps its existing reconnect-pending semantics (cancel refresh, await reconnect); `dispose()` is the final UA-shutdown path (cancel refresh, unsubscribe, no reconnect expectation). Both cancel the same refresh timer; only the surrounding lifecycle state differs.

**Red test:** after `await ua.disconnect()`, the `FakeClock` reports no pending refresh handle; the transaction-layer subscriber count returns to its pre-connect value.

#### Task I — Bound AuthManager state

**Files:** `src/auth/manager.ts`, `test/auth/manager.test.ts`

**Defect:** `nonceCounts` (keyed `realm:nonce`) and the upstream `retriesByRequest` map grow unboundedly across a long-lived UA session. The UA constructs one `AuthManager` per `UserAgent`; the Registrar keys `requestId` as `callId:cseq`, so each CSeq adds an entry and the map grows by one per outbound REGISTER.

**Fix:** Cap both maps. `nonceCounts`: bound to N entries (e.g., 64), evicting the oldest insertion when exceeded. `retriesByRequest`: drop a request's entry once its exchange completes (response received or transport disconnected) rather than retaining it; if a hard cap is still needed, bound it identically. The budget semantics (stale-nonce consumption, nc reset on a genuinely new nonce — see Task L) are preserved.

**Red test:** many exchanges with distinct nonces keep `nonceCounts` size at or under the cap; completed exchanges leave no `retriesByRequest` entry; stale-nonce budget consumption still behaves as before.

#### Task J — Event-type exports

**Files:** `src/index.ts`, `src/ua/index.ts`, `test/package/exports.test.mjs`

**Defect:** `RegistrationEvent`, `RegistrationEventEmitter`, `RegistrationStateChangedEvent`, and `RegistrationFailedEvent` are not re-exported from `src/index.ts` (`RegistrationIdentity` and `RegisterState` are). Plan 04 deferred this until the event surface was finalized for Plan 06 recovery; Plan 06 is now complete.

**Fix:** Add the four event-type re-exports to `src/index.ts` (via `src/ua/index.ts` if not already barrelled). Extend `test/package/exports.test.mjs` to assert they resolve from the packed tarball in ESM, CommonJS, and types consumers.

**Red test:** the packed-consumer matrix imports the four types without importing source files.

### Tier 3 — Parser robustness, test hardening, docs, viaAddress

#### Task K — Challenge parser robustness

**Files:** `src/auth/challenge.ts`, `test/auth/challenge.test.ts`

**Defect:** Three defensive-hardening gaps noted in the Plan 04 handoff: (1) the `:159-166` boundary heuristic breaks on a param literally named `digest`; (2) `:176` splits unquoted multi-word values on whitespace (unquoted values are tokens, not whitespace-separated lists); (3) `:199-200` hardcodes error offset `0` for missing-realm/missing-nonce instead of the actual bad-byte offset. The parser already handles every RFC-conformant challenge in the suite including quoted commas and multiple challenges; these are edge-case hardening with no behavior change for conformant input.

**Fix:** Make the boundary heuristic token-aware so a `digest` param name is not mistaken for the scheme boundary; keep unquoted values intact as single tokens; report the real byte offset for missing-realm/missing-nonce. Three red tests, one per defect.

**Red test:** a challenge with a param named `digest` parses correctly; an unquoted multi-word value stays intact; a missing-realm error reports the offset of the bad byte, not 0.

#### Task L — Test-description and coverage fixes (test-only)

**Files:** `test/auth/challenge.test.ts`, `test/auth/hash.test.ts`, `test/auth/digest.test.ts`, `test/auth/manager.test.ts`

**Defect:** Four test-honesty gaps from the Plan 04 handoff, none load-bearing:
- `challenge.test.ts:438` malformed-escape test does not exercise the malformed-escape path (the error raised is missing-nonce). The malformed-escape code path itself is correct.
- `hash.test.ts:19` label says "448-bit … abcdefghijklmnopqrstuvwxyz" but that string is 26 bytes = 208 bits, single-block; the 448-bit/two-block vector is the SHA-256 case below it. Expected value is correct; only the description is wrong.
- `digest.test.ts` throw tests do not assert the error message and miss the `cnonce`-present/`nc`-missing combination; the code path is identical so neither is load-bearing.
- `manager.test.ts` stale=true tests do not discriminate budget consumption (both pass whether stale consumes budget; no boundary case), and the stale path is never tested with a genuinely new nonce so the nc-reset branch is untested.

**Fix:** Rewrite the malformed-escape test to feed a genuine malformed escape; correct the hash label; add the error-message assertion and the `cnonce`-present/`nc`-missing case; add a new-nonce stale test and a budget boundary case. No production changes.

#### Task M — Phase-3 internal polish

**Files:** `src/transactions/ack.ts`, `src/transactions/invite-client.ts`, `src/transactions/non-invite-client.ts`, `src/dialogs/dialog.ts`, `src/transactions/coordinator.ts`, related tests

**Defect (safe items from the Plan 04 phase-3 list):**
- `buildNon2xxAck` (`ack.ts`) clones the entire header set, a superset of the RFC-required headers (Route, From, Call-ID, Max-Forwards, Via). Trim to the required set.
- DRY: `cseqMethod` is duplicated in `invite-client.ts` and `non-invite-client.ts`; `contactUri` in `dialog.ts` re-implements the `<...>` extraction that `extractUri` in `header-values.ts` already provides.
- `coordinator.ts` `forward()` deletes the `terminated` key from **both** client and server maps on one event; client/server keys share the `branch|method` shape and can collide (`branch|INVITE`). Pass the owning map so the delete is precise. (Pairs with Task F's isolation edit in the same function.)

**Fix:** Trim the ACK header copy; extract the shared `cseqMethod` helper; collapse `contactUri` onto `extractUri`; thread the owning map into `forward()`'s terminated delete. Each with a regression test that confirms current behavior is preserved.

**Deliberately not forced (will be noted as still-open in the plan, not implemented):** the two "arguably correct but untested" items — late `transportError` dropped after the transaction reached `Terminated`, and the coverage gaps (non-ACK duplicate in `Confirmed`; reliable-INVITE `Confirmed` with I=0). These are noted in the Plan 04 phase-3 list as "harmless in practice / arguably correct"; forcing coverage adds tests without changing behavior, so they are left as documented open items rather than scope of this plan.

#### Task N — `viaAddress` option

**Files:** `src/ua/user-agent.ts`, `test/ua/user-agent.test.ts`

**Defect:** `user-agent.ts:237` and `:369` hardcode `viaAddress: '192.0.2.1:5060'` for `Inviter` and `Invitation` with `// TODO: extract from transport`; the OPTIONS liveness factory at `:326` does the same. The scan established that no `Transport` exposes a sent-by (TCP has only remote host/port, UDP only a local port, WS holds its URL privately, Node WS exposes only `readyState`/`protocol`), so the TODO's premise — extract from transport — is unfulfillable. Sent-by is the caller's reachable address, not inferable from the socket.

**Fix:** Add `viaAddress?: string` to `UserAgentOptions`. The three call sites become `this.options.viaAddress ?? '192.0.2.1:5060'`. The default preserves today's behavior; a caller supplying a real reachable `host:port` gets correct Via sent-by on INVITE/ACK/BYE/INVITE-response and OPTIONS liveness probes. Remove the two `// TODO` comments.

**Red test:** a UA constructed with `viaAddress: '203.0.113.7:5060'` emits that sent-by on its INVITE/ACK/BYE and OPTIONS Via; the default (no `viaAddress`) still produces `192.0.2.1:5060`.

#### Task O — Docs drift

**Files:** `docs/superpowers/plans/2026-08-04-phase-1-codec-follow-up-fixes.md`, `docs/superpowers/plans/2026-08-04-sip-worker-index.md`

**Defect:** The phase-1 codec follow-up plan was fully implemented (commits `9bfe75a`, `fb99b08`, `8cb88ba`, `ab996ff`) but its plan file has zero `[x]` and it is absent from the index Execution Order. The index also still lists Plan 04 Handoff deferred items that this plan closes.

**Fix:** Mark the phase-1 follow-up plan's tasks `[x]` and add it to the index Execution Order as a completed entry. Add Plan 07 (this plan's implementation plan) to the index Execution Order and Plan Gates table. After implementation, strike the resolved items from the Plan 04 Handoff section.

---

## Verification, Ordering, and Gates

**Task order** (risk-descending, green exit after each):

A → B → C → D → E → F → G → H → I → J → K → L → M → N → O

**Per-task gate** (matches Plans 01–06):
1. Write the red test.
2. Run the focused suite — verify RED.
3. Implement the fix.
4. Run the focused suite + `npm run typecheck` — verify GREEN.
5. Run `npm test` — full regression green.
6. Commit.

**Plan gate** (final acceptance):

```bash
npm ci
npm run typecheck
npm test
npm run build
npm run test:package
```

Expected: every command exits 0; the existing release-smoke trace (`registered → inviting → confirmed → terminated → unregistered`) still passes; no new open handles or unhandled rejections; the packed ESM/CommonJS/type fixtures resolve the new event-type exports.

## Testing Strategy

Every task follows the codebase's TDD discipline: a witnessed red test first, then the implementation. No real-time sleeps — the injected `Clock`/`FakeClock` covers registrar refresh (Task H), AuthManager timing (Task I), and liveness. Tolerance/parser tests (Task K) stay inside `expect(() => parse(...)).not.toThrow()`. Redirect loop tests (Task G) use the virtual clock and a deterministic redirect sequence, not real network. The packed-consumer matrix (Task J) imports the packed tarball into fresh temporary ESM/CJS/TS consumer directories, not workspace aliases.

## Out of Scope (noted as still-open, not implemented)

- The "arguably correct but untested" transaction edge cases from Task M (late `transportError` after `Terminated`; non-ACK duplicate in `Confirmed`; reliable-INVITE `Confirmed` with I=0). Documented in the Plan 04 phase-3 list as harmless; forcing coverage adds tests without changing behavior.
- `TypedEventEmitter` internal `Function`/`unknown[]` type erasure (cosmetic — consumers get typed events via the `RegistrationEventEmitter` interface). Left as-is.
- Live-call reconstruction after worker death. The v1 rule (registration restored, calls end with the old generation and must be recreated by the application) is the documented Plan 06 recovery boundary, not a defect.
