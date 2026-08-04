import { describe, it, expect } from 'vitest';
import { SipStreamDecoder } from '../../src/stream/decoder.js';
import { parseMessage } from '../../src/messages/parser.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8');
const MAX_BODY = 1048576;

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.byteLength, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.byteLength;
  }
  return out;
}

const HEAD = encoder.encode('MESSAGE sip:b SIP/2.0\r\n');
const TERM = encoder.encode('\r\n');
const BODY = encoder.encode('café');
const MSG = concat(HEAD, encoder.encode('Content-Length: 5\r\n'), TERM, BODY);

function makeMsg(clName: string, clValue: number, body: string): Uint8Array {
  return concat(HEAD, encoder.encode(`${clName}: ${clValue}\r\n`), TERM, encoder.encode(body));
}

function messagesFrom(pushes: Uint8Array[]): Uint8Array[] {
  const d = new SipStreamDecoder();
  const out: Uint8Array[] = [];
  for (const p of pushes) {
    const r = d.push(p);
    if (!r.ok) throw new Error(r.error.message);
    out.push(...r.value);
  }
  return out;
}

function bodyText(slice: Uint8Array): string {
  const r = parseMessage(slice);
  if (!r.ok) throw new Error(r.error.message);
  return decoder.decode(r.value.body);
}

describe('SipStreamDecoder', () => {
  it('emits a complete message from a single chunk', () => {
    const msgs = messagesFrom([MSG]);
    expect(msgs).toHaveLength(1);
    expect(Array.from(msgs[0]!)).toEqual(Array.from(MSG));
    expect(bodyText(msgs[0]!)).toBe('café');
  });

  it('frames correctly at every split position across the header delimiter and the five-byte café body', () => {
    for (let i = 1; i < MSG.byteLength; i += 1) {
      const d = new SipStreamDecoder();
      const first = d.push(MSG.slice(0, i));
      expect(first.ok).toBe(true);
      if (!first.ok) throw new Error(first.error.message);
      expect(first.value).toHaveLength(0);
      const second = d.push(MSG.slice(i));
      if (!second.ok) throw new Error(second.error.message);
      expect(second.value).toHaveLength(1);
      const slice = second.value[0]!;
      expect(Array.from(slice)).toEqual(Array.from(MSG));
      expect(decoder.decode(slice.subarray(slice.byteLength - 5))).toBe('café');
      const parsed = parseMessage(slice);
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) throw new Error(parsed.error.message);
      expect(parsed.value.body.byteLength).toBe(5);
      expect(decoder.decode(parsed.value.body)).toBe('café');
    }
  });

  it('frames messages using lone LF line endings', () => {
    const lfMsg = concat(
      encoder.encode('MESSAGE sip:b SIP/2.0\n'),
      encoder.encode('Content-Length: 5\n'),
      encoder.encode('\n'),
      BODY,
    );
    for (const split of [1, 22, 41, 45]) {
      const d = new SipStreamDecoder();
      expect(d.push(lfMsg.slice(0, split)).ok).toBe(true);
      const r = d.push(lfMsg.slice(split));
      if (!r.ok) throw new Error(r.error.message);
      expect(r.value).toHaveLength(1);
      expect(Array.from(r.value[0]!)).toEqual(Array.from(lfMsg));
    }
  });

  it('returns both messages when two arrive in a single chunk', () => {
    const msgs = messagesFrom([concat(MSG, MSG)]);
    expect(msgs).toHaveLength(2);
    expect(msgs[0]).not.toBe(msgs[1]);
    expect(Array.from(msgs[0]!)).toEqual(Array.from(MSG));
    expect(Array.from(msgs[1]!)).toEqual(Array.from(MSG));
  });

  it('preserves bytes remaining after a complete message', () => {
    const d = new SipStreamDecoder();
    const a = d.push(concat(MSG, MSG.slice(0, 3)));
    if (!a.ok) throw new Error(a.error.message);
    expect(a.value).toHaveLength(1);
    expect(Array.from(a.value[0]!)).toEqual(Array.from(MSG));
    const b = d.push(MSG.slice(3));
    if (!b.ok) throw new Error(b.error.message);
    expect(b.value).toHaveLength(1);
    expect(Array.from(b.value[0]!)).toEqual(Array.from(MSG));
  });

  it('frames three messages across arbitrary chunk boundaries', () => {
    const wire = concat(MSG, MSG, MSG);
    const n: number[] = [1, 23, 60, 2, 41, 15, 5];
    expect(n.reduce((a, b) => a + b, 0)).toBe(wire.byteLength);
    const parts: Uint8Array[] = [];
    let at = 0;
    for (const k of n) {
      parts.push(wire.slice(at, at + k));
      at += k;
    }
    const msgs = messagesFrom(parts);
    expect(msgs).toHaveLength(3);
    for (const m of msgs) expect(Array.from(m)).toEqual(Array.from(MSG));
  });

  it('honors the compact l header across a chunk split', () => {
    const compact = makeMsg('l', 5, 'café');
    const d = new SipStreamDecoder();
    expect(d.push(compact.slice(0, 30)).ok).toBe(true);
    const r = d.push(compact.slice(30));
    if (!r.ok) throw new Error(r.error.message);
    expect(r.value).toHaveLength(1);
    expect(Array.from(r.value[0]!)).toEqual(Array.from(compact));
    expect(bodyText(r.value[0]!)).toBe('café');
  });

  it('accepts repeated equal Content-Length values', () => {
    const repeated = concat(HEAD, encoder.encode('Content-Length: 5\r\nContent-Length: 5\r\n'), TERM, BODY);
    const msgs = messagesFrom([repeated]);
    expect(msgs).toHaveLength(1);
    expect(bodyText(msgs[0]!)).toBe('café');
  });

  it('rejects conflicting Content-Length values and resets', () => {
    const longConflict = concat(HEAD, encoder.encode('Content-Length: 5\r\nContent-Length: 6\r\n'), TERM, BODY);
    const mixedConflict = concat(HEAD, encoder.encode('l: 5\r\nContent-Length: 6\r\n'), TERM, BODY);
    for (const bad of [longConflict, mixedConflict]) {
      const d = new SipStreamDecoder();
      const r = d.push(bad);
      expect(r.ok).toBe(false);
      if (r.ok) throw new Error('expected an error');
      expect(r.error.message).toMatch(/conflicting/i);
      const fresh = d.push(MSG);
      if (!fresh.ok) throw new Error(fresh.error.message);
      expect(fresh.value).toHaveLength(1);
      expect(bodyText(fresh.value[0]!)).toBe('café');
    }
  });

  it('rejects a non-decimal Content-Length and resets', () => {
    const bad = concat(HEAD, encoder.encode('Content-Length: xyz\r\n'), TERM);
    const d = new SipStreamDecoder();
    const r = d.push(bad);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('expected an error');
    expect(r.error.message).toMatch(/Content-Length/i);
    const fresh = d.push(MSG);
    if (!fresh.ok) throw new Error(fresh.error.message);
    expect(fresh.value).toHaveLength(1);
  });

  it('rejects a declared body above the maximum and resets', () => {
    const bad = makeMsg('Content-Length', MAX_BODY + 1, 'x');
    const d = new SipStreamDecoder();
    const r = d.push(bad);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('expected an error');
    expect(r.error.message).toMatch(/body too large/i);
    const fresh = d.push(MSG);
    if (!fresh.ok) throw new Error(fresh.error.message);
    expect(fresh.value).toHaveLength(1);
  });

  it('rejects a header block that cannot terminate within the limit and resets', () => {
    const headless = new Uint8Array(65537).fill(0x61); // 65,537 'a' bytes, no terminator
    const d = new SipStreamDecoder();
    const r = d.push(headless);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('expected an error');
    expect(r.error.message).toMatch(/header block too large/i);
    const fresh = d.push(MSG);
    if (!fresh.ok) throw new Error(fresh.error.message);
    expect(fresh.value).toHaveLength(1);
  });

  it('resets a partial buffer on an explicit reset() call', () => {
    const d = new SipStreamDecoder();
    const first = d.push(MSG.slice(0, 10));
    if (!first.ok) throw new Error(first.error.message);
    expect(first.value).toHaveLength(0);
    d.reset();
    const r = d.push(MSG);
    if (!r.ok) throw new Error(r.error.message);
    expect(r.value).toHaveLength(1);
    expect(bodyText(r.value[0]!)).toBe('café');
  });

  it('emits distinct copied slices, not views into the internal buffer', () => {
    const d = new SipStreamDecoder();
    const r = d.push(concat(MSG, MSG));
    if (!r.ok) throw new Error(r.error.message);
    expect(r.value).toHaveLength(2);
    const [a, b] = r.value;
    expect(a).not.toBe(b);
    expect(Array.from(a!)).toEqual(Array.from(MSG));
    expect(Array.from(b!)).toEqual(Array.from(MSG));
  });

  it('accepts a zero-length body', () => {
    const empty = makeMsg('Content-Length', 0, '');
    const msgs = messagesFrom([empty, empty]);
    expect(msgs).toHaveLength(2);
    expect(Array.from(msgs[0]!)).toEqual(Array.from(empty));
    expect(msgs[0]!.byteLength).toBe(empty.byteLength);
  });
});
