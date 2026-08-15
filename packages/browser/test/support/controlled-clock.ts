/**
 * Deterministic fake clock for vitest browser/recovery tests.
 *
 * Mirrors {@link Clock} (`now`, `setTimeout`, `clearTimeout`) but records the
 * delay of the most recently armed timer (`nextDelay()`), advances pending
 * timers explicitly (`advance`), and reports how many timers are still pending
 * (`pendingCount`). Every test must leave `pendingCount` at zero.
 */
export class ControlledClock {
  private lastDelay = 0;
  private nextId = 1;
  private readonly timers = new Map<number, { at: number; cb: () => void }>();
  private nowMs = 0;

  now(): number {
    return this.nowMs;
  }

  setTimeout(callback: () => void, delayMs: number): number {
    this.lastDelay = delayMs;
    const id = this.nextId;
    this.nextId += 1;
    this.timers.set(id, { at: this.nowMs + delayMs, cb: callback });
    return id;
  }

  clearTimeout(id: number): void {
    this.timers.delete(id);
  }

  /** The delay of the most recently armed timer (0 when none). */
  nextDelay(): number {
    return this.lastDelay;
  }

  /** How many timers are still pending (not yet fired or cleared). */
  get pendingCount(): number {
    return this.timers.size;
  }

  /** Run every pending timer whose deadline is <= `now + ms`, then advance time. */
  advance(ms: number): void {
    if (ms <= 0) return;
    this.nowMs += ms;
    const due = [...this.timers.entries()].filter(([, timer]) => timer.at <= this.nowMs);
    due.sort((a, b) => a[1].at - b[1].at);
    for (const [id, timer] of due) {
      // A timer may have been cleared while an earlier due timer ran.
      if (!this.timers.has(id)) continue;
      this.timers.delete(id);
      timer.cb();
    }
  }
}
