# Authentication and Registration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Register and unregister against a Digest-authenticated registrar with correct retries, expiry refresh, 423 handling, reconnect behavior, and promise outcomes.

**Architecture:** Pure hash/challenge modules feed an `AuthManager` that returns a new request without mutating or losing the original. `Registrar` owns registration identity/CSeq/timers; `UserAgent` wires transport → ingress → transaction coordinator before sending anything.

**Tech Stack:** TypeScript, Vitest, RFC 7616/8760 Digest, pure bundled MD5/SHA-256, virtual clock.

## Global Constraints

- Requires Plans 01–03 green.
- Prefer SHA-256; accept MD5 only for legacy interoperability; support `qop=auth`.
- Parse a complete Digest challenge; commas inside quoted values do not split challenges.
- Retries replace Via/CSeq/auth fields, preserve body bytes, and use a new client transaction.
- INVITE challenges are ACKed by Plan 03 before retry; REGISTER challenges need no ACK.
- Registration Call-ID is stable and CSeq strictly increases across initial, authenticated, 423, refresh, unregister, and reconnect requests.
- Public promises settle only on final protocol outcomes.

---

### Task 1: Pure MD5, SHA-256, and Digest response computation

**Files:**
- Create: `src/auth/md5.ts`
- Create: `src/auth/sha256.ts`
- Create: `src/auth/digest.ts`
- Create: `test/auth/hash.test.ts`
- Create: `test/auth/digest.test.ts`

**Interfaces:**
- Consumes: UTF-8 strings.
- Produces: `md5(input): string`, `sha256(input): string`, and `computeDigest(params): string`.

- [ ] **Step 1: Write failing standard-vector tests**

```ts
expect(md5('')).toBe('d41d8cd98f00b204e9800998ecf8427e');
expect(md5('abc')).toBe('900150983cd24fb0d6963f7d28e17f72');
expect(sha256('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
expect(computeDigest({
  algorithm: 'MD5', username: 'Mufasa', password: 'Circle Of Life',
  realm: 'testrealm@host.com', nonce: 'dcd98b7102dd2f0e8b11d0f600bfb0c093',
  method: 'GET', uri: '/dir/index.html', qop: 'auth',
  nc: '00000001', cnonce: '0a4f113b',
})).toBe('6629fae49393a05397450978507c4ef1');
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/auth/hash.test.ts test/auth/digest.test.ts`

Expected: FAIL because hash modules are absent.

- [ ] **Step 3: Implement byte-correct hash primitives and formula**

Implement FIPS 180-4 SHA-256 and RFC 1321 MD5 over `TextEncoder` UTF-8 bytes, including message padding, little-endian MD5 words, big-endian SHA words, unsigned 32-bit rotations/addition, and lowercase fixed-width hex. `computeDigest` calculates HA1=`H(username:realm:password)`, HA2=`H(method:uri)`, then `H(HA1:nonce:nc:cnonce:qop:HA2)` for qop auth or `H(HA1:nonce:HA2)` without qop. Reject missing nc/cnonce when qop is present.

- [ ] **Step 4: Verify**

Run: `npx vitest run test/auth/hash.test.ts test/auth/digest.test.ts && npm run typecheck && npm test`

Expected: PASS for MD5 and SHA-256 vectors.

- [ ] **Step 5: Commit**

```bash
git add src/auth test/auth
git commit -m "feat: add dependency-free Digest hash primitives"
```

### Task 2: Digest challenge grammar and Authorization rendering

**Files:**
- Create: `src/auth/challenge.ts`
- Create: `src/auth/authorization.ts`
- Create: `test/auth/challenge.test.ts`
- Create: `test/auth/authorization.test.ts`

**Interfaces:**
- Consumes: raw `WWW-Authenticate`/`Proxy-Authenticate` field values.
- Produces: `parseDigestChallenges(values): ParseResult<DigestChallenge[]>`, `selectChallenge`, and `renderAuthorization`.

- [ ] **Step 1: Write failing quoted-comma/multiple-challenge tests**

```ts
const parsed = parseDigestChallenges([
  'Digest realm="a,b", nonce="n1", algorithm=MD5, qop="auth,auth-int"',
  'Digest realm="a,b", nonce="n2", algorithm=SHA-256, qop="auth"',
]);
expect(parsed.ok && selectChallenge(parsed.value)?.nonce).toBe('n2');
```

Also assert 407 selects `Proxy-Authorization`; unsupported algorithms are ignored; missing realm/nonce and malformed escapes return `ParseError`; rendering quotes username/realm/nonce/uri/response/cnonce/opaque but not algorithm/qop/nc.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/auth/challenge.test.ts test/auth/authorization.test.ts`

Expected: FAIL because grammar/rendering modules are absent.

- [ ] **Step 3: Implement a character scanner, not comma splitting**

Scan scheme tokens and auth parameters while tracking quoted-string/escape state. A comma starts a new challenge only when followed by a scheme token and whitespace; otherwise it separates parameters or remains inside quotes. Normalize algorithm case, split qop only after unquoting, retain opaque/stale/domain, and prefer SHA-256 over MD5 with qop auth.

- [ ] **Step 4: Verify**

Run: `npx vitest run test/auth/challenge.test.ts test/auth/authorization.test.ts && npm run typecheck && npm test`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/auth test/auth
git commit -m "feat: parse and render SIP Digest authentication"
```

### Task 3: Immutable authentication retry manager

**Files:**
- Create: `src/auth/manager.ts`
- Create: `src/auth/index.ts`
- Create: `test/auth/manager.test.ts`

**Interfaces:**
- Consumes: original request, 401/407 response, credentials, injected ID generator.
- Produces: `AuthManager.retry(context): SipRequestMessage | AuthFailure`, per-nonce counts, and `redact(message)`.

- [ ] **Step 1: Write failing preservation/replacement/redaction tests**

Assert retry keeps byte-identical SDP, Call-ID, From, To, Contact, Route, and request URI; increments numeric CSeq once; leaves one Via with a new branch; leaves one appropriate auth header; removes the opposite auth header; uses nonce counts 00000001/00000002; permits `stale=true` with a new nonce without consuming the ordinary retry budget; and redaction contains no original credential bytes in any header entry.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/auth/manager.test.ts`

Expected: FAIL because `AuthManager` is absent.

- [ ] **Step 3: Implement request-scoped retry state**

```ts
export interface AuthContext {
  readonly requestId: string;
  readonly request: SipRequestMessage;
  readonly response: SipResponseMessage;
  readonly credentials: { username: string; password: string };
}
export type AuthFailure = { readonly type: 'unsupported' | 'exhausted' | 'malformed'; readonly error: SipError };
```

Clone headers/body; use replacing `set` for CSeq/Via/Authorization; use `delete` for stale auth fields; preserve the original body object by copying its bytes; key ordinary retries by requestId and nonce counts by realm+nonce; generate cnonce/branch through injected IDs; default maximum ordinary retries to three.

- [ ] **Step 4: Verify**

Run: `npx vitest run test/auth/manager.test.ts && npm run typecheck && npm test`

Expected: PASS, including a log serialization assertion that cannot find the secret response value.

- [ ] **Step 5: Commit**

```bash
git add src/auth test/auth
git commit -m "feat: orchestrate immutable Digest retries"
```

### Task 4: Registrar request/state machine

**Files:**
- Create: `src/ua/registrar.ts`
- Create: `src/ua/registration-types.ts`
- Create: `test/ua/registrar.test.ts`

**Interfaces:**
- Consumes: `TransactionLayer`, `AuthManager`, `Clock`, URI/credentials/IDs.
- Produces: `Registrar.register`, `unregister`, `onTransportConnected`, `onTransportDisconnected`, state events, and persisted `RegistrationIdentity`.

- [ ] **Step 1: Write failing virtual registration scenarios**

Test: unauthenticated 200; 401→authenticated 200; 407 header choice; 423→Min-Expires retry; shorter granted expiry accepted without immediate retry; matching Contact expires precedence over response Expires; refresh at configured 0.5 fraction; unregister Contact `*`/Expires 0 semantics; reconnect re-register; repeated cycles leave one timer/listener; stable Call-ID and CSeq sequence `[1,2,3,...]`.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/ua/registrar.test.ts`

Expected: FAIL because Registrar is absent.

- [ ] **Step 3: Implement promise/state ownership**

```ts
export interface RegistrationIdentity { readonly callId: string; nextCSeq: number; }
export type RegisterState = 'unregistered' | 'registering' | 'registered' | 'unregistering' | 'failed';
```

Each outbound attempt obtains and increments `nextCSeq`, builds all mandatory REGISTER headers, and installs one transaction-event listener. `register()` holds a deferred promise across 401/407/423 retries and resolves only after 2xx expiry parsing. Nonrecoverable final responses reject `SipError`. Refresh/reconnect reuse the identity. `unregister()` cancels refresh first and resolves only on 2xx.

- [ ] **Step 4: Verify**

Run: `npx vitest run test/ua/registrar.test.ts && npm run typecheck && npm test`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ua/registrar.ts src/ua/registration-types.ts test/ua/registrar.test.ts
git commit -m "feat: add authenticated registrar lifecycle"
```

### Task 5: UserAgent wiring and mock-registrar integration

**Files:**
- Create: `src/ua/user-agent.ts`
- Create: `src/ua/events.ts`
- Create: `src/ua/index.ts`
- Create: `test/support/mock-registrar.ts`
- Create: `test/integration/registration.test.ts`
- Modify: `src/index.ts`

**Interfaces:**
- Consumes: Transport, SipIngress, TransactionCoordinator, Registrar.
- Produces: `UserAgent.connect/register/unregister/disconnect`, typed registration events, and recovery-exportable registration identity.

- [ ] **Step 1: Write failing synchronous-response integration test**

```ts
await ua.connect();
const registration = ua.register();
expect(ua.registerState).toBe('registering');
await registration;
expect(ua.registerState).toBe('registered');
expect(server.requests.map((r) => r.headers.has('Authorization'))).toEqual([false, true]);
```

The mock registrar delivers its response synchronously from `transport.send` to prove branch tracking and ingress are installed first. Add 423, refresh, unregister, reconnect, timeout, and disconnect-cleanup cases.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/integration/registration.test.ts`

Expected: FAIL because UserAgent wiring is absent.

- [ ] **Step 3: Implement construction/destruction order**

`connect()` connects transport, creates coordinator, starts ingress, then enables registrar operations. Incoming transport disconnect stops ingress, cancels refresh, and marks reconnect pending. `disconnect()` unregisters listeners/timers exactly once. Forward Registrar state into a typed overload-based event emitter; expose a readonly snapshot of Call-ID/next CSeq for Plan 06 recovery.

- [ ] **Step 4: Run the plan gate**

Run: `npm run typecheck && npm test && npm run build && npm run test:package`

Expected: PASS; authenticated registration integration completes without real-time sleeps.

- [ ] **Step 5: Commit**

```bash
git add src/ua src/index.ts test/support/mock-registrar.ts test/integration/registration.test.ts
git commit -m "feat: wire UserAgent authenticated registration"
```
