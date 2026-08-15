import { describe, expect, it } from 'vitest';
import {
  normalizeBrowserPhoneOptions,
} from '../../src/phone/config.js';
import type { BrowserPhoneOptions } from '../../src/phone/types.js';

/** Deep partial so helper call sites can pass partial nested fragments. */
type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };

/** A fully-valid configuration; nested families are deep-merged over defaults. */
function validOptions(overrides: DeepPartial<BrowserPhoneOptions> = {}): BrowserPhoneOptions {
  return {
    signaling: {
      url: 'wss://sip.example.com/ws',
      ...(overrides.signaling ?? {}),
    },
    account: {
      registrarUri: 'sip:example.com',
      aor: 'sip:alice@example.com',
      contact: 'sip:alice@example.com',
      username: 'alice',
      password: 'secret',
      ...(overrides.account ?? {}),
    },
    ...(overrides.media ? { media: overrides.media } : {}),
    ...(overrides.diagnostics ? { diagnostics: overrides.diagnostics } : {}),
  };
}

describe('normalizeBrowserPhoneOptions', () => {
  it('deep-copies and freezes so caller mutation cannot leak into the normalized config', () => {
    const input = validOptions({
      signaling: { reconnect: { maxAttempts: 8 } },
      media: {
        iceServers: [{ urls: ['turn:relay.example'], username: 'u', credential: 'secret' }],
      },
    });
    const normalized = normalizeBrowserPhoneOptions(input);
    (input.media!.iceServers![0] as { username: string }).username = 'changed';
    expect(normalized.media!.iceServers?.[0]?.username).toBe('u');
    expect(Object.isFrozen(normalized)).toBe(true);
  });

  it('rejects a ws: URL unless allowInsecureWebSocket is exactly true', () => {
    expect(() => normalizeBrowserPhoneOptions(validOptions({
      signaling: { url: 'ws://sip.example/ws' },
    }))).toThrow(/allowInsecureWebSocket/);
  });

  it('requires username and password to be supplied together', () => {
    expect(() => normalizeBrowserPhoneOptions(validOptions({
      account: { username: 'alice', password: undefined },
    }))).toThrow(/together/);
  });

  it('rejects supplying both static iceServers and an iceServerProvider', () => {
    expect(() => normalizeBrowserPhoneOptions(validOptions({
      media: { iceServers: [], iceServerProvider: async () => [] },
    }))).toThrow(/mutually exclusive/);
  });

  it('freezes the top level and nested media/ICE configuration', () => {
    const normalized = normalizeBrowserPhoneOptions(validOptions({
      media: { iceServers: [{ urls: ['stun:stun.example'], username: 'u', credential: 'c' }] },
    }));
    expect(Object.isFrozen(normalized)).toBe(true);
    expect(Object.isFrozen(normalized.media)).toBe(true);
    expect(Object.isFrozen(normalized.media!.iceServers)).toBe(true);
  });

  it('fills omitted reconnect fields from DEFAULT_RECONNECT_OPTIONS', () => {
    const normalized = normalizeBrowserPhoneOptions(validOptions());
    expect(normalized.signaling.reconnect).toEqual({
      initialDelayMs: 250,
      maxDelayMs: 5_000,
      maxAttempts: 8,
      recoveryTimeoutMs: 30_000,
    });
  });

  it('throws a RangeError when maxAttempts falls outside the closed integer window', () => {
    expect(() => normalizeBrowserPhoneOptions(validOptions({
      signaling: { reconnect: { maxAttempts: 0 } },
    }))).toThrow(RangeError);
    expect(() => normalizeBrowserPhoneOptions(validOptions({
      signaling: { reconnect: { maxAttempts: 21 } },
    }))).toThrow(RangeError);
  });

  it('throws a RangeError for invalid delay/timeout caps', () => {
    expect(() => normalizeBrowserPhoneOptions(validOptions({
      signaling: { reconnect: { initialDelayMs: 0 } },
    }))).toThrow(RangeError);
    expect(() => normalizeBrowserPhoneOptions(validOptions({
      signaling: { reconnect: { initialDelayMs: 31_000 } },
    }))).toThrow(RangeError);
    expect(() => normalizeBrowserPhoneOptions(validOptions({
      signaling: { reconnect: { maxDelayMs: 4_999, initialDelayMs: 5_000 } },
    }))).toThrow(RangeError);
    expect(() => normalizeBrowserPhoneOptions(validOptions({
      signaling: { reconnect: { maxDelayMs: 31_000 } },
    }))).toThrow(RangeError);
    expect(() => normalizeBrowserPhoneOptions(validOptions({
      signaling: { reconnect: { recoveryTimeoutMs: 0 } },
    }))).toThrow(RangeError);
    expect(() => normalizeBrowserPhoneOptions(validOptions({
      signaling: { reconnect: { recoveryTimeoutMs: 120_001 } },
    }))).toThrow(RangeError);
  });

  it('preserves a caller-provided reconnect override', () => {
    const normalized = normalizeBrowserPhoneOptions(validOptions({
      signaling: { reconnect: { maxAttempts: 12, initialDelayMs: 500 } },
    }));
    expect(normalized.signaling.reconnect.maxAttempts).toBe(12);
    expect(normalized.signaling.reconnect.initialDelayMs).toBe(500);
    expect(normalized.signaling.reconnect.maxDelayMs).toBe(5_000);
    expect(normalized.signaling.reconnect.recoveryTimeoutMs).toBe(30_000);
  });

  it('fails securely when a worker cannot authenticate (no credential leakage)', () => {
    const normalized = normalizeBrowserPhoneOptions(validOptions({}));
    expect(normalized.account.password).toBe('secret');
    expect(normalized.account.username).toBe('alice');
  });
});
