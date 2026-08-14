/**
 * Browser media facade (v0.5).
 *
 * The high-level surface a `BrowserUserAgent` exposes as `ua.media`. It
 * delegates device operations (list/prepare/microphone selection) to the
 * {@link WebRtcMediaManager} and its internal {@link MediaDeviceManager}, and
 * delegates remote-audio attach/detach/output-selection to the
 * {@link RemoteAudioRenderer}.
 *
 * Element ownership remains with the application: this facade never creates an
 * `HTMLMediaElement` and never touches an element past the session it serves.
 * Device-change remains the manager's single `devicechange` listener; the
 * facade adds no second one. No module reads `navigator`, `document`, or
 * `RTCPeerConnection`.
 */

import { MediaError } from '@sip-worker/core';
import type {
  BrowserAudioDevice,
  PrepareMediaOptions,
} from './types.js';
import type { WebRtcMediaManager } from './media-manager.js';
import { RemoteAudioRenderer } from './remote-audio.js';

/** The public media surface exposed on a `BrowserUserAgent` as `ua.media`. */
export interface BrowserMedia {
  listDevices(): Promise<readonly BrowserAudioDevice[]>;
  prepare(options?: PrepareMediaOptions): Promise<void>;
  selectMicrophone(deviceId: string | undefined): Promise<void>;
  attachRemoteAudio(
    element: HTMLMediaElement,
    options?: { readonly outputDeviceId?: string; readonly play?: boolean },
  ): Promise<() => void>;
  setAudioOutput(element: HTMLMediaElement, deviceId: string): Promise<void>;
}

/**
 * The `BrowserMedia` implementation. Construct with the media manager the
 * `BrowserUserAgent` already owns.
 */
export class BrowserMedia {
  private readonly manager: WebRtcMediaManager;
  private readonly renderer = new RemoteAudioRenderer();
  private readonly unsubscribes: Array<() => void> = [];
  private disposed = false;

  constructor(manager: WebRtcMediaManager) {
    this.manager = manager;
    // Observe session-end so an element still referencing a closing session's
    // stream is detached (only if it still references that exact stream).
    this.unsubscribes.push(
      manager.onSessionEnd((sessionId) => {
        this.renderer.detachAllForSession(sessionId);
      }),
    );
  }

  async listDevices(): Promise<readonly BrowserAudioDevice[]> {
    this.assertLive();
    return this.manager.listDevices();
  }

  async prepare(options?: PrepareMediaOptions): Promise<void> {
    this.assertLive();
    return this.manager.prepare(options);
  }

  /**
   * Select the preferred microphone. During an ACTIVE call the replacement is
   * transactional (acquire → replaceTrack → commit → stop old, delegated to the
   * session); while idle the in-memory preference is committed and validated on
   * the next `prepare()`/call acquisition.
   */
  async selectMicrophone(deviceId: string | undefined): Promise<void> {
    this.assertLive();
    if (this.manager.activeSessionId !== undefined) {
      return this.manager.replaceActiveMicrophone(deviceId);
    }
    this.manager.selectMicrophone(deviceId);
  }

  /**
   * Assign the active session's remote stream to an app-owned element, optionally
   * selecting an output and awaiting `play()`. Returns an idempotent detach.
   * Rejects when no active remote stream is available yet.
   */
  async attachRemoteAudio(
    element: HTMLMediaElement,
    options?: { readonly outputDeviceId?: string; readonly play?: boolean },
  ): Promise<() => void> {
    this.assertLive();
    const sessionId = this.manager.activeSessionId;
    const stream = this.manager.activeRemoteStream;
    if (sessionId === undefined || stream === null) {
      throw new MediaError(
        'INTERNAL_ERROR',
        'No active remote audio stream is available.',
      );
    }
    return this.renderer.attach(element, sessionId, stream, options);
  }

  /** Select the audio output device for an element via `setSinkId`. */
  setAudioOutput(element: HTMLMediaElement, deviceId: string): Promise<void> {
    this.assertLive();
    return this.renderer.setOutput(element, deviceId);
  }

  /**
   * Release the facade's session-end observer. Idempotent.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const unsubscribe of this.unsubscribes) {
      unsubscribe();
    }
    this.unsubscribes.length = 0;
  }

  private assertLive(): void {
    if (this.disposed) {
      throw new MediaError('ABORTED', 'The media operation was aborted.');
    }
  }
}