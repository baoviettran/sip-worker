# Worker and Media Reliability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Provide truthful worker recovery and bounded media operations.

**Architecture:** Protocol messages carry monotonic identity checkpoints and explicit failure outcomes. Supervisor lifecycle has one terminal close path; media requests carry a timeout and session teardown command.

**Tech Stack:** TypeScript strict ESM, Vitest, FakeClock, structured-clone ports.

## Global Constraints

- Validate every message generation and never lower persisted CSeq.
- Sanitize error message, stack, cause, and non-Error values before surfacing.

---

### Task 1: Supervisor lifecycle and recovery protocol

**Files:** Modify `src/bridge/worker-protocol.ts`, `src/bridge/worker-runtime.ts`, `src/bridge/worker-supervisor.ts`; Test `test/bridge/worker-supervisor.test.ts`, `test/integration/worker-recovery.test.ts`.

- [ ] Add failing tests for start-before-register, registration failure, death after send, concurrent waiters, stop/start, observer throw, and stale generations.
- [ ] Add `registrationFailed`, pre-send identity checkpoints, `close()`, waiter collection, guarded port/listener transitions, and bounded restart policy.
- [ ] Run `npm test -- --run test/bridge test/integration/worker-recovery.test.ts`; expect all focused tests pass.
- [ ] Commit `fix: make worker recovery sequence-safe and observable`.

### Task 2: Bounded media lifecycle

**Files:** Modify `src/media/protocol.ts`, `src/media/worker-controller.ts`, `src/media/stub-main-handler.ts`, `src/ua/*`; Test `test/media/bridge.test.ts` and call integration tests.

- [ ] Add failing tests for missing reply deadline, controller close during offer, and session close after BYE.
- [ ] Add deadline handles, `closeSession` command, pending cancellation, and UA session cleanup wiring.
- [ ] Run `npm test -- --run test/media test/integration/call.test.ts`; expect all focused tests pass.
- [ ] Commit `fix: bound worker media operations and cleanup`.

