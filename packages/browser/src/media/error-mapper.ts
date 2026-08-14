/**
 * Map browser user-media/WebRTC exceptions to stable, serializable
 * {@link @sip-worker/core#MediaError}s, and build the browser media
 * environment seam.
 *
 * Messages are fixed and safe: the cause's message/name is never interpolated
 * into the surfaced message (device IDs, labels, credentials, SDP and other
 * secrets must not leak). The original cause is retained only as an optional,
 * non-enumerable `localCause` field so it survives only in memory for
 * debugging and is excluded from serialization and logs.
 */

import { MediaError, type MediaErrorCode } from '@sip-worker/core';
import type { BrowserMediaEnvironment, BrowserMediaOptions } from './types.js';

/** Fixed safe messages; never interpolate exception content into these. */
const FIXED_MESSAGES: Readonly<Partial<Record<MediaErrorCode, string>>> = {
  PERMISSION_DENIED: 'Microphone or media permission was denied.',
  DEVICE_NOT_FOUND: 'No matching media device was found.',
  DEVICE_UNAVAILABLE: 'The media device is unavailable or in use by another application.',
  CONSTRAINT_UNSATISFIED: 'The requested audio constraints could not be satisfied.',
  ABORTED: 'The media operation was aborted.',
  INTERNAL_ERROR: 'An internal browser media error occurred.',
};

const DEFAULT_MESSAGE = FIXED_MESSAGES.INTERNAL_ERROR as string;

/**
 * Map a thrown browser media exception to a stable {@link MediaError}.
 *
 * Detection is by the exception `name`. The WHATWG names (`NotAllowedError`,
 * `NotFoundError`, `NotReadableError`, `OverconstrainedError`, `AbortError`)
 * and their short forms (`NotAllowed`, `NotFound`, ...) both map; anything else
 * becomes `INTERNAL_ERROR`.
 *
 * @param cause - the raw browser exception.
 * @param sessionId - optional owning session id, carried on the {@link MediaError}.
 * @param operation - optional operation name, carried on the {@link MediaError}.
 */
export function mapBrowserMediaError(
  cause: unknown,
  sessionId?: string,
  operation?: string,
): MediaError {
  const code = codeForName(extractName(cause));
  const message = FIXED_MESSAGES[code] ?? DEFAULT_MESSAGE;

  const error = new MediaError(code, message, sessionId, operation);
  if (cause !== undefined) {
    defineNonEnumerable(error, 'localCause', cause);
  }
  return error;
}

/** Interpret an exception `name` as a `MediaErrorCode`; anything else is internal. */
function codeForName(name: string | undefined): MediaErrorCode {
  switch (name ?? '') {
    case 'NotAllowed':
    case 'NotAllowedError':
      return 'PERMISSION_DENIED';
    case 'NotFound':
    case 'NotFoundError':
      return 'DEVICE_NOT_FOUND';
    case 'NotReadable':
    case 'NotReadableError':
      return 'DEVICE_UNAVAILABLE';
    case 'Overconstrained':
    case 'OverconstrainedError':
      return 'CONSTRAINT_UNSATISFIED';
    case 'Abort':
    case 'AbortError':
      return 'ABORTED';
    default:
      return 'INTERNAL_ERROR';
  }
}

/** Read the `name` off a thrown value without trusting the constructor. */
function extractName(cause: unknown): string | undefined {
  if (cause !== null && typeof cause === 'object') {
    const name = (cause as { name?: unknown }).name;
    if (typeof name === 'string') {
      return name;
    }
  }
  return undefined;
}

/** Define a non-enumerable own property (visible in debugging, hidden from JSON). */
function defineNonEnumerable(target: object, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: false,
    configurable: true,
    writable: true,
  });
}

/** True when the global exists (guarded against read-through accessors). */
function hasGlobal(
  name: 'navigator' | 'RTCPeerConnection' | 'MediaStream' | 'MediaStreamTrack' | 'RTCRtpSender',
): boolean {
  return typeof globalThis[name] !== 'undefined';
}

function missing(operation: string, label: string): MediaError {
  return new MediaError('INTERNAL_ERROR', `Missing browser global '${label}'.`, undefined, operation);
}

type PeerConnectionCtor = new (configuration?: RTCConfiguration) => RTCPeerConnection;
type MediaStreamCtor = new (tracks?: MediaStreamTrack[]) => MediaStream;

/** Constructor types, so `new` compiles against lib.dom. */
interface MediaGlobals {
  peerConnection?: PeerConnectionCtor;
  mediaStream?: MediaStreamCtor;
  mediaStreamTrack?: typeof MediaStreamTrack;
  rtpSender?: { getCapabilities?: (kind: string) => RTCRtpCapabilities | null };
  mediaDevices?: MediaDevices;
}

/** Read the media globals we care about, resolved lazily. */
function readMediaGlobals(): MediaGlobals {
  const mediaDevices = hasGlobal('navigator')
    ? (globalThis.navigator as unknown as { mediaDevices?: MediaDevices }).mediaDevices
    : undefined;
  return {
    mediaDevices,
    peerConnection: hasGlobal('RTCPeerConnection')
      ? globalThis.RTCPeerConnection
      : undefined,
    mediaStream: hasGlobal('MediaStream') ? globalThis.MediaStream : undefined,
    mediaStreamTrack: hasGlobal('MediaStreamTrack')
      ? globalThis.MediaStreamTrack
      : undefined,
    rtpSender: hasGlobal('RTCRtpSender')
      ? (globalThis as unknown as { RTCRtpSender: MediaGlobals['rtpSender'] }).RTCRtpSender
      : undefined,
  };
}

/**
 * Create a {@link BrowserMediaEnvironment} bound to the real browser globals.
 *
 * Nothing is read at module evaluation time. Globals are resolved lazily, once
 * at environment creation to fail fast, and again per method call so callers
 * and tests can inject or override them.
 */
export function createBrowserMediaEnvironment(
  _options?: BrowserMediaOptions,
): BrowserMediaEnvironment {
  // Resolve once to surface a missing-global configuration error eagerly, but
  // keep none of it closed over; each call re-reads the current globals.
  readMediaGlobals();

  return {
    get mediaDevices(): MediaDevices {
      const { mediaDevices } = readMediaGlobals();
      if (mediaDevices === undefined) {
        throw missing('createBrowserMediaEnvironment', 'navigator.mediaDevices');
      }
      return mediaDevices;
    },
    createPeerConnection(configuration: RTCConfiguration): RTCPeerConnection {
      const { peerConnection } = readMediaGlobals();
      if (peerConnection === undefined) {
        throw missing('createPeerConnection', 'RTCPeerConnection');
      }
      return new peerConnection(configuration);
    },
    createMediaStream(tracks?: MediaStreamTrack[]): MediaStream {
      const { mediaStream } = readMediaGlobals();
      if (mediaStream === undefined) {
        throw missing('createMediaStream', 'MediaStream');
      }
      return tracks === undefined || tracks.length === 0
        ? new mediaStream()
        : new mediaStream([...tracks]);
    },
    getAudioCapabilities(): RTCRtpCapabilities | null {
      const { rtpSender } = readMediaGlobals();
      if (rtpSender?.getCapabilities === undefined) {
        return null;
      }
      try {
        return rtpSender.getCapabilities('audio');
      } catch {
        return null;
      }
    },
  };
}