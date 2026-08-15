/**
 * Phone configuration normalization: copy, validate, then freeze (v0.7).
 *
 * Configuration becomes immutable at construction so caller mutation after the
 * constructor cannot alter an active phone. Credentials remain application
 * owned; `ws:` requires explicit opt-in; static ICE servers and an async
 * provider are mutually exclusive.
 */

import { validateBrowserMediaOptions } from '../media/index.js';
import type {
  BrowserPhoneOptions,
  NormalizedBrowserPhoneOptions,
  NormalizedMediaPhoneOptions,
  ReconnectOptions,
} from './types.js';
import {
  MAX_RECONNECT_ATTEMPTS,
  MAX_RECONNECT_DELAY_MS,
  MAX_RECOVERY_TIMEOUT_MS,
  MIN_RECONNECT_ATTEMPTS,
  DEFAULT_RECONNECT_OPTIONS,
} from './types.js';

/**
 * Copy + freeze a plain configuration subtree so it cannot be mutated by the
 * caller later, nor leak later caller mutations into an active configuration.
 */
function copyAndFreeze<T>(value: T): T {
  if (Array.isArray(value)) {
    return Object.freeze(value.map((entry) => copyAndFreeze(entry))) as T;
  }
  if (value !== null && typeof value === 'object') {
    const copied: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      copied[key] = copyAndFreeze(entry);
    }
    return Object.freeze(copied) as T;
  }
  return value;
}

function assertFiniteInt(value: number, name: string, min: number, max: number): void {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new RangeError(
      `${name} must be an integer from ${min} to ${max}; got ${String(value)}.`,
    );
  }
}

function assertFinitePositiveCapped(value: number, name: string, cap: number): void {
  if (!Number.isFinite(value) || value <= 0 || value > cap) {
    throw new RangeError(
      `${name} must be a finite positive number (ms) capped at ${cap}; got ${String(value)}.`,
    );
  }
}

/** Fill omitted reconnect fields from {@link DEFAULT_RECONNECT_OPTIONS}. */
function normalizeReconnect(partial?: Partial<ReconnectOptions>): Readonly<ReconnectOptions> {
  const reconnect: ReconnectOptions = { ...DEFAULT_RECONNECT_OPTIONS, ...partial };

  assertFiniteInt(
    reconnect.maxAttempts,
    'maxAttempts',
    MIN_RECONNECT_ATTEMPTS,
    MAX_RECONNECT_ATTEMPTS,
  );
  assertFinitePositiveCapped(reconnect.initialDelayMs, 'initialDelayMs', MAX_RECONNECT_DELAY_MS);
  assertFinitePositiveCapped(reconnect.maxDelayMs, 'maxDelayMs', MAX_RECONNECT_DELAY_MS);
  assertFinitePositiveCapped(
    reconnect.recoveryTimeoutMs,
    'recoveryTimeoutMs',
    MAX_RECOVERY_TIMEOUT_MS,
  );

  if (reconnect.maxDelayMs < reconnect.initialDelayMs) {
    throw new RangeError(
      `maxDelayMs must be at least initialDelayMs; got maxDelayMs=${String(reconnect.maxDelayMs)}, ` +
      `initialDelayMs=${String(reconnect.initialDelayMs)}.`,
    );
  }

  return Object.freeze(reconnect);
}

/**
 * Validate and normalize the full product configuration. Returns a frozen,
 * deeply-copied {@link NormalizedBrowserPhoneOptions}.
 *
 * Throws:
 * - {@link RangeError} on any reconnect cap violation.
 * - {@link RangeError} matching `/ws/` protection for a `ws:` URL unless
 *   `allowInsecureWebSocket` is exactly `true`.
 * - {@link Error} matching `/together/` when username/password are not both
 *   supplied together.
 * - {@link Error} matching `/mutually exclusive/` when both static
 *   `iceServers` and an `iceServerProvider` are supplied.
 */
export function normalizeBrowserPhoneOptions(
  options: BrowserPhoneOptions,
): Readonly<NormalizedBrowserPhoneOptions> {
  const { signaling, account, media, diagnostics } = options;

  const allowInsecureWebSocket = signaling.allowInsecureWebSocket === true;
  if (signaling.url.startsWith('ws:') && !allowInsecureWebSocket) {
    throw new RangeError(
      `Refusing insecure 'ws:' signaling URL '${signaling.url}'. ` +
      `Set signaling.allowInsecureWebSocket === true to allow it (development only). ` +
      `Browsers still enforce mixed-content regardless.`,
    );
  }

  if ((account.username === undefined) !== (account.password === undefined)) {
    throw new RangeError(
      'account.username and account.password must be supplied together or both omitted.',
    );
  }

  if (media !== undefined && media.iceServers !== undefined && media.iceServerProvider !== undefined) {
    throw new RangeError(
      'media.iceServers and media.iceServerProvider are mutually exclusive.',
    );
  }

  const reconnect = normalizeReconnect(signaling.reconnect);

  const normalizedMedia = media === undefined
    ? undefined
    : normalizeMediaPhoneOptions(media);

  return Object.freeze({
    signaling: Object.freeze({
      url: signaling.url,
      allowInsecureWebSocket,
      reconnect,
    }),
    account: Object.freeze({
      registrarUri: account.registrarUri,
      aor: account.aor,
      contact: account.contact,
      username: account.username,
      password: account.password,
    }),
    media: normalizedMedia,
    diagnostics: diagnostics === undefined || diagnostics.logger === undefined
      ? undefined
      : Object.freeze({ logger: diagnostics.logger }),
  });
}

function normalizeMediaPhoneOptions(
  media: Exclude<BrowserPhoneOptions['media'], undefined>,
): Readonly<NormalizedMediaPhoneOptions> {
  // Reuse the existing v0.5 media validation for copy + freeze + timeout caps.
  const validated = validateBrowserMediaOptions(media);

  const holdDirection = media.holdDirection ?? 'sendonly';

  return Object.freeze({
    ...validated,
    iceServerProvider: media.iceServerProvider === undefined
      ? undefined : copyAndFreeze(media.iceServerProvider),
    holdDirection,
  });
}
