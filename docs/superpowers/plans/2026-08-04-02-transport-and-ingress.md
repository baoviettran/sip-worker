# Transport and Ingress Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver typed Node/browser transports that emit complete SIP message bytes and one ingress path that parses and routes them.

**Architecture:** Every adapter implements the frozen `Transport` event union; TCP owns stream framing while UDP and WebSocket preserve message boundaries. `SipIngress` is the only consumer of transport data and never encodes failures as empty bytes.

**Tech Stack:** TypeScript, Vitest, injected `dgram`/`net`/`ws`-compatible objects, native browser WebSocket constructor injection.

## Global Constraints

- Requires Plan 01 complete and green.
- No adapter touches an environment global at import time.
- `data` means one complete SIP message; `error` and `disconnected` are typed events.
- `capabilities.reliable` is `false` only for UDP.
- Browser code cannot send WebSocket control Ping frames.
- Every task runs focused tests, all prior tests, typecheck, and commits.

---

### Task 1: Transport contract and deterministic fakes

**Files:**
- Create: `src/transport/transport.ts`
- Create: `src/transport/index.ts`
- Create: `test/support/fake-clock.ts`
- Create: `test/support/fake-transport.ts`
- Create: `test/transport/contract.test.ts`

**Interfaces:**
- Consumes: `TransportError` from Plan 01.
- Produces: frozen `TransportCapabilities`, `TransportEvent`, `Transport`, `Clock`, `FakeClock`, and `FakeTransport`.

- [ ] **Step 1: Write failing event-contract tests**

```ts
it('keeps data and failures distinct', async () => {
  const transport = new FakeTransport({ reliable: true, framing: 'message' });
  const events: TransportEvent[] = []; transport.subscribe((e) => events.push(e));
  transport.emitData(new Uint8Array());
  transport.emitError(new TransportError('lost'));
  expect(events.map((e) => e.type)).toEqual(['data', 'error']);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/transport/contract.test.ts`

Expected: FAIL because transport contracts are absent.

- [ ] **Step 3: Implement the frozen event interface and fakes**

Use the exact `Transport` definitions from the index. `FakeTransport.send` copies bytes into `sent`; `connect`/`disconnect` emit lifecycle events; explicit `emitData`, `emitError`, and `emitDisconnected` methods drive tests. `FakeClock.advance(ms)` repeatedly executes the earliest due timer, including timers scheduled by callbacks before the target time.

- [ ] **Step 4: Verify**

Run: `npx vitest run test/transport/contract.test.ts && npm run typecheck && npm test`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/transport test/support test/transport/contract.test.ts
git commit -m "feat: define typed transport events and deterministic fakes"
```

### Task 2: UDP and TCP adapters

**Files:**
- Create: `src/transport/node/udp.ts`
- Create: `src/transport/node/tcp.ts`
- Create: `test/transport/node-udp.test.ts`
- Create: `test/transport/node-tcp.test.ts`

**Interfaces:**
- Consumes: `Transport`, `SipStreamDecoder`, and `TransportError`.
- Produces: `NodeUdpTransport` and `NodeTcpTransport` over injected socket shapes.

- [ ] **Step 1: Write failing adapter tests**

Assert UDP emits one copied `data` event per datagram and has `{ reliable:false, framing:'datagram' }`. Assert TCP feeds arbitrary chunks through `SipStreamDecoder`, emits one event per complete message, rejects writes after close, and emits decoder failures as `error` rather than `data`.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/transport/node-udp.test.ts test/transport/node-tcp.test.ts`

Expected: FAIL because adapters are absent.

- [ ] **Step 3: Implement injected socket boundaries**

```ts
export interface DatagramSocketLike {
  bind(port: number, callback: () => void): void;
  send(data: Uint8Array, port: number, host: string, callback: (error?: Error) => void): void;
  close(callback: () => void): void;
  on(event: 'message' | 'error' | 'close', listener: (...args: unknown[]) => void): void;
}

export interface StreamSocketLike {
  connect(port: number, host: string, callback: () => void): void;
  write(data: Uint8Array, callback: (error?: Error) => void): void;
  end(callback: () => void): void;
  on(event: 'data' | 'error' | 'close', listener: (...args: unknown[]) => void): void;
}
```

Each adapter maintains one listener set, copies outbound/inbound bytes, wraps callback/socket errors as `TransportError`, makes connect/disconnect promises settle exactly once, and removes socket listeners during final disconnect.

- [ ] **Step 4: Verify**

Run: `npx vitest run test/transport/node-udp.test.ts test/transport/node-tcp.test.ts && npm run typecheck && npm test`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/transport/node test/transport/node-*.test.ts
git commit -m "feat: add injected UDP and TCP transports"
```

### Task 3: Node and browser WebSocket adapters

**Files:**
- Create: `src/transport/node/ws.ts`
- Create: `src/transport/browser/ws.ts`
- Create: `test/transport/node-ws.test.ts`
- Create: `test/transport/browser-ws.test.ts`

**Interfaces:**
- Consumes: transport contract.
- Produces: `NodeWebSocketTransport` and `BrowserWebSocketTransport`; both negotiate/require the `sip` subprotocol and map one WebSocket message to one SIP data event.

- [ ] **Step 1: Write failing WebSocket tests**

Test connect waits for `open`, rejects on pre-open `error`, validates `protocol === 'sip'`, accepts string/ArrayBuffer/views, copies received bytes, rejects send unless OPEN, emits typed close/error events, and restores no overwritten callbacks. Assert an empty message remains a `data` event. Assert browser adapter has no `ping` call.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/transport/node-ws.test.ts test/transport/browser-ws.test.ts`

Expected: FAIL because adapters are absent.

- [ ] **Step 3: Implement explicit injected shapes**

```ts
export interface BrowserWebSocketLike {
  readonly readyState: number;
  readonly protocol: string;
  binaryType: string;
  addEventListener(type: string, listener: (event: Event) => void): void;
  removeEventListener(type: string, listener: (event: Event) => void): void;
  send(data: Uint8Array): void;
  close(code?: number, reason?: string): void;
}
export type BrowserWebSocketFactory = (url: string, protocols: string[]) => BrowserWebSocketLike;
```

Node uses an equivalent EventEmitter-shaped injection. Constructors install no global objects; `connect()` invokes the factory or starts the supplied socket, then checks the negotiated protocol. Protocol Ping/Pong is reserved for Plan 06 through an optional Node-only capability and is never simulated with data messages.

- [ ] **Step 4: Verify**

Run: `npx vitest run test/transport/*ws.test.ts && npm run typecheck && npm test`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/transport/node/ws.ts src/transport/browser test/transport/*ws.test.ts
git commit -m "feat: add RFC 7118 WebSocket transports"
```

### Task 4: Single ingress coordinator and transport package exports

**Files:**
- Create: `src/transport/ingress.ts`
- Create: `src/transport/node/index.ts`
- Create: `src/transport/browser/index.ts`
- Create: `test/transport/ingress.test.ts`
- Modify: `package.json`
- Modify: `tsup.config.ts`
- Modify: `src/index.ts`

**Interfaces:**
- Consumes: `parseMessage`, transport events.
- Produces: `MessageSink { receive(message: SipMessage): void }`, `SipIngress.start()/stop()`, and working `./transport/node` and `./transport/browser` exports.

- [ ] **Step 1: Write failing ingress tests**

```ts
it('routes valid messages and reports failures without fake data', () => {
  const messages: SipMessage[] = []; const errors: Error[] = [];
  const ingress = new SipIngress(transport, { receive: (m) => messages.push(m) }, (e) => errors.push(e));
  ingress.start();
  transport.emitData(validResponseBytes); transport.emitData(new Uint8Array([0xff]));
  transport.emitError(new TransportError('closed'));
  expect(messages).toHaveLength(1); expect(errors).toHaveLength(2);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/transport/ingress.test.ts`

Expected: FAIL because `SipIngress` is absent.

- [ ] **Step 3: Implement start/stop ownership and build entries**

`start()` subscribes once; `data` calls `parseMessage`; valid values call the sink; parse/transport errors call the error listener; `stop()` invokes the stored unsubscribe and is idempotent. Add source barrels and tsup entries `transport/node/index` and `transport/browser/index`, then add matching package exports.

- [ ] **Step 4: Run the plan gate**

Run: `npm run typecheck && npm test && npm run test:package`

Expected: PASS; ESM/CJS/declaration imports for both transport subpaths resolve.

- [ ] **Step 5: Commit**

```bash
git add src/transport src/index.ts package.json tsup.config.ts test
git commit -m "feat: route typed transport events through SIP ingress"
```
