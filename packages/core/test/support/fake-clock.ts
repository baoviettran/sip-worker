import type { Clock } from '../../src/transport/index.js';

interface Timer {
  readonly due: number;
  readonly callback: () => void;
}

export class FakeClock implements Clock {
  private currentTime = 0;
  private nextId = 1;
  private readonly timers = new Map<number, Timer>();

  now(): number {
    return this.currentTime;
  }

  setTimeout(callback: () => void, delayMs: number): number {
    const id = this.nextId;
    this.nextId += 1;
    this.timers.set(id, { due: this.currentTime + Math.max(0, delayMs), callback });
    return id;
  }

  clearTimeout(id: number): void {
    this.timers.delete(id);
  }

  /** Number of outstanding timers. */
  pending(): number {
    return this.timers.size;
  }

  advance(ms: number): void {
    const target = this.currentTime + ms;
    let next = this.nextTimer(target);
    while (next !== undefined) {
      this.timers.delete(next.id);
      this.currentTime = next.timer.due;
      next.timer.callback();
      next = this.nextTimer(target);
    }
    this.currentTime = target;
  }

  private nextTimer(target: number): { id: number; timer: Timer } | undefined {
    let next: { id: number; timer: Timer } | undefined;
    for (const [id, timer] of this.timers) {
      if (timer.due > target) continue;
      if (next === undefined || timer.due < next.timer.due || (timer.due === next.timer.due && id < next.id)) {
        next = { id, timer };
      }
    }
    return next;
  }
}
