import { describe, expect, it } from 'vitest';
import { observeOperation, validateOperationTimeout } from '../../src/ua/index.js';
import { FakeClock } from '../support/fake-clock.js';

/** A manually-controlled deferred, mirroring the resolver pattern used in ua tests. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (reason: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Flush microtasks so fire-and-forget rejections settle. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('validateOperationTimeout', () => {
  it('rejects non-positive or non-finite timeouts', () => {
    expect(() => validateOperationTimeout(0, 30_000)).toThrow(RangeError);
    expect(() => validateOperationTimeout(-1, 30_000)).toThrow(RangeError);
    expect(() => validateOperationTimeout(Number.POSITIVE_INFINITY, 30_000)).toThrow(RangeError);
    expect(() => validateOperationTimeout(Number.NaN, 30_000)).toThrow(RangeError);
  });

  it('falls back to the default when timeout is undefined', () => {
    expect(validateOperationTimeout(undefined, 30_000)).toBe(30_000);
  });

  it('clamps timeouts to the maximum operation timeout', () => {
    expect(validateOperationTimeout(500_000, 30_000)).toBe(120_000);
    expect(validateOperationTimeout(10_000, 30_000)).toBe(10_000);
  });
});

describe('observeOperation', () => {
  it('rejects the caller with OPERATION_ABORTED and clears the timer on abort', async () => {
    const clock = new FakeClock();
    const abort = new AbortController();
    const source = deferred<void>();

    const observed = observeOperation(source.promise, {
      clock,
      operation: 'register',
      defaultTimeoutMs: 30_000,
      options: { signal: abort.signal, timeoutMs: 1_000 },
    });

    abort.abort();
    await expect(observed).rejects.toMatchObject({ code: 'OPERATION_ABORTED' });
    source.resolve();
    await flush();

    expect(clock.pending()).toBe(0);
    expect(abort.signal.aborted).toBe(true);
  });

  it('rejects with OPERATION_TIMEOUT when the injected clock elapses and clears timer + listener', async () => {
    const clock = new FakeClock();
    const abort = new AbortController();
    const source = deferred<void>();

    const observed = observeOperation(source.promise, {
      clock,
      operation: 'register',
      defaultTimeoutMs: 30_000,
      options: { signal: abort.signal, timeoutMs: 1_000 },
    });

    clock.advance(1_000);
    await expect(observed).rejects.toMatchObject({ code: 'OPERATION_TIMEOUT' });
    source.reject(new Error('late failure'));
    await flush();

    // The former source rejection must be consumed, not surface as unhandled.
    expect(clock.pending()).toBe(0);
  });

  it('resolves through the source when it wins before abort/timeout', async () => {
    const clock = new FakeClock();
    const abort = new AbortController();
    const source = deferred<string>();

    const observed = observeOperation(source.promise, {
      clock,
      operation: 'register',
      defaultTimeoutMs: 30_000,
      options: { signal: abort.signal, timeoutMs: 1_000 },
    });

    source.resolve('ok');
    await expect(observed).resolves.toBe('ok');
    await flush();

    expect(clock.pending()).toBe(0);
  });

  it('invokes onAbort fire-and-forget when abort fires', async () => {
    const clock = new FakeClock();
    const abort = new AbortController();
    const source = deferred<void>();
    let fired = 0;

    const observed = observeOperation(source.promise, {
      clock,
      operation: 'register',
      defaultTimeoutMs: 30_000,
      options: { signal: abort.signal },
      onAbort: () => {
        fired += 1;
      },
    });

    abort.abort();
    await expect(observed).rejects.toMatchObject({ code: 'OPERATION_ABORTED' });
    source.resolve();
    await flush();

    expect(fired).toBe(1);
    expect(clock.pending()).toBe(0);
  });
});
