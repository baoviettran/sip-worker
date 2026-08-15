import { SipError } from '../errors.js';
import type { Clock } from '../transport/index.js';

/**
 * Per-operation control options. When provided, `signal` allows the caller to
 * abort the operation early, and `timeoutMs` bounds how long the operation may
 * run before it is forcibly failed.
 */
export interface OperationOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

/**
 * Upper bound for a single operation's timeout, in milliseconds. Prevents a
 * caller from scheduling an effectively-infinite wait.
 */
export const MAX_OPERATION_TIMEOUT_MS = 120_000;

/**
 * Resolve a caller-supplied timeout against a fallback default, validating that
 * the selected value is a finite positive number and clamping it to the maximum
 * allowed operation timeout. Throws {@link RangeError} for non-positive or
 * non-finite values.
 */
export function validateOperationTimeout(value: number | undefined, fallback: number): number {
  const selected = value ?? fallback;
  if (!Number.isFinite(selected) || selected <= 0) {
    throw new RangeError('timeoutMs must be a finite positive number');
  }
  return Math.min(selected, MAX_OPERATION_TIMEOUT_MS);
}

/** Configuration shared by every observeOperation call. */
export interface ObserveOperationConfig {
  readonly clock: Clock;
  readonly operation: string;
  readonly defaultTimeoutMs: number;
  readonly options?: OperationOptions;
  readonly onAbort?: () => void | Promise<void>;
}

/**
 * Observe a caller-supplied source promise and race it against an injected
 * clock timeout and an optional abort signal.
 *
 * The caller is rejected with a fixed {@link SipError}: `OPERATION_ABORTED`
 * when the abort signal fires and `OPERATION_TIMEOUT` when the injected clock
 * elapses the operation timeout first. Both the abort listener and the clock
 * timer are detached on first settlement, while the source promise is left
 * running so already-sent SIP work can reconcile. The source's own rejection
 * is consumed internally so that it never surfaces as an unhandled rejection,
 * even when abort/timeout wins the race first.
 *
 * Only the injected clock is used — no ambient timer is ever constructed.
 */
export function observeOperation<T>(source: Promise<T>, config: ObserveOperationConfig): Promise<T> {
  const { clock, operation, defaultTimeoutMs, options, onAbort } = config;
  const timeoutMs = validateOperationTimeout(options?.timeoutMs, defaultTimeoutMs);
  const signal = options?.signal;

  // Consume the source's eventual rejection regardless of the race outcome so
  // it never becomes an unhandled rejection.
  source.catch(() => undefined);

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let timerId = -1;

    const cleanup = (): void => {
      settled = true;
      if (signal) signal.removeEventListener('abort', onAbortFire);
      clock.clearTimeout(timerId);
    };

    const settle = (): void => {
      if (settled) return;
      cleanup();
    };

    const onAbortFire = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      if (onAbort) {
        // Fire-and-forget: failures must not propagate to the caller.
        void Promise.resolve().then(onAbort).catch(() => undefined);
      }
      reject(new SipError(0, `${operation} aborted`, 'OPERATION_ABORTED'));
    };

    source.then(
      (value) => {
        settle();
        resolve(value);
      },
      (reason) => {
        settle();
        reject(reason as Error);
      },
    );

    const onTimeout = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new SipError(0, `${operation} timed out`, 'OPERATION_TIMEOUT'));
    };

    timerId = clock.setTimeout(onTimeout, timeoutMs);

    if (signal) {
      if (signal.aborted) {
        onAbortFire();
        return;
      }
      signal.addEventListener('abort', onAbortFire);
    }
  });
}
