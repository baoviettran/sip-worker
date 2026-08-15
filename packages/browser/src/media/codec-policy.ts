/**
 * Browser WebRTC audio codec policy (v0.5).
 *
 * Uses `RTCRtpSender.getCapabilities('audio')` as the source of truth (through
 * the injected {@link BrowserMediaEnvironment}), preferring Opus first by
 * default followed by PCMU and PCMA while retaining browser-associated
 * telephone-event entries for future DTMF support. An application
 * `codecPreference` may reorder or narrow the named primary codecs; negotiation
 * fails if no usable audio codec remains. When `setCodecPreferences()` is
 * unavailable the browser order is preserved and a usable-codec check is made
 * instead of editing SDP text. Matching is case-insensitive by MIME subtype and
 * respects clock rate/channel identity.
 */

import { MediaError } from '@sip-worker/core';
import type { MediaCodec } from './types.js';

/** Default primary preference, already in the desired order. */
const DEFAULT_PREFERENCE: readonly MediaCodec[] = ['opus', 'PCMU', 'PCMA'];

/** MIME subtypes treated as related (retained with the audio), in no ordering sense. */
const RELATED_SUBTYPES: ReadonlySet<string> = new Set(['telephone-event']);

/**
 * The subset of the browser session surface the policy needs. Production passes
 * an {@link RTCRtpTransceiver}; tests pass a narrower stub. The media session
 * guarantees only the transceiver it owns is ever touched.
 */
export interface AudioCodecPolicyTarget {
  setCodecPreferences?(codecs: RTCRtpCodec[]): void;
}

/**
 * Lowercase the MIME subtype (`audio/OPUS` -> `opus`) for case-insensitive
 * matching.
 */
function mimeSubtype(mimeType: string): string {
  const i = mimeType.lastIndexOf('/');
  return (i < 0 ? mimeType : mimeType.slice(i + 1)).toLowerCase();
}

/** True when a capability is one of the named primary codecs (case-insensitive). */
function isPrimary(codec: RTCRtpCodec): boolean {
  const subtype = mimeSubtype(codec.mimeType);
  return subtype === 'opus' || subtype === 'pcmu' || subtype === 'pcma';
}

/** True when a related (retained, non-primary) entry belongs with the audio. */
function isRelated(codec: RTCRtpCodec): boolean {
  return RELATED_SUBTYPES.has(mimeSubtype(codec.mimeType));
}

/**
 * Apply the v0.5 audio codec policy to one audio transceiver.
 *
 * - A null capabilities payload (browser has no `RTCRtpSender.getCapabilities`)
 *   is a no-op: the browser keeps its own defaults.
 * - Primary codecs present in the browser are ordered by `preference` (default
 *   Opus, PCMU, PCMA); related telephone-event entries are retained afterward.
 * - When `setCodecPreferences()` is available the ordered preference is applied.
 * - When it is absent (or not a function) the browser order is preserved and
 *   SDP text is never touched.
 * - Negotiation fails with {@link MediaErrorCode.NEGOTIATION_FAILED} if no
 *   usable primary codec remains.
 *
 * No SDP string is ever produced, parsed, or edited by this policy.
 */
export function applyAudioCodecPolicy(
  target: AudioCodecPolicyTarget,
  capabilities: RTCRtpCapabilities | null,
  preference?: readonly MediaCodec[],
): void {
  if (capabilities === null) {
    return;
  }
  if (!capabilitiesHasUsable(capabilities, preference)) {
    throw unusable();
  }
  const set = target.setCodecPreferences;
  if (typeof set !== 'function') {
    return; // preserve browser order; usable primary already verified
  }
  const ordered = order(capabilities.codecs, preference);
  set.call(target, ordered);
}

/**
 * True when at least one present codec can act as the negotiated primary. With
 * a custom preference a primary is usable only if the preference selects it and
 * it is actually present.
 */
function capabilitiesHasUsable(
  capabilities: RTCRtpCapabilities,
  preference: readonly MediaCodec[] | undefined,
): boolean {
  const subset = preference ?? DEFAULT_PREFERENCE;
  const present = new Set(
    capabilities.codecs.filter(isPrimary).map((c) => mimeSubtype(c.mimeType)),
  );
  return subset.some((name) => present.has(name.toLowerCase()));
}

/** Build the ordered preference, with related entries appended after the primaries. */
function order(
  codecs: readonly RTCRtpCodec[],
  preference: readonly MediaCodec[] | undefined,
): RTCRtpCodec[] {
  const subset = preference ?? DEFAULT_PREFERENCE;
  const primaryBySubtype = new Map<string, RTCRtpCodec>();
  const related: RTCRtpCodec[] = [];
  for (const codec of codecs) {
    if (isRelated(codec)) {
      related.push(codec);
    } else if (isPrimary(codec)) {
      const subtype = mimeSubtype(codec.mimeType);
      if (!primaryBySubtype.has(subtype)) {
        primaryBySubtype.set(subtype, codec);
      }
    }
  }
  const result: RTCRtpCodec[] = [];
  for (const name of subset) {
    const found = primaryBySubtype.get(name.toLowerCase());
    if (found !== undefined) {
      result.push(found);
    }
  }
  result.push(...related);
  return result;
}

/** A fixed, safe `NEGOTIATION_FAILED` failure; no SDP or codec detail leaks. */
function unusable(): MediaError {
  return new MediaError(
    'NEGOTIATION_FAILED',
    'No usable audio codec is available for this call.',
    undefined,
    'audio codec policy',
  );
}