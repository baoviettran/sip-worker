# Phase 09 — Call Lifecycle and Authentication Design

## Goal

Make calls and Digest authentication safe across remote termination, cancellation, duplicate messages, failures, and teardown.

## Scope

Introduce owned operation cleanup, dialog-ID/CSeq validation, incoming CANCEL and outgoing-session BYE handling, atomic invitation transitions, stable authentication exchange IDs, and regenerated Digest credentials for every changed request URI or nonce-count.

## Acceptance

- A wrong-tag or replayed BYE receives an error and cannot terminate a call.
- A valid remote BYE receives 200 and tears down the owning call.
- `disconnect()` settles every public operation exactly once.
- Credentials alone enable both REGISTER and INVITE Digest retries; retries stay bounded.

