# Phase 10 — Transport Resilience Design

## Goal

Make transport behavior truthful, bounded, and safe under peer loss and hostile UDP input.

## Scope

Extend transport composition with a SIP Via transport token and caller-owned sent-by/rport policy. Validate UDP source peers, propagate terminal transport failure into the transaction layer, bound send/connect/disconnect operations, and prevent liveness callbacks from escaping timer execution.

## Acceptance

- UDP/TCP/WS/WSS requests emit the correct Via transport token.
- Unconfigured UDP sources never reach SIP ingress.
- Disconnect terminates owned transactions with one typed error.
- Liveness and transport synchronous failures become typed callbacks, never uncaught timer exceptions.

