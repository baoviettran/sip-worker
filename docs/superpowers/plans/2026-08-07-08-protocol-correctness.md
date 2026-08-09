# Protocol Correctness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Correct transaction ownership, matching, retransmission, routing, and timer behavior.

**Architecture:** The transaction layer owns operation identity and immutable wire snapshots. Dialog construction receives routing context but stays transport-independent.

**Tech Stack:** TypeScript strict ESM, Vitest, injected FakeClock.

## Global Constraints

- Preserve every existing public export unless replaced by an additive API.
- Write and witness a focused failing Vitest test before each production change.
- Use no real-time waits; use `FakeClock`.

---

### Task 1: Transaction identity and validation

**Files:** Modify `src/transactions/coordinator.ts`; Test `test/transactions/coordinator.test.ts`.

- [ ] Add failing tests for simultaneous REGISTER/OPTIONS CSeq collisions, branchless requests, Via sent-by collision, and CSeq method mismatch.
- [ ] Change `clientKey`/`serverKey` to include normalized top-Via sent-by and validate CSeq numeric method equals request method before map insertion.
- [ ] Route subscriber handling by returned transaction key.
- [ ] Run `npm test -- --run test/transactions/coordinator.test.ts`; expect all focused tests pass.
- [ ] Commit `fix: isolate SIP transaction ownership`.

### Task 2: Immutable client retransmissions and configured timers

**Files:** Modify `src/transactions/invite-client.ts`, `src/transactions/non-invite-client.ts`, `src/transactions/timers.ts`; Test corresponding transaction suites.

- [ ] Add failing mutation-after-start header/body tests and non-default T1/T4 timer tests.
- [ ] Snapshot request headers/body and cache serialized first-send bytes; derive I/J/K from T4/64*T1.
- [ ] Run `npm test -- --run test/transactions`; expect all transaction tests pass.
- [ ] Commit `fix: cache retransmits and honor timer configuration`.

### Task 3: Dialog route correctness

**Files:** Modify `src/dialogs/dialog.ts`, `src/dialogs/header-values.ts`; Test `test/dialogs/dialog.test.ts`.

- [ ] Replace inverted loose/strict expectations with RFC 3261 §12.2.1.1 cases including repeated Route fields and bare Contact URI.
- [ ] Implement loose route as remote target plus full Route set; implement strict route as first route plus remaining routes and remote target.
- [ ] Run `npm test -- --run test/dialogs`; expect all dialog tests pass.
- [ ] Commit `fix: route in-dialog SIP requests per RFC 3261`.

