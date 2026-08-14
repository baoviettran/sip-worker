/**
 * Small helper for attaching a session's remote audio stream to an
 * application-owned `HTMLMediaElement` (v0.5).
 *
 * The application owns every `HTMLMediaElement`; this helper never creates a
 * DOM node. It assigns `element.srcObject`, optionally selects an audio output
 * via `setSinkId`, optionally calls and awaits `play()`, and returns an
 * idempotent detach function. Attachments are tracked in memory keyed by
 * element/session/stream — no DOM queries — so session-cleanup can detach
 * exactly the elements that still reference the closing session's stream and
 * never touch a different call's element.
 *
 * Errors are {@link @sip-worker/core#MediaError}s with fixed safe messages:
 * `OUTPUT_SELECTION_UNSUPPORTED` when `setSinkId` is missing, mapped
 * user-media codes when selection fails, and `PLAYBACK_FAILED` when `play()`
 * rejects. No device ID, credential, stack, or SDP ever appears in an error.
 * No module reads `navigator`, `document`, or `RTCPeerConnection`.
 */

import { MediaError } from '@sip-worker/core';
import type { MediaErrorCode } from '@sip-worker/core';

/** A single tracked attachment: the element, its session, and the assigned stream. */
interface Attachment {
  readonly element: HTMLMediaElement;
  readonly sessionId: string;
  readonly stream: MediaStream;
}

/** Fixed safe messages; never interpolate exception content into these. */
const FAIL_MESSAGES: Readonly<Record<MediaErrorCode, string>> = {
  PERMISSION_DENIED: 'Microphone or media permission was denied.',
  DEVICE_NOT_FOUND: 'No matching media device was found.',
  DEVICE_UNAVAILABLE: 'The media device is unavailable or in use by another application.',
  CONSTRAINT_UNSATISFIED: 'The requested audio constraints could not be satisfied.',
  NEGOTIATION_FAILED: 'The media negotiation failed.',
  REMOTE_DESCRIPTION_REJECTED: 'The remote session description was rejected.',
  ICE_GATHERING_TIMEOUT: 'ICE gathering did not complete in time.',
  ICE_CONNECTION_FAILED: 'The media connection could not be established.',
  OUTPUT_SELECTION_UNSUPPORTED: 'Output selection is not supported on this device.',
  PLAYBACK_FAILED: 'Remote audio playback failed.',
  ABORTED: 'The media operation was aborted.',
  INTERNAL_ERROR: 'An internal browser media error occurred.',
};

/**
 * Attach/detach/select-output helper for remote audio playback.
 *
 * Each async operation is element-centric and rolls its own state back on
 * failure. The renderer stores only the attachment records needed to drive
 * session-cleanup detach.
 */
export class RemoteAudioRenderer {
  /** Live attachments, in attach order; keyed semantically by element identity. */
  private readonly attachments: Attachment[] = [];

  /**
   * Assign `stream` (the active session's remote audio) to `element`.
   *
   * - When `options.outputDeviceId` is set, selects the output first (reusing
   *   {@link setOutput}; its codes apply). On failure the assignment is reverted
   *   and the error rethrown.
   * - When `options.play === true`, calls AND awaits `element.play()`. A
   *   rejection maps to `PLAYBACK_FAILED` and reverts the assignment — autoplay
   *   rejection is never reported as successful playback.
   * - Otherwise assigns without playing.
   *
   * Returns an idempotent detach that clears `srcObject` only while it still
   * references the stream we assigned.
   */
  async attach(
    element: HTMLMediaElement,
    sessionId: string,
    stream: MediaStream,
    options?: { readonly outputDeviceId?: string; readonly play?: boolean },
  ): Promise<() => void> {
    element.srcObject = stream;
    const detach = this.track(element, sessionId, stream);
    let playRequested = false;
    try {
      if (options?.outputDeviceId !== undefined) {
        await this.setOutput(element, options.outputDeviceId);
      }
      playRequested = options?.play === true;
      if (playRequested) {
        await element.play();
      }
      return detach;
    } catch (cause) {
      // Never leave a half-applied assignment on failure.
      this.detach(element, sessionId, stream);
      throw playRequested ? this.fail('PLAYBACK_FAILED') : cause;
    }
  }

  /**
   * Select the audio output device for an element via `setSinkId`.
   *
   * Rejects with `OUTPUT_SELECTION_UNSUPPORTED` when the element lacks
   * `setSinkId`. Never pretends success, never creates an element, and never
   * swallows a selection failure (mapped through the browser error mapper).
   */
  async setOutput(element: HTMLMediaElement, deviceId: string): Promise<void> {
    const setSinkId = (
      element as HTMLMediaElement & { setSinkId?: (id: string) => Promise<void> }
    ).setSinkId;
    if (typeof setSinkId !== 'function') {
      throw this.fail('OUTPUT_SELECTION_UNSUPPORTED');
    }
    try {
      await setSinkId.call(element, deviceId);
    } catch (cause) {
      throw mapOutputError(cause);
    }
  }

  /**
   * Detach every element still bound to `sessionId` — used when a session
   * closes/reclaims its stream. An element whose `srcObject` was already
   * replaced by the application is left alone.
   */
  detachAllForSession(sessionId: string): void {
    for (let i = this.attachments.length - 1; i >= 0; i -= 1) {
      const attachment = this.attachments[i];
      if (attachment !== undefined && attachment.sessionId === sessionId) {
        if (attachment.element.srcObject === attachment.stream) {
          attachment.element.srcObject = null;
        }
        this.attachments.splice(i, 1);
      }
    }
  }

  /** Register the attachment and return an idempotent detach for this trio. */
  private track(element: HTMLMediaElement, sessionId: string, stream: MediaStream): () => void {
    const attachment: Attachment = { element, sessionId, stream };
    this.attachments.push(attachment);
    return (): void => {
      this.detach(element, sessionId, stream);
    };
  }

  /** Clear `srcObject` and drop the record only when it matches this trio exactly. */
  private detach(element: HTMLMediaElement, sessionId: string, stream: MediaStream): void {
    const index = this.attachments.findIndex((a) =>
      a.element === element && a.sessionId === sessionId && a.stream === stream);
    if (index !== -1) {
      this.attachments.splice(index, 1);
    }
    if (element.srcObject === stream) {
      element.srcObject = null;
    }
  }

  private fail(code: MediaErrorCode): MediaError {
    return new MediaError(code, FAIL_MESSAGES[code]);
  }
}

/**
 * Map a thrown `setSinkId` output-selection rejection to a stable coded
 * {@link MediaError} by DOMException name. No raw message is surfaced.
 */
function mapOutputError(cause: unknown): MediaError {
  const name = nameOf(cause);
  let code: MediaErrorCode = 'INTERNAL_ERROR';
  switch (name) {
    case 'NotFound':
    case 'NotFoundError':
      code = 'DEVICE_NOT_FOUND';
      break;
    case 'NotAllowed':
    case 'NotAllowedError':
      code = 'PERMISSION_DENIED';
      break;
    case 'NotReadable':
    case 'NotReadableError':
      code = 'DEVICE_UNAVAILABLE';
      break;
    case 'Abort':
    case 'AbortError':
      code = 'ABORTED';
      break;
    default:
      break;
  }
  return new MediaError(code, FAIL_MESSAGES[code]);
}

function nameOf(cause: unknown): string | undefined {
  if (cause !== null && typeof cause === 'object') {
    const name = (cause as { name?: unknown }).name;
    if (typeof name === 'string') return name;
  }
  return undefined;
}