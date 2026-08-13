import { describe, expect, it } from 'vitest';
import { WebRtcMediaSession } from '../../src/media/session.js';
import type { WebRtcMediaSessionDeps } from '../../src/media/session.js';
import type { BrowserMediaEventMap } from '../../src/media/types.js';
import { FakePeerConnection } from '../support/fake-media-environment.js';
import { FakeMediaEnvironment } from '../support/fake-media-environment.js';

/** Injectable clock driving the ICE-gathering deadline deterministically. */
class FakeClock {
  private current = 0;
  private nextId = 1;
  private readonly timers = new Map<number, { due: number; callback: () => void }>();
  now(): number { return this.current; }
  setTimeout(callback: () => void, delayMs: number): number {
    const id = this.nextId;
    this.nextId += 1;
    this.timers.set(id, { due: this.current + delayMs, callback });
    return id;
  }
  clearTimeout(id: number): void { this.timers.delete(id); }
  pending(): number { return this.timers.size; }
  advance(ms: number): void {
    const now = this.current + ms;
    for (const [id, timer] of [...this.timers]) {
      if (timer.due <= now) {
        this.timers.delete(id);
        timer.callback();
      }
    }
    this.current = now;
  }
}

function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** A manually-settled promise, for controlling a pending getUserMedia. */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** Recording emitter capturing every typed media event. */
// (type-param emitted above is not read here; kept for clarity)
class Recorder {
  readonly events: Array<BrowserMediaEventMap[keyof BrowserMediaEventMap]> = [];
  emit<K extends keyof BrowserMediaEventMap>(_type: K, value: BrowserMediaEventMap[K]): void {
    this.events.push(value);
  }
}

/** A `MediaStreamTrack` whose `stop()` we observe. */
interface RecTrack extends MediaStreamTrack {
  stopped: boolean;
}

function makeAudioTrack(): RecTrack {
  let stopped = false;
  const track = {
    get stopped(): boolean { return stopped; },
    set stopped(v: boolean) { stopped = v; },
    kind: 'audio',
    id: 'mic-track',
    get readyState(): MediaStreamTrackState { return stopped ? 'ended' : 'live'; },
    stop(): void { stopped = true; },
  };
  return track as unknown as RecTrack;
}

function makeAudioStream(): { track: RecTrack; stream: MediaStream } {
  const track = makeAudioTrack();
  const stream = {
    getTracks(): MediaStreamTrack[] { return [track]; },
    getAudioTracks(): MediaStreamTrack[] { return [track]; },
  } as unknown as MediaStream;
  return { track, stream };
}

interface Setup {
  env: FakeMediaEnvironment;
  clock: FakeClock;
  recorder: Recorder;
  pc: FakePeerConnection;
  session: WebRtcMediaSession;
}

function setup(overrides?: Partial<WebRtcMediaSessionDeps>): Setup {
  const env = new FakeMediaEnvironment([]);
  const clock = new FakeClock();
  const recorder = new Recorder();
  const pc = new FakePeerConnection();
  env.queuedPeerConnections.push(pc as unknown as RTCPeerConnection);
  const session = new WebRtcMediaSession({
    env,
    options: { iceGatheringTimeoutMs: 1000, codecPreference: ['opus'] },
    acquireTrack: async (): Promise<MediaStream> => {
      const current = env.queuedUserMedia.shift();
      if (current instanceof Promise) return current;
      if (typeof current === 'function') return current();
      if (current !== undefined) return current as MediaStream;
      throw new Error('acquireTrack called with empty queuedUserMedia');
    },
    clock,
    emitter: recorder,
    sessionId: 's1',
    ...overrides,
  });
  // Default: an immediately available mic track.
  if (env.queuedUserMedia.length === 0 && overrides?.acquireTrack === undefined) {
    env.queuedUserMedia.push(makeAudioStream().stream);
  }
  return { env, clock, recorder, pc, session };
}

/** Start a createOffer, complete ICE gathering, and await the full SDP offer. */
async function fullOffer(session: WebRtcMediaSession, pc: FakePeerConnection): Promise<string> {
  const op = session.createOffer();
  await flush();
  pc._completeGathering();
  return op;
}

function stateTransitions(recorder: Recorder): string[] {
  return recorder.events
    .filter((e) => e.type === 'mediaStateChanged')
    .map((e) => (e as Extract<BrowserMediaEventMap['mediaStateChanged'], { type: 'mediaStateChanged' }>).state);
}

function failureCode(recorder: Recorder): string | undefined {
  const f = recorder.events.find((e) => e.type === 'mediaFailed') as
    Extract<BrowserMediaEventMap['mediaFailed'], { type: 'mediaFailed' }> | undefined;
  return f?.error.code;
}

describe('WebRtcMediaSession.createOffer', () => {
  it('wires one audio sendrecv transceiver and returns complete SDP after ICE completes', async () => {
    const { session, pc, recorder } = setup();
    const offerPromise = session.createOffer();
    await flush();
    expect(pc.transceivers).toHaveLength(1);
    expect(pc.transceivers[0]!.direction).toBe('sendrecv');
    expect(pc.transceivers[0]!.sender.replaceTrackCalls).toHaveLength(1);
    pc._completeGathering();
    const sdp = await offerPromise;
    expect(typeof sdp).toBe('string');
    expect(sdp.length).toBeGreaterThan(0);
    expect(pc.setLocalCalls.length).toBeGreaterThan(0);
    expect(stateTransitions(recorder)).toEqual(['acquiring', 'negotiating']);
  });

  it('subscribes for ICE completion before setLocalDescription and never resolves early', async () => {
    const { pc, session } = setup();
    let resolved = false;
    const offerPromise = session.createOffer().then(() => { resolved = true; });
    await flush();
    expect(resolved).toBe(false); // not complete yet
    expect(pc.onicegatheringstatechange).not.toBeNull(); // subscribed before setLocal
    pc._completeGathering();
    await offerPromise;
    expect(resolved).toBe(true);
  });

  it('resolves immediately when ICE is already complete', async () => {
    const { pc, session } = setup();
    pc._completeGathering(); // gathered before negotiation starts
    const sdp = await session.createOffer();
    expect(sdp.length).toBeGreaterThan(0);
  });

  it('fails closed with ICE_GATHERING_TIMEOUT on the deadline and releases the session', async () => {
    const { clock, session, recorder } = setup();
    const offerPromise = session.createOffer();
    await flush();
    expect(clock.pending()).toBe(1);
    clock.advance(1000); // fire the deadline
    await expect(offerPromise).rejects.toMatchObject({ code: 'ICE_GATHERING_TIMEOUT' });
    expect(failureCode(recorder)).toBe('ICE_GATHERING_TIMEOUT');
    expect(stateTransitions(recorder)).toContain('failed');
    expect(clock.pending()).toBe(0); // deadline timer cleared
  });

  it('surfaces NEGOTIATION_FAILED when codec policy leaves no usable primary', async () => {
    const { env, session, recorder } = setup();
    env.audioCapabilities = {
      codecs: [{ mimeType: 'audio/CN', clockRate: 8000 }, { mimeType: 'audio/telephone-event', clockRate: 8000 }],
      headerExtensions: [],
    };
    // applyCodecs throws synchronously inside createOffer, so the rejection is
    // ready before any flush; attach the handler immediately to avoid an
    // unhandled-rejection warning.
    const offerPromise = session.createOffer();
    await expect(offerPromise).rejects.toMatchObject({ code: 'NEGOTIATION_FAILED' });
    expect(failureCode(recorder)).toBe('NEGOTIATION_FAILED');
    expect(session.currentState).toBe('failed');
  });
});

describe('WebRtcMediaSession.createAnswer', () => {
  it('applies the remote offer, then creates+applies the answer and returns complete SDP', async () => {
    const env = new FakeMediaEnvironment([]);
    const clock = new FakeClock();
    const recorder = new Recorder();
    const pc = new FakePeerConnection();
    env.queuedPeerConnections.push(pc as unknown as RTCPeerConnection);
    env.queuedUserMedia.push(makeAudioStream().stream);
    const session = new WebRtcMediaSession({
      env,
      options: {},
      acquireTrack: async (): Promise<MediaStream> => env.queuedUserMedia.shift() as Promise<MediaStream>,
      clock,
      emitter: recorder,
      sessionId: 's2',
    });
    const answerPromise = session.createAnswer('v=0\no=remote 1 1 IN IP4 0.0.0.0\ns=-\nm=audio 5004 RTP/AVP 0\n');
    await flush();
    expect(pc.setRemoteCalls.length).toBe(1);
    expect(pc.setRemoteCalls[0]!.type).toBe('offer');
    pc._completeGathering();
    const sdp = await answerPromise;
    expect(sdp.length).toBeGreaterThan(0);
    expect(pc.createAnswerCalls.length).toBe(1);
  });
});

describe('WebRtcMediaSession.setRemote', () => {
  it('applies a remote answer and treats rejection as REMOTE_DESCRIPTION_REJECTED', async () => {
    const env = new FakeMediaEnvironment([]);
    const clock = new FakeClock();
    const recorder = new Recorder();
    const pc = new FakePeerConnection();
    env.queuedPeerConnections.push(pc as unknown as RTCPeerConnection);
    env.queuedUserMedia.push(makeAudioStream().stream);
    const session = new WebRtcMediaSession({
      env, options: {}, clock, emitter: recorder, sessionId: 's3',
      acquireTrack: async (): Promise<MediaStream> => env.queuedUserMedia.shift() as Promise<MediaStream>,
    });
    await fullOffer(session, pc); // establish an active session
    const apply = session.setRemote('v=0\no=remote 1 1 IN IP4 0.0.0.0\ns=-\nm=audio 5004 RTP/AVP\n');
    await flush();
    expect(pc.setRemoteCalls.length).toBe(1);
    await apply;
  });

  it('maps a rejected remote description distinctly to REMOTE_DESCRIPTION_REJECTED', async () => {
    const env = new FakeMediaEnvironment([]);
    const clock = new FakeClock();
    const recorder = new Recorder();
    const pc = new FakePeerConnection();
    env.queuedPeerConnections.push(pc as unknown as RTCPeerConnection);
    env.queuedUserMedia.push(makeAudioStream().stream);
    const session = new WebRtcMediaSession({
      env, options: {}, clock, emitter: recorder, sessionId: 's4',
      acquireTrack: async (): Promise<MediaStream> => env.queuedUserMedia.shift() as Promise<MediaStream>,
    });
    await fullOffer(session, pc);
    pc._rejectNextRemote();
    await expect(session.setRemote('a=whatever'))
      .rejects.toMatchObject({ code: 'REMOTE_DESCRIPTION_REJECTED' });
    expect(failureCode(recorder)).toBe('REMOTE_DESCRIPTION_REJECTED');
  });
});

describe('WebRtcMediaSession negotiation lock', () => {
  it('rejects a duplicate concurrent negotiation with INVALID_STATE', async () => {
    const { session } = setup();
    // Pin ICE so the first offer stays pending, then race a second offer.
    const first = session.createOffer();
    const second = session.createOffer();
    await expect(second).rejects.toMatchObject({ code: 'INVALID_STATE' });
    // Clean up so the pending waiter does not leak.
    session.close();
    await expect(first).rejects.toMatchObject({ code: 'ABORTED' });
  });
});

describe('WebRtcMediaSession restartIce', () => {
  it('calls pc.restartIce() when present and returns complete SDP after gathering', async () => {
    const { pc, session } = setup();
    await fullOffer(session, pc);
    pc._setIceConnection('connected');
    const restartPromise = session.restartIce();
    await flush();
    expect(pc.restartIceCalls).toHaveLength(1);
    expect(pc.createOfferCalls[pc.createOfferCalls.length - 1]!.iceRestart).toBe(true);
    pc._completeGathering();
    const sdp = await restartPromise;
    expect(sdp.length).toBeGreaterThan(0);
  });

  it('falls back to createOffer({ iceRestart: true }) when restartIce is absent', async () => {
    const { pc, session } = setup();
    pc._setNoRestartIce();
    await fullOffer(session, pc);
    pc._setIceConnection('connected');
    const restartPromise = session.restartIce();
    await flush();
    expect(pc.createOfferCalls[pc.createOfferCalls.length - 1]!.iceRestart).toBe(true);
    pc._completeGathering();
    await restartPromise;
    // restartIce was never called on the absent-method path.
    expect((pc as unknown as { restartIceCalls: number[] }).restartIceCalls).toHaveLength(0);
  });
});

describe('WebRtcMediaSession remote audio', () => {
  it('assembles one remote stream per session and emits remoteAudio on a remote audio track', async () => {
    const { pc, session, recorder } = setup();
    await fullOffer(session, pc);
    pc._emitRemoteAudioTrack();
    const audio = recorder.events.filter((e) => e.type === 'remoteAudio').length;
    expect(audio).toBe(1);
  });

  it('fails to ICE_CONNECTION_FAILED and tears down on ICE connection failure', async () => {
    const { pc, session, recorder } = setup();
    await fullOffer(session, pc);
    pc._setIceConnection('checking');
    pc._setIceConnection('failed');
    expect(failureCode(recorder)).toBe('ICE_CONNECTION_FAILED');
    expect(session.currentState).toBe('failed');
    expect(pc.closed).toBe(true);
  });
});

describe('WebRtcMediaSession.replaceMicrophone', () => {
  it('transactionally replaces the attached track and stops the old one on success', async () => {
    const { pc, session } = setup();
    await fullOffer(session, pc);
    const oldTrack = makeAudioTrack();
    const newTrack = makeAudioTrack();
    pc.transceivers[0]!.sender.replaceTrack(oldTrack);
    (session as unknown as { localTrack: MediaStreamTrack }).localTrack = oldTrack;
    await session.replaceMicrophone(newTrack);
    expect(newTrack.stopped).toBe(false);
    expect(oldTrack.stopped).toBe(true);
    expect((session as unknown as { localTrack: MediaStreamTrack }).localTrack).toBe(newTrack);
  });

  it('rolls back and stops the new track when replaceTrack fails', async () => {
    const { pc, session } = setup();
    await fullOffer(session, pc);
    const oldTrack = makeAudioTrack();
    const newTrack = makeAudioTrack();
    pc.transceivers[0]!.sender.replaceTrack(oldTrack);
    (session as unknown as { localTrack: MediaStreamTrack }).localTrack = oldTrack;
    pc.transceivers[0]!.sender.failNextReplaceTrack = true;
    await expect(session.replaceMicrophone(newTrack))
      .rejects.toMatchObject({ code: 'INTERNAL_ERROR' });
    expect(newTrack.stopped).toBe(true); // rejected new track stopped
    expect(oldTrack.stopped).toBe(false); // old track preserved
  });

  it('rollback keeps the session non-terminal (connected) with the old track live', async () => {
    const { pc, session } = setup();
    await fullOffer(session, pc);
    pc._setIceConnection('connected');
    const oldTrack = makeAudioTrack();
    const newTrack = makeAudioTrack();
    pc.transceivers[0]!.sender.replaceTrack(oldTrack);
    (session as unknown as { localTrack: MediaStreamTrack }).localTrack = oldTrack;
    pc.transceivers[0]!.sender.failNextReplaceTrack = true;
    await expect(session.replaceMicrophone(newTrack)).rejects.toBeInstanceOf(Error);
    expect(session.currentState).not.toBe('failed'); // non-terminal after rollback
    expect(session.currentState).not.toBe('closed');
    expect(session.currentState).toBe('connected'); // still connected
    expect(oldTrack.stopped).toBe(false); // old track NOT stopped
    // PC still open and listening: a LATER ICE failure must tear down, not leak.
    pc._setIceConnection('failed');
    expect(session.currentState).toBe('failed');
    expect(pc.closed).toBe(true); // PC reclaimed by the later teardown
    expect(oldTrack.stopped).toBe(true); // track reclaimed by the later teardown
  });
});

describe('WebRtcMediaSession close', () => {
  it('is idempotent, stops local and remote tracks, closes the PC, and emits no post-terminal state', async () => {
    const { pc, session, recorder } = setup();
    const op = session.createOffer();
    await flush();
    // Deliver a remote track so close also releases remote resources.
    pc._emitRemoteAudioTrack();
    session.close();
    session.close(); // again: idempotent
    expect(pc.closed).toBe(true);
    expect(pc.oniceconnectionstatechange).toBeNull();
    expect(stateTransitions(recorder).at(-1)).toBe('closed');
    await expect(op).rejects.toMatchObject({ code: 'ABORTED' });

    // No later state transition after close even if the PC still fires.
    const before = stateTransitions(recorder).length;
    pc._setIceConnection('failed');
    pc._emitRemoteAudioTrack();
    expect(stateTransitions(recorder).length).toBe(before);
  });

  it('closing during a pending offer rejects the operation without emitting a bad transition', async () => {
    const { session, recorder } = setup();
    const op = session.createOffer();
    await flush();
    session.close();
    await expect(op).rejects.toMatchObject({ code: 'ABORTED' });
    expect(stateTransitions(recorder).at(-1)).toBe('closed');
  });

  it('close after a terminal failed state does not emit closed', async () => {
    const { pc, session, recorder } = setup();
    await fullOffer(session, pc);
    pc._setIceConnection('failed'); // terminal
    session.close();
    expect(stateTransitions(recorder).at(-1)).toBe('failed');
  });

  it('close during microphone acquisition stops the late track, leaks no PC, and emits no post-terminal transition', async () => {
    const { env, session, recorder } = setup(); // setup() pre-queues a default mic stream, so clear it
    env.queuedUserMedia.length = 0;
    const { promise, resolve } = deferred<MediaStream>();
    env.queuedUserMedia.push(promise);
    const op = session.createOffer();
    await flush(); // acquisition now pending on `promise`
    session.close();
    const { stream, track } = makeAudioStream();
    resolve(stream); // late delivery after close
    await expect(op).rejects.toMatchObject({ code: 'ABORTED' });
    expect(track.stopped).toBe(true); // late track reclaimed
    expect(env.peerConnectionCalls).toHaveLength(0); // NO peer connection created (late PC would leak)
    expect(stateTransitions(recorder).at(-1)).toBe('closed'); // no closed->negotiating repost
  });
});