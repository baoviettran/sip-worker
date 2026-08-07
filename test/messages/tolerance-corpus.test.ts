import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseMessage } from '../../src/messages/parser.js';
import { isRequest } from '../../src/messages/message.js';

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'tolerance');

function readFixture(name: string): Uint8Array {
  return new Uint8Array(readFileSync(join(fixturesDir, name)));
}

const decoder = new TextDecoder('utf-8');

/**
 * Tolerance classification table (malformed-message corpus).
 * Each row: fixture bytes → expected outcome. Every fixture, malformed or not,
 * must satisfy the never-throw invariant.
 */
interface Case {
  name: string;
  accepted: boolean;
  /** When rejected, the byte offset of the first offending byte; when accepted, optional body/header assertions. */
  offset?: number;
  checkAccepted?: (bytes: Uint8Array) => void;
}
const CASES: Case[] = [
  {
    // Bare LF line endings are a compatibility input: accepted.
    name: 'bare-lf.sip',
    accepted: true,
    checkAccepted: (b) => {
      const r = parseMessage(b);
      if (!r.ok) throw new Error(`expected ok, got ${r.error.message} at ${r.error.offset}`);
      expect(isRequest(r.value)).toBe(true);
      if (isRequest(r.value)) expect(r.value.method).toBe('OPTIONS');
    },
  },
  {
    // Obsolete folded headers are a compatibility input: accepted, normalized to one space.
    name: 'folded-header.sip',
    accepted: true,
    checkAccepted: (b) => {
      const r = parseMessage(b);
      if (!r.ok) throw new Error(`expected ok, got ${r.error.message} at ${r.error.offset}`);
      // ' First tiny' + 'second part' fold into 'First tiny second part'
      expect(r.value.headers.get('Via')).toBe('SIP/2.0/UDP host:5060;branch=z9hG4bK0 First tiny second part');
    },
  },
  {
    // Conflicting duplicate Content-Length is rejected; offset = first value byte of the conflicting header.
    name: 'duplicate-content-length.sip',
    accepted: false,
    offset: 58, // index of '6' in the second 'Content-Length: 6'
    // 68-byte fixture; second value '6' at byte 57.
  },
  {
    // A line that cannot be a request or a response start line is rejected.
    name: 'invalid-start-line.sip',
    accepted: false,
    offset: 0,
  },
  {
    // Declared body longer than the supplied bytes is rejected; offset = end of the truncated input.
    name: 'truncated-body.sip',
    accepted: false,
    offset: 184, // total byte length: fewer bytes than Content-Length: 50
  },
  {
    // A body with bytes that are invalid UTF-8 is accepted; raw body bytes are preserved.
    name: 'non-utf8-body.sip',
    accepted: true,
    checkAccepted: (b) => {
      const r = parseMessage(b);
      if (!r.ok) throw new Error(`expected ok, got ${r.error.message} at ${r.error.offset}`);
      expect(r.value.body.byteLength).toBe(6);
      expect(decoder.decode(r.value.body.slice(0, 4))).toBe('v=0\n');
      expect(Array.from(r.value.body.slice(4))).toEqual([0x80, 0x81]);
    },
  },
  {
    // Header block exceeding MAX_HEADER_BLOCK (65536) is rejected at the limit.
    name: 'oversized-header.sip',
    accepted: false,
    offset: 65536,
  },
];

describe('malformed-message tolerance corpus', () => {
  for (const c of CASES) {
    it(`${c.accepted ? 'accepts' : 'rejects'} ${c.name}`, () => {
      const bytes = readFixture(c.name);
      // Never-throw invariant: the parser must not raise on any input.
      let result: ReturnType<typeof parseMessage>;
      expect(() => {
        result = parseMessage(bytes);
      }).not.toThrow();

      // Separate classification assertion.
      const r = result!;
      expect(r.ok).toBe(c.accepted);
      if (c.accepted) {
        c.checkAccepted?.(bytes);
      } else if (!r.ok) {
        expect(Number.isInteger(r.error.offset)).toBe(true);
        expect(r.error.offset).toBe(c.offset);
      }
    });
  }
});
