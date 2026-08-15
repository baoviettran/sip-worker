/**
 * Browser WebRTC media types and immutable options validation (v0.5).
 *
 * These are the public, deterministic shapes the browser media layer produces
 * and consumes. No module reads `navigator`, `document`, or `RTCPeerConnection`
 * here; DOM types appear only as type annotations so the browser package stays
 * Node-free and import-safe.
 */

import type { MediaError, MediaErrorCode } from '@sip-worker/core';

/** Aggregate options used to configure browser media for a call. */
export interface BrowserMediaOptions {
  readonly iceServers?: readonly RTCIceServer[];
  readonly iceTransportPolicy?: RTCIceTransportPolicy;
  readonly iceGatheringTimeoutMs?: number;
  readonly mediaOperationTimeoutMs?: number;
  readonly microphoneDeviceId?: string;
  readonly audioConstraints?: MediaTrackConstraints;
  readonly codecPreference?: readonly MediaCodec[];
}

/** Per-operation options for acquiring/selecting the microphone. */
export interface PrepareMediaOptions {
  readonly microphoneDeviceId?: string;
  readonly signal?: AbortSignal;
}

/** A single browser audio device (input or output), as listed by enumerateDevices. */
export interface BrowserAudioDevice {
  readonly deviceId: string;
  readonly label: string;
  readonly groupId: string;
  readonly kind: 'audioinput' | 'audiooutput';
}

/**
 * The environment seam through which the media manager talks to the real
 * browser. Production attaches real globals; tests inject fakes. Globals are
 * resolved lazily per call so the boundary is overridable and import-safe.
 */
export interface BrowserMediaEnvironment {
  readonly mediaDevices: Pick<MediaDevices,
    'getUserMedia' | 'enumerateDevices' | 'addEventListener' | 'removeEventListener'>;
  createPeerConnection(configuration: RTCConfiguration): RTCPeerConnection;
  createMediaStream(tracks?: MediaStreamTrack[]): MediaStream;
  getAudioCapabilities(): RTCRtpCapabilities | null;
}

/** Monotonic lifecycle of one media session. */
export type MediaSessionState =
  | 'new' | 'acquiring' | 'negotiating' | 'connecting'
  | 'connected' | 'failed' | 'closed';

/** Typed event map emitted by browser media sessions. */
export interface BrowserMediaEventMap {
  readonly mediaStateChanged: {
    readonly type: 'mediaStateChanged'; readonly sessionId: string;
    readonly previous: MediaSessionState; readonly state: MediaSessionState;
    readonly reason?: MediaErrorCode;
  };
  readonly remoteAudio: {
    readonly type: 'remoteAudio'; readonly sessionId: string;
    readonly stream: MediaStream;
  };
  readonly mediaFailed: {
    readonly type: 'mediaFailed'; readonly sessionId: string;
    readonly error: MediaError;
  };
  readonly deviceChanged: { readonly type: 'deviceChanged' };
  readonly mutedChanged: {
    readonly type: 'mutedChanged'; readonly sessionId: string;
    readonly previous: boolean; readonly muted: boolean;
  };
}

/** The named primary codecs the v0.5 media layer may order/narrow by MIME subtype. */
export type MediaCodec = 'opus' | 'PCMU' | 'PCMA';

/** Canonical codec names, in default-preferred order. */
export const MEDIA_CODECS: readonly MediaCodec[] = ['opus', 'PCMU', 'PCMA'];

/** Upper bound (ms) for timeouts; larger values have no meaning for a call. */
export const MAX_MEDIA_TIMEOUT_MS = 120_000;

/** Default ICE gathering deadline (ms), matching the design's 8 seconds. */
export const DEFAULT_ICE_GATHERING_TIMEOUT_MS = 8_000;

/** Default media operation deadline (ms), matching the design's 30 seconds. */
export const DEFAULT_MEDIA_OPERATION_TIMEOUT_MS = 30_000;

/** The supported codec names, as a Set for O(1) membership checks. */
const MEDIA_CODEC_SET: ReadonlySet<MediaCodec> = new Set(MEDIA_CODECS);

/** Canonical display name for an unknown media operation. */
const UNKNOWN_OPERATION = 'media operation';

/** Sort key for validated (normalized) options, kept in one place. */
export type NormalizedMediaOptions = {
  readonly iceServers?: readonly RTCIceServer[];
  readonly iceTransportPolicy?: RTCIceTransportPolicy;
  readonly iceGatheringTimeoutMs: number;
  readonly mediaOperationTimeoutMs: number;
  readonly microphoneDeviceId?: string;
  readonly audioConstraints?: MediaTrackConstraints;
  readonly codecPreference?: readonly MediaCodec[];
};

/** Recursively copy and freeze plain configuration arrays/records. */
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

/** Freeze a defensive copy of an optional readonly array. */
function copyOptionalArray<T>(value: readonly T[] | undefined): readonly T[] | undefined {
  return value === undefined ? undefined : copyAndFreeze(value);
}

/** Deep defensive copy of ICE servers, including URL arrays and OAuth credentials. */
function copyIceServers(
  value: readonly RTCIceServer[] | undefined,
): readonly RTCIceServer[] | undefined {
  return value === undefined ? undefined : copyAndFreeze(value);
}

/**
 * Validate and defensively copy {@link BrowserMediaOptions}.
 *
 * - Timeout deadlines must be finite, positive, and capped at
 *   {@link MAX_MEDIA_TIMEOUT_MS}. Non-positive/NaN/±Infinity deadlines are
 *   rejected.
 * - `codecPreference` is restricted to the supported union; any other name is
 *   rejected.
 * - `iceServers`, `audioConstraints`, and `codecPreference` are copied so
 *   caller mutation after validation cannot alter an active negotiation.
 *
 * The returned object starts as a shallow copy of the input and is frozen, so
 * it cannot be mutated by later callers either.
 */
export function validateBrowserMediaOptions(
  options: BrowserMediaOptions,
): Readonly<NormalizedMediaOptions> {
  const iceGatheringTimeoutMs = options.iceGatheringTimeoutMs
    ?? DEFAULT_ICE_GATHERING_TIMEOUT_MS;
  const mediaOperationTimeoutMs = options.mediaOperationTimeoutMs
    ?? DEFAULT_MEDIA_OPERATION_TIMEOUT_MS;

  assertFinitePositiveTimeout(iceGatheringTimeoutMs, 'iceGatheringTimeoutMs');
  assertFinitePositiveTimeout(mediaOperationTimeoutMs, 'mediaOperationTimeoutMs');

  if (options.codecPreference !== undefined) {
    for (const codec of options.codecPreference) {
      if (!MEDIA_CODEC_SET.has(codec)) {
        throw new RangeError(
          `Unsupported codec '${String(codec)}'. Supported media codecs: ` +
          `${MEDIA_CODECS.join(', ')}.`,
        );
      }
    }
  }

  return Object.freeze({
    ...options,
    iceGatheringTimeoutMs: Math.min(iceGatheringTimeoutMs, MAX_MEDIA_TIMEOUT_MS),
    mediaOperationTimeoutMs: Math.min(mediaOperationTimeoutMs, MAX_MEDIA_TIMEOUT_MS),
    iceServers: copyIceServers(options.iceServers),
    audioConstraints: options.audioConstraints === undefined
      ? undefined : copyAndFreeze(options.audioConstraints),
    codecPreference: copyOptionalArray(options.codecPreference),
  });
}

function assertFinitePositiveTimeout(value: number, name: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(
      `${name} must be a finite positive number (ms); got ${String(value)}. ` +
      `${UNKNOWN_OPERATION} deadlines are capped at ${MAX_MEDIA_TIMEOUT_MS} ms.`,
    );
  }
}