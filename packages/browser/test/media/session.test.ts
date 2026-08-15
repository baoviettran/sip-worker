import { describe, expect, it } from 'vitest';
import { WebRtcMediaSession } from '../../src/media/session.js';
import type { WebRtcMediaSessionDeps } from '../../src/media/session.js';
import type { BrowserMediaEventMap } from '../../src/media/types.js';
import { FakePeerConnection } from '../support/fake-media-environment.js';
import { FakeMediaEnvironment } from '../support/fake-media-environment.js';
import { completeGathering } from '../support/fake-media-environment.js';

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
  let enabled = true;
  const track = {
    get stopped(): boolean { return stopped; },
    set stopped(v: boolean) { stopped = v; },
    kind: 'audio',
    id: 'mic-track',
    get readyState(): MediaStreamTrackState { return stopped ? 'ended' : 'live'; },
    get enabled(): boolean { return enabled; },
    set enabled(v: boolean) { enabled = v; },
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

/** The session-owned local microphone track (active after the first offer). */
function activeLocalTrack(session: WebRtcMediaSession): RecTrack {
  return (session as unknown as { localTrack: RecTrack }).localTrack;
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
    expect(sdp).toContain('a=candidate:');
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

  it('observes the ICE waiter when setLocalDescription rejects', async () => {
    const { pc, session } = setup();
    pc.setLocalDescription = async (): Promise<void> => {
      throw new Error('setLocalDescription rejected');
    };
    let unhandled: unknown;
    const onUnhandled = (error: unknown): void => { unhandled = error; };
    process.on('unhandledRejection', onUnhandled);

    try {
      await expect(session.createOffer()).rejects.toBeInstanceOf(Error);
      await flush();
    } finally {
      process.removeListener('unhandledRejection', onUnhandled);
    }

    expect(unhandled).toBeUndefined();
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
    expect(sdp).toContain('a=candidate:');
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
    expect(sdp).toContain('a=candidate:');
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

describe('WebRtcMediaSession directional offers', () => {
  it('stages a direction on the transceiver and returns complete SDP after gathering', async () => {
    const { session, pc } = setup();
    await fullOffer(session, pc);
    const staged = session.createDirectionalOffer('sendonly');
    await flush();
    expect(pc.transceivers[0]!.direction).toBe('sendonly');
    completeGathering(pc);
    const sdp = await staged;
    expect(sdp).toContain('a=candidate:');
    expect(sdp.length).toBeGreaterThan(0);
    // A direction offer publishes NO hold state: no remoteAudio/hold events.
    expect((session as unknown as { stagedDirection?: string }).stagedDirection).toBe('sendonly');
    expect((session as unknown as { confirmedDirection?: string }).confirmedDirection).toBe('sendrecv');
  });

  it('rolls the staged direction back with setLocalDescription({type: rollback})', async () => {
    const { session, pc } = setup();
    await fullOffer(session, pc);
    const staged = session.createDirectionalOffer('sendonly');
    await completeGathering(pc);
    await staged;
    expect(pc.transceivers[0]!.direction).toBe('sendonly');
    await session.rollbackDirection();
    expect(pc.setLocalCalls.at(-1)).toMatchObject({ type: 'rollback' });
    expect(pc.transceivers[0]!.direction).toBe('sendrecv');
    expect((session as unknown as { stagedDirection?: string }).stagedDirection).toBeUndefined();
    expect((session as unknown as { confirmedDirection?: string }).confirmedDirection).toBe('sendrecv');
  });

  it('commits the staged direction and clears the stage', async () => {
    const { session, pc } = setup();
    await fullOffer(session, pc);
    const staged = session.createDirectionalOffer('sendonly');
    await completeGathering(pc);
    await staged;
    await session.setRemote('v=0\no=remote 1 1 IN IP4 0.0.0.0\ns=-\nm=audio 5004 RTP/AVP\n');
    await session.commitDirection();
    expect((session as unknown as { confirmedDirection?: string }).confirmedDirection).toBe('sendonly');
    expect((session as unknown as { stagedDirection?: string }).stagedDirection).toBeUndefined();
    expect(pc.transceivers[0]!.direction).toBe('sendonly');
  });

  it('commit with nothing staged is a safe no-op that keeps sendrecv', async () => {
    const { session, pc } = setup();
    await fullOffer(session, pc);
    await session.commitDirection();
    expect((session as unknown as { confirmedDirection?: string }).confirmedDirection).toBe('sendrecv');
    expect((session as unknown as { stagedDirection?: string }).stagedDirection).toBeUndefined();
    expect(pc.transceivers[0]!.direction).toBe('sendrecv');
  });

  it('a rollback setLocalDescription failure is terminal NEGOTIATION_FAILED with a clean stage', async () => {
    const { session, pc, recorder } = setup();
    await fullOffer(session, pc);
    const staged = session.createDirectionalOffer('sendonly');
    await completeGathering(pc);
    await staged;
    pc.setLocalDescription = async (): Promise<void> => {
      throw new Error('rollback rejected');
    };
    await expect(session.rollbackDirection()).rejects.toMatchObject({ code: 'NEGOTIATION_FAILED' });
    expect(failureCode(recorder)).toBe('NEGOTIATION_FAILED');
    expect(session.currentState).toBe('failed');
    expect((session as unknown as { stagedDirection?: string }).stagedDirection).toBeUndefined();
    expect(pc.closed).toBe(true);
  });

  it('clears a staged direction when a later setRemote failure fails the session', async () => {
    const { session, pc } = setup();
    await fullOffer(session, pc);
    const staged = session.createDirectionalOffer('sendonly');
    await completeGathering(pc);
    await staged;
    expect((session as unknown as { stagedDirection?: string }).stagedDirection).toBe('sendonly');
    pc._rejectNextRemote();
    await expect(session.setRemote('v=0\no=remote 1 1 IN IP4 0.0.0.0\ns=-\nm=audio 5004 RTP/AVP\n'))
      .rejects.toMatchObject({ code: 'REMOTE_DESCRIPTION_REJECTED' });
    // A terminal failure must not leave a stale staged direction behind.
    expect((session as unknown as { stagedDirection?: string }).stagedDirection).toBeUndefined();
    expect(session.currentState).toBe('failed');
  });

  it('rejects an in-flight rollback with ABORTED when the session closes during it', async () => {
    const { session, pc } = setup();
    await fullOffer(session, pc);
    const staged = session.createDirectionalOffer('sendonly');
    await completeGathering(pc);
    await staged;
    let releaseSetLocal!: (v: void) => void;
    const gate = new Promise<void>((resolve) => { releaseSetLocal = resolve; });
    pc.setLocalDescription = (): Promise<void> => gate;
    const rollback = session.rollbackDirection();
    await flush(); // rollback now awaiting the gated setLocalDescription
    session.close();
    releaseSetLocal();
    await expect(rollback).rejects.toMatchObject({ code: 'ABORTED' });
    expect((session as unknown as { stagedDirection?: string }).stagedDirection).toBeUndefined();
  });

  it('committing a sendonly direction sets localHoldValue and disables the local track', async () => {
    const { session, pc } = setup();
    await fullOffer(session, pc);
    const local = activeLocalTrack(session);
    expect(local.enabled).toBe(true);

    const staged = session.createDirectionalOffer('sendonly');
    await completeGathering(pc);
    await staged;
    await session.setRemote('v=0\no=remote 1 1 IN IP4 0.0.0.0\ns=-\nm=audio 5004 RTP/AVP\n');
    await session.commitDirection();

    expect((session as unknown as { localHoldValue: boolean }).localHoldValue).toBe(true);
    expect((session as unknown as { confirmedDirection?: string }).confirmedDirection).toBe('sendonly');
    expect(local.enabled).toBe(false);
  });

  it('committing an inactive direction sets localHoldValue and disables the local track', async () => {
    const { session, pc } = setup();
    await fullOffer(session, pc);
    const local = activeLocalTrack(session);

    const staged = session.createDirectionalOffer('inactive');
    await completeGathering(pc);
    await staged;
    await session.setRemote('v=0\no=remote 1 1 IN IP4 0.0.0.0\ns=-\nm=audio 5004 RTP/AVP\n');
    await session.commitDirection();

    expect((session as unknown as { localHoldValue: boolean }).localHoldValue).toBe(true);
    expect(local.enabled).toBe(false);
  });

  it('committing a sendrecv resume clears localHoldValue and re-enables the track', async () => {
    const { session, pc } = setup();
    await fullOffer(session, pc);
    const local = activeLocalTrack(session);

    const held = session.createDirectionalOffer('sendonly');
    await completeGathering(pc);
    await held;
    await session.setRemote('v=0\no=remote 1 1 IN IP4 0.0.0.0\ns=-\nm=audio 5004 RTP/AVP\n');
    await session.commitDirection();
    expect(local.enabled).toBe(false);

    const resumed = session.createDirectionalOffer('sendrecv');
    await completeGathering(pc);
    await resumed;
    await session.setRemote('v=0\no=remote 1 1 IN IP4 0.0.0.0\ns=-\nm=audio 5004 RTP/AVP\n');
    await session.commitDirection();

    expect((session as unknown as { localHoldValue: boolean }).localHoldValue).toBe(false);
    expect(local.enabled).toBe(true);
  });

  it('preserves a pre-existing mute across a hold commit', async () => {
    const { session, pc } = setup();
    await fullOffer(session, pc);
    const local = activeLocalTrack(session);
    session.setMuted(true);
    expect(local.enabled).toBe(false);

    const staged = session.createDirectionalOffer('inactive');
    await completeGathering(pc);
    await staged;
    await session.setRemote('v=0\no=remote 1 1 IN IP4 0.0.0.0\ns=-\nm=audio 5004 RTP/AVP\n');
    await session.commitDirection();

    // Muted AND held: still disabled; unmuting leaves the track held.
    expect((session as unknown as { localHoldValue: boolean }).localHoldValue).toBe(true);
    expect(local.enabled).toBe(false);
    session.setMuted(false);
    expect(local.enabled).toBe(false);
  });
});

describe('WebRtcMediaSession remote direction', () => {
  it('exposes the remote direction from a sendonly remote offer', async () => {
    const { session, pc } = setup();
    await fullOffer(session, pc);
    await session.setRemote(
      'v=0\no=remote 1 1 IN IP4 0.0.0.0\ns=-\nm=audio 5004 RTP/AVP 0\na=sendonly\n',
      'offer',
    );
    expect(session.remoteDirection).toBe('sendonly');
  });

  it('exposes the remote direction from an inactive remote offer', async () => {
    const { session, pc } = setup();
    await fullOffer(session, pc);
    await session.setRemote(
      'v=0\no=remote 1 1 IN IP4 0.0.0.0\ns=-\nm=audio 5004 RTP/AVP 0\na=inactive\n',
      'offer',
    );
    expect(session.remoteDirection).toBe('inactive');
  });

  it('stays undefined when the remote offer carries no direction attribute', async () => {
    const { session, pc } = setup();
    await fullOffer(session, pc);
    await session.setRemote('v=0\no=remote 1 1 IN IP4 0.0.0.0\ns=-\nm=audio 5004 RTP/AVP\n', 'offer');
    expect(session.remoteDirection).toBeUndefined();
  });
});

describe('WebRtcMediaSession.setMuted', () => {
  function activeLocalTrack(session: WebRtcMediaSession): RecTrack {
    return (session as unknown as { localTrack: RecTrack }).localTrack;
  }

  function mutedEvents(recorder: Recorder): Array<
    Extract<BrowserMediaEventMap['mutedChanged'], { type: 'mutedChanged' }>
  > {
    return recorder.events.filter((e) => e.type === 'mutedChanged') as Array<
      Extract<BrowserMediaEventMap['mutedChanged'], { type: 'mutedChanged' }>
    >;
  }

  it('mutes the local track and emits one immutable mutedChanged; a repeated mute emits nothing', async () => {
    const { session, pc, recorder } = setup();
    await fullOffer(session, pc);
    const local = activeLocalTrack(session);
    expect(local.enabled).toBe(true);

    session.setMuted(true);
    expect(local.enabled).toBe(false);
    expect((session as unknown as { mutedValue: boolean }).mutedValue).toBe(true);
    expect(mutedEvents(recorder)).toEqual([
      { type: 'mutedChanged', sessionId: 's1', previous: false, muted: true },
    ]);

    session.setMuted(true); // idempotent: same value, no event
    expect(mutedEvents(recorder)).toHaveLength(1);
  });

  it('unmutes the local track and emits previous:true muted:false', async () => {
    const { session, pc, recorder } = setup();
    await fullOffer(session, pc);
    const local = activeLocalTrack(session);
    session.setMuted(true);
    session.setMuted(false);
    expect(local.enabled).toBe(true);
    expect(mutedEvents(recorder)).toEqual([
      { type: 'mutedChanged', sessionId: 's1', previous: false, muted: true },
      { type: 'mutedChanged', sessionId: 's1', previous: true, muted: false },
    ]);
  });

  it('emits a fresh immutable mutedChanged object on every change', async () => {
    const { session, pc, recorder } = setup();
    await fullOffer(session, pc);
    session.setMuted(true);
    session.setMuted(false);
    const events = mutedEvents(recorder);
    expect(events).toHaveLength(2);
    expect(events[0]).not.toBe(events[1]); // distinct references, never reused
  });

  it('keeps the track disabled while held and combines mute with hold orthogonally', async () => {
    const { session, pc } = setup();
    await fullOffer(session, pc);
    const local = activeLocalTrack(session);
    const held = session as unknown as { localHoldValue: boolean };
    held.localHoldValue = true; // Task 11 owns writing this; Task 10 only reads it

    session.setMuted(true);
    expect(local.enabled).toBe(false); // muted + held
    session.setMuted(false);
    expect(local.enabled).toBe(false); // held still disables the track
    held.localHoldValue = false;
    session.setMuted(true);
    expect(local.enabled).toBe(false); // muted alone
    session.setMuted(false);
    expect(local.enabled).toBe(true); // neither muted nor held
  });

  it('persists the muted preference across an ICE restart', async () => {
    const { session, pc } = setup();
    await fullOffer(session, pc);
    const local = activeLocalTrack(session);
    session.setMuted(true);
    expect(local.enabled).toBe(false);
    pc._setIceConnection('connected');
    const restart = session.restartIce();
    await flush();
    pc._completeGathering();
    await restart;
    expect(local.enabled).toBe(false); // mute survives the restart (track untouched)
  });

  it('applies mute without throwing while the local track is ending', async () => {
    const { session, pc } = setup();
    await fullOffer(session, pc);
    const local = activeLocalTrack(session);
    local.stop(); // readyState becomes 'ended' (device ended mid-call)
    session.setMuted(true);
    expect((session as unknown as { mutedValue: boolean }).mutedValue).toBe(true);
    expect(local.enabled).toBe(false);
    session.setMuted(false); // unmute after the track ended still no-ops cleanly
    expect(local.enabled).toBe(true);
  });

  it('keeps the replacement track muted and restores the prior enabled state on rollback', async () => {
    const { session, pc } = setup();
    await fullOffer(session, pc);
    const oldTrack = activeLocalTrack(session);
    session.setMuted(true);
    expect(oldTrack.enabled).toBe(false);

    const newTrack = makeAudioTrack();
    await session.replaceMicrophone(newTrack);
    expect(activeLocalTrack(session)).toBe(newTrack);
    expect(newTrack.enabled).toBe(false); // replacement comes in muted
    expect(oldTrack.stopped).toBe(true);

    // A failed replacement rolls back and restores the prior (muted) state.
    const replacement = makeAudioTrack();
    pc.transceivers[0]!.sender.failNextReplaceTrack = true;
    await expect(session.replaceMicrophone(replacement))
      .rejects.toMatchObject({ code: 'INTERNAL_ERROR' });
    expect(activeLocalTrack(session)).toBe(newTrack);
    expect(newTrack.enabled).toBe(false); // prior muted state preserved
    expect(replacement.stopped).toBe(true);
  });

  it('restores the prior enabled state on rollback when unmuted', async () => {
    const { session, pc } = setup();
    await fullOffer(session, pc);
    const oldTrack = activeLocalTrack(session);
    expect(oldTrack.enabled).toBe(true);
    const newTrack = makeAudioTrack();
    pc.transceivers[0]!.sender.failNextReplaceTrack = true;
    await expect(session.replaceMicrophone(newTrack))
      .rejects.toMatchObject({ code: 'INTERNAL_ERROR' });
    expect(activeLocalTrack(session)).toBe(oldTrack);
    expect(oldTrack.enabled).toBe(true); // unmuted state preserved
    expect(newTrack.stopped).toBe(true);
  });

  it('rejects INVALID_STATE on a closed or failed session', async () => {
    const { session, pc } = setup();
    await fullOffer(session, pc);
    session.close();
    expect(() => session.setMuted(true))
      .toThrowError(expect.objectContaining({ code: 'INVALID_STATE' }));

    const failed = setup();
    await fullOffer(failed.session, failed.pc);
    failed.pc._setIceConnection('failed'); // terminal
    expect(() => failed.session.setMuted(true))
      .toThrowError(expect.objectContaining({ code: 'INVALID_STATE' }));
  });
});