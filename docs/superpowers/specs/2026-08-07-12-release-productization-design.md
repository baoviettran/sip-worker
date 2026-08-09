# Phase 12 — Release Productization Design

## Goal

Turn the package into a reproducible, supportable release artifact and prove it against realistic infrastructure.

## Scope

Add clean-tree packaging gates, shared runtime module identity, complete public exports, package metadata and policies, CI, and an opt-in external interoperability matrix. Documentation states supported runtimes, security limits, signaling-only media scope, and required supervisor startup sequence.

## Acceptance

- Packing a fresh archive contains all declared exports.
- Root and subpath exports share public class identity.
- CI runs typecheck, tests, clean-tree pack, packed consumers, and interoperability jobs.
- README examples execute as written.

