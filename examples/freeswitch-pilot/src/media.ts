/**
 * Selectable microphone media environment for the FreeSWITCH pilot.
 *
 * Wraps a {@link BrowserMediaEnvironment} so the app can commit a microphone
 * device selection: once a device is chosen, every `getUserMedia` acquires
 * that exact device. All other mediaDevices methods, peer connection, stream,
 * and capability factories delegate to the underlying environment untouched.
 *
 * The environment is resolved lazily via `createBrowserMediaEnvironment` when
 * no explicit environment is supplied, making it unit-testable with fakes.
 */

import {
  createBrowserMediaEnvironment,
  type BrowserMediaEnvironment,
} from 'sip-worker';

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export interface SelectableMediaEnvironment {
  /** The underlying media environment with getUserMedia interception. */
  readonly environment: BrowserMediaEnvironment;
  /** Set the preferred microphone device id, or undefined to clear. */
  selectMicrophone(deviceId: string | undefined): void;
  /** List only audioinput devices, frozen. */
  listMicrophones(): Promise<readonly MediaDeviceInfo[]>;
  /** Clear the microphone selection (next getUserMedia uses default). */
  clear(): void;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Create a {@link SelectableMediaEnvironment} wrapping the real browser media
 * environment (or an injected fake for testing).
 *
 * @param baseEnvironment - optional override; when omitted the real browser
 *   environment is created via `createBrowserMediaEnvironment()`.
 */
export function createSelectableMediaEnvironment(
  baseEnvironment?: BrowserMediaEnvironment,
): SelectableMediaEnvironment {
  const base = baseEnvironment ?? createBrowserMediaEnvironment();
  let selectedDeviceId: string | undefined;

  const mediaDevices: BrowserMediaEnvironment['mediaDevices'] = {
    getUserMedia: (constraints?: MediaStreamConstraints) => {
      if (selectedDeviceId === undefined) {
        return base.mediaDevices.getUserMedia(constraints);
      }
      const audioConstraint =
        typeof constraints?.audio === 'object' && constraints.audio !== null
          ? { ...constraints.audio, deviceId: { exact: selectedDeviceId } }
          : { deviceId: { exact: selectedDeviceId } };
      return base.mediaDevices.getUserMedia({ ...constraints, audio: audioConstraint });
    },
    enumerateDevices: () => base.mediaDevices.enumerateDevices(),
    addEventListener: ((
      type: string,
      listener: EventListenerOrEventListenerObject,
      options?: boolean | AddEventListenerOptions,
    ) => {
      base.mediaDevices.addEventListener(type, listener, options);
    }) as MediaDevices['addEventListener'],
    removeEventListener: ((
      type: string,
      listener: EventListenerOrEventListenerObject,
      options?: boolean | EventListenerOptions,
    ) => {
      base.mediaDevices.removeEventListener(type, listener, options);
    }) as MediaDevices['removeEventListener'],
  };

  const environment: BrowserMediaEnvironment = {
    mediaDevices,
    createPeerConnection: (config: RTCConfiguration) => base.createPeerConnection(config),
    createMediaStream: (tracks?: MediaStreamTrack[]) => base.createMediaStream(tracks),
    getAudioCapabilities: () => base.getAudioCapabilities(),
  };

  return {
    environment,
    selectMicrophone(deviceId: string | undefined): void {
      selectedDeviceId = deviceId;
    },
    async listMicrophones(): Promise<readonly MediaDeviceInfo[]> {
      const devices = await base.mediaDevices.enumerateDevices();
      return Object.freeze(
        devices.filter((d) => d.kind === 'audioinput'),
      );
    },
    clear(): void {
      selectedDeviceId = undefined;
    },
  };
}
