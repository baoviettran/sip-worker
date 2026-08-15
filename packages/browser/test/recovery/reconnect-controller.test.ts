import { describe, expect, it } from 'vitest';
import { ReconnectController } from '../../src/recovery/index.js';
import type { ReconnectOptions } from '../../src/phone/types.js';
import { ControlledClock } from '../support/controlled-clock.js';

/** Emits online/offline and records its own subscription activity. */
class FakeLifecycle {
  online = true;
  onlineListeners = new Set<() => void>();
  offlineListeners = new Set<() => void>();
  removeCount = 0;

  isOnline(): boolean {
    return this.online;
  }

  subscribeOnline(listener: () => void): () => void {
    this.onlineListeners.add(listener);
    return () => {
      this.onlineListeners.delete(listener);
      this.removeCount += 1;
    };
  }

  subscribeOffline(listener: () => void): () => void {
    this.offlineListeners.add(listener);
    return () => {
      this.offlineListeners.delete(listener);
      this.removeCount += 1;
    };
  }

  emitOnline(): void {
    this.online = true;
    for (const listener of [...this.onlineListeners]) listener();
  }

  emitOffline(): void {
    this.online = false;
    for (const listener of [...this.offlineListeners]) listener();
  }
}

interface Harness {
  controller: ReconnectController;
  clock: ControlledClock;
  lifecycle: FakeLifecycle;
  connectCalls: () => number;
  rejectAttempt: (error: unknown) => void;
  resolveAttempt: () => void;
  setRandom: (value: number) => void;
  attempts: () => number;
  stopSignals: () => number;
  options: ReconnectOptions;
}

function buildController(
  overrides: Partial<ReconnectOptions> = {},
  diagnostics: () => void = () => {},
): Harness {
  const clock = new ControlledClock();
  const lifecycle = new FakeLifecycle();
  const options: ReconnectOptions = {
    initialDelayMs: 250,
    maxDelayMs: 5_000,
    maxAttempts: 8,
    recoveryTimeoutMs: 30_000,
    ...overrides,
  };

  let randomValue = 0.5;
  const random = (): number => randomValue;

  let connectCount = 0;
  let stopCount = 0;
  let currentMonitor: { onSuccess: () => void; onFailure: (reason: unknown) => void } | undefined;

  const controller = new ReconnectController(options, {
    clock,
    random,
    lifecycle,
    connect: (monitor) => {
      connectCount += 1;
      currentMonitor = monitor;
      return () => {
        stopCount += 1;
        currentMonitor = undefined;
      };
    },
    diagnostics,
  });

  return {
    controller,
    clock,
    lifecycle,
    connectCalls: () => connectCount,
    rejectAttempt: (error: unknown) => {
      currentMonitor?.onFailure(error);
    },
    resolveAttempt: () => {
      currentMonitor?.onSuccess();
    },
    setRandom: (value: number) => {
      randomValue = value;
    },
    attempts: () => connectCount,
    stopSignals: () => stopCount,
    options,
  };
}

describe('ReconnectController', () => {
  it('retries with full jitter, pauses offline, resumes online, and exhausts on deadline', async () => {
    const h = buildController();
    const { controller, clock, lifecycle } = h;

    const recovery = controller.recover();
    expect(h.connectCalls()).toBe(1); // immediate attempt
    h.rejectAttempt(new Error('one'));
    expect(clock.nextDelay()).toBe(125); // random=.5, ceiling=250
    clock.advance(125);
    expect(h.connectCalls()).toBe(2);

    lifecycle.emitOffline();
    h.rejectAttempt(new Error('two'));
    clock.advance(5_000);
    expect(h.connectCalls()).toBe(2); // offline pauses new sockets
    lifecycle.emitOnline();
    expect(h.connectCalls()).toBe(3); // immediate hint-triggered try

    clock.advance(30_000);
    await expect(recovery).rejects.toMatchObject({
      code: 'CONNECTION_RECOVERY_EXHAUSTED',
    });
    expect(clock.pendingCount).toBe(0);
    controller.dispose();
  });

  it('exhausts after maxAttempts attempts rather than looping forever', async () => {
    const h = buildController({ maxAttempts: 3 });
    const { controller, clock } = h;

    const recovery = controller.recover();
    expect(h.connectCalls()).toBe(1);
    h.rejectAttempt(new Error('one'));
    expect(clock.nextDelay()).toBe(125); // n=2
    clock.advance(125);
    expect(h.connectCalls()).toBe(2);
    h.rejectAttempt(new Error('two'));
    expect(clock.nextDelay()).toBe(250); // n=3
    clock.advance(250);
    expect(h.connectCalls()).toBe(3);
    h.rejectAttempt(new Error('three'));

    await expect(recovery).rejects.toMatchObject({
      code: 'CONNECTION_RECOVERY_EXHAUSTED',
    });
    expect(clock.pendingCount).toBe(0);
    controller.dispose();
  });

  it('shares exactly one recovery promise and one cycle across concurrent calls', async () => {
    const h = buildController({ maxAttempts: 1 });
    const { controller, clock } = h;

    const first = controller.recover();
    const second = controller.recover();
    expect(second).toBe(first);
    expect(h.connectCalls()).toBe(1);
    expect(clock.pendingCount).toBe(1); // one total deadline only

    h.rejectAttempt(new Error('one')); // only attempt -> exhaustion
    await expect(first).rejects.toMatchObject({
      code: 'CONNECTION_RECOVERY_EXHAUSTED',
    });
    expect(clock.pendingCount).toBe(0);
    controller.dispose();
  });

  it('resolves recovery when an attempt succeeds', async () => {
    const h = buildController();
    const { controller, clock } = h;

    const recovery = controller.recover();
    expect(h.connectCalls()).toBe(1);
    h.resolveAttempt();
    await expect(recovery).resolves.toBeUndefined();
    expect(clock.pendingCount).toBe(0);
    controller.dispose();
  });

  it('cancels an active cycle, detaches timers, and allows a fresh cycle', async () => {
    const h = buildController();
    const { controller, clock } = h;

    const recovery = controller.recover();
    expect(h.connectCalls()).toBe(1);
    controller.cancel();
    await expect(recovery).rejects.toMatchObject({ code: 'OPERATION_ABORTED' });
    expect(clock.pendingCount).toBe(0);

    const next = controller.recover();
    expect(h.connectCalls()).toBe(2);
    h.resolveAttempt();
    await expect(next).resolves.toBeUndefined();
    expect(clock.pendingCount).toBe(0);
    controller.dispose();
  });

  it('does not re-arm or run new sockets after dispose while a timer is pending', async () => {
    const h = buildController();
    const { controller, clock } = h;

    const recovery = controller.recover();
    expect(h.connectCalls()).toBe(1);
    h.rejectAttempt(new Error('one'));
    expect(clock.nextDelay()).toBe(125);
    expect(clock.pendingCount).toBe(2); // retry + deadline

    controller.dispose();
    expect(clock.pendingCount).toBe(0);

    clock.advance(10_000);
    expect(h.connectCalls()).toBe(1);
    await expect(recovery).rejects.toMatchObject({ code: 'OPERATION_ABORTED' });
  });

  it('ignores a stale in-flight attempt that settles after the cycle ends', async () => {
    const h = buildController();
    const { controller, clock } = h;

    const recovery = controller.recover();
    expect(h.connectCalls()).toBe(1);
    controller.cancel();
    await expect(recovery).rejects.toMatchObject({ code: 'OPERATION_ABORTED' });

    h.rejectAttempt(new Error('late'));
    expect(h.connectCalls()).toBe(1);
    expect(clock.pendingCount).toBe(0);

    const next = controller.recover();
    expect(h.connectCalls()).toBe(2);
    h.resolveAttempt();
    await expect(next).resolves.toBeUndefined();
    expect(clock.pendingCount).toBe(0);
    controller.dispose();
  });

  it('maps random=0 to a zero retry delay', async () => {
    const h = buildController();
    const { controller, clock } = h;

    const recovery = controller.recover();
    expect(h.connectCalls()).toBe(1);
    h.setRandom(0);
    h.rejectAttempt(new Error('one'));
    expect(clock.nextDelay()).toBe(0); // floor(0 * ceiling)
    controller.cancel();
    await expect(recovery).rejects.toMatchObject({ code: 'OPERATION_ABORTED' });
    controller.dispose();
  });

  it('maps the 0.999 endpoint to the floored ceiling', async () => {
    const h = buildController();
    const { controller, clock } = h;

    const recovery = controller.recover();
    expect(h.connectCalls()).toBe(1);
    h.setRandom(0.999);
    h.rejectAttempt(new Error('one'));
    expect(clock.nextDelay()).toBe(Math.floor(0.999 * 250));
    controller.cancel();
    await expect(recovery).rejects.toMatchObject({ code: 'OPERATION_ABORTED' });
    controller.dispose();
  });

  it('counts offline time against the total deadline without pausing it', async () => {
    const h = buildController();
    const { controller, clock, lifecycle } = h;

    const recovery = controller.recover();
    expect(h.connectCalls()).toBe(1);
    lifecycle.emitOffline();
    h.rejectAttempt(new Error('offline-first'));
    clock.advance(25_000);
    expect(h.connectCalls()).toBe(1); // offline pauses new sockets
    clock.advance(10_000); // 35s total exceeds the 30s deadline
    await expect(recovery).rejects.toMatchObject({
      code: 'CONNECTION_RECOVERY_EXHAUSTED',
    });
    expect(clock.pendingCount).toBe(0);
    controller.dispose();
  });

  it('keeps recovery alive when a diagnostics sink throws', async () => {
    const { controller, clock } = buildController({}, () => {
      throw new Error('boom');
    });
    const recovery = controller.recover();
    expect(clock.pendingCount).toBe(1);
    controller.dispose();
    await expect(recovery).rejects.toMatchObject({ code: 'OPERATION_ABORTED' });
    expect(clock.pendingCount).toBe(0);
  });
});
