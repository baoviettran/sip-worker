import type { Clock } from '../transport/transport.js';
import { DEFAULT_TIMERS, type DerivedTimers, type TimerConfig } from './types.js';

/**
 * Derive the RFC 3261 transaction timers from a base configuration.
 *
 * B/F/H/L/M all scale to 64*T1 (the maximum retransmission interval). D is the
 * time a UAS transaction waits for a retransmission of the request before
 * terminating (T4 for reliable transports, 32 seconds for unreliable ones).
 * I/J/K are only meaningful for unreliable transports: I and K use T4, while J
 * scales to 64*T1. On reliable transports these collapse to 0.
 */
export function deriveTimers(config: TimerConfig, reliable: boolean): DerivedTimers {
  const max = 64 * config.T1;
  return {
    T1: config.T1,
    T2: config.T2,
    T4: config.T4,
    B: max,
    D: reliable ? 0 : Math.max(32000, 64 * config.T1),
    F: max,
    H: max,
    I: reliable ? 0 : config.T4,
    J: reliable ? 0 : max,
    K: reliable ? 0 : config.T4,
    L: max,
    M: max,
  };
}

const scheduledIds = new WeakMap<Clock, Set<number>>();

/** Schedule `callback` to run after `delayMs` on the injected Clock, returning its numeric id. */
export function schedule(clock: Clock, delayMs: number, callback: () => void): number {
  const id = clock.setTimeout(callback, delayMs);
  let ids = scheduledIds.get(clock);
  if (ids === undefined) {
    ids = new Set();
    scheduledIds.set(clock, ids);
  }
  ids.add(id);
  return id;
}

/** Cancel a pending timer by its Clock id. Safe to call with an unknown id. */
export function cancel(clock: Clock, id: number): void {
  clock.clearTimeout(id);
  scheduledIds.get(clock)?.delete(id);
}

/** Cancel every timer scheduled on the Clock. */
export function cancelAll(clock: Clock): void {
  const ids = scheduledIds.get(clock);
  if (ids === undefined) return;
  for (const id of ids) clock.clearTimeout(id);
  ids.clear();
}

export { DEFAULT_TIMERS };
export type { DerivedTimers, TimerConfig } from './types.js';
