# Call Lifecycle and Authentication Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ensure calls and authentication settle safely and correctly under real protocol outcomes.

**Architecture:** Sessions own one operation subscription and explicit disposal; the UA routes each in-dialog request to a dialog-indexed session. One UA-owned AuthManager tracks a stable logical exchange ID.

**Tech Stack:** TypeScript strict ESM, Vitest, FakeClock.

## Global Constraints

- Every pending public promise resolves or rejects exactly once.
- Validate Call-ID, From tag, To tag, method, and CSeq before mutating call state.
- Never reuse Authorization across a changed request URI.

---

### Task 1: Session request routing and invitation state

**Files:** Modify `src/ua/user-agent.ts`, `src/ua/inviter.ts`, `src/ua/invitation.ts`, `src/dialogs/dialog.ts`; Test `test/ua/inviter.test.ts`, `test/ua/invitation.test.ts`, `test/integration/call.test.ts`.

- [ ] Add failing tests for remote BYE, wrong-tag BYE, duplicate answer/reject, CANCEL, and duplicate accepted INVITE.
- [ ] Add dialog-indexed routing, respond 200 to valid BYE/CANCEL, reject invalid in-dialog requests, and make invitation terminal methods atomic.
- [ ] Run `npm test -- --run test/ua test/integration/call.test.ts`; expect all focused tests pass.
- [ ] Commit `fix: enforce dialog lifecycle ownership`.

### Task 2: Teardown and operation ownership

**Files:** Modify `src/ua/user-agent.ts`, `src/ua/registrar.ts`, `src/ua/inviter.ts`, `src/ua/invitation.ts`; Test `test/ua/user-agent.test.ts`.

- [ ] Add failing tests that disconnect during register, invite, answer, and hangup.
- [ ] Add idempotent `dispose(error)` paths that detach listeners, stop timers/retransmitters, reject deferreds, and clear active maps.
- [ ] Run `npm test -- --run test/ua`; expect all focused tests pass.
- [ ] Commit `fix: settle SIP operations on shutdown`.

### Task 3: Digest exchange correctness

**Files:** Modify `src/ua/user-agent.ts`, `src/ua/registrar.ts`, `src/ua/inviter.ts`, `src/auth/manager.ts`; Test auth and UA suites.

- [ ] Add failing tests for credentials-only INVITE auth, fourth challenge rejection, auth→423, and auth→redirect.
- [ ] Store one UA AuthManager, use stable exchange IDs, settle every terminal exchange, and recompute Digest after URI/nonce changes.
- [ ] Run `npm test -- --run test/auth test/ua`; expect all focused tests pass.
- [ ] Commit `fix: bound and regenerate SIP Digest retries`.

