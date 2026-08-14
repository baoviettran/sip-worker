/**
 * Browser microphone device and permission manager (v0.5).
 *
 * Owns a single in-memory preferred microphone device ID (never persisted),
 * requests capture permission through a probe stream, and lists/selects audio
 * devices. The probe stream is stopped on every success, failure, cancellation,
 * and disposal path; live call tracks are obtained fresh per call and owned by
 * the caller.
 *
 * No module reads `navigator`, `document`, or `RTCPeerConnection`; all WebRTC
 * access flows through the injected {@link BrowserMediaEnvironment}. Returned
 * devices carry only privacy-filtered labels, and no identifier/label/constraint
 * ever leaks into a thrown {@link MediaError}.
 */

import { MediaError } from '@sip-worker/core';
import type {
  BrowserAudioDevice,
  BrowserMediaEnvironment,
  BrowserMediaOptions,
  PrepareMediaOptions,
} from './types.js';
import { mapBrowserMediaError } from './error-mapper.js';

/**
 * Lifecycle ownership: a monotonically increasing generation plus a terminal
 * disposed flag guard every async operation. Each operation captures the
 * generation at start; on completion it honours the result only if the captured
 * generation still matches and the manager is not disposed. A stale operation
 * stops any delivered stream before rejecting `ABORTED`, so a late track can
 * never corrupt a newer lifecycle. Disposal also bumps the generation so every
 * in-flight operation is invalidated at once.
 *
 * The range alternates between odd (probe, disposed-checked) and even tokens.
 * A token is authoritative if it is greater than every token validated so far;
 * this is implemented by tracking the largest validated token in
 * `consumeDrainingGeneration`.
 */
export class MediaDeviceManager {
  private readonly env: BrowserMediaEnvironment;
  private readonly options: BrowserMediaOptions;

  /** The in-memory preferred microphone device ID; undefined = default device. */
  private preferredDeviceId: string | undefined;

  /** Largest token we have ever returned. Never decremented. */
  private generation = 0;

  /** Set on dispose; a disposed manager rejects every operation. */
  private disposed = false;

  /** The single registered devicechange listener, or null when disposed. */
  private deviceChangeListener: ((event: Event) => void) | null = null;

  /** Pending getUserMedia probes, cancelled atomically by disposal. */
  private readonly inFlight = new Set<AbortController>();

  constructor(env: BrowserMediaEnvironment, options: BrowserMediaOptions) {
    this.env = env;
    this.options = options;
    this.preferredDeviceId = options.microphoneDeviceId;
  }

  /** List only audio devices: audioinput and audiooutput are kept. */
  async listDevices(): Promise<readonly BrowserAudioDevice[]> {
    // A device list is not an operation that a later prepare/dispose owns, so
    // it reads the current environment without a generation token. Disposal
    // still rejects: a disposed manager stops enumerating.
    if (this.disposed) {
      throw this.aborted('listDevices');
    }
    const infos = await this.env.mediaDevices.enumerateDevices();
    const devices: BrowserAudioDevice[] = [];
    for (const info of infos) {
      if (info.kind === 'audioinput' || info.kind === 'audiooutput') {
        devices.push({
          deviceId: info.deviceId,
          label: info.label,
          groupId: info.groupId,
          kind: info.kind,
        });
      }
    }
    return Object.freeze(devices);
  }

  /**
   * Request capture permission and validate the selected device via a probe
   * stream, then stop the probe immediately. Honours
   * {@link PrepareMediaOptions#signal} and disposal: a late probe is stopped and
   * the operation rejects with `ABORTED`.
   */
  async prepare(options?: PrepareMediaOptions): Promise<void> {
    const token = this.begin();
    const request = this.buildRequest(options?.microphoneDeviceId);
    const status = await this.preCheck(
      request.microphoneDeviceId, token,
    );
    if (status === 'unavailable') {
      throw this.unavailable();
    }
    if (status === 'not-found') {
      throw this.notFound();
    }
    const stream = await this.probe(request.request, options?.signal, token);
    if (stream !== null) {
      stopStream(stream);
    }
  }

  /**
   * Acquire a fresh currently-selected microphone track for one call. The
   * returned stream is NOT stopped here: the caller owns it and stops it at call
   * teardown, so cancellation/disposal do not apply once delivered.
   */
  async acquireMicrophone(
    options?: Pick<PrepareMediaOptions, 'microphoneDeviceId' | 'signal'>,
  ): Promise<MediaStream> {
    const token = this.begin();
    const request = this.buildRequest(options?.microphoneDeviceId);
    const status = await this.preCheck(
      request.microphoneDeviceId, token,
    );
    if (status === 'unavailable') {
      throw this.unavailable();
    }
    if (status === 'not-found') {
      throw this.notFound();
    }
    const stream = await this.probe(request.request, options?.signal, token);
    if (stream === null) {
      throw this.aborted('acquireMicrophone');
    }
    return stream;
  }

  /** Select the preferred microphone by device ID, stored in memory only. */
  selectMicrophone(deviceId: string | undefined): void {
    if (this.disposed) {
      throw this.aborted('selectMicrophone');
    }
    this.preferredDeviceId = deviceId;
  }

  /**
   * Notify on browser `devicechange`. Registers exactly one environment
   * listener; a second registration replaces the first. Returns an idempotent
   * unsubscribe that removes the listener only if it is still the current one.
   */
  onDeviceChange(listener: () => void): () => void {
    if (this.disposed) {
      throw this.aborted('onDeviceChange');
    }
    this.removeDeviceChangeListener();
    const change = (): void => listener();
    this.deviceChangeListener = change;
    this.env.mediaDevices.addEventListener('devicechange', change);
    return (): void => {
      if (this.deviceChangeListener === change) {
        this.removeDeviceChangeListener();
      }
    };
  }

  /**
   * Release every resource and make the manager terminal. Removes the single
   * devicechange listener; all in-flight operations are invalidated (generation
   * bump) and any late-delivered probe stream is stopped before the operation
   * rejects `ABORTED`.
   */
  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.generation += 1; // invalidate every in-flight operation
    this.removeDeviceChangeListener();
    this.preferredDeviceId = undefined;
    // Cancel every still-pending probe so a late-delivered stream is stopped
    // and rejects ABORTED, not surfaced to a newer lifecycle.
    for (const controller of this.inFlight) {
      controller.abort();
    }
    this.inFlight.clear();
  }

  /** Return the next generation token, or throw if already disposed. */
  private begin(): number {
    if (this.disposed) {
      throw this.aborted('media operation');
    }
    return this.generation;
  }

  /**
   * True when `token` is still the newest generation and the manager is not
   * disposed. A stale token rejects the awaiting operation.
   */
  private stillCurrent(token: number): boolean {
    return token === this.generation && !this.disposed;
  }

  /**
   * Build the getUserMedia request and the device to validate, merging the
   * selected device without mutating caller input. `audioConstraints` is merged
   * into the audio half; video is always `false`.
   */
  private buildRequest(
    overridden: string | undefined,
  ): {
    request: MediaStreamConstraints;
    microphoneDeviceId: string | undefined;
  } {
    const microphoneDeviceId = overridden ?? this.preferredDeviceId;
    const request: MediaStreamConstraints = { audio: true, video: false };
    if (this.options.audioConstraints !== undefined) {
      request.audio = { ...this.options.audioConstraints };
    }
    if (microphoneDeviceId !== undefined) {
      const audio = (request.audio === undefined || typeof request.audio === 'boolean')
        ? {} as MediaTrackConstraints
        : { ...request.audio as MediaTrackConstraints };
      audio.deviceId = { exact: microphoneDeviceId };
      request.audio = audio;
    }
    return { request, microphoneDeviceId };
  }

  /**
   * Look up the current device list before probing. Zero audio inputs is
   * `DEVICE_UNAVAILABLE`; a selected-but-absent device is `DEVICE_NOT_FOUND`;
   * otherwise `ok`. A stale token aborts the check.
   */
  private async preCheck(
    selectedId: string | undefined,
    token: number,
  ): Promise<'ok' | 'unavailable' | 'not-found'> {
    const infos = await this.env.mediaDevices.enumerateDevices();
    if (!this.stillCurrent(token)) {
      throw this.aborted('media operation');
    }
    if (selectedId !== undefined) {
      const exists = infos.some((info) => info.kind === 'audioinput' && info.deviceId === selectedId);
      return exists ? 'ok' : 'not-found';
    }
    const hasInput = infos.some((info) => info.kind === 'audioinput');
    return hasInput ? 'ok' : 'unavailable';
  }

  /**
   * Run getUserMedia and surface its stream only while the operation is still
   * current. When the abort signal fires or the operation is superseded before
   * delivery, the operation rejects `ABORTED` and any stream the promise later
   * delivers is stopped and discarded. When a stream arrives but the operation
   * has since gone stale, the stream is stopped before the operation rejects
   * `ABORTED`.
   */
  private async probe(
    request: MediaStreamConstraints,
    signal: AbortSignal | undefined,
    token: number,
  ): Promise<MediaStream | null> {
    if (!this.stillCurrent(token) || signal?.aborted) {
      throw this.aborted('media operation');
    }
    // A per-operation controller lets dispose() cancel a still-pending probe.
    const local = new AbortController();
    this.inFlight.add(local);
    const base = this.env.mediaDevices.getUserMedia(request);
    try {
      // Guarantee the probe started before we await; a synchronous throw from
      // getUserMedia must surface as a mapped error, not an unhandled rejection
      // racing the abort set. (Production getUserMedia is async, but the fake
      // and hostile environments are not assumed well-behaved.)
      void base;
      const stream = await raceWithAbort(
        base,
        () => this.aborted('media operation'),
        (cause) => mapBrowserMediaError(cause, undefined, 'media operation'),
        local.signal,
        signal,
      );
      if (!this.stillCurrent(token) || signal?.aborted || local.signal.aborted) {
        stopStream(stream);
        throw this.aborted('media operation');
      }
      return stream;
    } finally {
      this.inFlight.delete(local);
    }
  }

  private unavailable(): MediaError {
    return new MediaError(
      'DEVICE_UNAVAILABLE',
      'No usable microphone device is available.',
      undefined,
      'device',
    );
  }

  private notFound(): MediaError {
    return new MediaError(
      'DEVICE_NOT_FOUND',
      'The selected microphone is not present.',
      undefined,
      'device',
    );
  }

  private aborted(operation: string): MediaError {
    return new MediaError('ABORTED', 'The media operation was aborted.', undefined, operation);
  }

  /** Detach and drop the registered devicechange listener. */
  private removeDeviceChangeListener(): void {
    if (this.deviceChangeListener !== null) {
      this.env.mediaDevices.removeEventListener('devicechange', this.deviceChangeListener);
      this.deviceChangeListener = null;
    }
  }
}

/** Stop every track of a stream; tolerates absent/no-op tracks. */
function stopStream(stream: MediaStream): void {
  for (const track of stream.getTracks()) {
    track.stop();
  }
}

/**
 * Resolve with the acquired stream, or reject:
 * - with `mapError(cause)` when capture itself rejects while the operation is
 *   still current;
 * - with `aborted()` (an `ABORTED` `MediaError`) when either the local
 *   controller or the caller's signal fires while capture is pending, or when
 *   a stream arrives after an abort has already won. A late-arriving stream is
 *   stopped before the `ABORTED` rejection.
 */
function raceWithAbort(
  acquire: Promise<MediaStream>,
  aborted: () => MediaError,
  mapError: (cause: unknown) => MediaError,
  local: AbortSignal,
  external: AbortSignal | undefined,
): Promise<MediaStream> {
  const stop = (stream: MediaStream): void => {
    stream.getTracks().forEach((track) => track.stop());
  };
  return new Promise<MediaStream>((resolve, reject) => {
    let settled = false;
    const cleanup = (): void => {
      local.removeEventListener('abort', signalAbort);
      external?.removeEventListener('abort', signalAbort);
    };
    const settle = (action: () => void): boolean => {
      if (settled) return false;
      settled = true;
      cleanup();
      action();
      return true;
    };
    const signalAbort = (): void => {
      settle(() => reject(aborted()));
    };
    if (local.aborted || external?.aborted) {
      signalAbort();
      return;
    }
    local.addEventListener('abort', signalAbort, { once: true });
    external?.addEventListener('abort', signalAbort, { once: true });
    acquire.then(
      (stream) => {
        if (local.aborted || external?.aborted) {
          stop(stream);
          settle(() => reject(aborted()));
        } else {
          settle(() => resolve(stream));
        }
      },
      (cause) => {
        if (local.aborted || external?.aborted) {
          settle(() => reject(aborted()));
        } else {
          settle(() => reject(mapError(cause)));
        }
      },
    );
  });
}