import type {
  BrowserAudioDevice,
  BrowserMediaEnvironment,
} from '../../src/media/types.js';

type DeviceListener = (event: Event) => void;

/**
 * Hand-rolled fake {@link BrowserMediaEnvironment} for deterministic media
 * tests. It exposes a scriptable `mediaDevices` and records each call so later
 * tasks (session construction, devices, codecs) can drive and assert on it
 * without a real browser.
 */
export class FakeMediaEnvironment implements BrowserMediaEnvironment {
  readonly mediaDevices: Pick<MediaDevices,
    'getUserMedia' | 'enumerateDevices' | 'addEventListener' | 'removeEventListener'>;

  readonly peerConnectionCalls: RTCConfiguration[] = [];
  readonly mediaStreamCalls: MediaStreamTrack[][] = [];
  readonly audioCapabilitiesCalls: number[] = [];

  /** Queue of results delivered to the next {@link FakeMediaEnvironment.createPeerConnection}. */
  queuedPeerConnections: RTCPeerConnection[] = [];
  /** Queue of results delivered to the next {@link FakeMediaEnvironment.createMediaStream}. */
  queuedMediaStreams: MediaStream[] = [];
  /** Value returned by {@link FakeMediaEnvironment.getAudioCapabilities}, or null to force failure. */
  audioCapabilities: RTCRtpCapabilities | null = makeDefaultCapabilities();

  private readonly listeners = new Map<string, Set<DeviceListener>>();

  constructor(devices: BrowserAudioDevice[] = []) {
    const ref = this;
    this.mediaDevices = {
      async getUserMedia(): Promise<MediaStream> {
        return ref.fakeGetUserMedia();
      },
      async enumerateDevices(): Promise<MediaDeviceInfo[]> {
        return ref.fakeEnumerateDevices(devices);
      },
      addEventListener(type: string, listener: DeviceListener): void {
        ref.addListener(type, listener);
      },
      removeEventListener(type: string, listener: DeviceListener): void {
        ref.removeEventListener(type, listener);
      },
    };
  }

  /** Bridge into the shared listener set for the mediaDevices surface. */
  private addListener(type: string, listener: DeviceListener): void {
    let set = this.listeners.get(type);
    if (set === undefined) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(listener);
  }

  removeEventListener(type: string, listener: DeviceListener): void {
    (this.listeners.get(type) ?? new Set()).delete(listener);
  }

  /** Default `getUserMedia`: deliver the next queued stream or reject. */
  private async fakeGetUserMedia(): Promise<MediaStream> {
    const next = this.queuedMediaStreams.shift();
    if (next !== undefined) {
      return next;
    }
    throw new Error('getUserMedia called with empty queuedMediaStreams');
  }

  /** Default `enumerateDevices`: map the configured devices to MediaDeviceInfo shapes. */
  private fakeEnumerateDevices(devices: BrowserAudioDevice[]): MediaDeviceInfo[] {
    return devices.map((device) => ({ ...device }) as MediaDeviceInfo);
  }

  /** Emit `devicechange` to registered listeners (privacy event only). */
  emitDeviceChange(): void {
    const event = new Event('devicechange');
    for (const listener of [...(this.listeners.get('devicechange') ?? [])]) {
      listener(event);
    }
  }

  createPeerConnection(configuration: RTCConfiguration): RTCPeerConnection {
    this.peerConnectionCalls.push(configuration);
    const next = this.queuedPeerConnections.shift();
    if (next === undefined) {
      throw new Error('createPeerConnection called with empty queuedPeerConnections');
    }
    return next;
  }

  createMediaStream(tracks?: MediaStreamTrack[]): MediaStream {
    this.mediaStreamCalls.push(tracks ?? []);
    const next = this.queuedMediaStreams.shift();
    if (next === undefined) {
      throw new Error('createMediaStream called with empty queuedMediaStreams');
    }
    return next;
  }

  getAudioCapabilities(): RTCRtpCapabilities | null {
    this.audioCapabilitiesCalls.push(1);
    return this.audioCapabilities;
  }
}

/** A minimal, codec-covered capabilities object for tests that sort codes. */
function makeDefaultCapabilities(): RTCRtpCapabilities {
  return {
    codecs: [
      { mimeType: 'audio/PCMU', clockRate: 8000 },
      { mimeType: 'audio/PCMA', clockRate: 8000 },
      { mimeType: 'audio/opus', clockRate: 48000, channels: 2 },
      { mimeType: 'audio/telephone-event', clockRate: 8000 },
    ],
    headerExtensions: [],
  };
}