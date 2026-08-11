# Release Productization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce reproducible packages and product-grade release evidence.

**Architecture:** Release scripts build from clean sources, validate the tarball in isolated consumers, and preserve shared module identity. CI runs local deterministic gates and a separately provisioned interoperability matrix.

**Tech Stack:** npm, tsup, TypeScript, Vitest, GitHub Actions, SIPp-compatible external test environment.

## Global Constraints

- Publishing must fail if `dist` is absent or packed exports do not resolve.
- Frame the released artifact as **0.1.0, a signaling-only prototype**: a real media adapter (and interop evidence) gates the 1.0 framing, and docs must not call 0.1.0 a "v1 release candidate".

---

### Task 1: Reproducible packaging and exports

**Files:** Modify `package.json`, `tsup.config.ts`, `test/package/exports.test.mjs`; Create `test/package/clean-pack.test.mjs`.

- [ ] Add failing clean-archive pack and root/subpath `instanceof` tests plus native ping adapter import test.
- [ ] Add prepack release gate, shared bundle graph or externalized shared modules, and export `toNativePingSocket`/`NativeNodeWebSocket`.
- [ ] Run `npm run test:package`; expect clean archive and all isolated consumers pass.
- [ ] Commit `build: make package releases reproducible`.

### Task 2: Operational contract and CI

**Files:** Modify `README.md`, `package.json`; Create `LICENSE`, `SECURITY.md`, `CHANGELOG.md`, `.github/workflows/ci.yml`, `.github/workflows/interop.yml`.

- [ ] Add failing documentation-link and script-presence assertions where practical.
- [ ] Declare engines, repository/support metadata, security limits, startup sequence, release procedure, CI gates, and scheduled interoperability inputs.
- [ ] Run `npm run typecheck`, `npm test`, and `npm run test:package`; expect all pass.
- [ ] Commit `docs: establish production release contract`.

