# Transport Resilience Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make transport identity and failure semantics safe and observable.

**Architecture:** Transport capabilities expose SIP transport identity; the layer owns one terminal transport subscription; adapters validate peer and settle all lifecycle operations through a shared finalizer.

**Tech Stack:** TypeScript strict ESM, Vitest, injected socket fakes.

## Global Constraints

- Do not infer public sent-by from a remote socket endpoint.
- Adapter failures must surface as `TransportError` and never escape a timer callback.

---

### Task 1: Via composition and terminal propagation

**Files:** Modify `src/transport/transport.ts`, `src/transactions/coordinator.ts`, `src/ua/user-agent.ts`, `src/ua/registrar.ts`, `src/dialogs/dialog.ts`; Test transport, UA, reliability suites.

- [x] Add tests asserting UDP/TCP/WS/WSS Via tokens and active transaction failure on disconnect.
- [x] Add transport token capability and inject caller-supplied sent-by/rport into request builders; add TransactionLayer disposal and terminal-error fan-out.
- [x] Run `npm test -- --run test/transport test/ua test/reliability`; expect all focused tests pass.
- [x] Commit `fix: make SIP transport identity and loss explicit`.

### Task 2: Adapter hardening

**Files:** Modify `src/transport/node/udp.ts`, `src/transport/node/tcp.ts`, `src/transport/node/ws.ts`, `src/transport/browser/ws.ts`, `src/reliability/*.ts`; Test matching suites.

- [x] Add failing tests for foreign UDP datagrams, throwing connect/ping, TCP half-close, and liveness factory throw.
- [x] Validate configured UDP peer, close on synchronous failures, wait for actual TCP close, and convert liveness failures to typed callbacks.
- [x] Run `npm test -- --run test/transport test/reliability`; expect all focused tests pass.
- [x] Commit `fix: harden transport and liveness failure paths`.

