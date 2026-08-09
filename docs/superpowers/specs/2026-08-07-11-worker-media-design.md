# Phase 11 — Worker and Media Reliability Design

## Goal

Make worker supervision observable and sequence-safe, and make media lifecycle failures settle rather than hang.

## Scope

The worker protocol gains generation-scoped registration failure and identity checkpoints. The supervisor supports explicit start/close semantics, multiple waiters, bounded restart policy, and isolated observers. The media protocol gains session close and operation deadlines; v1 remains explicitly signaling-only until a real media adapter is supplied.

## Acceptance

- A sent REGISTER CSeq is checkpointed before a worker may die.
- Worker registration failures reject caller promises with typed generation context.
- Supervisor close releases worker resources and all waiters.
- Missing media replies reject before a configurable deadline.

