import { describe, expect, it } from 'vitest';
import type { TransportEvent } from '../packages/core/src/transport/transport.js';
import { CountingClock, countSubscriptions } from './measure.js';

const realClock = { now: () => Date.now(), setTimeout, clearTimeout };
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 10));

describe('CountingClock', () => {
  it('counts armed timers and decrements on clearTimeout', async () => {
    const clock = new CountingClock(realClock);
    const a = clock.setTimeout(() => {}, 60_000);
    const b = clock.setTimeout(() => {}, 60_000);
    expect(clock.pending()).toBe(2);
    clock.clearTimeout(a);
    expect(clock.pending()).toBe(1);
    clock.clearTimeout(b);
    expect(clock.pending()).toBe(0);
  });

  it('decrements when a timer fires on its own', async () => {
    const clock = new CountingClock(realClock);
    let fired = 0;
    const id = clock.setTimeout(() => { fired += 1; }, 0);
    expect(clock.pending()).toBe(1);
    await tick();
    expect(fired).toBe(1);
    expect(clock.pending()).toBe(0);
    void id;
  });

  it('delegates now() to the underlying clock', () => {
    const clock = new CountingClock({ now: () => 42, setTimeout, clearTimeout });
    expect(clock.now()).toBe(42);
  });
});

describe('countSubscriptions', () => {
  it('counts live transport subscribers', () => {
    const listeners = new Set<(event: TransportEvent) => void>();
    const transport = {
      subscribe: (listener: (event: TransportEvent) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
    const counter = countSubscriptions(transport);
    const detach1 = transport.subscribe(() => {});
    const detach2 = transport.subscribe(() => {});
    expect(counter.count()).toBe(2);
    detach1();
    expect(counter.count()).toBe(1);
    detach2();
    expect(counter.count()).toBe(0);
  });
});
