import { describe, expect, it } from 'vitest';
import { MediaError } from '@sip-worker/core';
import { BrowserMedia } from '../../src/media/browser-media.js';
import { WebRtcMediaManager } from '../../src/media/media-manager.js';
import type { BrowserMediaEventMap } from '../../src/media/types.js';
import { FakeMediaEnvironment, FakePeerConnection } from '../support/fake-media-environment.js';

function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function deferred<T>(): {
  promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void;
} {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** Recording emitter capturing every typed media event. */
class Recorder {
  readonly events: Array<BrowserMediaEventMap[keyof BrowserMediaEventMap]> = [];
  emit<K extends keyof BrowserMediaEventMap>(_t: K, value: BrowserMediaEventMap[K]): void {
    this.events.push(value);
  }
}

/** A `MediaStreamTrack` whose `stop()` and `id` we observe. */
interface RecTrack extends MediaStreamTrack { stopped: boolean; id: string; }
function makeTrack(id: string): RecTrack {
  let stopped = false;
  return {
    get stopped(): boolean { return stopped; },
    set stopped(v: boolean) { stopped = v; },
    id,
    kind: 'audio',
    get readyState(): MediaStreamTrackState { return stopped ? 'ended' : 'live'; },
    stop(): void { stopped = true; },
  } as unknown as RecTrack;
}
function streamFrom(track: RecTrack): MediaStream {
  return { getTracks: () => [track], getAudioTracks: () => [track] } as unknown as MediaStream;
}

/** A stub HTMLMediaElement: srcObject + controllable play/setSinkId. */
class MockMediaElement {
  srcObject: MediaStream | null = null;
  playImpl: () => Promise<void> = async () => {};
  playCalls = 0;
  sinkCalls: string[] = [];
  setSinkImpl?: (id: string) => Promise<void>;
  play(): Promise<void> { this.playCalls += 1; return this.playImpl(); }
  asElement(): HTMLMediaElement { return this as unknown as HTMLMediaElement; }
}
function makeElement(opts?: {
  play?: () => Promise<void>;
  sinkId?: (id: string) => Promise<void>;
}): MockMediaElement {
  const element = new MockMediaElement();
  if (opts?.play !== undefined) element.playImpl = opts.play;
  if (opts?.sinkId !== undefined) {
    element.setSinkImpl = opts.sinkId;
    Object.defineProperty(element, 'setSinkId', {
      configurable: true,
      value(deviceId: string): Promise<void> {
        element.sinkCalls.push(deviceId);
        return element.setSinkImpl!(deviceId);
      },
    });
  }
  return element;
}

interface Harness {
  env: FakeMediaEnvironment;
  manager: WebRtcMediaManager;
  ua: BrowserMedia;
  pc: FakePeerConnection;
  events: Array<BrowserMediaEventMap[keyof BrowserMediaEventMap]>;
}

function buildFacade(): Harness {
  const env = new FakeMediaEnvironment([
    { deviceId: 'mic-1', label: 'Mic', groupId: 'g-1', kind: 'audioinput' },
    { deviceId: 'spk-1', label: 'Speaker', groupId: 'g-2', kind: 'audiooutput' },
  ]);
  const recorder = new Recorder();
  const manager = new WebRtcMediaManager({
    env,
    options: { iceGatheringTimeoutMs: 1000 },
    clock: { now: () => 0, setTimeout: () => 1, clearTimeout: () => {} },
    emitter: { emit: (t, v) => recorder.emit(t, v) },
  });
  const ua = new BrowserMedia(manager);
  env.queuedPeerConnections.push(new FakePeerConnection() as unknown as RTCPeerConnection);
  return {
    env,
    manager,
    ua,
    pc: env.queuedPeerConnections[0] as unknown as FakePeerConnection,
    events: recorder.events,
  };
}

/**
 * Drive a createOffer session to a connected call with a surfaced remote stream.
 * Requires the caller to have queued a call microphone stream first.
 */
async function driveActiveCall(h: Harness): Promise<void> {
  h.pc.autoCompleteIceGathering = true;
  h.env.queuedUserMedia.push(streamFrom(makeTrack('call-track')));
  h.manager.postMessage({ type: 'createOffer', requestId: 'req-1', sessionId: 's1' });
  await flush();
  h.pc._setIceConnection('connected');
  await flush();
  h.pc._emitRemoteAudioTrack();
  await flush();
  // Session end is observable by closing the session.
}

function remoteEventStream(h: Harness): MediaStream {
  const event = h.events.find((e) => e.type === 'remoteAudio') as
    { type: 'remoteAudio'; sessionId: string; stream: MediaStream } | undefined;
  if (event === undefined) throw new Error('no remoteAudio event surfaced');
  return event.stream;
}

describe('BrowserMedia — device delegation', () => {
  it('listDevices delegates to the manager/device-manager', async () => {
    const { ua } = buildFacade();
    const devices = await ua.listDevices();
    expect(devices.map((d) => d.kind)).toEqual(['audioinput', 'audiooutput']);
  });

  it('prepare delegates to the manager/device-manager probe path', async () => {
    const { env, ua } = buildFacade();
    env.queuedUserMedia.push(streamFrom(makeTrack('probe')));
    await ua.prepare();
    expect(env.getUserMediaConstraints.length).toBeGreaterThan(0);
  });

  it('selectMicrophone while idle commits a preference validated on the next prepare', async () => {
    const { env, ua } = buildFacade();
    await ua.selectMicrophone('mic-1'); // idle: in-memory commit only
    env.queuedUserMedia.push(streamFrom(makeTrack('probe')));
    await ua.prepare();
    expect(env.getUserMediaConstraints[0]!.audio).toEqual({ deviceId: { ideal: 'mic-1' } });
  });

  it('rejects when the facade is disposed', async () => {
    const { ua } = buildFacade();
    ua.dispose();
    await expect(ua.listDevices()).rejects.toBeInstanceOf(MediaError);
    await expect(ua.listDevices()).rejects.toMatchObject({ code: 'ABORTED' });
  });
});

describe('BrowserMedia — active-call selectMicrophone', () => {
  it('delegates to the session swap: replaceTrack then stop old, then commits preference', async () => {
    const h = buildFacade();
    await driveActiveCall(h);
    const sender = h.pc.transceivers[0]!.sender;
    const oldTrack = sender.track as unknown as RecTrack;
    expect(oldTrack.stopped).toBe(false);

    const newTrack = makeTrack('new-track');
    h.env.queuedUserMedia.push(streamFrom(newTrack));

    await h.ua.selectMicrophone('mic-1');

    // Order: sender now holds the new track; the old track stopped after the swap.
    expect(sender.replaceTrackCalls.length).toBeGreaterThanOrEqual(1);
    expect(sender.replaceTrackCalls[sender.replaceTrackCalls.length - 1] as unknown as RecTrack)
      .toBe(newTrack);
    expect(oldTrack.stopped).toBe(true);
    expect(newTrack.stopped).toBe(false);
  });

  it('on replacement failure stops the new track and preserves the old track', async () => {
    const h = buildFacade();
    await driveActiveCall(h);
    const sender = h.pc.transceivers[0]!.sender;
    sender.failNextReplaceTrack = true;
    const oldTrack = sender.track as unknown as RecTrack;
    const newTrack = makeTrack('failed-new');
    h.env.queuedUserMedia.push(streamFrom(newTrack));

    await expect(h.ua.selectMicrophone('mic-1')).rejects.toBeInstanceOf(MediaError);
    await expect(h.ua.selectMicrophone('mic-1')).rejects.toMatchObject({ code: 'INTERNAL_ERROR' });
    expect(oldTrack.stopped).toBe(false); // old track still attached and live
    expect(newTrack.stopped).toBe(true);  // failed-new track reclaimed
    expect(sender.track as unknown as RecTrack).toBe(oldTrack);
  });

  it('stops the newly-acquired track when replaceMicrophone throws from a pre-call guard', async () => {
    const h = buildFacade();
    await driveActiveCall(h);
    const sender = h.pc.transceivers[0]!.sender;
    const oldTrack = sender.track as unknown as RecTrack;

    // Gate the replacement acquisition. While it is pending, close the session
    // so that when the track lands, replaceMicrophone hits its `closed` guard
    // (a pre-call guard that throws WITHOUT stopping the freshly acquired track).
    const gated = deferred<MediaStream>();
    const newTrack = makeTrack('guard-new');
    h.env.queuedUserMedia.push(gated.promise);
    const replacement = h.ua.selectMicrophone('mic-1');
    await flush(); // acquisition (getUserMedia) is now pending
    h.manager.postMessage({ type: 'closeSession', sessionId: 's1' });
    await flush();
    // The old stream is reclaimed by close; the acquired track was never
    // attached to the session, so this caller must own stopping it. Attach the
    // rejection handler immediately after resolving so the ABORTED rejection is
    // never reported as an unhandled error.
    gated.resolve(streamFrom(newTrack));
    await expect(replacement).rejects.toBeInstanceOf(MediaError);
    await expect(replacement).rejects.toMatchObject({ code: 'ABORTED' });
    expect(newTrack.stopped).toBe(true);  // the device-holding track is reclaimed
    expect(oldTrack.stopped).toBe(true);  // old session teardown stopped old track
  });
});

describe('BrowserMedia — attachRemoteAudio', () => {
  it('rejects when no active remote stream exists yet', async () => {
    const { ua } = buildFacade();
    const element = makeElement();
    await expect(ua.attachRemoteAudio(element.asElement()))
      .rejects.toMatchObject({ code: 'INTERNAL_ERROR' });
  });

  it('assigns the active remote stream without playing when play is not requested', async () => {
    const h = buildFacade();
    await driveActiveCall(h);
    const stream = remoteEventStream(h);
    const element = makeElement();
    const detach = await h.ua.attachRemoteAudio(element.asElement());
    expect(element.srcObject).toBe(stream);
    expect(element.playCalls).toBe(0);
    detach();
    expect(element.srcObject).toBeNull();
  });

  it('calls setSinkId when an output is selected and available', async () => {
    const h = buildFacade();
    await driveActiveCall(h);
    const element = makeElement({ sinkId: async () => {} });
    const detach = await h.ua.attachRemoteAudio(element.asElement(), { outputDeviceId: 'spk-1' });
    expect(element.sinkCalls).toEqual(['spk-1']);
    detach();
  });

  it('rejects OUTPUT_SELECTION_UNSUPPORTED when setSinkId is absent', async () => {
    const h = buildFacade();
    await driveActiveCall(h);
    const element = makeElement(); // no setSinkId
    await expect(h.ua.attachRemoteAudio(element.asElement(), { outputDeviceId: 'spk-1' }))
      .rejects.toMatchObject({ code: 'OUTPUT_SELECTION_UNSUPPORTED' });
    expect(element.srcObject).toBeNull(); // assignment reverted
  });

  it('calls and awaits play() when play: true and rejects PLAYBACK_FAILED on autoplay denial', async () => {
    const h = buildFacade();
    await driveActiveCall(h);
    const ok = makeElement();
    const detach = await h.ua.attachRemoteAudio(ok.asElement(), { play: true });
    expect(ok.playCalls).toBe(1);
    detach();

    const blocked = makeElement({ play: () => Promise.reject(new Error('NotAllowedError')) });
    await expect(h.ua.attachRemoteAudio(blocked.asElement(), { play: true }))
      .rejects.toMatchObject({ code: 'PLAYBACK_FAILED' });
    expect(blocked.playCalls).toBe(1);
    expect(blocked.srcObject).toBeNull();
  });

  it('returns an idempotent detach', async () => {
    const h = buildFacade();
    await driveActiveCall(h);
    const element = makeElement();
    const detach = await h.ua.attachRemoteAudio(element.asElement());
    expect(element.srcObject).not.toBeNull();
    detach();
    detach();
    expect(element.srcObject).toBeNull();
  });
});

describe('BrowserMedia — setAudioOutput', () => {
  it('delegates output selection to the renderer via setSinkId', async () => {
    const { ua } = buildFacade();
    const element = makeElement({ sinkId: async () => {} });
    await ua.setAudioOutput(element.asElement(), 'spk-1');
    expect(element.sinkCalls).toEqual(['spk-1']);
  });

  it('rejects OUTPUT_SELECTION_UNSUPPORTED when setSinkId is absent', async () => {
    const { ua } = buildFacade();
    const element = makeElement();
    await expect(ua.setAudioOutput(element.asElement(), 'spk-1'))
      .rejects.toMatchObject({ code: 'OUTPUT_SELECTION_UNSUPPORTED' });
  });
});

describe('BrowserMedia — remote-audio cleanup on session end', () => {
  it('detaches only the element still bound to the closing session stream', async () => {
    const h = buildFacade();
    await driveActiveCall(h);
    const stream = remoteEventStream(h);
    const live = makeElement();
    const others = makeElement();
    await h.ua.attachRemoteAudio(live.asElement());
    await h.ua.attachRemoteAudio(others.asElement());

    // Close the session; the facade's session-end observer detaches the stream.
    h.manager.postMessage({ type: 'closeSession', sessionId: 's1' });
    await flush();

    expect(live.srcObject).toBeNull();
    expect(others.srcObject).toBeNull();
    void stream;
  });

  it('does not detach an element whose stream the application already replaced', async () => {
    const h = buildFacade();
    await driveActiveCall(h);
    const replacement = streamFrom(makeTrack('other'));
    const element = makeElement();
    await h.ua.attachRemoteAudio(element.asElement());
    element.srcObject = replacement; // app swapped the stream before close
    h.manager.postMessage({ type: 'closeSession', sessionId: 's1' });
    await flush();
    expect(element.srcObject).toBe(replacement); // untouched — not ours anymore
  });
});