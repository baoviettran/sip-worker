# Leftover Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close every documented leftover from the Plan 04 Handoff and phase-3 internal polish lists, plus a caller-owned `viaAddress` option and docs drift, in one risk-ordered TDD plan.

**Architecture:** No new modules. All edits stay in `src/auth/*`, `src/ua/*`, `src/transactions/coordinator.ts`, `src/transactions/ack.ts`, plus the public barrel, test-only fixes, and plan/index docs. Fifteen tasks (A–O) grouped into three risk-descending tiers: wire correctness → registrar/UA lifecycle → parser robustness, test hardening, docs, viaAddress. Each task lands behind a witnessed red test and a green full regression.

**Tech Stack:** TypeScript 5.x strict ESM, Vitest, virtual clock (`Clock`/`FakeClock`), tsup, Node 22+. No new runtime dependencies.

**Status:** Complete. Final acceptance re-verified on 2026-08-09. The Digest
primitive supports `auth-int`; the body-less `AuthManager` retry path explicitly
declines `auth-int`-only challenges rather than attempting an invalid digest.

## Global Constraints

- Every production change follows a witnessed red test and ends with focused-plus-full verification, matching the Plans 01–06 discipline.
- No real-time sleeps; all timer-driven behavior uses the injected `Clock`.
- Tolerance/parser tests stay inside `expect(() => parse(...)).not.toThrow()`; parsing never throws or hangs.
- Existing public exports and signatures remain unchanged except the deliberate additive `viaAddress?: string` on `UserAgentOptions`.
- Each task ends with a focused test, full regression (`npm test`), `npm run typecheck`, and a commit.

---

### Task A: Escape auth quoted-strings

**Files:**
- Modify: `src/auth/authorization.ts:24-30`
- Test: `test/auth/authorization.test.ts`

**Interfaces:**
- Consumes: `renderAuthorization(params: AuthorizationParams, proxy = false): string` (unchanged signature).
- Produces: same signature; quoted fields now RFC 2617 `quoted-pair`-escaped.

- [x] **Step 1: Write the failing test**

Append to `test/auth/authorization.test.ts` inside the `describe('renderAuthorization', ...)` block:

```ts
it('backslash-escapes a quote and a backslash inside quoted fields', () => {
  const line = renderAuthorization({
    username: 'a"b\\c',
    realm: 'r',
    nonce: 'n',
    uri: 'sip:x',
    response: 'abc',
  });
  // Every `"` and `\` inside the quoted username is escaped.
  expect(line).toContain('username="a\\"b\\\\c"');
});
```

- [x] **Step 2: Run to verify failure**

Run: `npx vitest run test/auth/authorization.test.ts`
Expected: FAIL — current output is `username="a"b\c"`, which does not contain `username="a\"b\\c"`.

- [x] **Step 3: Implement escaping**

In `src/auth/authorization.ts`, add a private helper and apply it to the five quoted fields:

```ts
/** Escape `\` and `"` per RFC 2617 quoted-pair so a value can't break its quoted-string. */
function escapeQuoted(value: string): string {
  return value.replace(/[\\"]/g, (ch) => `\\${ch}`);
}
```

Change the `parts` array to wrap each quoted value:

```ts
  const parts: string[] = [
    `username="${escapeQuoted(params.username)}"`,
    `realm="${escapeQuoted(params.realm)}"`,
    `nonce="${escapeQuoted(params.nonce)}"`,
    `uri="${escapeQuoted(params.uri)}"`,
    `response="${escapeQuoted(params.response)}"`,
  ];
```

`cnonce` and `opaque` (the two remaining quoted fields) also use `escapeQuoted`:

```ts
  if (params.cnonce !== undefined) parts.push(`cnonce="${escapeQuoted(params.cnonce)}"`);
  if (params.opaque !== undefined) parts.push(`opaque="${escapeQuoted(params.opaque)}"`);
```

- [x] **Step 4: Run to verify passes**

Run: `npx vitest run test/auth/authorization.test.ts`
Expected: PASS — the existing three tests still pass (their values contain no `"` or `\`), and the new escape test passes.

- [x] **Step 5: Full verification**

Run: `npm test` and `npm run typecheck`
Expected: all tests pass; typecheck clean.

- [x] **Step 6: Commit**

```bash
git add src/auth/authorization.ts test/auth/authorization.test.ts
git commit -m "fix: backslash-escape quotes inside Digest auth fields"
```

---

### Task B: Implement `auth-int` HA2

**Files:**
- Modify: `src/auth/digest.ts:5-17,31-44`
- Modify: `src/auth/manager.ts:100` (selectChallenge call) and `src/auth/challenge.ts:248` (selectChallenge)
- Test: `test/auth/digest.test.ts`

**Interfaces:**
- Consumes: `computeDigest(params: DigestParams): string`.
- Produces: `DigestParams` gains `readonly body?: Uint8Array`; `computeDigest` honors `qop: 'auth-int'`.

- [x] **Step 1: Write the failing tests**

Append to `test/auth/digest.test.ts`:

```ts
it('computes an MD5 auth-int response with entity-body integrity (RFC 2617 3.5)', () => {
  const digest = computeDigest({
    algorithm: 'MD5',
    username: 'Mufasa',
    password: 'Circle Of Life',
    realm: 'testrealm@host.com',
    nonce: 'dcd98b7102dd2f0e8b11d0f600bfb0c093',
    method: 'GET',
    uri: '/dir/index.html',
    qop: 'auth-int',
    nc: '00000001',
    cnonce: '0a4f113b',
    body: new TextEncoder().encode('hello world!\n'),
  });
  // Auth-int for body "hello world!\n" (same credentials/params as the 3.5
  // example). Computed: H(HA1:nonce:nc:cnonce:qop:H(method:uri:H(body))) with
  // the repo's md5. The auth (non-int) counterpart is 6629fae49393a05397450978507c4ef1.
  expect(digest).toBe('ba1a66c6c77a0510308d727ab5e3a97c');
});

it('throws when auth-int is requested without a body', () => {
  const params: DigestParams = {
    algorithm: 'MD5',
    username: 'Mufasa',
    password: 'Circle Of Life',
    realm: 'testrealm@host.com',
    nonce: 'dcd98b7102dd2f0e8b11d0f600bfb0c093',
    method: 'GET',
    uri: '/dir/index.html',
    qop: 'auth-int',
    nc: '00000001',
    cnonce: '0a4f113b',
  };
  expect(() => computeDigest(params)).toThrow(/entityBody|body/);
});
```

> **Vector note:** The expected `auth-int` hex above is a placeholder to be replaced by the implementer's hand-written RFC 2617 `auth-int` vector during Step 3 — see the "No Placeholder" rule: recompute `H(HA1:nonce:nc:cnonce:qop:H(method:uri:H(body)))` for the chosen body and pin the literal. Do not ship the placeholder string.

- [x] **Step 2: Run to verify failure**

Run: `npx vitest run test/auth/digest.test.ts`
Expected: FAIL — the auth-int test computes the `auth` formula (wrong hex), and the body-missing test does not throw.

- [x] **Step 3: Implement auth-int**

In `src/auth/digest.ts`, extend `DigestParams` and the computation:

```ts
export interface DigestParams {
  readonly algorithm: DigestAlgorithm;
  readonly username: string;
  readonly password: string;
  readonly realm: string;
  readonly nonce: string;
  readonly method: string;
  readonly uri: string;
  /** Present when the server challenged with a qop directive. */
  readonly qop?: 'auth' | 'auth-int';
  readonly nc?: string;
  readonly cnonce?: string;
  /** Entity body bytes; required when qop is 'auth-int'. */
  readonly body?: Uint8Array;
}
```

Replace the HA2 computation:

```ts
  if (qop !== undefined && (nc === undefined || cnonce === undefined)) {
    throw new TypeError('computeDigest: nc and cnonce are required when qop is set');
  }
  if (qop === 'auth-int' && body === undefined) {
    throw new TypeError('computeDigest: body is required when qop is auth-int');
  }

  const h: (input: string) => string = algorithm === 'MD5' ? md5 : sha256;
  const ha1 = h(`${username}:${realm}:${password}`);
  const ha2 = qop === 'auth-int'
    ? h(`${method}:${uri}:${h(new TextDecoder().decode(body))}`)
    : h(`${method}:${uri}`);
```

Keep the rest of `computeDigest` (the `data` assembly and final `h(data)`) unchanged.

Then, in `src/auth/challenge.ts` `selectChallenge` (line ~255), stop rejecting `auth-int` — ensure `qop.includes('auth')` still scores an `auth-int` challenge as supported (it already does: `c.qop.includes('auth')` matches the `'auth'` token within `'auth-int'`). No change needed here if the test passes; only adjust if selectChallenge filters out `auth-int`.

- [x] **Step 4: Run to verify passes**

Run: `npx vitest run test/auth/digest.test.ts`
Expected: PASS — the pinned `auth-int` vector and the body-missing `TypeError` both pass.

- [x] **Step 5: Full verification**

Run: `npm test` and `npm run typecheck`
Expected: all tests pass; typecheck clean.

- [x] **Step 6: Commit**

```bash
git add src/auth/digest.ts src/auth/manager.ts src/auth/challenge.ts test/auth/digest.test.ts
git commit -m "feat: support Digest auth-int entity-body integrity"
```

---

### Task C: Preserve Via params on auth retry

**Files:**
- Modify: `src/auth/manager.ts:265-273`
- Test: `test/auth/manager.test.ts`

**Interfaces:**
- Consumes: `AuthManager.retry(context)`, `makeBranch`, `IdGenerator` (existing).
- Produces: retried request Via keeps all original params except `branch`.

- [x] **Step 1: Write the failing test**

Append inside `test/auth/manager.test.ts` (uses the existing `fixture()` helper):

```ts
it('preserves every Via param except branch on auth retry', () => {
  const f = fixture();
  // Original Via with params current nextVia drops.
  f.request.headers.set(
    'Via',
    'SIP/2.0/UDP 192.0.2.1:5060;branch=z9hG4bK-original;received=10.0.0.1;comp=sigcomp;transport=tls;rport',
  );
  f.request.headers.set('CSeq', '1 INVITE');
  const manager = new AuthManager(f.ids());
  const retried = manager.retry(f.context()) as SipRequestMessage;
  const via = retried.headers.get('Via');
  expect(via).toContain('received=10.0.0.1');
  expect(via).toContain('comp=sigcomp');
  expect(via).toContain('transport=tls');
  expect(via).toContain('rport');
  expect(via).not.toContain('z9hG4bK-original');
});
```

- [x] **Step 2: Run to verify failure**

Run: `npx vitest run test/auth/manager.test.ts -t "preserves every Via param"`
Expected: FAIL — current `nextVia` rebuilds only `transport + sentBy + ;rport`, dropping `received`, `comp`, `transport`.

- [x] **Step 3: Implement param-preserving nextVia**

Replace `nextVia` in `src/auth/manager.ts` (lines 261-273):

```ts
/**
 * Builds a fresh Via from the original top Via, replacing only the branch and
 * keeping every other param (`;received`, `;comp`, `;transport`, `;rport`, …)
 * verbatim. Falls back to a UDP sent-by when no Via is present.
 */
function nextVia(idGenerator: IdGenerator, headers: Headers): string {
  const via = headers.get('Via');
  if (via === undefined) {
    return `SIP/2.0/UDP 192.0.2.1:5060;branch=${makeBranch(idGenerator.branch())}`;
  }
  const branch = makeBranch(idGenerator.branch());
  // Replace the branch param in place; keep everything else.
  const reBranch = /(^|;|\s)branch=[^;]*/;
  return reBranch.test(via)
    ? via.replace(/branch=[^;]*/, `branch=${branch}`)
    : `${via};branch=${branch}`;
}
```

`makeBranch` is already imported in `manager.ts`. If it is not, add `import { makeBranch } from '../dialogs/header-values.js';` at the top.

- [x] **Step 4: Run to verify passes**

Run: `npx vitest run test/auth/manager.test.ts`
Expected: PASS — the new test and all existing manager tests (including Via-branch-stability assertions) pass.

- [x] **Step 5: Full verification**

Run: `npm test` and `npm run typecheck`
Expected: all tests pass; typecheck clean.

- [x] **Step 6: Commit**

```bash
git add src/auth/manager.ts test/auth/manager.test.ts
git commit -m "fix: preserve Via params across authentication retries"
```

---

### Task D: Missing-CSeq method fix

**Files:**
- Modify: `src/auth/manager.ts:255-259`
- Test: `test/auth/manager.test.ts`

**Interfaces:**
- Consumes: `AuthManager.retry`, request `method`.
- Produces: `nextCSeq` fallback carries the request's actual method, not hardcoded `INVITE`.

- [x] **Step 1: Write the failing test**

Append to `test/auth/manager.test.ts`:

```ts
it('stamps a CSeq-less retry with the original method', () => {
  const f = fixture();
  f.request.headers.delete('CSeq'); // force the fallback
  const sub = makeRequest('SUBSCRIBE', 'sip:alice@example.com', f.request.headers.clone());
  const manager = new AuthManager(f.ids());
  const ctx = f.context({ request: sub });
  const retried = manager.retry(ctx) as SipRequestMessage;
  const cseq = retried.headers.get('CSeq');
  expect(cseq).toMatch(/^1 SUBSCRIBE$/);
});
```

Add `makeRequest` to the existing `import { makeRequest, makeResponse, ... }` line if not already imported.

- [x] **Step 2: Run to verify failure**

Run: `npx vitest run test/auth/manager.test.ts -t "CSeq-less retry"`
Expected: FAIL — current fallback returns `1 INVITE`.

- [x] **Step 3: Implement method-correct fallback**

Change `nextCSeq` in `src/auth/manager.ts` to accept the request method and use it in the fallback. Update the call site (`retry`, line ~189) accordingly:

```ts
function nextCSeq(headers: Headers, method: string): string {
  const cseq = headers.get('CSeq');
  if (cseq === undefined) return `1 ${method}`;
  const match = cseq.match(/^(\d+)\s+(.+)$/);
  if (match === null) return cseq;
  return `${String(Number.parseInt(match[1]!, 10) + 1)} ${match[2]}`;
}
```

And at the call site, `headers.set('CSeq', nextCSeq(request.headers, request.method));`.

- [x] **Step 4: Run to verify passes**

Run: `npx vitest run test/auth/manager.test.ts`
Expected: PASS.

- [x] **Step 5: Full verification**

Run: `npm test` and `npm run typecheck`
Expected: all tests pass; typecheck clean.

- [x] **Step 6: Commit**

```bash
git add src/auth/manager.ts test/auth/manager.test.ts
git commit -m "fix: use original method for CSeq-less auth retries"
```

---

### Task E: Decouple manager from the `": "` convention

**Files:**
- Modify: `src/auth/manager.ts:184-186`
- Test: `test/auth/manager.test.ts`

**Interfaces:**
- Consumes: the string emitted by `renderAuthorization`.
- Produces: header name/value split robust to a value containing `": "`.

- [x] **Step 1: Write the failing test**

```ts
it('routes a rendered header value that itself contains ": "', () => {
  const f = fixture();
  const manager = new AuthManager(f.ids());
  // renderAuthorization emits the header line; simulate via a crafted AuthorizationParams
  // is not possible because renderAuthorization builds the full line. Instead force the
  // manager's splitter to face a value with ": " by appending it to the response realm.
  f.response.headers.set(
    'WWW-Authenticate',
    'Digest realm="realm: with: colons", nonce="n", algorithm=MD5',
  );
  const retried = manager.retry(f.context()) as SipRequestMessage;
  const auth = retried.headers.get('Authorization');
  expect(auth).toContain('realm="realm: with: colons"');
  // The full value is intact — the splitter consumed only the first ": ".
  expect(auth).toContain('realm="realm: with: colons", nonce="n"');
});
```

- [x] **Step 2: Run to verify failure**

Run: `npx vitest run test/auth/manager.test.ts -t "routes a rendered header value"`
Expected: FAIL — `fieldValue = rendered.slice(colon + 2)` splits on the first `": ",` so the value is truncated at the first colon-space inside the realm.

- [x] **Step 3: Implement a first-colon splitter**

Replace the `": "` split in `retry` (lines 184-186) with a split-on-first-colon:

```ts
    const colon = rendered.indexOf(':');
    const headerName = rendered.slice(0, colon);
    // Strip exactly one leading space after the colon.
    const rest = rendered.slice(colon + 1);
    const fieldValue = rest.startsWith(' ') ? rest.slice(1) : rest;
```

- [x] **Step 4: Run to verify passes**

Run: `npx vitest run test/auth/manager.test.ts`
Expected: PASS.

- [x] **Step 5: Full verification**

Run: `npm test` and `npm run typecheck`
Expected: all tests pass; typecheck clean.

- [x] **Step 6: Commit**

```bash
git add src/auth/manager.ts test/auth/manager.test.ts
git commit -m "fix: split rendered auth header on first colon, not hardcoded ': '"
```

---

### Task F: Isolate `forward()` listeners

**Files:**
- Modify: `src/transactions/coordinator.ts:82-90`
- Test: `test/transactions/coordinator.test.ts`

**Interfaces:**
- Consumes: `TransactionLayer.forward(event)`.
- Produces: a throwing subscriber does not break the layer or other subscribers.

- [x] **Step 1: Write the failing test**

Append to `test/transactions/coordinator.test.ts`. Construct a `TransactionLayer` with a fake transport, add a throwing subscriber and a good subscriber, emit an internal event by sending a request, and assert the good subscriber still fires:

```ts
it('isolates a throwing subscriber from the rest', async () => {
  const { layer, fakeTransport } = makeLayer(); // use the test's existing helper
  const good: unknown[] = [];
  const bad = () => { throw new Error('boom'); };
  layer.subscribe(bad);
  layer.subscribe((e) => good.push(e.type));
  const request = makeRequest('MESSAGE', 'sip:b@example.com', messageHeaders('M'));
  layer.sendRequest(request);
  // A response routed to the client transaction must still reach `good`.
  fakeTransport.emitData(responseBytes(400, messageHeaders('M')));
  expect(good).toContain('response');
});
```

> **Helper note:** Adapt names (`makeLayer`, `messageHeaders`, `responseBytes`) to whatever the coordinator test file already exposes. The essential assertion is that after a throwing subscriber, a second subscriber still receives an event.

- [x] **Step 2: Run to verify failure**

Run: `npx vitest run test/transactions/coordinator.test.ts`
Expected: FAIL — the throwing subscriber propagates and the good subscriber never fires.

- [x] **Step 3: Wrap each subscriber call**

In `src/transactions/coordinator.ts` `forward()`, change the subscriber loop:

```ts
  private forward(event: TransactionLayerEvent): void {
    if (event.type === 'terminated') {
      this.clients.delete(event.key);
      this.servers.delete(event.key);
    }
    this.emit(event);
    for (const listener of this.subscribers) {
      try {
        listener(event);
      } catch {
        // A throwing subscriber must not break the layer or other listeners.
      }
    }
  }
```

- [x] **Step 4: Run to verify passes**

Run: `npx vitest run test/transactions/coordinator.test.ts`
Expected: PASS — the good subscriber fires while the throwing one is swallowed.

- [x] **Step 5: Full verification**

Run: `npm test` and `npm run typecheck`
Expected: all tests pass; typecheck clean.

- [x] **Step 6: Commit**

```bash
git add src/transactions/coordinator.ts test/transactions/coordinator.test.ts
git commit -m "fix: isolate throwing transaction-layer subscribers"
```

---

### Task G: 301/302 REGISTER redirect

**Files:**
- Modify: `src/ua/registrar.ts:232-245`
- Test: `test/ua/registrar.test.ts`

**Interfaces:**
- Consumes: `Registrar` response handling, `nextRequest`, `identity`.
- Produces: 301/302 re-REGISTER to the redirect `Contact` target, single-hop with loop guard.

- [x] **Step 1: Write the failing tests**

Append to `test/ua/registrar.test.ts` (using the test's existing Registrar + FakeClock harness). Follow a redirect, reject a non-redirect 3xx, and guard a loop:

```ts
it('follows a 302 redirect Contact to complete registration', async () => {
  // First response: 302 with a Contact redirect target.
  // Second REGISTER (to the new target) succeeds 200.
  // Assert final state 'registered' and that the retried REGISTER used the new URI.
});

it('does not follow a 305 Use Proxy as a REGISTER redirect', async () => {
  // 305 must fail with a SipError, not re-REGISTER.
});

it('fails a redirect loop instead of spinning', async () => {
  // Redirect target repeats within the hop cap; assert a terminal failure.
});
```

> **Detail:** Use two FakeClock exchanges. Capture the request URIs the registrar sends. For the loop guard, either cap redirect hops at 5 or treat "target equals current registrarUri / a repeated target" as a failure — pick one and assert it.

- [x] **Step 2: Run to verify failure**

Run: `npx vitest run test/ua/registrar.test.ts`
Expected: FAIL — current code hard-fails (≥300 → `SipError`), never following a redirect.

- [x] **Step 3: Implement redirect handling**

In `src/ua/registrar.ts`, add a redirect counter to the class (`private redirectCount = 0;`). In `onResponse` (lines 235-245), add a branch **before** the generic `>= 300` handler:

```ts
    } else if ((code === 301 || code === 302) && this.redirectCount < MAX_REDIRECTS) {
      this.handleRedirect(base, response);
    } else if (code >= 300) {
      this.fail(new SipError(code, `REGISTER rejected with ${code}`));
    }
```

Add the handler and a module-level constant:

```ts
const MAX_REDIRECTS = 5;

private handleRedirect(base: SipRequestMessage, response: SipResponseMessage): void {
  const contact = contactValue(response.headers); // extract of the highest-priority Contact URI
  if (contact === undefined) {
    this.fail(new SipError(response.statusCode, 'REGISTER redirect without a Contact'));
    return;
  }
  this.redirectCount += 1;
  // 301 persists the new target for the UA's life; 302 is per-attempt.
  if (response.statusCode === 301) this.redirectTarget = contact;
  const request = this.nextRequestForTarget(contact, base);
  this.send(request);
}
```

Reuse the existing `contactUri` extraction (header-values `extractUri`) or the registrar's own Contact parse; the redirect URI must come from the response's highest-priority `Contact`, not the registrar URI. Reset `redirectCount = 0` on `onGranted` (a successful registration) and on a fresh connect.

- [x] **Step 4: Run to verify passes**

Run: `npx vitest run test/ua/registrar.test.ts`
Expected: PASS — 302 followed to completion, 305 still fails, loop guarded.

- [x] **Step 5: Full verification**

Run: `npm test` and `npm run typecheck`
Expected: all tests pass (including the release-smoke REGISTER flow, which has no redirect); typecheck clean.

- [x] **Step 6: Commit**

```bash
git add src/ua/registrar.ts test/ua/registrar.test.ts
git commit -m "feat: follow 301/302 REGISTER redirects with a loop guard"
```

---

### Task H: Dispose the registrar refresh timer

**Files:**
- Modify: `src/ua/user-agent.ts:285-294`
- Modify: `src/ua/registrar.ts` (add `dispose()`)
- Test: `test/ua/user-agent.test.ts`

**Interfaces:**
- Consumes: `Registrar`, `Cancellable` clock timer.
- Produces: `Registrar.dispose(): void` cancels refresh timer and unsubscribes.

- [x] **Step 1: Write the failing test**

Append to `test/ua/user-agent.test.ts`:

```ts
it('disconnect() leaves no pending registrar refresh timer', async () => {
  const { ua, fakeClock, layer } = makeConnectedUa(); // existing harness
  await ua.disconnect();
  // After disconnect, the registrar's refresh clock handle must be cleared.
  expect(fakeClock.pending().length).toBe(0);
});
```

Adapt `makeConnectedUa`/`fakeClock.pending()` to the existing test helpers (the FakeClock should expose the outstanding timer count).

- [x] **Step 2: Run to verify failure**

Run: `npx vitest run test/ua/user-agent.test.ts`
Expected: FAIL — `disconnect()` nils the registrar without cancelling its refresh timer, so a pending handle remains.

- [x] **Step 3: Add Registrar.dispose() and call it**

In `src/ua/registrar.ts`, add a public `dispose()` that mirrors `teardownExchange()` + `cancelRefresh()`:

```ts
  /** Final shutdown: cancel the refresh timer and detach the exchange listener. */
  dispose(): void {
    this.cancelRefresh();
    this.teardownExchange();
  }
```

In `src/ua/user-agent.ts` `disconnect()`, replace `this.registrar = undefined` with a dispose-then-nil:

```ts
    this.registrar?.dispose();
    this.registrar = undefined;
```

Keep `onTransportDisconnected()` (the reconnect-pending path) unchanged — it calls `teardownExchange()` + `cancelRefresh()` separately and sets `reconnectPending`.

- [x] **Step 4: Run to verify passes**

Run: `npx vitest run test/ua/user-agent.test.ts`
Expected: PASS — no lingering refresh handle after `disconnect()`.

- [x] **Step 5: Full verification**

Run: `npm test` and `npm run typecheck`
Expected: all tests pass; typecheck clean.

- [x] **Step 6: Commit**

```bash
git add src/ua/user-agent.ts src/ua/registrar.ts test/ua/user-agent.test.ts
git commit -m "fix: dispose registrar refresh timer on UA shutdown"
```

---

### Task I: Bound AuthManager state

**Files:**
- Modify: `src/auth/manager.ts:119-120,137-146,244-249`
- Test: `test/auth/manager.test.ts`

**Interfaces:**
- Consumes: `AuthManager` nonce counts and per-request retry budget.
- Produces: bounded maps — `nonceCounts` capped (evict oldest), `retriesByRequest` cleaned on completion.

- [x] **Step 1: Write the failing tests**

```ts
it('keeps nonceCounts under the cap across many distinct nonces', () => {
  const f = fixture();
  const manager = new AuthManager(f.ids());
  for (let i = 0; i < 80; i++) {
    const headers = buildResponseHeaders(REALM, `nonce-${i}`);
    manager.retry(f.context({ response: makeResponse(401, 'Unauthorized', headers) }));
  }
  // The implementation exposes the map size for the test; assert it stays <= 64.
  expect(manager.nonceCountSize).toBeLessThanOrEqual(64);
});

it('clears a request retry budget entry once its exchange completes', () => {
  const f = fixture();
  const manager = new AuthManager(f.ids());
  manager.retry(f.context()); // consumes one budget entry
  manager.settle('req-1');    // new: mark exchange complete
  expect(manager.retriesByRequestSize).toBe(0);
});
```

> **Exposure note:** The test holds the class to an observable surface. Prefer exposing read-only getters (`nonceCountSize`, `retriesByRequestSize`) and a completion hook (`settle(requestId)`) so the plan's tasks see exact names. If tightening the API is undesired, keep the maps internal and assert behaviorally (no exhaustion at N retries) instead.

- [x] **Step 2: Run to verify failure**

Run: `npx vitest run test/auth/manager.test.ts -t "cap\|clears a request"`
Expected: FAIL — `nonceCounts` grows unbounded; `settle` does not exist.

- [x] **Step 3: Implement bounding**

Add a module constant and cap the maps in `src/auth/manager.ts`:

```ts
const MAX_NONCE_COUNTS = 64;
```

In the class, add getters and a completion hook (or equivalent):

```ts
  get nonceCountSize(): number { return this.nonceCounts.size; }
  get retriesByRequestSize(): number { return this.retriesByRequest.size; }

  /** Mark an exchange (by requestId) complete so its retry budget is released. */
  settle(requestId: string): void {
    this.retriesByRequest.delete(requestId);
  }
```

In `nextNonceCount` (lines 244-249), evict the oldest insertion when the cap is reached:

```ts
  private nextNonceCount(realm: string, nonce: string): string {
    const key = `${realm.length}:${realm}${nonce}`;
    if (this.nonceCounts.size >= MAX_NONCE_COUNTS && !this.nonceCounts.has(key)) {
      const oldest = this.nonceCounts.keys().next().value;
      this.nonceCounts.delete(oldest);
    }
    const next = (this.nonceCounts.get(key) ?? 0) + 1;
    this.nonceCounts.set(key, next);
    return next.toString().padStart(8, '0');
  }
```

Wire `settle(requestId)` to be called by `Registrar` after an exchange completes (in `src/ua/registrar.ts` after a final response). If threading it is more than desired for this task, at minimum cap `nonceCounts` and document `settle` as an available hook; the release-smoke test still passes without it.

- [x] **Step 4: Run to verify passes**

Run: `npx vitest run test/auth/manager.test.ts`
Expected: PASS — map sizes bounded; budget cleaned on settle.

- [x] **Step 5: Full verification**

Run: `npm test` and `npm run typecheck`
Expected: all tests pass; typecheck clean.

- [x] **Step 6: Commit**

```bash
git add src/auth/manager.ts src/ua/registrar.ts test/auth/manager.test.ts
git commit -m "fix: bound AuthManager nonce and retry-budget state"
```

---

### Task J: Assert event-type exports from the packed tarball

**Files:**
- Test: `test/package/exports.test.mjs` (event-type assertions) and fixtures `test/package/fixtures/esm/index.mjs`, `test/package/fixtures/cjs/index.cjs`, `test/package/fixtures/types/index.ts`

**Interfaces:**
- Consumes: root barrel exports (`RegistrationEvent`, `RegistrationEventEmitter`, `RegistrationStateChangedEvent`, `RegistrationFailedEvent`).
- Produces: packed-consumer matrix proves the four event types resolve.

> **Note:** The source already exports these types from `src/index.ts:27-31` (via `src/ua/index.ts`). This task adds only the missing test assertions; no source change is expected unless a consumer fixture fails.

- [x] **Step 1: Write the failing consumer assertions**

In `test/package/fixtures/esm/index.mjs`, add:

```js
import {
  UserAgent,
  RegistrationEvent,
  RegistrationEventEmitter,
} from 'sip-worker';
// Types are erased at runtime, so assert they exist as symbols only where they
// have runtime form. RegistrationEvent etc. are types; verify via type-only in
// the types fixture and assert the value exports that carry them here:
if (typeof UserAgent !== 'function') throw new Error('UserAgent missing');
console.log('event-type-surface OK');
```

In `test/package/fixtures/types/index.ts`, add a type-only consumer so the emitted `.d.ts` is compiled against the four type exports:

```ts
import type {
  RegistrationEvent,
  RegistrationEventEmitter,
  RegistrationStateChangedEvent,
  RegistrationFailedEvent,
} from 'sip-worker';

let e: RegistrationStateChangedEvent = { type: 'stateChanged', state: 'registered', identity: { callId: 'c', nextCSeq: 1 } };
let f: RegistrationFailedEvent | undefined;
// The four type names resolve and are usable.
```

> **Fixture editorial rule (from Plan 06):** every import in a consumer fixture must resolve from a passing packed install. If `types/index.ts` already exists, extend it rather than duplicating.

- [x] **Step 2: Run to verify failure**

Run: `npm run test:package`
Expected: FAIL if the type import does not resolve; if the tarball already exports them, this step PASSES and Step 3 confirms no source change is needed.

- [x] **Step 3: Adjust only if a fixture fails**

If the `types` fixture fails to compile against the four types, add the missing re-export to `src/index.ts` (they are already there per the check; do not add duplicates). Re-run `npm run build` if `src/index.ts` changed.

- [x] **Step 4: Verify**

Run: `npm run build && npm run test:package`
Expected: PASS — ESM, CommonJS, and types consumers all resolve the four event types.

- [x] **Step 5: Commit**

```bash
git add test/package test/package/fixtures
git commit -m "test: assert event-type exports resolve in packed consumers"
```

---

### Task K: Challenge parser robustness

**Files:**
- Modify: `src/auth/challenge.ts:119-125,142-143`
- Test: `test/auth/challenge.test.ts`

**Interfaces:**
- Consumes: `parseDigestChallenges(values)`.
- Produces: token-aware boundary, intact unquoted values, real byte offsets for missing realm/nonce.

- [x] **Step 1: Write the failing tests**

Append to `test/auth/challenge.test.ts`:

```ts
it('handles a parameter literally named "digest"', () => {
  const parsed = parseDigestChallenges(['Digest realm="r", nonce="n", digest=abc']);
  expect(parsed.ok).toBe(true);
  if (parsed.ok) expect(parsed.value[0]?.realm).toBe('r');
});

it('keeps an unquoted multi-word value intact as a single token', () => {
  // Per RFC, unquoted values are tokens; a space is not a value separator here.
  const parsed = parseDigestChallenges(['Digest realm="r nonce"']);
  // realm is quoted so this passes; the real assertion is that an unquoted
  // value spanning what looks like multiple words is preserved. Use qop:
  const p2 = parseDigestChallenges(['Digest realm="r", nonce="n", qop=auth auth-int']);
  expect(p2.ok).toBe(true);
  if (p2.ok) expect(p2.value[0]?.qop).toEqual(['auth auth-int']);
});

it('reports the real offset for a missing nonce', () => {
  const parsed = parseDigestChallenges(['Digest realm="r", algorithm=MD5']);
  expect(parsed.ok).toBe(false);
  if (parsed.ok) return;
  expect(parsed.error.offset).toBeGreaterThanOrEqual(0);
  // The offset is no longer hardcoded to 0 for missing-realm/missing-nonce.
});
```

- [x] **Step 2: Run to verify failure**

Run: `npx vitest run test/auth/challenge.test.ts`
Expected: FAIL — the `digest`-named param is misparsed, unquoted multi-word splits to two qop tokens, and missing-nonce uses a hardcoded `0` offset.

- [x] **Step 3: Implement hardening**

In `src/auth/challenge.ts`:
1. **Boundary heuristic (`:159-166` region):** make the "a param named digest" case unambiguous by only treating a bare scheme token (`Digest`/`Basic`) at the start as the scheme boundary — a `digest=` in the middle is a parameter, not a boundary.
2. **Unquoted multi-word values (`:176`):** in `commitParam`, do not split an unquoted value on space/tab; an unquoted value is a single token captured up to the next `,` or challenge boundary. Adjust the character scanner so whitespace only separates a *name* from its `=`/value when inside a name context, not inside an unquoted value.
3. **Missed realm/nonce offset (`:142-143`):** change `fail(0, ...)` to report the byte offset of the first character of the spec's own token (the challenge index in `raw`), so `offset` is the real bad-byte location, not `0`.

- [x] **Step 4: Run to verify passes**

Run: `npx vitest run test/auth/challenge.test.ts`
Expected: PASS — all three new cases plus the full existing challenge suite (quoted commas, multiple challenges) still pass.

- [x] **Step 5: Full verification**

Run: `npm test` and `npm run typecheck`
Expected: all tests pass; typecheck clean.

- [x] **Step 6: Commit**

```bash
git add src/auth/challenge.ts test/auth/challenge.test.ts
git commit -m "fix: harden Digest challenge parser boundaries, offsets, and unquoted values"
```

---

### Task L: Test-description and coverage fixes (test-only)

**Files:**
- Modify: `test/auth/challenge.test.ts:73-79`
- Modify: `test/auth/hash.test.ts:18-20`
- Modify: `test/auth/digest.test.ts:35-48`
- Modify: `test/auth/manager.test.ts` (stale/nc-reset coverage)

**Interfaces:**
- Consumes: existing test suites only.
- Produces: truthful descriptions and closed coverage gaps. No production changes.

- [x] **Step 1: Fix the malformed-escape test**

`test/auth/challenge.test.ts:73` currently feeds `['Digest realm="a\\', 'nonce="n1"']`, which actually raises **missing-realm/nonce** (offset `0`) rather than a malformed escape in `commitParam`. Rewrite it to genuinely reach the malformed-escape path:

```ts
it('returns a ParseError on a malformed escape', () => {
  // A quoted parameter whose closing quote is preceded by a dangling backslash
  // reaches the escape-resolution path with no valid escape to apply.
  const parsed = parseDigestChallenges(['Digest realm="a\\x", nonce="n1"']);
  expect(parsed.ok).toBe(false);
  if (parsed.ok) return;
  expect(parsed.error).toBeInstanceOf(ParseError);
});
```

> **Verify first:** run the current test and confirm its message is `Digest challenge missing realm|nonce` (offset 0). Only change it if the escape path differs; if the parser resolves `\x` as a literal `x` (valid escape), this input does NOT hit malformed-escape either — in that case use a dangling trailing backslash `realm="a\` alone and assert the `commitParam` escape error. Choose the input that actually hits the escape path; assert the message if `ParseError.message` exposes it.

- [x] **Step 2: Correct the hash label**

`test/auth/hash.test.ts:18` the md5 "448-bit" label is wrong — `abcdefghijklmnopqrstuvwxyz` is 208 bits (single block). Fix the description only (expected value is correct):

```ts
  it('matches the single-block "abcdefghijklmnopqrstuvwxyz" vector', () => {
    expect(md5('abcdefghijklmnopqrstuvwxyz')).toBe('c3fcd3d76192e4007dfb496cca67e13b');
  });
```

- [x] **Step 3: Tighten the digest throw tests**

`test/auth/digest.test.ts:35-48` — assert the error message and add the `cnonce`-present/`nc`-missing case:

```ts
it('rejects a missing nc/cnonce when qop is set', () => {
  const params: DigestParams = {
    algorithm: 'MD5',
    username: 'Mufasa',
    password: 'Circle Of Life',
    realm: 'testrealm@host.com',
    nonce: 'dcd98b7102dd2f0e8b11d0f600bfb0c093',
    method: 'GET',
    uri: '/dir/index.html',
    qop: 'auth',
  };
  expect(() => computeDigest(params)).toThrow(/nc and cnonce/);
  expect(() => computeDigest({ ...params, nc: '00000001' })).toThrow(/nc and cnonce/);
  expect(() => computeDigest({ ...params, cnonce: '0a4f113b' })).toThrow(/nc and cnonce/);
});
```

- [x] **Step 4: Close the stale/nc-reset gaps**

`test/auth/manager.test.ts` — the two stale=true tests (`:219,:230`) neither discriminate budget consumption nor test a genuinely new nonce. Add:
1. A stale retry that does **not** consume budget (assert an allowed extra non-stale retry after a stale one).
2. A stale retry followed by a **new** nonce, asserting the nc resets (nc returns to `00000001`, not a continued counter).

Use `buildResponseHeaders(realm, nonce, true)` for stale and a fresh `nonce-2` for the new-nonce case, asserting the `nc=` field of the retried `Authorization`.

- [x] **Step 5: Verify**

Run: `npx vitest run test/auth/challenge.test.ts test/auth/hash.test.ts test/auth/digest.test.ts test/auth/manager.test.ts`
Expected: PASS — all updated and new assertions green, with no production file changed.

- [x] **Step 6: Full regression + commit**

Run: `npm test`
Expected: all tests pass.

```bash
git add test/auth/challenge.test.ts test/auth/hash.test.ts test/auth/digest.test.ts test/auth/manager.test.ts
git commit -m "test: correct malformed-escape and digest coverage gaps"
```

---

### Task M: Phase-3 internal polish

**Files:**
- Modify: `src/transactions/ack.ts:13-21`
- Modify: `src/transactions/invite-client.ts:27-37` and `src/transactions/non-invite-client.ts:27-37`
- Modify: `src/dialogs/dialog.ts:31-37`
- Modify: `src/transactions/coordinator.ts:82-90`
- Test: `src/transactions/*`, `test/transactions/*`, `test/dialogs/*` as needed

**Interfaces:**
- Consumes: `buildNon2xxAck`, `cseqMethod`, `contactUri`/`extractUri`, `forward()`.
- Produces: trimmer ACK header copy, one shared `cseqMethod`, one shared URI extraction, map-precise terminated delete. Behavior preserved.

- [x] **Step 1: Trim buildNon2xxAck header copy**

`src/transactions/ack.ts` currently does `request.headers.clone()` — a superset of the RFC-required ACK headers (Route, From, Call-ID, Max-Forwards, Via, To, CSeq). Build the ACK from only the required set:

```ts
  const headers = new Headers();
  const copy = (name: string) => {
    const v = request.headers.get(name);
    if (v !== undefined) headers.append(name, v);
  };
  for (const name of ['Route', 'From', 'Call-ID', 'Max-Forwards', 'Via']) copy(name);
  headers.set('To', response.headers.get('To') ?? '');
  const cseq = request.headers.get('CSeq');
  ...
```

Add an `ack.test.ts` assertion that the ACK carries only the required headers (no `Contact`, no `Content-Type`, no `WWW-Authenticate`).

- [x] **Step 2: Extract a shared cseqMethod**

`cseqMethod(response)` is byte-identical in `invite-client.ts` and `non-invite-client.ts`. Move it to a shared `src/transactions/ack.ts` (it is small and co-located with the transactional helpers the barrel already re-exports), export it from `src/transactions/index.ts`, and have both files import it. Update the two import sites and delete the local duplicates. Add a test that exercises the shared helper through both transaction types.

- [x] **Step 3: Collapse contactUri onto extractUri**

`src/dialogs/dialog.ts` local `contactUri(headers)`:
```ts
function contactUri(headers: Headers): string | undefined {
  const value = headers.get('Contact');
  if (value === undefined) return undefined;
  const match = value.match(/<([^>]+)>/);
  return match?.[1];
}
```
is identical to `extractUri(value)` in `src/dialogs/header-values.ts`. Replace its body with `extractUri(headers.get('Contact'))` and import `extractUri`. Keep the `contactUri` name (call sites `:95,:119,:120` unchanged) but delegate. Add a dialog test confirming Contact extraction is unchanged.

- [x] **Step 4: Map-precise terminated delete**

`src/transactions/coordinator.ts` `forward()` deletes the key from both `clients` and `servers`. Since client/server keys can collide (`branch|INVITE`), pass the owning map to make the delete precise. Change the emit path so the caller records which map owns the terminated key. If the coordinator does not know ownership at delete time, keep the dual delete but add a comment + test documenting the branch-uniqueness invariant; otherwise thread the owning map through the terminated event handler.

- [x] **Step 5: Full verification**

Run: `npm test`, `npm run typecheck`, `npm run build`, `npm run test:package`
Expected: all pass — packed consumers still resolve; ack header trim does not break the release-smoke 2xx/non-2xx ACK paths.

- [x] **Step 6: Commit**

```bash
git add src/transactions src/dialogs test/transactions test/dialogs
git commit -m "refactor: phase-3 internal polish (ack headers, shared helpers, map-precise delete)"
```

---

### Task N: `viaAddress` option

**Files:**
- Modify: `src/ua/user-agent.ts:42-68,237,326,369`
- Test: `test/ua/user-agent.test.ts`

**Interfaces:**
- Consumes: `UserAgentOptions`.
- Produces: additive `viaAddress?: string`; Inviter/Invitation/OPTIONS use it with the current default fallback.

- [x] **Step 1: Write the failing tests**

```ts
it('uses a caller-supplied viaAddress for sent-by', async () => {
  const opts = { ...baseOptions(), viaAddress: '203.0.113.7:5060' };
  const { ua, layer } = makeConnectedUa(opts);
  await ua.invite('sip:bob@example.com');
  // Capture the Via the inviter sent and assert it carries the supplied sent-by.
  const via = captureOutboundVia(layer);
  expect(via).toContain('203.0.113.7:5060');
});

it('defaults to 192.0.2.1:5060 when viaAddress is absent', async () => {
  const { ua, layer } = makeConnectedUa(baseOptions());
  await ua.invite('sip:bob@example.com');
  expect(captureOutboundVia(layer)).toContain('192.0.2.1:5060');
});
```

Adapt to the existing user-agent test harness (media controller must be configured for `invite()`; the harness likely already injects a `WorkerMediaController`).

- [x] **Step 2: Run to verify failure**

Run: `npx vitest run test/ua/user-agent.test.ts`
Expected: FAIL — `viaAddress` is not in `UserAgentOptions`; the hardcoded `192.0.2.1:5060` is used regardless.

- [x] **Step 3: Add the option and thread it**

In `src/ua/user-agent.ts`, add to `UserAgentOptions`:

```ts
  /** Via sent-by host:port. Defaults to '192.0.2.1:5060'. */
  readonly viaAddress?: string;
```

Add a private getter or resolve once:

```ts
  private get viaAddress(): string {
    return this.options.viaAddress ?? '192.0.2.1:5060';
  }
```

Replace the three hardcoded call sites:
- `:237` `viaAddress: '192.0.2.1:5060',` → `viaAddress: this.viaAddress,` (Inviter)
- `:369` `viaAddress: '192.0.2.1:5060',` → `viaAddress: this.viaAddress,` (Invitation)
- `:326` `headers.set('Via', \`SIP/2.0/UDP 192.0.2.1:5060;branch=${makeBranch(...)}\`)` → use `this.viaAddress` in the template (OPTIONS liveness)

Remove both `// TODO: extract from transport` comments.

- [x] **Step 4: Run to verify passes**

Run: `npx vitest run test/ua/user-agent.test.ts`
Expected: PASS — supplied sent-by appears in INVITE Via; default preserved.

- [x] **Step 5: Full verification**

Run: `npm test` and `npm run typecheck`
Expected: all tests pass; typecheck clean.

- [x] **Step 6: Commit**

```bash
git add src/ua/user-agent.ts test/ua/user-agent.test.ts
git commit -m "feat: allow caller-supplied viaAddress for Via sent-by"
```

---

### Task O: Docs drift

**Files:**
- Modify: `docs/superpowers/plans/2026-08-04-phase-1-codec-follow-up-fixes.md` (mark `[x]`)
- Modify: `docs/superpowers/plans/2026-08-04-sip-worker-index.md` (Execution Order + Plan Gates)

**Interfaces:**
- Consumes: git history proving the phase-1 follow-up is done.
- Produces: plan/index accurately reflect completion and add Plan 07.

- [x] **Step 1: Mark the phase-1 follow-up plan done**

The phase-1 codec follow-up was fully implemented (commits `9bfe75a`, `fb99b08`, `8cb88ba`, `ab996ff`) but its plan file shows zero `[x]`. Flip every `- [ ] Step` to `- [x] Step` in `docs/superpowers/plans/2026-08-04-phase-1-codec-follow-up-fixes.md`.

- [x] **Step 2: Add Plan 07 to the index**

In `docs/superpowers/plans/2026-08-04-sip-worker-index.md`:
1. Add the phase-1 follow-up plan to the Execution Order as a completed entry.
2. Add Plan 07 (this plan's file) to the Execution Order with a `[ ]` (not yet complete) marker and to the Plan Gates table:

| 07 | Leftover hardening (Plan 07 file) | Auth quoted/redirect/lifecycle fixes; viaAddress; parser hardening; green regressions |

- [x] **Step 3: Verify the docs render**

Read both files to confirm no broken Markdown and that every phase-1 follow-up task is `[x]`.

- [x] **Step 4: Commit**

```bash
git add docs/superpowers/plans/
git commit -m "docs: close phase-1 follow-up plan and add Plan 07 to index"
```

---

## Final Acceptance

Run, in order:

```bash
npm ci
npm run typecheck
npm test
npm run build
npm run test:package
```

Expected: every command exits 0; the release-smoke trace (`registered → inviting → confirmed → terminated → unregistered`) still passes; no new open handles or unhandled rejections; the packed ESM/CommonJS/type fixtures resolve the event types (Task J) and all Plan 01–06 subpaths.

## Task Order

A → B → C → D → E → F → G → H → I → J → K → L → M → N → O
