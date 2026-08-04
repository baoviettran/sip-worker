# Codec and Package Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce a strict, packable SIP wire codec with byte-correct parsing, serialization, and stream framing.

**Architecture:** `messages/` owns immutable message values and ordered headers; the parser discovers all boundaries in bytes before decoding text. `stream/` frames TCP chunks and delegates complete messages to the parser. Separate source barrels match every package subpath.

**Tech Stack:** TypeScript 5.x strict ESM, Vitest, tsup, Node 22+, no runtime dependencies.

**Status:** Complete — verified with 87 tests, typecheck, and ESM/CJS/package export gates.

## Global Constraints

- Parsing returns `ParseResult<SipMessage>` and never throws for malformed input.
- `ParseError.offset` is a byte offset.
- `Headers.append` adds; `Headers.set` replaces.
- Serializer emits exactly one recomputed `Content-Length` and rejects CR/LF injection.
- UTF-8 text helpers are explicit; transport-facing bodies remain `Uint8Array`.
- Maximum header block is 65,536 bytes; maximum body is 1,048,576 bytes.
- Every task runs focused tests, `npm test`, `npm run typecheck`, and commits.

---

## File Structure

```text
package.json
tsconfig.json
vitest.config.ts
tsup.config.ts
src/errors.ts
src/index.ts
src/messages/index.ts
src/messages/headers.ts
src/messages/message.ts
src/messages/parser.ts
src/messages/serializer.ts
src/stream/index.ts
src/stream/decoder.ts
test/messages/*.test.ts
test/stream/decoder.test.ts
test/package/exports.test.mjs
```

### Task 1: Toolchain, errors, and build entries

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `tsup.config.ts`
- Create: `.gitignore`
- Create: `src/errors.ts`
- Create: `src/index.ts`
- Create: `src/messages/index.ts`
- Create: `src/stream/index.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `SipError`, `ParseError`, `TransportError`; ESM/CJS/declaration build entries for `.`, `./messages`, and the initial public barrels.

- [x] **Step 1: Write the initial package/build files**

Use these scripts and initial build entries; later plans extend the exports and build-entry maps:

```json
{
  "name": "sip-worker",
  "version": "0.1.0",
  "type": "module",
  "files": ["dist"],
  "main": "./dist/index.cjs",
  "module": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js", "require": "./dist/index.cjs" },
    "./messages": { "types": "./dist/messages/index.d.ts", "import": "./dist/messages/index.js", "require": "./dist/messages/index.cjs" }
  },
  "scripts": {
    "build": "tsup",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "test:package": "npm run build && node test/package/exports.test.mjs"
  },
  "devDependencies": { "tsup": "^8.0.0", "typescript": "^5.5.0", "vitest": "^2.0.0" }
}
```

```ts
// tsup.config.ts
import { defineConfig } from 'tsup';
export default defineConfig({
  entry: { index: 'src/index.ts', 'messages/index': 'src/messages/index.ts' },
  format: ['esm', 'cjs'],
  outExtension: ({ format }) => ({ js: format === 'cjs' ? '.cjs' : '.js' }),
  dts: true, clean: true, sourcemap: true, splitting: false, target: 'es2022',
});
```

- [x] **Step 2: Define typed errors**

```ts
export class SipError extends Error {
  constructor(readonly statusCode: number, message: string) { super(message); this.name = 'SipError'; }
}
export class ParseError extends Error {
  constructor(readonly offset: number, message: string) { super(message); this.name = 'ParseError'; }
}
export class TransportError extends Error {
  constructor(message: string, readonly cause?: unknown) { super(message); this.name = 'TransportError'; }
}
```

- [x] **Step 3: Verify the empty package**

Run: `npm install && npm run typecheck && npm test && npm run build`

Expected: all commands exit 0 and `dist/index.{js,cjs,d.ts}` plus `dist/messages/index.{js,cjs,d.ts}` exist.

- [x] **Step 4: Commit**

```bash
git add package.json tsconfig.json vitest.config.ts tsup.config.ts .gitignore src
git commit -m "chore: scaffold strict SIP codec package"
```

### Task 2: Ordered headers and byte message model

**Files:**
- Create: `src/messages/headers.ts`
- Create: `src/messages/message.ts`
- Create: `test/messages/headers.test.ts`
- Create: `test/messages/message.test.ts`

**Interfaces:**
- Consumes: `ParseError` only through later tasks.
- Produces: `Headers`, `SipRequestMessage`, `SipResponseMessage`, `SipMessage`, constructors, guards, `bodyText`, and `withTextBody`.

- [x] **Step 1: Write failing mutation and body tests**

```ts
it('separates append from replacement', () => {
  const h = new Headers();
  h.append('Via', 'one'); h.append('v', 'two');
  expect(h.getAll('Via')).toEqual(['one', 'two']);
  h.set('Via', 'replacement');
  expect(h.getAll('v')).toEqual(['replacement']);
});

it('stores UTF-8 bodies as bytes', () => {
  const request = withTextBody(makeRequest('INVITE', 'sip:b@example.com'), 'café', 'application/sdp');
  expect(request.body.byteLength).toBe(5);
  expect(bodyText(request)).toBe('café');
});
```

- [x] **Step 2: Run tests to verify failure**

Run: `npx vitest run test/messages/headers.test.ts test/messages/message.test.ts`

Expected: FAIL because the modules do not exist.

- [x] **Step 3: Implement the exact public shapes**

```ts
export class Headers {
  private readonly rows: Array<{ name: string; lower: string; value: string }> = [];
  append(name: string, value: string): void { this.rows.push({ name, lower: name.toLowerCase(), value }); }
  set(name: string, value: string): void { this.delete(name); this.append(name, value); }
  get(name: string): string | undefined { return this.rows.find((r) => r.lower === name.toLowerCase())?.value; }
  getAll(name: string): string[] { return this.rows.filter((r) => r.lower === name.toLowerCase()).map((r) => r.value); }
  has(name: string): boolean { return this.get(name) !== undefined; }
  delete(name: string): void {
    const lower = name.toLowerCase();
    for (let i = this.rows.length - 1; i >= 0; i -= 1) if (this.rows[i]?.lower === lower) this.rows.splice(i, 1);
  }
  entries(): ReadonlyArray<readonly [string, string]> { return this.rows.map((r) => [r.name, r.value] as const); }
  clone(): Headers { const out = new Headers(); for (const [n, v] of this.entries()) out.append(n, v); return out; }
}
```

Define the message interfaces exactly as frozen in the index. Constructors default `headers` to a new `Headers` and `body` to an empty `Uint8Array`; `withTextBody` clones headers, replaces `Content-Type`, and encodes with `TextEncoder`.

- [x] **Step 4: Verify focused and regression suites**

Run: `npx vitest run test/messages && npm run typecheck && npm test`

Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add src/messages test/messages
git commit -m "feat: add ordered SIP headers and byte messages"
```

### Task 3: Byte-oriented parser and serializer

**Files:**
- Create: `src/messages/parser.ts`
- Create: `src/messages/serializer.ts`
- Create: `test/messages/parser.test.ts`
- Create: `test/messages/serializer.test.ts`

**Interfaces:**
- Consumes: Task 2 message values and Task 1 `ParseError`.
- Produces: `parseMessage(bytes): ParseResult<SipMessage>` and `serializeMessage(message): Uint8Array`.

- [x] **Step 1: Write the acceptance matrix as failing tests**

Cover exact byte fixtures for: CRLF and lone LF; folded headers; compact `v/f/t/i/m/l/c`; IPv6 bracket hosts; quoted commas; repeated equal and conflicting Content-Length; truncated bodies; 65,537-byte headers; 1,048,577-byte bodies; malformed request/response start lines; multibyte bodies; and CR/LF injection. Include:

```ts
it('uses body octets rather than decoded string length', () => {
  const wire = encoder.encode('MESSAGE sip:b SIP/2.0\r\nContent-Length: 5\r\n\r\ncafé');
  const result = parseMessage(wire);
  expect(result.ok && result.value.body.byteLength).toBe(5);
});

it('serializes one Content-Length', () => {
  const h = new Headers(); h.append('Content-Length', '99'); h.append('l', '88');
  const wire = decoder.decode(serializeMessage(makeRequest('OPTIONS', 'sip:b', h)));
  expect(wire.match(/content-length/gi)).toHaveLength(1);
});
```

- [x] **Step 2: Run tests to verify failure**

Run: `npx vitest run test/messages/parser.test.ts test/messages/serializer.test.ts`

Expected: FAIL because parser/serializer are absent.

- [x] **Step 3: Implement byte-boundary parsing**

Implement these exact stages: scan bytes for `CRLFCRLF`, falling back to `LFLF`; reject oversized header blocks before decoding; decode only the header slice; unfold continuation lines; validate the start line grammar; normalize compact names; require decimal Content-Length tokens; accept duplicate lengths only when numerically equal; reject declared bodies above the maximum or shorter than declared; copy exactly the declared body bytes; return trailing-byte errors for the single-message parser. Every failure constructs `ParseError` at the first offending byte.

Serializer stages are: validate start-line and header names/values; omit every existing long or compact Content-Length; encode the start line and headers with strict CRLF; append one canonical `Content-Length`; concatenate header bytes and the original body bytes.

- [x] **Step 4: Verify focused and regression suites**

Run: `npx vitest run test/messages && npm run typecheck && npm test`

Expected: PASS with no thrown parser exception in a 10,000-input malformed-byte fuzz loop.

- [x] **Step 5: Commit**

```bash
git add src/messages test/messages
git commit -m "feat: add byte-correct SIP parser and serializer"
```

### Task 4: Stream decoder and package gate

**Files:**
- Create: `src/stream/decoder.ts`
- Create: `test/stream/decoder.test.ts`
- Create: `test/package/exports.test.mjs`
- Modify: `src/index.ts`
- Modify: `src/messages/index.ts`
- Modify: `src/stream/index.ts`
- Modify: `package.json`
- Modify: `tsup.config.ts`

**Interfaces:**
- Consumes: parser limits and complete-message codec.
- Produces: `SipStreamDecoder.push(chunk): ParseResult<Uint8Array[]>`, `reset()`, and usable package exports.

- [x] **Step 1: Write failing chunk-boundary tests**

Test every split position across a header delimiter and the five-byte `café` body, two messages in one chunk, compact `l`, conflicting lengths, oversized declared bodies, and reset after error.

- [x] **Step 2: Run the decoder test to verify failure**

Run: `npx vitest run test/stream/decoder.test.ts`

Expected: FAIL because `SipStreamDecoder` is absent.

- [x] **Step 3: Implement framing and barrels**

The decoder buffers bytes, scans only the buffered header prefix, parses long or compact Content-Length without decoding body bytes, emits copied complete-message slices, preserves remaining bytes, and returns a `ParseError` while resetting on invalid/oversized input. Export all public codec symbols from `src/messages/index.ts`, `src/stream/index.ts`, and `src/index.ts`. Add `stream/index` to the tsup entry map and add a matching `./stream` package export.

- [x] **Step 4: Add and run the package assertion**

```js
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const root = await import('../../dist/index.js');
const messages = await import('../../dist/messages/index.js');
const stream = await import('../../dist/stream/index.js');
const required = require('../../dist/index.cjs');
assert.equal(typeof root.SipStreamDecoder, 'function');
assert.equal(typeof stream.SipStreamDecoder, 'function');
assert.equal(typeof messages.parseMessage, 'function');
assert.equal(typeof required.serializeMessage, 'function');
```

Run: `npm run typecheck && npm test && npm run test:package`

Expected: PASS and all nine `.js/.cjs/.d.ts` root/message/stream artifacts exist.

- [x] **Step 5: Commit**

```bash
git add src package.json tsup.config.ts test/package test/stream
git commit -m "feat: complete SIP codec framing and package exports"
```
