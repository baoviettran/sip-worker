import { describe, expect, it } from 'vitest';
import { DEFAULT_TIMERS, cancel, cancelAll, deriveTimers, schedule } from '../../src/transactions/timers.js';
import { FakeClock } from '../support/fake-clock.js';

describe('deriveTimers', () => {
  it('derives RFC 3261 timers for reliable transports', () => {
    expect(deriveTimers(DEFAULT_TIMERS, true)).toMatchObject({ D: 0, I: 0, J: 0, K: 0, L: 32000, M: 32000 });
  });

  it('derives RFC 3261 timers for unreliable transports', () => {
    expect(deriveTimers(DEFAULT_TIMERS, false)).toMatchObject({ D: 32000, I: 5000, J: 32000, K: 5000 });
  });

  it('scales B/F/H/L/M to 64*T1', () => {
    const derived = deriveTimers(DEFAULT_TIMERS, false);
    expect(derived.B).toBe(64 * DEFAULT_TIMERS.T1);
    expect(derived.F).toBe(64 * DEFAULT_TIMERS.T1);
    expect(derived.H).toBe(64 * DEFAULT_TIMERS.T1);
    expect(derived.L).toBe(64 * DEFAULT_TIMERS.T1);
    expect(derived.M).toBe(64 * DEFAULT_TIMERS.T1);
  });

  it('leaves the base TimerConfig values intact', () => {
    const derived = deriveTimers(DEFAULT_TIMERS, false);
    expect(derived.T1).toBe(DEFAULT_TIMERS.T1);
    expect(derived.T2).toBe(DEFAULT_TIMERS.T2);
    expect(derived.T4).toBe(DEFAULT_TIMERS.T4);
  });
});

describe('schedule / cancel / cancelAll', () => {
  it('schedules a callback returning a numeric Clock id', () => {
    const clock = new FakeClock();
    const called: string[] = [];
    const id = schedule(clock, 1000, () => called.push('run'));
    expect(typeof id).toBe('number');
    expect(called).toEqual([]);
    clock.advance(1000);
    expect(called).toEqual(['run']);
  });

  it('cancel prevents a pending callback from running', () => {
    const clock = new FakeClock();
    const called: string[] = [];
    const id = schedule(clock, 1000, () => called.push('run'));
    cancel(clock, id);
    clock.advance(1000);
    expect(called).toEqual([]);
  });

  it('cancelAll clears every pending timer', () => {
    const clock = new FakeClock();
    const called: string[] = [];
    schedule(clock, 1000, () => called.push('a'));
    schedule(clock, 2000, () => called.push('b'));
    cancelAll(clock);
    clock.advance(2000);
    expect(called).toEqual([]);
  });

  it('cancel of an unknown id is a no-op', () => {
    const clock = new FakeClock();
    expect(() => cancel(clock, 999)).not.toThrow();
  });
});