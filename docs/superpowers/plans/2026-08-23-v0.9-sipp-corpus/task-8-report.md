# Task 8 Report: invite-outgoing scenario over UDP and TCP

**Status:** DONE
**Commit:** `ace8bc8` on `main`

## What was done

### Scenario file
Created `test/sipp/scenarios/invite-outgoing.xml` -- a SIPp UAS scenario that:
1. Receives an INVITE
2. Sends 180 Ringing and 200 OK (with SDP body)
3. Receives ACK
4. Receives BYE
5. Sends 200 OK for BYE

### Driver action
Added `runOutgoingCall()` to `test/sipp/driver/agent.ts` and wired the `'invite-outgoing'` dispatch case. The driver creates an outgoing call, waits for the `confirmed` session state, hangs up, and waits for `terminated`.

### Bug fix: TCP transport settle callback
TCP tests failed with "INVITE transportError" because `NodeTcpTransport.send()` used `error === undefined` (strict) to detect success in the `socket.write` callback. Node.js streams pass `null` (not `undefined`) on success. Changed to `error == null` (loose equality) at `packages/node/src/transport/tcp.ts:181`.

This was the only code change needed. The UDP transport already used `error == null` correctly.

## Verification

- `npm run test:sipp -- invite-outgoing`: **PASS** for both `udp` and `tcp`
- `npm run test:sipp:unit`: **16/16 PASS**
- `npx vitest run`: **1277 passed, 1 skipped, 0 failed**
