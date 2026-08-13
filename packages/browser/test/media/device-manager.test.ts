import { describe, expect, it } from 'vitest';
import { MediaError } from '@sip-worker/core';
import { MediaDeviceManager } from '../../src/media/device-manager.js';
import type { BrowserAudioDevice } from '../../src/media/types.js';
import { FakeMediaEnvironment } from '../support/fake-media-environment.js';

const AUDIO_INPUT: BrowserAudioDevice = {
  deviceId: 'mic-1', label: 'Microphone', groupId: 'g-1', kind: 'audioinput',
};
const AUDIO_OUTPUT: BrowserAudioDevice = {
  deviceId: 'spk-1', label: 'Speaker', groupId: 'g-2', kind: 'audiooutput',
};
/** A video device smuggled into the environment to prove listDevices filters it. */
const VIDEO_INPUT = {
  deviceId: 'cam-1', label: 'Camera', groupId: 'g-3', kind: 'videoinput',
} as unknown as BrowserAudioDevice;
const ONLY_AUDIO_INPUT: BrowserAudioDevice[] = [AUDIO_INPUT];

/** A resolvable promise whose settlement the test controls (never real timers). */
function deferred<T>(): {
  promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

interface RecTrack extends MediaStreamTrack { stopped: boolean; }
/** A fake audio stream whose track records whether it was stopped. */
function makeAudioStream(): { stream: MediaStream; isStopped: () => boolean } {
  const track = {
    stopped: false as boolean,
    kind: 'audio',
    id: 'track-1',
    stop(this: { stopped: boolean }): void { this.stopped = true; },
  } as unknown as RecTrack;
  const stream = {
    getTracks(): MediaStreamTrack[] { return [track]; },
    getAudioTracks(): MediaStreamTrack[] { return [track]; },
  } as unknown as MediaStream;
  return { stream, isStopped: () => track.stopped };
}

/** Flush pending microtasks around a controlled promise settlement. */
function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe('MediaDeviceManager.listDevices', () => {
  it('returns only audio devices, filtering out videoinput/videooutput', async () => {
    const manager = new MediaDeviceManager(
      new FakeMediaEnvironment([AUDIO_INPUT, VIDEO_INPUT, AUDIO_OUTPUT]),
      {},
    );
    const devices = await manager.listDevices();
    expect(devices.map((device) => device.kind)).toEqual(['audioinput', 'audiooutput']);
    expect(devices.map((device) => device.deviceId)).toEqual(['mic-1', 'spk-1']);
  });

  it('surfaces privacy-filtered labels without throwing when labels are missing', async () => {
    const manager = new MediaDeviceManager(
      new FakeMediaEnvironment([{ ...AUDIO_INPUT, label: '' }]),
      {},
    );
    const [device] = await manager.listDevices();
    expect(device!.deviceId).toBe('mic-1');
    expect(device!.label).toBe('');
  });
});

describe('MediaDeviceManager.prepare', () => {
  it('requests audio and NO video as { audio: true, video: false }', async () => {
    const env = new FakeMediaEnvironment(ONLY_AUDIO_INPUT);
    const manager = new MediaDeviceManager(env, {});
    env.queuedUserMedia.push(makeAudioStream().stream);
    await manager.prepare();
    const constraints = env.getUserMediaConstraints[0]!;
    expect(constraints.audio).toBe(true);
    expect(constraints.video).toBe(false);
  });

  it('merges configured audioConstraints and keeps video false (defensive copy)', async () => {
    const env = new FakeMediaEnvironment(ONLY_AUDIO_INPUT);
    const manager = new MediaDeviceManager(env, {
      audioConstraints: { echoCancellation: true, noiseSuppression: true },
    });
    const callerConstraints = { echoCancellation: true, noiseSuppression: true };
    env.queuedUserMedia.push(makeAudioStream().stream);
    await manager.prepare();
    expect(env.getUserMediaConstraints[0]!.audio).toEqual(callerConstraints);
    expect(env.getUserMediaConstraints[0]!.video).toBe(false);
  });

  it('uses the exact selected-device constraints after selectMicrophone', async () => {
    const env = new FakeMediaEnvironment(ONLY_AUDIO_INPUT);
    const manager = new MediaDeviceManager(env, {});
    manager.selectMicrophone('mic-1');
    env.queuedUserMedia.push(makeAudioStream().stream);
    await manager.prepare();
    expect(env.getUserMediaConstraints[0]!.audio).toEqual({ deviceId: { ideal: 'mic-1' } });
    expect(env.getUserMediaConstraints[0]!.video).toBe(false);
  });

  it('stops the probe track on success and makes exactly one getUserMedia call', async () => {
    const env = new FakeMediaEnvironment(ONLY_AUDIO_INPUT);
    const manager = new MediaDeviceManager(env, {});
    const { stream, isStopped } = makeAudioStream();
    env.queuedUserMedia.push(stream);
    await manager.prepare();
    expect(isStopped()).toBe(true);
    expect(env.getUserMediaConstraints.length).toBe(1);
  });

  it('maps a rejected probe stream on failure without leaking state', async () => {
    const env = new FakeMediaEnvironment(ONLY_AUDIO_INPUT);
    const manager = new MediaDeviceManager(env, {});
    env.queuedUserMedia.push(() => Promise.reject({ name: 'NotFoundError', message: 'nope' }));
    await expect(manager.prepare()).rejects.toMatchObject({ code: 'DEVICE_NOT_FOUND' });
  });

  it('rejects with DEVICE_UNAVAILABLE when no audio device exists at all', async () => {
    const manager = new MediaDeviceManager(new FakeMediaEnvironment([]), {});
    await expect(manager.prepare()).rejects.toMatchObject({ code: 'DEVICE_UNAVAILABLE' });
  });

  it('rejects with DEVICE_NOT_FOUND when the selected device is not present', async () => {
    const manager = new MediaDeviceManager(new FakeMediaEnvironment(ONLY_AUDIO_INPUT), {});
    manager.selectMicrophone('nope');
    await expect(manager.prepare()).rejects.toMatchObject({ code: 'DEVICE_NOT_FOUND' });
  });

  it('stops a late probe when the operation is aborted mid-flight (controlled promise)', async () => {
    const env = new FakeMediaEnvironment(ONLY_AUDIO_INPUT);
    const manager = new MediaDeviceManager(env, {});
    const gum = deferred<MediaStream>();
    const { stream, isStopped } = makeAudioStream();
    env.queuedUserMedia.push(gum.promise);
    const controller = new AbortController();
    const operation = manager.prepare({ signal: controller.signal });
    await flush(); // let the pre-check resolve so getUserMedia is pending
    controller.abort();
    await expect(operation).rejects.toMatchObject({ code: 'ABORTED' });
    gum.resolve(stream);
    await flush();
    expect(isStopped()).toBe(true);
  });

  it('stops a late probe when dispose supersedes the operation (controlled promise)', async () => {
    const env = new FakeMediaEnvironment(ONLY_AUDIO_INPUT);
    const manager = new MediaDeviceManager(env, {});
    const gum = deferred<MediaStream>();
    const { stream, isStopped } = makeAudioStream();
    env.queuedUserMedia.push(gum.promise);
    const operation = manager.prepare();
    await flush(); // let the pre-check resolve so getUserMedia is pending
    manager.dispose();
    gum.resolve(stream);
    await expect(operation).rejects.toMatchObject({ code: 'ABORTED' });
    expect(isStopped()).toBe(true);
  });

  it('rejects with an ABORTED MediaError when disposed before the operation starts', async () => {
    const manager = new MediaDeviceManager(new FakeMediaEnvironment(ONLY_AUDIO_INPUT), {});
    manager.dispose();
    await expect(manager.prepare()).rejects.toBeInstanceOf(MediaError);
    await expect(manager.prepare()).rejects.toMatchObject({ code: 'ABORTED' });
  });
});

describe('MediaDeviceManager.acquireMicrophone', () => {
  it('returns a fresh track using the selected-device constraints without stopping it', async () => {
    const env = new FakeMediaEnvironment(ONLY_AUDIO_INPUT);
    const manager = new MediaDeviceManager(env, {});
    manager.selectMicrophone('mic-1');
    const { stream, isStopped } = makeAudioStream();
    env.queuedUserMedia.push(stream);
    const acquired = await manager.acquireMicrophone();
    expect(acquired).toBe(stream);
    expect(env.getUserMediaConstraints[0]!.audio).toEqual({ deviceId: { ideal: 'mic-1' } });
    expect(isStopped()).toBe(false);
  });

  it('rejects with DEVICE_NOT_FOUND when the selected device is absent', async () => {
    const manager = new MediaDeviceManager(new FakeMediaEnvironment(ONLY_AUDIO_INPUT), {});
    manager.selectMicrophone('nope');
    await expect(manager.acquireMicrophone()).rejects.toMatchObject({ code: 'DEVICE_NOT_FOUND' });
  });
});

describe('MediaDeviceManager.selectMicrophone and device changes', () => {
  it('stores the selection in memory (no persistence) and uses it on the next prepare', async () => {
    const env = new FakeMediaEnvironment(ONLY_AUDIO_INPUT);
    const manager = new MediaDeviceManager(env, {});
    manager.selectMicrophone('mic-1');
    expect((manager as unknown as { preferredDeviceId: string | undefined }).preferredDeviceId)
      .toBe('mic-1');
    env.queuedUserMedia.push(makeAudioStream().stream);
    await manager.prepare();
    expect(env.getUserMediaConstraints[0]!.audio).toEqual({ deviceId: { ideal: 'mic-1' } });
  });

  it('fires the deviceChanged notification and unsubscribe removes the listener', () => {
    const env = new FakeMediaEnvironment(ONLY_AUDIO_INPUT);
    const manager = new MediaDeviceManager(env, {});
    let fired = 0;
    const off = manager.onDeviceChange(() => { fired += 1; });
    env.emitDeviceChange();
    expect(fired).toBe(1);
    off();
    env.emitDeviceChange();
    expect(fired).toBe(1);
  });

  it('dispose removes the single device-change listener', async () => {
    const env = new FakeMediaEnvironment(ONLY_AUDIO_INPUT);
    const manager = new MediaDeviceManager(env, {});
    let fired = 0;
    manager.onDeviceChange(() => { fired += 1; });
    env.emitDeviceChange();
    expect(fired).toBe(1);
    manager.dispose();
    env.emitDeviceChange();
    expect(fired).toBe(1);
  });
});