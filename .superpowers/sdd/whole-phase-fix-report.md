# Phase 09 Whole-Review Fix Report

## Scope and invariants

- Base: `2a3b250bb861f68d4b79d9a64ac9291e3300f833`
- Planned commit subject: `fix: close phase 09 lifecycle and auth gaps`
- Inputs: the Phase 09 plan and design, the full `11d896b..2a3b250` review package, and all three task reports.
- Scope was kept within Phase 09 call lifecycle, authentication, dialog ownership, transaction teardown, and SIP identity handling.
- The user-owned `.claude/` directory was left untouched and is not part of the change.

The wave preserves these required invariants:

1. Every pending public promise resolves or rejects exactly once.
2. Call-ID, From identity, To identity, method, and CSeq are accepted before response-driven call-state mutation.
3. Authorization is regenerated whenever the request URI changes.

## TDD record for the whole-review findings

Each behavior below was introduced as a focused regression test, run against the reviewed base to witness the named failure, and then rerun after the smallest implementation change needed for GREEN. Tests that prove timeout settlement advance a `FakeClock`; they do not dispose the object early to manufacture settlement.

### 1. Response identity before client-transaction mutation (Critical)

- Focused command: `npm test -- --run test/transactions/coordinator.test.ts test/integration/call.test.ts`
- RED: a forged final response with a matching transaction key reached `tx.receive()` first, canceled Timer B/F, and moved the client transaction to a final state before Registrar/Inviter identity checks rejected it. A later legitimate final could no longer complete the operation; the forged-final timeout path also no longer followed the normal Timer B/F outcome.
- GREEN: `TransactionLayer.receiveResponse()` now performs full request/response identity acceptance before dispatching to a client transaction. The check covers Call-ID, From tag, To identity, CSeq number, and CSeq method while preserving normal Via/CSeq transaction matching. Regression tests cover forged final then legitimate final, and forged final then natural Timer B/F timeout without cleanup disposal.
- Compatibility refinement: a narrow RFC-compatible exception accepts a tagless `100 Trying` only when both request and response lack a To tag; To URI plus every other identity field remains mandatory. The test proves valid tagless 100 stops Timer A while a forged identity does not.

### 2. Atomic incoming-answer settlement (Critical)

- Focused command: `npm test -- --run test/ua/invitation.test.ts`
- RED: ACK, CANCEL, or failure moved session state and synchronously notified observers before the answer deferred was captured and cleared. A throwing listener could strand `answer()`, and reentrant disconnect could steal the intended terminal result.
- GREEN: every terminal path captures and clears the answer deferred first, commits the internal outcome, settles the promise exactly once, and only then emits the public session transition. Session notification isolates observer exceptions. Tests cover valid ACK, CANCEL, and failure with throwing and reentrant listeners.
- Reentry refinement: synchronous delivery of the matching ACK during the initial 200 send previously left the internal Invitation state as `accepted`, causing a new response retransmitter to start and later fail a confirmed call. RED produced 11 total 200 sends after `64*T1`; GREEN sends one 200, leaves no timer, and keeps the session confirmed.

### 3. Complete server/TU shutdown and reentry-safe scheduling (Important)

- Focused commands:
  - `npm test -- --run test/transactions/coordinator.test.ts`
  - `npm test -- --run test/transactions/invite-server.test.ts test/transactions/non-invite-server.test.ts`
  - `npm test -- --run test/ua/invite-response-retransmitter.test.ts test/reliability/options-liveness.test.ts`
- RED: layer disposal omitted server transactions, leaving initial INVITE Timer 100 and Accepted/Completed timers alive. Synchronous send callbacks could ACK, dispose, terminate, or stop an owner, after which the original stack frame still scheduled a timer. A throwing transaction callback could abort disposal after the first transaction and make the already-marked-disposed layer impossible to retry.
- GREEN: disposal terminates both client and server maps, isolates each termination callback, and unconditionally clears maps/subscribers. Client/server send paths and TU retransmitters recheck state/ownership after synchronous I/O before scheduling. Initial INVITE Timer 100, Accepted/Completed, retransmission, and reentrant send cases all end with zero pending timers.
- Additional shutdown edge: `OptionsLiveness` now uses a generation/started guard so synchronous `stop()` during request installation immediately releases late ownership instead of resurrecting a standalone OPTIONS transaction.
- Additional transport edge: INVITE and non-INVITE server sends normalize synchronous throws and Promise rejections through their normal error paths. INVITE final states retain required RFC termination timers; non-INVITE final send failure terminates rather than leaking a map entry.

### 4. To tags on locally generated final responses (Important)

- Focused commands: `npm test -- --run test/integration/call.test.ts test/ua/user-agent.test.ts`
- RED: locally generated 486/487 and matching CANCEL 200 responses lacked a To tag, so a peer applying the same strict response-identity policy rejected the otherwise valid final and timed out.
- GREEN: local rejection, canceled INVITE, and matching CANCEL success responses carry a stable local To tag. End-to-end rejection and CANCEL flows now complete under strict identity validation; malformed incoming responses remain rejected.
- Review follow-up: generic non-100 local finals, including unmatched CANCEL 481, now add a local To tag when one is absent. Transaction response caching preserves it on retransmission.

### 5. Fork lifecycle ownership and isolation (Important)

- Focused commands: `npm test -- --run test/ua/dialog-set.test.ts test/ua/inviter.test.ts test/ua/user-agent.test.ts`
- RED: an extra fork was not published until after ACK I/O, so a synchronously delivered remote BYE had no owner and did not receive 200. Concurrent repeated 2xx responses could duplicate cleanup. Cleanup BYE failure propagated through Inviter and failed the selected healthy call.
- GREEN: each fork dialog and owner is published before ACK I/O, repeated 2xx cleanup is idempotent, remote BYE on an extra fork routes successfully, and cleanup BYE rejection remains isolated from the selected session.
- Review follow-up: `DialogSet.handleSuccess()` reports whether a response created/selected the application dialog. Inviter applies SDP only for the newly selected dialog, so a distinct SDP answer from an extra fork cannot overwrite selected media. Extra-fork ACK failure is also isolated and cleanup still proceeds.
- Late-fork follow-up: INVITE/fork response ownership is now independent of the selected dialog's BYE operation. A second 2xx arriving after selected hangup completes is still ACKed and cleaned with BYE during the accepted transaction lifetime.

### 6. Failed local hangup recovery (Important)

- Focused command: `npm test -- --run test/ua/inviter.test.ts`
- RED: a rejected local BYE left session state at `terminating` with `hangingUp=true`, permanently blocking later hangup attempts.
- GREEN: BYE failure settles that call once, clears the in-flight flag, and restores the confirmed session coherently. A subsequent valid hangup can send a new BYE and complete normally.

### 7. Redirect composed with 423 retry (Important)

- Focused command: `npm test -- --run test/ua/registrar.test.ts`
- RED: after an authenticated redirect, a 423 retry rebuilt REGISTER from the original registrar URI. The request target and Digest `uri` no longer referred to the redirect target.
- GREEN: the current redirected URI is retained through Min-Expires rebuilding, and Digest is regenerated for exactly that URI. The test asserts both the outgoing target and Authorization `uri` remain redirected.

### 8. Bounded stale authentication (Important)

- Focused commands:
  - `npm test -- --run test/auth/manager.test.ts`
  - `npm test -- --run test/ua/registrar.test.ts test/ua/inviter.test.ts`
- RED: repeated `stale=true` challenges bypassed the ordinary authentication retry budget indefinitely, so Registrar/Inviter public operations remained pending while requests continued.
- GREEN: a separate consecutive-stale budget permits legitimate stale nonce recovery but rejects the fourth consecutive stale challenge. Registrar and Inviter settle their public operations with the original authentication failure instead of looping. Successful completion and non-stale progress clear the relevant exchange accounting.
- Review follow-up: `retriesByRequestSize` now reports the union of ordinary and stale-only in-flight exchanges, so diagnostic state does not incorrectly report zero while a stale exchange is active.

### 9. Safe tag parsing for identity and dialog routing (Important)

- Focused commands: `npm test -- --run test/dialogs/header-values.test.ts test/dialogs/dialog.test.ts test/transactions/coordinator.test.ts`
- RED: the previous regular expression matched `tag=` text inside a quoted display name or inside an angle-bracketed URI parameter, allowing a decoy to influence response identity or dialog routing. Parameter name matching was not reliably case-insensitive.
- GREEN: `extractTag()` now scans quotes and angle brackets, considers only header parameters outside those regions, accepts case-insensitive `tag`, and preserves ordinary valid headers. Parser, identity, and dialog tests cover quoted and URI-parameter decoys.

## Independent final code-review follow-ups

A read-only final review was requested after the original nine findings were GREEN. It found additional synchronous reentry, transport-error, compatibility, and fork-lifetime edges within the same Phase 09 scope. All were reproduced RED and closed before the final matrix:

1. ACK delivered during the initial 200 send could restart retransmission: fixed with a committed `confirmed` internal state and post-send guard.
2. A throwing terminated callback could abort layer disposal: fixed with per-transaction isolation and `finally` cleanup.
3. Standards-compliant tagless 100 was rejected: fixed with the narrow status-100 identity exception described above.
4. OPTIONS stop during synchronous send could install stale ownership: fixed with a generation guard.
5. Synchronous server transport throws could strand final transaction states: fixed by normalized send-error handling.
6. Initial 200 async send rejection and TU retransmission rejection could leave `Invitation.answer()` pending or create an unhandled rejection: Invitation now owns exact server-transaction errors, and the retransmitter catches sync/async errors, stops, and rejects the answer promptly once.
7. Extra-fork ACK failure could kill the selected call: fixed by selected/extra classification and isolated extra-fork cleanup.
8. Extra-fork SDP could overwrite selected media: SDP is applied only to the newly selected fork.
9. Unmatched CANCEL 481 lacked a To tag: generic local non-100 finals now add one.
10. A late fork after selected hangup had no response owner: INVITE ownership now survives independently through the accepted lifetime.

A second read-only pass over those resolutions found four further Important edges. The focused command
`npm test -- --run test/transactions/coordinator.test.ts test/transactions/invite-client.test.ts test/transactions/non-invite-client.test.ts test/ua/user-agent.test.ts`
first produced 8 expected failures with 92 passing tests, then passed all 100 tests after these minimal fixes:

11. A bare From/To addr-spec gained a response tag and compared as a different URI. A From/To-specific URI extractor now removes only the recognized header `tag` while preserving URI parameters; the transaction test uses `;transport=tcp` to prove this composition.
12. INVITE and non-INVITE client transports could throw synchronously on initial send, Timer A/E retransmit, or non-2xx ACK. Both machines now normalize synchronous throws and Promise rejections through the same single `transportError`/termination path and leave zero timers.
13. A `terminating` observer could deliver a valid remote BYE, settle hangup, and return into code that still sent a local BYE. Hangup now revalidates the exact deferred, generation, flag, and session state after synchronous transition; the end-to-end test proves one settlement, no local BYE, and no owned timers.
14. Late-fork creation after the selected session became terminal could re-add a detached owner forever. DialogSet now releases each published owner idempotently after successful cleanup or a valid remote BYE; the UA removes only the matching mapping. Failed cleanup retains routing through selected-call termination and is bounded by Timer M, after which extra ownership expires.

The rapid resolution review then exposed two subtleties in items 11 and 14. The command
`npm test -- --run test/transactions/coordinator.test.ts test/ua/user-agent.test.ts`
witnessed 3 failures with 58 passing tests: a quoted `;tag=fake` decoy defeated raw replacement, failed-cleanup remote BYE received 481, and ownership was absent before expiry. The tag parser now returns its exact quote-aware span, and failed cleanup retains ownership until remote BYE or Timer M. The same command finished GREEN with 2 files and 61 tests; the broader parser/dialog/fork set finished GREEN with 6 files and 140 tests.

## Files changed

Implementation:

- `src/auth/manager.ts`
- `src/dialogs/header-values.ts`
- `src/reliability/options-liveness.ts`
- `src/transactions/coordinator.ts`
- `src/transactions/invite-client.ts`
- `src/transactions/invite-server.ts`
- `src/transactions/non-invite-client.ts`
- `src/transactions/non-invite-server.ts`
- `src/ua/dialog-set.ts`
- `src/ua/invitation.ts`
- `src/ua/invite-response-retransmitter.ts`
- `src/ua/inviter.ts`
- `src/ua/registrar.ts`
- `src/ua/response-identity.ts`
- `src/ua/session.ts`
- `src/ua/user-agent.ts`

Tests:

- `test/auth/manager.test.ts`
- `test/dialogs/dialog.test.ts`
- `test/dialogs/header-values.test.ts` (new)
- `test/integration/call.test.ts`
- `test/reliability/options-liveness.test.ts`
- `test/transactions/coordinator.test.ts`
- `test/transactions/invite-client.test.ts`
- `test/transactions/invite-server.test.ts`
- `test/transactions/non-invite-client.test.ts`
- `test/transactions/non-invite-server.test.ts`
- `test/ua/dialog-set.test.ts`
- `test/ua/invitation.test.ts`
- `test/ua/invite-response-retransmitter.test.ts` (new)
- `test/ua/inviter.test.ts`
- `test/ua/registrar.test.ts`
- `test/ua/user-agent.test.ts`

## Final verification

Fresh commands run after all behavioral and review-follow-up fixes:

- `npm test -- --run test/auth test/ua test/transactions test/dialogs test/integration`
  - GREEN: 25 test files, 366 tests.
- `npm run typecheck`
  - GREEN: `tsc --noEmit`, no diagnostics.
- `npm test`
  - GREEN: 41 test files, 552 tests.
- `git diff --check`
  - GREEN: no whitespace errors.

During the wave, the first aggregate run exposed three UA cases where a synchronous disconnect returned into client `start()` and armed timers after termination; post-send state guards fixed them. The first full run also exposed four liveness fixtures whose fabricated responses no longer met the stricter identity policy; the fixtures were corrected to represent valid finals, while the separately tested tagless-100 compatibility rule remains narrow.

## Self-review

- Verified that response identity is checked before transaction mutation rather than only at the Registrar/Inviter layer.
- Audited terminal deferred ownership so capture/clear/settle precedes synchronous public emission.
- Audited transaction/TU timer installation after sends for ACK, dispose, stop, and terminate reentry.
- Audited client and server ownership maps through normal termination, send failure, disposal, selected hangup, and late-fork cleanup.
- Audited synchronous client sends at initial, retransmit, and ACK boundaries and verified one error event with no timer resurrection.
- Audited per-dialog routing release after both local cleanup settlement and remote dialog termination.
- Confirmed URI-changing redirect/retry paths regenerate Digest Authorization.
- Confirmed strict malformed-response rejection remains in place; only valid tagless 100 receives the protocol-specific exception.
- Kept API changes small: a dialog-success classification result and a direction-specific server transaction subscription were necessary to express ownership without ambiguous key routing.
- Reviewed the complete diff for unrelated changes. `.claude/` remains untouched and untracked.

## Concerns

No blocking concern remains. The response-identity helper is used by the transaction coordinator to enforce the required pre-mutation boundary; it has no transaction dependency and introduces no runtime cycle. The tagless-100 exception is intentionally limited to status 100 with no To tag on either side and does not weaken final-response identity validation.
