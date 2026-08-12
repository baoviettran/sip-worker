import { describe, it, expect } from 'vitest';
import { Headers } from '../../src/messages/headers.js';

describe('Headers', () => {
  it('separates append from replacement', () => {
    const h = new Headers();
    h.append('Via', 'one');
    h.append('via', 'two');
    expect(h.getAll('Via')).toEqual(['one', 'two']);
    h.set('Via', 'replacement');
    expect(h.getAll('vIa')).toEqual(['replacement']);
  });

  it('is case-insensitive for lookup', () => {
    const h = new Headers();
    h.append('Content-Type', 'application/sdp');
    expect(h.get('content-type')).toBe('application/sdp');
    expect(h.has('CONTENT-TYPE')).toBe(true);
  });

  it('returns undefined for missing header', () => {
    const h = new Headers();
    expect(h.get('Via')).toBeUndefined();
    expect(h.getAll('Via')).toEqual([]);
    expect(h.has('Via')).toBe(false);
  });

  it('deletes all instances of a header', () => {
    const h = new Headers();
    h.append('Via', 'one');
    h.append('Via', 'two');
    h.delete('via');
    expect(h.has('Via')).toBe(false);
    expect(h.getAll('Via')).toEqual([]);
  });

  it('preserves insertion order in entries', () => {
    const h = new Headers();
    h.append('Via', 'one');
    h.append('From', 'a');
    h.append('To', 'b');
    expect(h.entries().map(([n]) => n)).toEqual(['Via', 'From', 'To']);
  });

  it('clones headers', () => {
    const h = new Headers();
    h.append('Via', 'one');
    const c = h.clone();
    c.set('Via', 'two');
    expect(h.get('Via')).toBe('one');
    expect(c.get('Via')).toBe('two');
  });
});