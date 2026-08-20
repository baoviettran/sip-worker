import type { Clock, TransportEvent } from '../packages/core/src/transport/transport.js';

/**
 * Clock wrapper that counts currently-armed timers. The id leaves the pending
 * set when the timer fires OR is cancelled, so `pending()` is the exact number
 * of timers armed right now — a timer that fires naturally is not counted as a
 * leak.
 */
export class CountingClock implements Clock {
  private readonly pendingIds = new Set<number>();

  constructor(private readonly clock: Clock) {}

  now(): number {
    return this.clock.now();
  }

  setTimeout(callback: () => void, delayMs: number): number {
    const id = this.clock.setTimeout(() => {
      this.pendingIds.delete(id);
      callback();
    }, delayMs);
    this.pendingIds.add(id);
    return id;
  }

  clearTimeout(id: number): void {
    this.pendingIds.delete(id);
    this.clock.clearTimeout(id);
  }

  /** Number of timers currently armed (not yet fired or cancelled). */
  pending(): number {
    return this.pendingIds.size;
  }
}

export interface SubscriptionCounter {
  count(): number;
}

/**
 * Wrap a transport's `subscribe` so every subscriber is counted. Must be
 * installed before the UA is constructed. The soak's FakeTransport is owned by
 * the harness, so shadowing the instance method is safe.
 */
export function countSubscriptions(transport: {
  subscribe(listener: (event: TransportEvent) => void): () => void;
}): SubscriptionCounter {
  const baseSubscribe = transport.subscribe.bind(transport);
  let current = 0;
  const wrapped = ((listener: (event: TransportEvent) => void) => {
    current += 1;
    const unsubscribe = baseSubscribe(listener);
    return () => {
      current -= 1;
      unsubscribe();
    };
  }) as typeof transport.subscribe;
  transport.subscribe = wrapped;
  return { count: () => current };
}
