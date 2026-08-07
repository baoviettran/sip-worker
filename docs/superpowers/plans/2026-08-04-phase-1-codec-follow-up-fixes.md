# Phase 1 Codec Follow-up Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Correct orphan continuation framing, multi-frame batch handling, and exact Content-Length error offsets without changing the public API.

**Architecture:** Keep parser and decoder framing byte-oriented. Add parallel source-byte maps to decoded header values during unfolding, validate decimal tokens at their first invalid character, and bound only incomplete per-frame state after consuming all complete frames.

**Tech Stack:** TypeScript 5.x strict ESM, Vitest, tsup, Node 22+, no runtime dependencies.

## Global Constraints

- Parsing malformed input returns `ParseError` with a byte offset and never throws.
- Stream decoder errors reset buffered state.
- Maximum header block remains 65,536 bytes; maximum body remains 1,048,576 bytes per frame.
- Existing public exports and signatures remain unchanged.
- Every production change follows a witnessed red test and ends with focused plus full verification.

---

### Task 1: Reject orphan header continuations during framing

**Files:**
- Modify: `test/stream/decoder.test.ts`
- Modify: `src/stream/decoder.ts`

**Interfaces:**
- Consumes: `SipStreamDecoder.push(chunk): ParseResult<Uint8Array[]>`.
- Produces: matching parser/decoder rejection for a continuation without a preceding header.

- [x] **Step 1: Write the failing regression test**

```ts
it('rejects an orphan header continuation and resets', () => {
  const bad = encoder.encode('MESSAGE sip:b SIP/2.0\r\n Content-Length: 5\r\n\r\nhello');
  const d = new SipStreamDecoder();
  const rejected = d.push(bad);
  expect(rejected.ok).toBe(false);
  if (rejected.ok) throw new Error('expected orphan continuation error');
  expect(rejected.error.offset).toBe(25);
  const fresh = d.push(MSG);
  expect(fresh.ok && fresh.value).toHaveLength(1);
});
```

- [x] **Step 2: Run the focused test to verify RED**

Run: `npx vitest run test/stream/decoder.test.ts -t "orphan header continuation"`

Expected: FAIL because the decoder emits a zero-body frame.

- [x] **Step 3: Implement strict header-only unfolding**

In `contentLength`, remove the start line before unfolding. Make `unfoldHeaderLines` return `ParseResult<HeaderLine[]>` and return `ParseError(line.byteOffset, 'continuation without a header')` when the first header line is a continuation. Propagate this result through `contentLength` so `push` resets via `failAndReset`.

- [x] **Step 4: Run the focused decoder suite to verify GREEN**

Run: `npx vitest run test/stream/decoder.test.ts`

Expected: all decoder tests pass.

- [x] **Step 5: Commit**

```bash
git add src/stream/decoder.ts test/stream/decoder.test.ts
git commit -m "fix: reject orphan stream header continuations"
```

### Task 2: Consume every valid frame in a batched push

**Files:**
- Modify: `test/stream/decoder.test.ts`
- Modify: `src/stream/decoder.ts`

**Interfaces:**
- Consumes: per-frame `MAX_HEADER_BLOCK` and `MAX_BODY` checks.
- Produces: all complete valid frames present in one `push` result.

- [x] **Step 1: Write the failing regression test**

```ts
it('accepts three large valid messages in one push', () => {
  const body = new Uint8Array(600000).fill(0x61);
  const message = concat(
    encoder.encode('MESSAGE sip:b SIP/2.0\r\nContent-Length: 600000\r\n\r\n'),
    body,
  );
  const result = new SipStreamDecoder().push(concat(message, message, message));
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error.message);
  expect(result.value).toHaveLength(3);
});
```

- [x] **Step 2: Run the focused test to verify RED**

Run: `npx vitest run test/stream/decoder.test.ts -t "three large valid messages"`

Expected: FAIL with `stream buffer too large`.

- [x] **Step 3: Remove the aggregate pending-buffer rejection**

Delete the post-frame `this.rx.length > MAX_HEADER_BLOCK + MAX_BODY + 4` check. The loop already rejects an incomplete oversized header and `frameLen` already bounds incomplete bodies per frame; complete frames must continue through the loop.

- [x] **Step 4: Run the focused decoder suite to verify GREEN**

Run: `npx vitest run test/stream/decoder.test.ts`

Expected: all decoder tests pass.

- [x] **Step 5: Commit**

```bash
git add src/stream/decoder.ts test/stream/decoder.test.ts
git commit -m "fix: consume all valid batched stream frames"
```

### Task 3: Report exact invalid Content-Length bytes

**Files:**
- Modify: `test/messages/parser.test.ts`
- Modify: `test/stream/decoder.test.ts`
- Modify: `src/messages/parser.ts`
- Modify: `src/stream/decoder.ts`

**Interfaces:**
- Consumes: unfolded Content-Length logical values.
- Produces: identical first-invalid-byte offsets from `parseMessage` and `SipStreamDecoder`.

- [x] **Step 1: Write failing ordinary and folded offset tests**

```ts
const ordinary = 'MESSAGE sip:b SIP/2.0\r\nContent-Length: 12x\r\n\r\n';
const folded = 'MESSAGE sip:b SIP/2.0\r\nContent-Length:\r\n x\r\n\r\n';
expect(parseMessage(encoder.encode(ordinary))).toMatchObject({
  ok: false,
  error: { offset: ordinary.indexOf('x') },
});
expect(parseMessage(encoder.encode(folded))).toMatchObject({
  ok: false,
  error: { offset: folded.indexOf('x') },
});
```

Add equivalent assertions through `SipStreamDecoder.push`.

- [x] **Step 2: Run focused tests to verify RED**

Run: `npx vitest run test/messages/parser.test.ts test/stream/decoder.test.ts -t "exact invalid Content-Length byte"`

Expected: FAIL because current errors point to the value start and folded parser/decoder offsets disagree.

- [x] **Step 3: Add source-byte maps during unfolding**

Extend internal header rows/lines with `valueOffsets: number[]`. Build the map by iterating decoded code points and advancing by `TextEncoder.encode(codePoint).byteLength`; map inserted unfolding space to the continuation line's leading whitespace byte. Trim strings and maps together. Locate the first `[^0-9]` index and return `valueOffsets[index]`, falling back to the empty value's byte offset.

- [x] **Step 4: Run focused suites to verify GREEN**

Run: `npx vitest run test/messages/parser.test.ts test/stream/decoder.test.ts`

Expected: all parser and decoder tests pass with matching exact offsets.

- [x] **Step 5: Run full verification**

Run independently:

```bash
npm test
npm run typecheck
npm run test:package
git diff --check
```

Expected: all commands exit 0; no formatting errors.

- [x] **Step 6: Commit**

```bash
git add src/messages/parser.ts src/stream/decoder.ts test/messages/parser.test.ts test/stream/decoder.test.ts
git commit -m "fix: report exact Content-Length error offsets"
```
