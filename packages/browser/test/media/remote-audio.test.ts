import { describe, expect, it } from 'vitest';
import { MediaError } from '@sip-worker/core';
import { RemoteAudioRenderer } from '../../src/media/remote-audio.js';

/** A controlled stream identity; plain object cast to MediaStream (no DOM). */
function makeStream(label: string): MediaStream {
  return { id: `stream-${label}` } as unknown as MediaStream;
}

/** A stub HTMLMediaElement with controllable play/setSinkId (absent by default). */
class MockMediaElement {
  srcObject: MediaStream | null = null;
  playImpl: () => Promise<void> = async () => {};
  playCalls = 0;
  sinkCalls: string[] = [];
  /** Assigned only when the test wants a supported output-selection surface. */
  setSinkImpl?: (id: string) => Promise<void>;

  play(): Promise<void> {
    this.playCalls += 1;
    return this.playImpl();
  }

  asElement(): HTMLMediaElement {
    return this as unknown as HTMLMediaElement;
  }
}

/** Build an element with the desired play/setSinkId surface. */
function makeElement(opts?: {
  play?: () => Promise<void>;
  sinkId?: (id: string) => Promise<void>;
}): MockMediaElement {
  const element = new MockMediaElement();
  if (opts?.play !== undefined) element.playImpl = opts.play;
  if (opts?.sinkId !== undefined) {
    element.setSinkImpl = opts.sinkId;
    // Define setSinkId as an own method only in the supported case.
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

function deferred<T>(): {
  promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void;
} {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe('RemoteAudioRenderer.attach — assignment and play', () => {
  it('assigns srcObject WITHOUT playing when play is not requested', async () => {
    const renderer = new RemoteAudioRenderer();
    const element = makeElement();
    const stream = makeStream('s1');
    const detach = await renderer.attach(element.asElement(), 's1', stream, {});
    expect(element.srcObject).toBe(stream);
    expect(element.playCalls).toBe(0);
    detach();
    expect(element.srcObject).toBeNull();
  });

  it('passes through plain assign when options is omitted', async () => {
    const renderer = new RemoteAudioRenderer();
    const element = makeElement();
    const stream = makeStream('s1');
    const detach = await renderer.attach(element.asElement(), 's1', stream);
    expect(element.srcObject).toBe(stream);
    expect(element.playCalls).toBe(0);
    detach();
  });

  it('calls AND AWAITS play() when play: true (resolves only after play resolves)', async () => {
    const renderer = new RemoteAudioRenderer();
    const element = makeElement();
    const gate = deferred<void>();
    element.playImpl = () => gate.promise;
    const stream = makeStream('s1');
    let attached = false;
    const pending = renderer
      .attach(element.asElement(), 's1', stream, { play: true })
      .then((detach) => { attached = true; return detach; });
    await flush();
    expect(attached).toBe(false); // not resolved until play resolves
    gate.resolve();
    const detach = await pending;
    expect(attached).toBe(true);
    expect(element.playCalls).toBe(1);
    detach();
  });

  it('maps a rejected play() to PLAYBACK_FAILED and detaches/reverts the element', async () => {
    const renderer = new RemoteAudioRenderer();
    const element = makeElement();
    element.playImpl = () => Promise.reject(new Error('NotAllowedError: autoplay'));
    const stream = makeStream('s1');
    await expect(
      renderer.attach(element.asElement(), 's1', stream, { play: true }),
    ).rejects.toBeInstanceOf(MediaError);
    await expect(
      renderer.attach(element.asElement(), 's1', stream, { play: true }),
    ).rejects.toMatchObject({ code: 'PLAYBACK_FAILED' });
    // Autoplay rejection must NOT be treated as successful playback: revert.
    expect(element.playCalls).toBe(2);
    expect(element.srcObject).toBeNull();
  });

  it('does not create any DOM node (works against a bare stub element)', async () => {
    const renderer = new RemoteAudioRenderer();
    const element = makeElement();
    const stream = makeStream('s1');
    const detach = await renderer.attach(element.asElement(), 's1', stream, { play: true });
    expect(element.srcObject).toBe(stream);
    expect(element.playCalls).toBe(1);
    detach();
  });
});

describe('RemoteAudioRenderer.attach — output selection (setSinkId)', () => {
  it('calls setSinkId on the element when the output is selected and it is available', async () => {
    const renderer = new RemoteAudioRenderer();
    const element = makeElement({ sinkId: async () => {} });
    const stream = makeStream('s1');
    const detach = await renderer.attach(element.asElement(), 's1', stream, {
      outputDeviceId: 'spk-1',
    });
    expect(element.sinkCalls).toEqual(['spk-1']);
    detach();
  });

  it('rejects with OUTPUT_SELECTION_UNSUPPORTED when setSinkId is absent', async () => {
    const renderer = new RemoteAudioRenderer();
    const element = makeElement(); // no setSinkId
    const stream = makeStream('s1');
    await expect(
      renderer.attach(element.asElement(), 's1', stream, { outputDeviceId: 'spk-1' }),
    ).rejects.toBeInstanceOf(MediaError);
    await expect(
      renderer.attach(element.asElement(), 's1', stream, { outputDeviceId: 'spk-1' }),
    ).rejects.toMatchObject({ code: 'OUTPUT_SELECTION_UNSUPPORTED' });
    // Failure reverts assignment; never pretends success.
    expect(element.srcObject).toBeNull();
  });

  it('setOutput surfaces a coded error when the sink selection itself fails', async () => {
    const renderer = new RemoteAudioRenderer();
    const element = makeElement({ sinkId: () => Promise.reject({ name: 'NotFoundError' }) });
    await expect(
      renderer.setOutput(element.asElement(), 'spk-missing'),
    ).rejects.toMatchObject({ code: 'DEVICE_NOT_FOUND' });
  });
});

describe('RemoteAudioRenderer — detach idempotency', () => {
  it('returns an idempotent detach function', async () => {
    const renderer = new RemoteAudioRenderer();
    const element = makeElement();
    const stream = makeStream('s1');
    const detach = await renderer.attach(element.asElement(), 's1', stream);
    expect(element.srcObject).toBe(stream);
    detach();
    detach(); // second call is a no-op
    expect(element.srcObject).toBeNull();
  });
});

describe('RemoteAudioRenderer — cleanup on session end', () => {
  it('clears only the matching element/srcObject for the closing session', async () => {
    const renderer = new RemoteAudioRenderer();
    const stream1 = makeStream('s1');
    const stream2 = makeStream('s2');
    const elementA = makeElement();
    const elementB = makeElement();
    await renderer.attach(elementA.asElement(), 'session-1', stream1);
    await renderer.attach(elementB.asElement(), 'session-2', stream2);
    renderer.detachAllForSession('session-1');
    expect(elementA.srcObject).toBeNull();       // its session closed
    expect(elementB.srcObject).toBe(stream2);    // a different session untouched
  });

  it('does not detach an element whose srcObject the application already changed', async () => {
    const renderer = new RemoteAudioRenderer();
    const stream1 = makeStream('s1');
    const other = makeStream('other');
    const element = makeElement();
    await renderer.attach(element.asElement(), 'session-1', stream1);
    element.srcObject = other; // app replaced the stream
    renderer.detachAllForSession('session-1');
    expect(element.srcObject).toBe(other); // left alone — not ours anymore
  });

  it('does not detach when notifySessionEnd refers to an unrelated session', async () => {
    const renderer = new RemoteAudioRenderer();
    const stream1 = makeStream('s1');
    const element = makeElement();
    await renderer.attach(element.asElement(), 'session-1', stream1);
    renderer.detachAllForSession('session-9');
    expect(element.srcObject).toBe(stream1); // still live
  });
});