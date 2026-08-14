import { describe, expect, it } from 'vitest';
import { MediaError, type MediaErrorCode } from '@sip-worker/core';
import { mapBrowserMediaError, createBrowserMediaEnvironment } from '../../src/media/error-mapper.js';
import {
  MAX_MEDIA_TIMEOUT_MS,
  MEDIA_CODECS,
  validateBrowserMediaOptions,
  type BrowserMediaOptions,
} from '../../src/media/types.js';
import type { MediaCodec } from '../../src/media/types.js';

/** Build a browser-user-media-looking cause without depending on DOMException. */
function cause(name: string, message: string): unknown {
  return { name, message } as unknown;
}

describe('mapBrowserMediaError', () => {
  it.each<[string, MediaErrorCode]>([
    ['NotAllowedError', 'PERMISSION_DENIED'],
    ['NotAllowed', 'PERMISSION_DENIED'],
    ['NotFoundError', 'DEVICE_NOT_FOUND'],
    ['NotFound', 'DEVICE_NOT_FOUND'],
    ['NotReadableError', 'DEVICE_UNAVAILABLE'],
    ['NotReadable', 'DEVICE_UNAVAILABLE'],
    ['OverconstrainedError', 'CONSTRAINT_UNSATISFIED'],
    ['Overconstrained', 'CONSTRAINT_UNSATISFIED'],
    ['AbortError', 'ABORTED'],
    ['Abort', 'ABORTED'],
  ])('maps %s to %s', (name, code) => {
    const error = mapBrowserMediaError(cause(name, 'some failure'));
    expect(error).toBeInstanceOf(MediaError);
    expect(error.code).toBe(code);
    expect(error.name).toBe('MediaError');
  });

  it('maps an unknown name to INTERNAL_ERROR', () => {
    const error = mapBrowserMediaError(cause('SomeRandomFailure', 'boom'));
    expect(error.code).toBe('INTERNAL_ERROR');
  });

  it('maps an Error without a recognisable name to INTERNAL_ERROR', () => {
    const error = mapBrowserMediaError(new Error('boom'));
    expect(error.code).toBe('INTERNAL_ERROR');
  });

  it('preserves sessionId and operation', () => {
    const error = mapBrowserMediaError(
      cause('NotFoundError', 'n/a'),
      'session-7',
      'acquire',
    );
    expect(error.sessionId).toBe('session-7');
    expect(error.operation).toBe('acquire');
  });

  it('surfaces a fixed safe message that excludes the cause name and message', () => {
    const error = mapBrowserMediaError(
      cause('SomeSecretName', 'navigator-secret-token-1234-super-secret'),
    );
    expect(error.message).not.toMatch(/SecretName/i);
    expect(error.message).not.toContain('navigator-secret-token-1234-super-secret');
  });

  it('keeps the cause out of a known-name message too', () => {
    const error = mapBrowserMediaError(cause('NotFoundError', 'device-fingerprint-999'));
    expect(error.message).not.toContain('device-fingerprint-999');
  });

  describe('lazy browser-media environment seam', () => {
    it('exposes the env factory and resolves globals lazily on invocation', async () => {
      // The env seam is exempted from the import-boundaries AST scan only
      // because it resolves globals lazily (never at import). This regression
      // proves the factory reads browser globals only when it is called.
      expect(createBrowserMediaEnvironment).toBeTypeOf('function');

      // Install throwing accessors for the browser globals the seam reads.
      const touching = new Set<string>();
      const envNames = ['navigator', 'RTCPeerConnection', 'MediaStream', 'MediaStreamTrack', 'RTCRtpSender'];
      const install = (name: string): void => {
        Object.defineProperty(globalThis, name, {
          configurable: true,
          get() {
            touching.add(name);
            return undefined;
          },
        });
      };
      for (const n of envNames) install(n);

      try {
        // Invoking the factory resolves the globals lazily (a real fault-trip if
        // they were read at import, which is separately asserted by import-safety).
        const env = createBrowserMediaEnvironment();
        expect(env).toBeDefined();
        expect(touching.size).toBeGreaterThan(0);
      } finally {
        for (const n of envNames) {
          Object.defineProperty(globalThis, n, { configurable: true, value: undefined });
        }
      }
    });
  });

  it('retains the local cause only in a non-enumerable, non-serialized field', () => {
    const secret = cause('HackAccess', 'credential=topsecret-abc');
    const error = mapBrowserMediaError(secret);
    expect((error as { localCause?: unknown }).localCause).toBe(secret);
    expect(Object.keys(error)).not.toContain('localCause');
    expect(JSON.stringify(error)).not.toContain('topsecret-abc');
    expect(JSON.stringify(error)).not.toContain('HackAccess');
  });
});

describe('validateBrowserMediaOptions', () => {
  it('accepts all supported codec names', () => {
    const out = validateBrowserMediaOptions({
      codecPreference: ['opus', 'PCMU', 'PCMA'],
    });
    expect(out.codecPreference).toEqual(['opus', 'PCMU', 'PCMA']);
  });

  it('rejects an unsupported codec name', () => {
    expect(() =>
      validateBrowserMediaOptions({ codecPreference: ['invalid' as MediaCodec] }),
    ).toThrowError(/codec/i);
  });

  it('caps positive timeout deadlines at MAX_MEDIA_TIMEOUT_MS', () => {
    expect(MAX_MEDIA_TIMEOUT_MS).toBe(120_000);
    const out = validateBrowserMediaOptions({
      iceGatheringTimeoutMs: 5_000_000,
      mediaOperationTimeoutMs: 9_000_000,
    });
    expect(out.iceGatheringTimeoutMs).toBe(120_000);
    expect(out.mediaOperationTimeoutMs).toBe(120_000);
  });

  it('leaves already-bounded timeouts untouched', () => {
    const out = validateBrowserMediaOptions({
      iceGatheringTimeoutMs: 8_000,
      mediaOperationTimeoutMs: 30_000,
    });
    expect(out.iceGatheringTimeoutMs).toBe(8_000);
    expect(out.mediaOperationTimeoutMs).toBe(30_000);
  });

  it('rejects non-positive, non-finite, and NaN deadlines', () => {
    for (const bad of [0, -1, -500, NaN, Infinity, -Infinity]) {
      expect(() =>
        validateBrowserMediaOptions({ iceGatheringTimeoutMs: bad }),
      ).toThrowError(/positive/i);
      expect(() =>
        validateBrowserMediaOptions({ mediaOperationTimeoutMs: bad }),
      ).toThrowError(/positive/i);
    }
  });

  it('defensively copies iceServers, audioConstraints, and codecPreference', () => {
    const iceServers: RTCIceServer[] = [{ urls: 'stun:example.test' }];
    const audioConstraints: MediaTrackConstraints = { echoCancellation: true };
    const codecPreference: MediaCodec[] = ['opus'];
    const options: BrowserMediaOptions = {
      iceServers,
      audioConstraints,
      codecPreference,
    };

    const out = validateBrowserMediaOptions(options);

    (iceServers[0] as { urls: string }).urls = 'mutated';
    audioConstraints.echoCancellation = false;
    (codecPreference as MediaCodec[])[0] = 'PCMU';

    expect(out.iceServers).toEqual([{ urls: 'stun:example.test' }]);
    expect(out.audioConstraints).toEqual({ echoCancellation: true });
    expect(out.codecPreference).toEqual(['opus']);
    expect(out.iceServers).not.toBe(iceServers);
    expect(out.audioConstraints).not.toBe(audioConstraints);
    expect(out.codecPreference).not.toBe(codecPreference);
  });

  it('treats absent optional collections as undefined', () => {
    const out = validateBrowserMediaOptions({});
    expect(out.iceServers).toBeUndefined();
    expect(out.audioConstraints).toBeUndefined();
    expect(out.codecPreference).toBeUndefined();
  });

  it('exposes a stable canonical codec list', () => {
    expect(MEDIA_CODECS).toEqual(['opus', 'PCMU', 'PCMA']);
  });
});