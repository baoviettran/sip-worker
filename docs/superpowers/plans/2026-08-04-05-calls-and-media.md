# Calls and Media Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Place and receive one authenticated SIP call, exchange stub SDP through a serializable media bridge, ACK correctly, and terminate with BYE.

**Architecture:** A request-correlated media bridge supplies opaque SDP to worker-side sessions. `Inviter` consumes client transaction events and owns 2xx dialog ACKs; `Invitation` consumes an INVITE server transaction and owns 2xx retransmission until ACK. Sessions expose promises that settle at protocol outcomes.

**Tech Stack:** TypeScript, Vitest, virtual clock, structured-clone-safe bridge messages, no WebRTC runtime in v1.

## Global Constraints

- Requires Plans 01–04 green.
- SDP is opaque UTF-8 text and only crosses the bridge in serializable message objects.
- `invite()`/`answer()` resolve at Confirmed; `hangup()` resolves after BYE 2xx.
- 2xx ACK uses the INVITE numeric CSeq, a fresh branch, and direct transport send without a client transaction.
- Every retransmitted/multiple 2xx is passed to session logic per RFC 6026.
- First successful dialog wins; additional successful dialogs are ACKed and BYEd.
- Incoming 2xx responses retransmit from the TU at T1 doubling to T2 until ACK or 64*T1.

---

### Task 1: Serializable media protocol and stub handler

**Files:**
- Create: `src/media/protocol.ts`
- Create: `src/media/worker-controller.ts`
- Create: `src/media/stub-main-handler.ts`
- Create: `src/media/index.ts`
- Create: `test/media/bridge.test.ts`

**Interfaces:**
- Consumes: injected `MediaPort` only.
- Produces: request-correlated offer/answer/setRemote operations and `STUB_SDP`.

- [ ] **Step 1: Write failing correlation/serialization tests**

```ts
const offer = controller.createOffer('session-1');
mainPort.deliver({ type: 'mediaResult', requestId: sent.requestId, sessionId: 'session-1', sdp: STUB_SDP });
await expect(offer).resolves.toBe(STUB_SDP);
expect(() => structuredClone(sent)).not.toThrow();
```

Also test simultaneous session requests do not cross-resolve, remote SDP delivery, error replies, unsubscribe, and rejection of pending requests when the port closes.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/media/bridge.test.ts`

Expected: FAIL because media modules are absent.

- [ ] **Step 3: Implement exact protocol shapes**

```ts
export type MediaCommand =
  | { type: 'createOffer'; requestId: string; sessionId: string }
  | { type: 'createAnswer'; requestId: string; sessionId: string; remoteSdp: string }
  | { type: 'setRemote'; requestId: string; sessionId: string; remoteSdp: string };
export type MediaReply =
  | { type: 'mediaResult'; requestId: string; sessionId: string; sdp?: string }
  | { type: 'mediaError'; requestId: string; sessionId: string; message: string };
export interface MediaPort { postMessage(message: MediaCommand | MediaReply): void; subscribe(listener: (message: MediaCommand | MediaReply) => void): () => void; }
```

`WorkerMediaController` stores deferreds by requestId and clears them on reply/close. `StubMainMediaHandler` replies with a fixed valid audio SDP and records remote SDP by session. Neither side imports `Worker`, `window`, navigator, or WebRTC.

- [ ] **Step 4: Verify**

Run: `npx vitest run test/media/bridge.test.ts && npm run typecheck && npm test`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/media test/media
git commit -m "feat: add serializable stub media bridge"
```

### Task 2: Session base and outgoing Inviter

**Files:**
- Create: `src/ua/session.ts`
- Create: `src/ua/inviter.ts`
- Create: `test/ua/inviter.test.ts`

**Interfaces:**
- Consumes: TransactionLayer, AuthManager, Dialog, WorkerMediaController, Transport, IDs.
- Produces: `SessionState`, `Session`, `Inviter.invite()`, `Inviter.hangup()`.

- [ ] **Step 1: Write failing outgoing state tests**

Test trace: offer requested → INVITE sent → 100 leaves Inviting → 180 sets Ringing → 183 with SDP sets Early and media remote → 200 creates dialog, sends direct ACK, sets Confirmed, resolves invite. Add 401 case asserting transaction ACK precedes authenticated re-INVITE; 486 rejects `SipError`; timeout/transport failure reject; BYE waits for 200; repeated same-dialog 200 resends byte-identical cached ACK.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/ua/inviter.test.ts`

Expected: FAIL because session classes are absent.

- [ ] **Step 3: Implement explicit deferred outcomes**

```ts
export type SessionState = 'initial' | 'inviting' | 'ringing' | 'early' | 'confirmed' | 'terminating' | 'terminated' | 'failed';
export interface SessionEvent { readonly session: Session; readonly previous: SessionState; readonly state: SessionState; readonly error?: SipError | TransportError; }
```

`invite()` is single-use, obtains SDP before constructing Content-Type/body, registers its transaction listener before send, and retains original request for auth retry. On 2xx, call `Dialog.fromUac`, apply remote SDP, create/cache/send ACK directly through Transport, transition Confirmed, then resolve. `hangup()` creates BYE through Dialog, uses a non-INVITE client transaction, and resolves only on 2xx.

- [ ] **Step 4: Verify**

Run: `npx vitest run test/ua/inviter.test.ts && npm run typecheck && npm test`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ua/session.ts src/ua/inviter.ts test/ua/inviter.test.ts
git commit -m "feat: add outgoing SIP call session"
```

### Task 3: Incoming Invitation and 2xx retransmission

**Files:**
- Create: `src/ua/invitation.ts`
- Create: `src/ua/invite-response-retransmitter.ts`
- Create: `test/ua/invitation.test.ts`

**Interfaces:**
- Consumes: incoming INVITE server transaction, media controller, Clock, Dialog.
- Produces: `Invitation.answer/reject/hangup`, ACK/BYE receive handlers.

- [ ] **Step 1: Write failing incoming-call tests**

Test answer obtains remote SDP from INVITE, requests answer, sends 200 with To tag/Contact/SDP, retransmits at T1 then 2*T1 up to T2 on both reliable and unreliable transports, stops on dialog ACK, transitions Confirmed, and resolves answer. Test no ACK terminates after 64*T1. Test reject sends 486 through server transaction and resolves after send. Test incoming BYE gets 200 and terminates; local hangup waits for BYE 200.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/ua/invitation.test.ts`

Expected: FAIL because Invitation modules are absent.

- [ ] **Step 3: Implement TU-owned 2xx response reliability**

`InviteResponseRetransmitter.start(response)` sends immediately, schedules intervals T1/2T1/.../T2 independent of transport reliability, and schedules absolute 64*T1 expiry. `ack()` cancels both slots. `Invitation` builds the dialog before its first 2xx, routes the coordinator `statelessRequest` ACK into the dialog and retransmitter, and settles `answer()` only after that ACK.

- [ ] **Step 4: Verify**

Run: `npx vitest run test/ua/invitation.test.ts && npm run typecheck && npm test`

Expected: PASS with exact virtual-clock send counts.

- [ ] **Step 5: Commit**

```bash
git add src/ua/invitation.ts src/ua/invite-response-retransmitter.ts test/ua/invitation.test.ts
git commit -m "feat: add incoming SIP call session"
```

### Task 4: Fork-safe successful response policy

**Files:**
- Create: `src/ua/dialog-set.ts`
- Create: `test/ua/dialog-set.test.ts`
- Modify: `src/ua/inviter.ts`

**Interfaces:**
- Consumes: every matching 2xx emitted from an Accepted INVITE client transaction.
- Produces: one selected application dialog plus protocol-safe handling of retransmissions/additional dialogs.

- [ ] **Step 1: Write failing fork-policy tests**

Use To tags A/A/B: first A selects and ACKs; repeated A resends the exact A ACK and sends no BYE; B creates a second dialog, sends B ACK, then sends BYE and consumes its 200; application state remains on A. Assert every matching 2xx is handled.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/ua/dialog-set.test.ts`

Expected: FAIL because dialog-set policy is absent.

- [ ] **Step 3: Implement tag-keyed dialog records**

Store `{ dialog, ackBytes, selected, cleanupStarted }` by remote To tag. An existing key resends cached ACK. The first new key becomes selected. Later new keys are ACKed before starting BYE cleanup. Reject a 2xx without To tag/Contact as `SipError` while keeping the INVITE transaction alive for later valid responses.

- [ ] **Step 4: Verify**

Run: `npx vitest run test/ua/dialog-set.test.ts test/ua/inviter.test.ts && npm run typecheck && npm test`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ua/dialog-set.ts src/ua/inviter.ts test/ua
git commit -m "feat: handle forked INVITE successes safely"
```

### Task 5: UserAgent call API and full call integration

**Files:**
- Modify: `src/ua/user-agent.ts`
- Modify: `src/ua/events.ts`
- Modify: `src/ua/index.ts`
- Modify: `src/index.ts`
- Create: `test/support/mock-sip-server.ts`
- Create: `test/integration/call.test.ts`

**Interfaces:**
- Consumes: session classes and incoming transaction events.
- Produces: `ua.invite(target)`, `incomingCall`, `callState`, and complete outgoing/incoming call flows.

- [ ] **Step 1: Write failing end-to-end call tests**

Outgoing test performs authenticated REGISTER, authenticated INVITE, offer/answer SDP, 180/200, direct ACK, BYE/200, and asserts trace `registered → inviting → ringing → confirmed → terminating → terminated`. Incoming test injects INVITE, observes `incomingCall`, answers, receives ACK, receives BYE, sends 200, and asserts media bridge values.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/integration/call.test.ts`

Expected: FAIL because UserAgent call routing is absent.

- [ ] **Step 3: Wire session ownership and cleanup**

`UserAgent` maps incoming unmatched INVITE transaction events to one `Invitation`, indexes live sessions by Call-ID/local+remote tags, forwards in-dialog ACK/BYE, removes sessions only at terminal state, and emits typed events. `invite()` constructs an Inviter with the existing transport/coordinator/auth/media dependencies; no session subscribes directly to transport.

- [ ] **Step 4: Run the plan gate**

Run: `npm run typecheck && npm test && npm run build && npm run test:package`

Expected: PASS for registration plus outgoing/incoming call integration.

- [ ] **Step 5: Commit**

```bash
git add src/ua src/index.ts test/support/mock-sip-server.ts test/integration/call.test.ts
git commit -m "feat: complete one-call SIP integration"
```
