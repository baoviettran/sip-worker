# Whole-branch review fix report

## Scope and status

Addressed all eight findings from the final review of `45572b9..0b04e6e` in the isolated `phase-08-protocol-correctness` worktree. Production changes are limited to INVITE branch generation, dialog Route formatting/list parsing, transaction subscription ownership, stateless INVITE identity matching, ingress error containment, OPTIONS ownership, top-Via parsing, and the `TransactionKey` type shape.

All new asynchronous regressions use `FakeClock`, synchronous transport hooks, and microtask draining; no new real-time waits were added.

## 1. Globally unique initial INVITE branches

### RED

Test added: `Inviter (outgoing SIP call session) > uses a distinct INVITE branch for a second Inviter while the first is in Accepted`.

Command:

```text
npm test -- --run test/ua/inviter.test.ts -t "uses a distinct INVITE branch"
```

Observed: one focused failure. Only one INVITE was sent (`expected length 2, received 1`) because both Inviter instances used `z9hG4bK-inv-1`, so the second operation reused the first Accepted client transaction within Timer M.

### GREEN

The initial INVITE now uses `makeBranch(this.idGenerator.branch())`; the instance-local counter was removed. Re-running the same command passed 1/1 focused test. The test shares the injected generator and transaction layer across sequential Inviters, does not advance Timer M, asserts two wire INVITEs, and asserts distinct Via values.

Files: `src/ua/inviter.ts`, `test/ua/inviter.test.ts`.

## 2. RFC Route name-addr serialization and list parsing

### RED

Updated loose/strict Route expectations to RFC-shaped `<uri>` name-addrs, added serialized-wire assertions, and added a quoted-display-name comma case.

Command:

```text
npm test -- --run test/dialogs/dialog.test.ts
```

Observed: 3 failed, 19 passed. Loose and strict Route values were bare URIs; the quoted comma case also produced an extra `"Edge` route fragment, proving the list splitter was syntax-blind.

### GREEN

Route-set entries remain bare URIs internally so strict routing can use the first URI as the Request-URI. `setRoute()` now serializes every Route entry as `<uri>`, including the strict-route appended remote target. Record-Route list splitting now respects quoted strings, escaped characters, and angle brackets. Re-running the suite passed 22/22.

Files: `src/dialogs/dialog.ts`, `src/dialogs/header-values.ts`, `test/dialogs/dialog.test.ts`.

## 3. Directional client transaction ownership

### RED

Test added: `Registrar > ignores a server transport error that shares its client transaction key`.

Command:

```text
npm test -- --run test/ua/registrar.test.ts -t "ignores a server transport error"
```

Observed: one focused failure. The registration rejected with `SipError: REGISTER transportError` after a same-key server transaction failed to send its response.

### GREEN

`TransactionLayer.subscribeClient()` now delivers only events emitted through the client transaction map. `sendOwnedRequest()` uses this client-direction subscription for both its synchronous buffer and its live listener. The same focused test passed 1/1.

Complementary guard: `Inviter > ignores a server timeout that shares its accepted client transaction key` constructs a same-key INVITE server transaction, advances FakeClock through Timer M/H, observes the server timeout, and verifies the confirmed client session stays confirmed. It passed 1/1.

Files: `src/transactions/coordinator.ts`, `src/transactions/request-ownership.ts`, `test/ua/registrar.test.ts`, `test/ua/inviter.test.ts`.

## 4. Returned-key matching for stateless INVITE 2xx

### RED

Parameterized tests added for wrong-branch and wrong-sent-by keyless INVITE 2xx responses.

Command:

```text
npm test -- --run test/ua/inviter.test.ts -t "ignores a keyless INVITE 2xx"
```

Observed: 2 focused failures. Both mismatched responses incorrectly resolved the invitation (`expected pending, received resolved`).

### GREEN

`sendOwnedRequest()` now supplies the exact returned transaction key to its install callback. Inviter retains that key and requires `clientKey(statelessResponse) === returnedInviteKey` before the existing CSeq/method, status, Call-ID, and From-tag checks. Re-running passed 2/2.

Files: `src/transactions/request-ownership.ts`, `src/ua/inviter.ts`, `test/ua/inviter.test.ts`.

## 5. Ingress containment of invalid transaction identity

### RED

Test added: `SipIngress > reports invalid transaction identity without throwing from the transport callback` using real wire bytes, `TransactionLayer`, `FakeTransport`, and `FakeClock`.

Command:

```text
npm test -- --run test/transport/ingress.test.ts -t "reports invalid transaction identity"
```

Observed: one focused failure. `transport.emitData()` threw `TransportError: top Via branch must contain the RFC 3261 magic cookie` outward.

### GREEN

SipIngress now separates parse failure handling from sink delivery and catches sink exceptions at the ingress boundary, forwarding them to `onError`. The regression passed 1/1, asserted no transaction/TU event, one `TransportError`, and no outward throw.

Files: `src/transport/ingress.ts`, `test/transport/ingress.test.ts`.

## 6. Synchronous OPTIONS final-response race

### RED

Test added: `OptionsLiveness > observes a final response delivered synchronously inside sendRequest` using `FakeTransport.onSend` and `FakeClock` only.

Command:

```text
npm test -- --run test/reliability/options-liveness.test.ts -t "observes a final response delivered synchronously"
```

Observed: one focused failure. The next cadence tick still had only one request (`expected 2, received 1`) because the synchronous response arrived before `outstanding` was assigned.

### GREEN

Options liveness now sends through `sendOwnedRequest()`. Its install callback records the returned key and unsubscribe function before buffered synchronous events replay. The focused test passed 1/1 and the next FakeClock cadence sent probe 2.

Files: `src/reliability/options-liveness.ts`, `test/reliability/options-liveness.test.ts`.

## 7. RFC SWS and repeated top Via fields

### RED

Tests added for separator whitespace around protocol slashes, sent-by colon, semicolon, and branch equals; repeated Via first-field selection; and rejection of a branchless first repeated Via despite a valid lower field.

Command:

```text
npm test -- --run test/transactions/coordinator.test.ts -t "Via"
```

Observed: 1 failed, 5 passed. The RFC-SWS form was rejected as lacking a magic-cookie branch; repeated-field guards already preserved strict top-field semantics.

### GREEN

Top Via parsing now selects the first value outside quoted strings, parses SIP/2.0/transport with separator whitespace, canonicalizes SWS around the sent-by colon, token-validates the branch parameter with SWS around `=`, and scans parameters without splitting quoted values. Re-running passed 6/6 Via-focused tests. Existing invalid identity checks remain in place.

Files: `src/transactions/coordinator.ts`, `test/transactions/coordinator.test.ts`.

## 8. Three-component TransactionKey type

### RED

Added a negative `@ts-expect-error` assertion for a two-component key and a valid three-component assertion.

Command:

```text
npm run typecheck
```

Observed: `TS2578: Unused '@ts-expect-error' directive`, proving the old type still accepted `branch|INVITE`.

### GREEN

`TransactionKey` is now `` `${string}|${string}|${string}` ``. Stale transaction-machine fixtures were mechanically updated to three components. `npm run typecheck` passed, and `npm test -- --run test/transactions/types.test.ts` passed 1/1. The package consumer fixture carries the same positive/negative assertions.

Files: `src/transactions/types.ts`, `test/transactions/types.test.ts`, `test/package/fixtures/types/index.ts`, and the four transaction-machine test fixtures.

## Focused and full verification

- Affected suites: 13 files, 175 tests passed.
- `npm test`: 39 files, 438 tests passed.
- `npm run typecheck`: passed.
- `git diff --check`: passed.

## Self-review

- Confirmed Request-URI values remain bare URIs while only Route field values become name-addrs.
- Confirmed client-only subscription dispatch is gated by the coordinator's owning client map, while legacy global and key-only subscriptions retain their documented behavior.
- Confirmed synchronous buffering installs teardown/key state before replay, so a synchronous final response can unsubscribe without leaking a listener.
- Confirmed wrong-key stateless responses fail before dialog identity handling, while legitimate repeated/forked 2xx retain the returned INVITE transaction identity.
- Confirmed the Via parser still rejects missing/invalid magic-cookie branches, missing sent-by, and mismatched/invalid CSeq inputs, including repeated lower Via attempts.
- Confirmed no caller-facing export was removed and all behavior changes are within the eight review findings.

## Concerns

- `npm run test:package` could not reach its TypeScript fixture in this worktree because `test/package/exports.test.mjs` hard-codes `node_modules/typescript/bin/tsc`, which is absent in the worktree even though `npm run typecheck` resolves `tsc` from the environment. The attempted package command completed build/declaration generation, then failed with `MODULE_NOT_FOUND` for that exact hard-coded path. The equivalent positive/negative type assertions are covered by the normal typecheck and the package fixture is updated for environments with a local TypeScript install.
- No production correctness concerns remain from the scoped findings at the time of self-review.
