import { describe, expect, it } from 'vitest';
import {
  assertTransition,
  type TransitionTable,
} from '../../src/transactions/transitions.js';

describe('assertTransition', () => {
  const table = { A: ['B'], B: ['C'], C: [] } as const satisfies TransitionTable<'A' | 'B' | 'C'>;

  it('allows a listed edge', () => {
    expect(() => assertTransition(table, 'A', 'B')).not.toThrow();
  });

  it('allows a self-transition', () => {
    expect(() => assertTransition(table, 'B', 'B')).not.toThrow();
  });

  it('throws on an unlisted edge', () => {
    expect(() => assertTransition(table, 'A', 'C')).toThrow(/invalid transaction state transition: A -> C/);
  });

  it('throws when the source row is missing', () => {
    expect(() => assertTransition({} as TransitionTable<'A'>, 'A', 'B')).toThrow(/invalid transaction state transition: A -> B/);
  });
});

import { INVITE_CLIENT_TRANSITIONS } from '../../src/transactions/invite-client.js';

describe('INVITE_CLIENT_TRANSITIONS', () => {
  it('contains exactly the RFC edges', () => {
    expect(INVITE_CLIENT_TRANSITIONS).toEqual({
      Calling: ['Proceeding', 'Accepted', 'Completed', 'Terminated'],
      Proceeding: ['Accepted', 'Completed', 'Terminated'],
      Accepted: ['Terminated'],
      Completed: ['Terminated'],
      Terminated: [],
    });
  });
});

import { INVITE_SERVER_TRANSITIONS } from '../../src/transactions/invite-server.js';

describe('INVITE_SERVER_TRANSITIONS', () => {
  it('contains exactly the RFC edges', () => {
    expect(INVITE_SERVER_TRANSITIONS).toEqual({
      Proceeding: ['Accepted', 'Completed', 'Terminated'],
      Accepted: ['Terminated'],
      Completed: ['Confirmed', 'Terminated'],
      Confirmed: ['Terminated'],
      Terminated: [],
    });
  });
});
