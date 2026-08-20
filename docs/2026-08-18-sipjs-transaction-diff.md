# SIP.js Transaction Layer — Comparison with sip-worker

**Date:** 2026-08-18
**Scope:** Transaction state machines and timers only.
**Sources compared:**
- `sip-worker` (this repo, 0.7.0): `packages/core/src/transactions/{coordinator,invite-client,invite-server,non-invite-client,non-invite-server,timers,types,ack}.ts`
- SIP.js `main` (2026-08-18, monorepo layout): `src/core/transactions/{transaction,client-transaction,invite-client-transaction,non-invite-client-transaction,server-transaction,invite-server-transaction,non-invite-server-transaction,transaction-user}.ts` and `src/core/timers.ts`

The four RFC 3261 transaction state machines are implemented by both. The
differences are in how many of the RFC's unreliable-transport timers are
actually implemented, how 2xx-ACK responsibility is divided between the
transaction and the TU, and how the state machine guards its own transitions.

## Headline

1. **SIP.js does not implement any retransmission timer.** Timer A (INVITE
   client), Timer E (non-INVITE client), and Timer G (INVITE server) are all
   `// TODO` no-ops. SIP.js is browser/WSS-only in practice, so a reliable
   transport makes retransmission unnecessary — but the code is not
   transport-generic the way sip-worker's `reliable` flag is.
2. **SIP.js hardcodes D/I/J/K to 0** and self-documents it as wrong for
   unreliable transports (`Timers.TIMER_D: 0 * T1, // Not correct for
   unreliable transports`). sip-worker derives all of B/D/F/H/I/J/K/L/M from
   the transport reliability — strictly more RFC-correct.
3. **sip-worker's Timer B fires from Proceeding; SIP.js's fires only from
   Calling** (and SIP.js clears B on entering Proceeding). RFC 3261 Figure 5
   shows a Timer-B timeout transition from Proceeding, so sip-worker is the
   RFC-complete behavior: an INVITE left ringing with no final response still
   times out.
4. **sip-worker sends the automatic 100 Trying (200 ms); SIP.js does not.**
   SIP.js's INVITE server transaction has a stale doc comment claiming it
   sends 100 immediately, but the constructor does not and there is no
   200 ms timer anywhere. sip-worker implements RFC 17.2.1 correctly.
5. **2xx ACK ownership is the one real architectural fork.** SIP.js keeps a
   per-`to-tag` ACK cache inside the transaction and auto-retransmits the ACK
   on retransmitted 2xx responses (a documented, deliberate non-compliance).
   sip-worker emits every 2xx to the TU and leaves 2xx ACK + retransmission to
   the dialog layer — the RFC 3261 division of labor.

## Shape comparison

| Concern | SIP.js | sip-worker |
| --- | --- | --- |
| Class shape | `Transaction` → `ClientTransaction`/`ServerTransaction` → 4 concrete; shared `TransactionState` enum | 4 flat classes; per-class state unions (`InviteState`, `NonInviteState`, …) |
| Transaction identity | Via branch only (`id`); CANCEL reuses INVITE branch | `TransactionKey` = `branch|sent-by|method`; ACK folded onto the INVITE server key |
| Via stamping | Transaction constructor calls `setViaHeader(id, protocol)` | Branch set upstream by injected `idGenerator`; transaction layer keys off existing Via |
| Send | On construction (constructor side effects) | Explicit `start()` |
| Timers | Static `Timers` constants; `setTimeout` | `deriveTimers(config, reliable)` → `DerivedTimers`; injected `Clock` |
| Timeout signal | `onRequestTimeout` callback (client only) | Typed `{type:'timeout'}` event on B/F/H, client and server |
| Transition guard | Central `stateTransition()` throws on illegal transitions | Inline state checks; every handler re-checks `currentState` after each send/emit (reentrancy-safe) |
| Retransmission | None (Timers A/E/G are TODOs) | All three implemented per RFC |

## InviteClientTransaction

| Behavior | SIP.js | sip-worker | Verdict |
| --- | --- | --- | --- |
| States | Calling → Proceeding → Accepted\|Completed → Terminated | same | same |
| Timer A (unreliable retransmit) | `TODO` — no-op | T1, doubles unbounded, only in Calling (RFC 17.1.1.2) | sip-worker ahead |
| Timer B timeout | Fires from Calling only; cleared on entering Proceeding | Armed in `start()`, fires from Calling **or** Proceeding | sip-worker RFC-complete (Figure 5) |
| 1xx | Passed to TU; Calling→Proceeding | same | same |
| 2xx → Accepted, Timer M | RFC 6026; primes ACK cache with `undefined`; arms Timer M (64·T1) | Arms Timer M; **emits every 2xx**, does not restart M | M same; TU division differs (below) |
| Non-2xx final → Completed, ACK | `ack(response)` builds ACK inline; resends on retransmitted final | `buildNon2xxAck` injected; bytes cached; resent on retransmitted final | same intent |
| Timer D (Completed linger) | `0 * T1` — wrong for UDP | `reliable ? 0 : max(32000, 64·T1)` | sip-worker ahead |
| 2xx in Completed | dropped as unexpected | dropped | same |
| Reentrancy guard | none after `user.receiveResponse` (can throw invalid transition) | re-checks state after every emit/send | sip-worker more robust |

**2xx handling is the interesting one.** SIP.js: first 2xx is passed to the TU
(which calls `ackResponse` to supply the ACK); a retransmitted 2xx in Accepted
with a cached ACK is absorbed and the ACK is re-sent by the transaction; a
retransmitted 2xx before the TU produced the ACK is discarded. This is
explicitly documented as non-compliant (RFC 6026 §8.4: the client transaction
"MUST NOT generate an ACK to the 2xx response — its handling is delegated to
the TU"). sip-worker: every 2xx in Accepted is emitted to the TU, and the
dialog layer must dedupe and re-ACK. sip-worker is the RFC-clean division —
**provided the dialog layer re-sends the ACK for each retransmitted 2xx**. This
is the one place the diff's correctness depends on a layer the transaction
itself cannot vouch for.

## InviteServerTransaction

| Behavior | SIP.js | sip-worker | Verdict |
| --- | --- | --- | --- |
| States | Proceeding → Accepted\|Completed → Confirmed → Terminated | same | same |
| Automatic 100 Trying | Stale comment only; no timer, nothing sent | 200 ms timer armed on initial request, cancelled by any UAS response | sip-worker implements RFC 17.2.1 |
| Provisional retransmission (RFC 13.3.1.1, 60 s) | Implemented (`progressExtensionTimer`; self-flagged as misplaced) | Not present | SIP.js has it, sip-worker lacks it — optional gap |
| Duplicate INVITE in Proceeding | resends `lastProvisionalResponse` | resends cached response (provisional or auto-100) | same intent |
| 2xx → Accepted, Timer L | RFC 6026; Timer L 64·T1; duplicate INVITE **absorbed** in transaction; `retransmitAcceptedResponse()` for the TU | Timer L same; duplicate INVITE **forwarded to TU** to resend the 2xx | division of labor (below) |
| Non-2xx final → Completed | Timer H 64·T1; **Timer G (retransmit) is `TODO`** | Timer G implemented (T1 doubling capped at T2); Timer H same | sip-worker ahead |
| ACK in Completed → Confirmed, Timer I | `0 * T4` — wrong for UDP | `reliable ? 0 : T4` | sip-worker ahead |
| Transport error | RFC 6026 §8.8: notify TU, **stay in current state** (must survive to receive the ACK) | same — `sendBytes` emits `transportError` only, never terminates | same, both RFC-correct |
| Timer H expiry | logs, terminates; no TU failure notification beyond state change | emits typed `{type:'timeout'}`, terminates | sip-worker observable |

**Accepted-state duplicate INVITE** is the mirror image of the 2xx fork: SIP.js
absorbs the duplicate inside the transaction and exposes
`retransmitAcceptedResponse()` for the TU; sip-worker forwards the duplicate up
so the TU resends the 2xx. RFC 6026 §8.7 says these retransmissions should be
absorbed by the transaction. Both designs work as long as the 2xx actually gets
re-sent — in sip-worker that responsibility lives in the dialog layer, so it
must be exercised (the reference softphone's hold/resume path re-INVITEs, which
does not prove the retransmitted-INVITE-in-Accepted path).

## NonInviteClientTransaction

| Behavior | SIP.js | sip-worker | Verdict |
| --- | --- | --- | --- |
| States | Trying → Proceeding → Completed → Terminated | same | same |
| Timer E (unreliable retransmit) | `TODO` — no-op | T1 doubling capped at T2; reset to T2 on entering Proceeding | sip-worker ahead |
| Timer F | fires in Trying **and** Proceeding (RFC 17.1.2.2) | same, emits `{type:'timeout'}` | same |
| Final → Completed, Timer K | `0 * T4` — wrong for UDP | `reliable ? 0 : T4` | sip-worker ahead |
| 408 received | `onRequestTimeout()`; 408 **not** passed to TU (RFC 4320 §4.1: the 408 conveys nothing the local timeout didn't already) | 408 passed through to TU as a normal final response | divergence, see Findings |

## NonInviteServerTransaction

| Behavior | SIP.js | sip-worker | Verdict |
| --- | --- | --- | --- |
| States | Trying → Proceeding → Completed → Terminated | same | same |
| Provisional >100 | **Throws** — RFC 4320 §4.1 forbids non-100 provisional to non-INVITE | Accepted and sent | gap, see Findings |
| Duplicate request Trying | discarded | resend of empty cache = discard | same |
| Duplicate request Proceeding / Completed | resends last response | resends cached response | same |
| Timer J | `0 * T1` — wrong for UDP | `reliable ? 0 : 64·T1` | sip-worker ahead |

## Timer values (ms)

RFC default T1=500, T2=4000, T4=5000.

| Timer | RFC | SIP.js | sip-worker (`reliable`/`unreliable`) |
| --- | --- | --- | --- |
| A (ICT, unreliable) | T1, doubling | not implemented | T1, doubling |
| B | 64·T1 | 32000 | 32000 |
| D (ICT Completed) | ≥32000 / 0 | 0 (wrong for UDP) | 0 / 32000 |
| E (NICT, unreliable) | T1→T2 | not implemented | T1→T2 |
| F | 64·T1 | 32000 | 32000 |
| G (IST, unreliable) | T1→T2 | not implemented | T1→T2 |
| H | 64·T1 | 32000 | 32000 |
| I (IST Confirmed) | T4 / 0 | 0 (wrong for UDP) | 0 / 5000 |
| J (NIST Completed) | 64·T1 / 0 | 0 (wrong for UDP) | 0 / 32000 |
| K (NICT Completed) | T4 / 0 | 0 (wrong for UDP) | 0 / 5000 |
| L (IST Accepted) | 64·T1 | 32000 | 32000 |
| M (ICT Accepted) | 64·T1 | 32000 | 32000 |

## Findings

### Worth borrowing from SIP.js

1. **RFC 4320 provisional guard on the non-INVITE server transaction.** SIP.js
   rejects any provisional >100 from the TU (`"Provisional response other than
   100 not allowed."`). sip-worker will happily send a 180/183 in answer to a
   REGISTER or OPTIONS. A `code > 100 && code <= 199` rejection in
   `NonInviteServerTransaction.sendResponseAwait` is a one-line compliance fix.

2. **Central transition assertions for tests.** SIP.js's `stateTransition()`
   throws on any illegal transition, catching programmer error loudly in the
   test suite. sip-worker's inline guards are reentrancy-safe but cannot assert
   "you did not need this transition path" — a debug-only transition table
   check (e.g. under a `NODE_ENV === 'test'` assertion) would buy the same
   coverage without the throw-in-production behavior.

3. **The 408-as-timeout treatment.** SIP.js suppresses a received 408 on a
   non-INVITE client transaction (RFC 4320 §4.1) rather than surfacing it as a
   normal response. sip-worker passes it through. Verify the dialog layer maps
   a 408 to the same outcome as the local Timer F timeout; if it already does,
   the transaction-level suppression is optional polish.

   **Resolution (2026-08-20): verified as a deliberate divergence, kept.** The
   two non-INVITE consumers both treat a received 408 as more informative than
   a local timeout, which is the RFC 4320 intent:
   - `Registrar`: a received 408 fails the exchange with
     `REGISTRATION_FAILED` (the server saw the request); a local Timer F
     expiry fails it with `TIMEOUT`. Locked in by
     `packages/core/test/ua/registrar.test.ts` ("maps a received 408 to
     REGISTRATION_FAILED, distinct from the local Timer F timeout").
   - `OptionsLiveness`: any final response — including 408 — proves peer
     liveness and schedules the next probe; only a transaction timeout or
     transport error reports a liveness failure. A 408 therefore cannot be
     conflated with "peer dead".
   Transaction-level suppression (SIP.js) would discard exactly the evidence
   the TU uses; pass-through stays.

4. **Per-`to-tag` 2xx ACK tracking.** The `ackRetransmissionCache` (Map of
   to-tag → ACK) is SIP.js's answer to forked INVITEs: multiple 2xx branches
   each get their own ACK. sip-worker's dialog layer needs the same
   per-`to-tag` bookkeeping when it re-ACKs retransmitted 2xx responses — worth
   confirming it keys ACKs by to-tag, not by dialog/CSeq alone.

   **Resolution (2026-08-20): already implemented.** `DialogSet`
   (`packages/core/src/ua/dialog-set.ts`) keys every fork by its remote To
   tag, serializes a per-dialog ACK once (its To header carries that fork's
   tag, `createAck` on the fork's own `Dialog`), caches the bytes, and re-sends
   the cached ACK on a repeated 2xx for the same tag (`handleSuccess`). Extra
   forks are BYE-cleaned once. Covered by
   `packages/core/test/ua/dialog-set.test.ts` and the forked-INVITE cases in
   `packages/core/test/ua/inviter.test.ts`.

### Deliberate divergences to keep (sip-worker is ahead)

5. **All retransmission timers implemented** (A/E/G) with correct
   unreliable-transport values (D/I/J/K derived per transport). SIP.js's are
   TODOs or hardcoded 0s because it never runs on UDP. This validates the
   `reliable`-derived-timers design; nothing to copy.

6. **Automatic 100 Trying** is real in sip-worker, doc-comment-only in SIP.js.

7. **Timer B from Proceeding** (RFC Figure 5) — SIP.js leaves a ringing call
   without any transaction-layer timeout once it has a provisional response.

8. **Structured typed events, per-key subscription, reentrancy guards, injected
   Clock + idGenerator** — all strictly ahead of SIP.js's callbacks, bare
   `setTimeout`, and `Math.random()` branches.

### Gaps to close or consciously accept in sip-worker

9. **Accepted-state duplicate INVITE → 2xx resend.** sip-worker delegates this
   to the dialog layer. There is no test evidence cited in this repo that the
   path (retransmitted INVITE while a 2xx is outstanding → 2xx re-sent) is
   exercised end-to-end. Confirm the dialog layer resends the 2xx; if it does
   not, either adopt the forwarding + TU-resend contract's test, or absorb the
   duplicate in the transaction and expose a `retransmitAcceptedResponse()`
   equivalent.

   **Resolution (2026-08-20): already implemented and proven.** The
   forwarding + TU-resend contract holds: `InviteServerTransaction` emits the
   duplicate in `Accepted`, the UA routes it to the existing `Invitation`
   (same initial-INVITE identity), and `Invitation.handleDuplicateInvite`
   (`packages/core/src/ua/invitation.ts`) re-sends the cached 2xx with a fresh
   Via for the new request — the accepted fork of this finding. Proven
   end-to-end by `packages/core/test/integration/call.test.ts` ("reuses an
   accepted Invitation for a duplicate INVITE on a new transaction"), which
   asserts a second 200 OK with the invitation's To tag on the duplicate
   transaction.

10. **Provisional retransmission (RFC 13.3.1.1).** SIP.js carries a 60 s
    `setInterval` resending the last non-100 provisional (self-flagged as
    misplaced in the transaction). sip-worker has nothing. Only matters for
    calls left in early-media/ringing beyond ~3 minutes (proxies may CANCEL a
    silent INVITE). Low priority given hold is a sendonly re-INVITE, but worth
    a deliberate decision — it is a UAS-core concern, not a transaction one,
    so the fix belongs above the transaction layer in sip-worker.

    **Resolution (2026-08-20): consciously deferred.** Agreed it is a
    UAS-core concern (the last sent provisional lives above the transaction),
    and no current sip-worker flow (hold/resume re-INVITE, immediate answer)
    leaves a call in early-media long enough for a proxy to treat it as
    silent. Track as a UAS-core enhancement if the FreeSWITCH/softswitch pilot
    surfaces a need; not a transaction-layer change.
