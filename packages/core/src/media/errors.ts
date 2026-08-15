/**
 * Coded, serializable media errors.
 *
 * `MediaError` is the typed error reconstructed on the worker side when a coded
 * `mediaError` reply crosses the boundary. It carries no stack/SDP/device/ICE
 * data — only the code and a human message — so it survives serialization. These
 * codes deliberately mirror the browser WebRTC/user-media failure surface but
 * remain transport/SIP-agnostic: this module never imports Worker, window,
 * navigator, or WebRTC.
 */

/** Valid media error codes, in the canonical order they appear in replies. */
export const MEDIA_ERROR_CODES = [
  'PERMISSION_DENIED', 'DEVICE_NOT_FOUND', 'DEVICE_UNAVAILABLE',
  'CONSTRAINT_UNSATISFIED', 'NEGOTIATION_FAILED',
  'REMOTE_DESCRIPTION_REJECTED', 'ICE_GATHERING_TIMEOUT',
  'ICE_CONNECTION_FAILED', 'OUTPUT_SELECTION_UNSUPPORTED',
  'PLAYBACK_FAILED', 'ABORTED', 'INVALID_STATE', 'MEDIA_OPERATION_TIMEOUT', 'INTERNAL_ERROR',
] as const;

export type MediaErrorCode = typeof MEDIA_ERROR_CODES[number];

/**
 * A reconstructible media error. `code` is guaranteed to be one of
 * `MEDIA_ERROR_CODES`; malformed/unknown codes in a reply map to
 * `INTERNAL_ERROR` at reconstruction time.
 */
export class MediaError extends Error {
  constructor(
    readonly code: MediaErrorCode,
    message: string,
    readonly sessionId?: string,
    readonly operation?: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'MediaError';
  }
}