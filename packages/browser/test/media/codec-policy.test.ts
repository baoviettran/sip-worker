import { describe, expect, it } from 'vitest';
import { MediaError } from '@sip-worker/core';
import { applyAudioCodecPolicy } from '../../src/media/codec-policy.js';
import type { MediaCodec } from '../../src/media/types.js';

/** A transceiver stub exposing only the codec surface the policy touches. */
function makeTransceiverWith(prefs?: (codecs: RTCRtpCodec[]) => void): {
  setCodecPreferences?: (codecs: RTCRtpCodec[]) => void;
  applied: RTCRtpCodec[] | null;
} {
  let applied: RTCRtpCodec[] | null = null;
  return {
    setCodecPreferences:
      prefs === undefined
        ? undefined
        // eslint-disable-next-line no-param-reassign
        : (codecs: RTCRtpCodec[]): void => {
            applied = codecs;
          },
    get applied(): RTCRtpCodec[] | null {
      return applied;
    },
  };
}

function makeCapabilities(...codecs: RTCRtpCodec[]): RTCRtpCapabilities {
  return { codecs, headerExtensions: [] };
}
function codec(mimeType: string, clockRate: number, channels?: number): RTCRtpCodec {
  return channels === undefined
    ? { mimeType, clockRate }
    : { mimeType, clockRate, channels };
}
/** Subtype of a codec's mimeType, original case preserved, for asserting identity. */
function subtype(codec: RTCRtpCodec): string {
  const parts = codec.mimeType.split('/');
  return parts[parts.length - 1] ?? codec.mimeType;
}
/** Lowercase subtype, for case-insensitive assertions on filtered sets. */
function lowerSubtype(codec: RTCRtpCodec): string {
  return subtype(codec).toLowerCase();
}

describe('applyAudioCodecPolicy', () => {
  it('orders Opus first, then PCMU then PCMA by default, retaining telephone-event', () => {
    const caps = makeCapabilities(
      codec('audio/PCMU', 8000),
      codec('audio/PCMA', 8000),
      codec('audio/opus', 48000, 2),
      codec('audio/CN', 8000),
      codec('audio/telephone-event', 8000),
      codec('audio/RED', 48000),
    );
    const tr = makeTransceiverWith(() => undefined);
    applyAudioCodecPolicy(tr as never, caps);
    expect(tr.applied?.map(subtype)).toEqual(['opus', 'PCMU', 'PCMA', 'telephone-event']);
    // No SDP string is ever produced or edited by the policy.
    expect(tr.applied?.some((c) => lowerSubtype(c) === 'cn')).toBe(false);
    expect(tr.applied?.some((c) => lowerSubtype(c) === 'red')).toBe(false);
  });

  it('reorders by a custom codecPreference', () => {
    const caps = makeCapabilities(
      codec('audio/opus', 48000, 2),
      codec('audio/PCMU', 8000),
      codec('audio/PCMA', 8000),
      codec('audio/telephone-event', 8000),
    );
    const tr = makeTransceiverWith(() => undefined);
    applyAudioCodecPolicy(tr as never, caps, ['PCMA', 'opus'] satisfies readonly MediaCodec[]);
    expect(tr.applied?.map(subtype)).toEqual(['PCMA', 'opus', 'telephone-event']);
  });

  it('retains every related telephone-event entry after the primary codecs', () => {
    const caps = makeCapabilities(
      codec('audio/opus', 48000, 2),
      codec('audio/telephone-event', 8000),
      codec('audio/telephone-event', 16000),
      codec('audio/PCMU', 8000),
    );
    const tr = makeTransceiverWith(() => undefined);
    applyAudioCodecPolicy(tr as never, caps);
    const tel = tr.applied?.filter((c) => lowerSubtype(c) === 'telephone-event') ?? [];
    expect(tel).toHaveLength(2);
    const telClockRates = tel.map((c) => c.clockRate);
    expect(telClockRates).toContain(8000);
    expect(telClockRates).toContain(16000);
  });

  it('matches MIME subtypes case-insensitively', () => {
    const caps = makeCapabilities(
      codec('audio/OPUS', 48000, 2),
      codec('audio/PCMU', 8000),
      codec('audio/PCMA', 8000),
      codec('audio/telephone-event', 8000),
    );
    const tr = makeTransceiverWith(() => undefined);
    applyAudioCodecPolicy(tr as never, caps, ['PCMU', 'opus'] satisfies readonly MediaCodec[]);
    expect(tr.applied?.map(subtype)).toEqual(['PCMU', 'OPUS', 'telephone-event']);
    // The original capability objects are passed through unchanged (no string munging).
    expect(tr.applied?.[1]).toBe(caps.codecs[0]);
  });

  it('fails negotiation when no usable primary codec remains', () => {
    const caps = makeCapabilities(
      codec('audio/CN', 8000),
      codec('audio/RED', 48000),
      codec('audio/telephone-event', 8000),
    );
    const tr = makeTransceiverWith(() => undefined);
    let thrown: unknown;
    try {
      applyAudioCodecPolicy(tr as never, caps);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(MediaError);
    expect((thrown as MediaError).code).toBe('NEGOTIATION_FAILED');
    expect(tr.applied).toBeNull(); // nothing applied before failing
  });

  it('fails negotiation when a custom preference names no present codec', () => {
    const caps = makeCapabilities(
      codec('audio/opus', 48000, 2),
      codec('audio/telephone-event', 8000),
    );
    const tr = makeTransceiverWith(() => undefined);
    let thrown: unknown;
    try {
      applyAudioCodecPolicy(tr as never, caps, ['PCMU', 'PCMA'] satisfies readonly MediaCodec[]);
    } catch (error) {
      thrown = error;
    }
    expect((thrown as MediaError).code).toBe('NEGOTIATION_FAILED');
  });

  it('preserves browser order without setCodecPreferences when the codec surface is absent', () => {
    const caps = makeCapabilities(
      codec('audio/PCMU', 8000),
      codec('audio/opus', 48000, 2),
      codec('audio/telephone-event', 8000),
    );
    const tr = makeTransceiverWith(undefined); // no setCodecPreferences
    let thrown: undefined | unknown;
    try {
      applyAudioCodecPolicy(tr as never, caps);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeUndefined(); // usable opus remains, browser order preserved, no SDP edits
    expect(tr.applied).toBeNull(); // never called
  });

  it('fails on missing setCodecPreferences when no usable primary remains', () => {
    const caps = makeCapabilities(
      codec('audio/CN', 8000),
      codec('audio/RED', 48000),
      codec('audio/telephone-event', 8000),
    );
    const tr = makeTransceiverWith(undefined);
    let thrown: unknown;
    try {
      applyAudioCodecPolicy(tr as never, caps);
    } catch (error) {
      thrown = error;
    }
    expect((thrown as MediaError).code).toBe('NEGOTIATION_FAILED');
  });

  it('is a no-op when the browser reports no codec capabilities', () => {
    const tr = makeTransceiverWith(() => undefined);
    expect(() => applyAudioCodecPolicy(tr as never, null)).not.toThrow();
    expect(tr.applied).toBeNull(); // preferences never touched
  });
});