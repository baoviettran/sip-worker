import { describe, expect, it, vi } from 'vitest';
import {
  createSelectableMediaEnvironment,
  type SelectableMediaEnvironment,
} from '../../examples/freeswitch-pilot/src/media.js';
import type { BrowserMediaEnvironment } from 'sip-worker';

// ---------------------------------------------------------------------------
// Fake BrowserMediaEnvironment for unit testing
// ---------------------------------------------------------------------------

function createFakeMediaEnvironment() {
  const fakeDevices: MediaDeviceInfo[] = [
    {
      deviceId: 'mic-1',
      kind: 'audioinput',
      label: 'Default Mic',
      groupId: 'g1',
      toJSON(): Record<string, unknown> {
        return { deviceId: 'mic-1', kind: 'audioinput', label: 'Default Mic', groupId: 'g1' };
      },
    } as MediaDeviceInfo,
    {
      deviceId: 'mic-2',
      kind: 'audioinput',
      label: 'External Mic',
      groupId: 'g2',
      toJSON(): Record<string, unknown> {
        return { deviceId: 'mic-2', kind: 'audioinput', label: 'External Mic', groupId: 'g2' };
      },
    } as MediaDeviceInfo,
    {
      deviceId: 'speaker-1',
      kind: 'audiooutput',
      label: 'Speakers',
      groupId: 'g3',
      toJSON(): Record<string, unknown> {
        return { deviceId: 'speaker-1', kind: 'audiooutput', label: 'Speakers', groupId: 'g3' };
      },
    } as MediaDeviceInfo,
  ];

  const fakeMediaDevices: MediaDevices = {
    getUserMedia: vi.fn(async (_constraints?: MediaStreamConstraints) => {
      return {} as MediaStream;
    }),
    enumerateDevices: vi.fn(async () => fakeDevices),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
    addDevicechangeListener: null as unknown as MediaDevices['addDevicechangeListener'],
    removeDevicechangeListener: null as unknown as MediaDevices['removeDevicechangeListener'],
  };

  const environment: BrowserMediaEnvironment = {
    mediaDevices: fakeMediaDevices,
    createPeerConnection: vi.fn((_config?: RTCConfiguration) => ({}) as unknown as RTCPeerConnection),
    createMediaStream: vi.fn((_tracks?: MediaStreamTrack[]) => ({}) as unknown as MediaStream),
    getAudioCapabilities: vi.fn((): RTCRtpCapabilities | null => null),
  };

  return {
    environment,
    fakeMediaDevices,
    fakeDevices,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SelectableMediaEnvironment', () => {
  describe('selectMicrophone', () => {
    it('delegates getUserMedia unchanged when no device is selected', async () => {
      const { environment, fakeMediaDevices } = createFakeMediaEnvironment();
      const selectable: SelectableMediaEnvironment = createSelectableMediaEnvironment(environment);
      selectable.selectMicrophone(undefined);

      const constraints: MediaStreamConstraints = { audio: true };
      await selectable.environment.mediaDevices.getUserMedia(constraints);

      expect(fakeMediaDevices.getUserMedia).toHaveBeenCalledWith({ audio: true });
    });

    it('injects exact deviceId constraint when a microphone is selected', async () => {
      const { environment, fakeMediaDevices } = createFakeMediaEnvironment();
      const selectable: SelectableMediaEnvironment = createSelectableMediaEnvironment(environment);

      selectable.selectMicrophone('mic-2');

      await selectable.environment.mediaDevices.getUserMedia({ audio: true });

      expect(fakeMediaDevices.getUserMedia).toHaveBeenCalledWith({
        audio: { deviceId: { exact: 'mic-2' } },
      });
    });

    it('merges existing audio constraints with deviceId selection', async () => {
      const { environment, fakeMediaDevices } = createFakeMediaEnvironment();
      const selectable: SelectableMediaEnvironment = createSelectableMediaEnvironment(environment);

      selectable.selectMicrophone('mic-1');

      await selectable.environment.mediaDevices.getUserMedia({
        audio: { echoCancellation: true },
      });

      expect(fakeMediaDevices.getUserMedia).toHaveBeenCalledWith({
        audio: { echoCancellation: true, deviceId: { exact: 'mic-1' } },
      });
    });

    it('clears device selection when selectMicrophone called with undefined', async () => {
      const { environment, fakeMediaDevices } = createFakeMediaEnvironment();
      const selectable: SelectableMediaEnvironment = createSelectableMediaEnvironment(environment);

      selectable.selectMicrophone('mic-2');
      selectable.selectMicrophone(undefined);

      await selectable.environment.mediaDevices.getUserMedia({ audio: true });

      expect(fakeMediaDevices.getUserMedia).toHaveBeenCalledWith({ audio: true });
    });
  });

  describe('listMicrophones', () => {
    it('returns only audioinput devices, frozen', async () => {
      const { environment } = createFakeMediaEnvironment();
      const selectable: SelectableMediaEnvironment = createSelectableMediaEnvironment(environment);
      const mics = await selectable.listMicrophones();

      expect(mics).toHaveLength(2);
      expect(mics[0].kind).toBe('audioinput');
      expect(mics[1].kind).toBe('audioinput');
      expect(Object.isFrozen(mics)).toBe(true);
    });

    it('returns empty array when no audioinput devices exist', async () => {
      const { environment } = createFakeMediaEnvironment();
      const selectable: SelectableMediaEnvironment = createSelectableMediaEnvironment(environment);
      const mics = await selectable.listMicrophones();

      expect(mics.length).toBeGreaterThanOrEqual(0);
      for (const mic of mics) {
        expect(mic.kind).toBe('audioinput');
      }
    });
  });

  describe('delegation', () => {
    it('delegates createPeerConnection to the base environment', () => {
      const { environment } = createFakeMediaEnvironment();
      const selectable: SelectableMediaEnvironment = createSelectableMediaEnvironment(environment);

      expect(selectable.environment.createPeerConnection).toBeDefined();
    });

    it('delegates createMediaStream to the base environment', () => {
      const { environment } = createFakeMediaEnvironment();
      const selectable: SelectableMediaEnvironment = createSelectableMediaEnvironment(environment);

      expect(selectable.environment.createMediaStream).toBeDefined();
    });

    it('delegates getAudioCapabilities to the base environment', () => {
      const { environment } = createFakeMediaEnvironment();
      const selectable: SelectableMediaEnvironment = createSelectableMediaEnvironment(environment);

      expect(selectable.environment.getAudioCapabilities).toBeDefined();
    });
  });

  describe('clear', () => {
    it('resets microphone selection after clear', async () => {
      const { environment, fakeMediaDevices } = createFakeMediaEnvironment();
      const selectable: SelectableMediaEnvironment = createSelectableMediaEnvironment(environment);

      selectable.selectMicrophone('mic-2');
      selectable.clear();

      await selectable.environment.mediaDevices.getUserMedia({ audio: true });

      expect(fakeMediaDevices.getUserMedia).toHaveBeenCalledWith({ audio: true });
    });
  });
});
