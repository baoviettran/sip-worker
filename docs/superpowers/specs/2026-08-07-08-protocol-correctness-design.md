# Phase 08 — Protocol Correctness Design

## Goal

Make the transaction and dialog core RFC-correct under concurrency, proxy routing, retransmission, and legacy ingress.

## Scope

Transaction subscriptions are keyed by the owning `TransactionKey`; client transactions snapshot and cache outbound bytes; server matching uses cookie branch plus sent-by and rejects unsupported legacy matching deterministically. Dialog route construction follows RFC 3261 §12.2.1.1, preserving all Route values. Transaction validation rejects CSeq/method mismatch and timers derive from caller configuration.

## Acceptance

- Concurrent REGISTER, INVITE, BYE, and OPTIONS cannot settle one another.
- Loose and strict Record-Route requests match RFC 3261 wire examples.
- Mutating a caller request after `sendRequest()` cannot change retransmissions.
- Every custom timer derives from supplied T1/T4 values.

