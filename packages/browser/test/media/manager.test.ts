import { describe, expect, it } from 'vitest';
import type { MediaCommand, MediaReply } from '@sip-worker/core';
import { WebRtcMediaManager } from '../../src/media/media-manager.js';
import type { BrowserMediaEventMap } from '../../src/media/types.js';
import { FakeMediaEnvironment, FakePeerConnection } from '../support/fake-media-environment.js';

const VALID_CODES = [
  'PERMISSION_DENIED', 'DEVICE_NOT_FOUND', 'DEVICE_UNAVAILABLE', 'CONSTRAINT_UNSATISFIED',
  'NEGOTIATION_FAILED', 'REMOTE_DESCRIPTION_REJECTED', 'ICE_GATHERING_TIMEOUT',
  'ICE_CONNECTION_FAILED', 'OUTPUT_SELECTION_UNSUPPORTED', 'PLAYBACK_FAILED',
  'ABORTED', 'INVALID_STATE', 'MEDIA_OPERATION_TIMEOUT', 'INTERNAL_ERROR',
];

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
  emit<K extends keyof BrowserMediaEventMap>(_type: K, value: BrowserMediaEventMap[K]): void {
    this.events.push(value);
  }
}

interface RecTrack extends MediaStreamTrack { stopped: boolean; }
function makeAudioTrack(): RecTrack {
  let stopped = false;
  return {
    get stopped(): boolean { return stopped; },
    set stopped(v: boolean) { stopped = v; },
    kind: 'audio', id: 'mic-track',
    get readyState(): MediaStreamTrackState { return stopped ? 'ended' : 'live'; },
    stop(): void { stopped = true; },
  } as unknown as RecTrack;
}
function makeAudioStream(): MediaStream {
  const track = makeAudioTrack();
  return {
    getTracks(): MediaStreamTrack[] { return [track]; },
    getAudioTracks(): MediaStreamTrack[] { return [track]; },
  } as unknown as MediaStream;
}
/** A stream with no audio track (legal browser outcome). */
function makeTracklessStream(): MediaStream {
  return { getTracks: () => [], getAudioTracks: () => [] } as unknown as MediaStream;
}

interface Setup {
  env: FakeMediaEnvironment;
  clock: FakeClock;
  manager: WebRtcMediaManager;
  replies: MediaReply[];
  unsubscribe: () => void;
}

/** Build a manager; by default queues one mic stream + one fresh peer connection. */
function setup(overrides?: { queued?: Array<MediaStream | Promise<MediaStream>> }): Setup {
  // The device manager's pre-check needs at least one audio input to pass.
  const env = new FakeMediaEnvironment([
    { deviceId: 'mic-1', label: 'Mic', groupId: 'g-1', kind: 'audioinput' },
  ]);
  const clock = new FakeClock();
  const recorder = new Recorder();
  const manager = new WebRtcMediaManager({
    env,
    options: { iceGatheringTimeoutMs: 1000, mediaOperationTimeoutMs: 1000, codecPreference: ['opus'] },
    clock,
    emitter: recorder,
  });
  const replies: MediaReply[] = [];
  const unsubscribe = manager.subscribeReplies((m) => replies.push(m));
  if (overrides?.queued !== undefined) {
    env.queuedUserMedia.push(...(overrides.queued as Array<MediaStream | Promise<MediaStream>>));
  } else {
    env.queuedUserMedia.push(makeAudioStream());
  }
  env.queuedPeerConnections.push(new FakePeerConnection() as unknown as RTCPeerConnection);
  return { env, clock, manager, replies, unsubscribe };
}

/** Drive a negotiation to ICE completion and settle the manager's reply. */
async function settle(manager: WebRtcMediaManager, pc: FakePeerConnection): Promise<void> {
  await flush();
  if (pc.iceGatheringState !== 'complete') {
    pc._completeGathering();
  }
  await flush();
  void manager;
}

function replyFor(replies: MediaReply[], requestId: string): MediaReply | undefined {
  return replies.filter((r) => r.requestId === requestId).slice(-1)[0];
}

describe('WebRtcMediaManager routing', () => {
  it('routes createOffer to the session and replies mediaResult with the SAME requestId + SDP', async () => {
    const { manager, env, replies } = setup();
    manager.postMessage({ type: 'createOffer', requestId: 'req-1', sessionId: 's1' });
    const pc = env.queuedPeerConnections[0] as unknown as FakePeerConnection;
    await settle(manager, pc);
    const reply = replyFor(replies, 'req-1');
    expect(reply).toBeDefined();
    expect(reply!.type).toBe('mediaResult');
    expect(reply!.requestId).toBe('req-1');
    expect(reply!.sessionId).toBe('s1');
    expect(typeof (reply as { sdp?: string }).sdp).toBe('string');
    expect((reply as { sdp?: string }).sdp!.length).toBeGreaterThan(0);
  });

  it('correlates two sequential requests with no cross-wiring (offer then answer, own requestIds)', async () => {
    const { manager, env, replies } = setup();
    const pc = env.queuedPeerConnections[0] as unknown as FakePeerConnection;
    manager.postMessage({ type: 'createOffer', requestId: 'A', sessionId: 's1' });
    await settle(manager, pc);
    // The ensuing answer acquires a SECOND fresh microphone track per call.
    env.queuedUserMedia.push(makeAudioStream());
    manager.postMessage({ type: 'createAnswer', requestId: 'B', sessionId: 's1', remoteSdp: 'v=0' });
    await settle(manager, pc);
    const a = replyFor(replies, 'A');
    const b = replyFor(replies, 'B');
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    expect(a!.type).toBe('mediaResult');
    expect(b!.type).toBe('mediaResult');
    expect(a!.requestId).toBe('A');
    expect(b!.requestId).toBe('B');
  });

  it('routes createAnswer to the session answer path with the remote SDP', async () => {
    const { manager, env, replies } = setup();
    const pc = env.queuedPeerConnections[0] as unknown as FakePeerConnection;
    manager.postMessage({ type: 'createAnswer', requestId: 'ans-1', sessionId: 's1', remoteSdp: 'v=0' });
    await settle(manager, pc);
    expect(pc.setRemoteCalls).toHaveLength(1);
    expect(pc.setRemoteCalls[0]!.sdp).toBe('v=0');
    const reply = replyFor(replies, 'ans-1');
    expect(reply!.type).toBe('mediaResult');
    expect(reply!.requestId).toBe('ans-1');
  });

  it('routes setRemote to the session setRemote path after a session is active', async () => {
    const { manager, env, replies } = setup();
    const pc = env.queuedPeerConnections[0] as unknown as FakePeerConnection;
    manager.postMessage({ type: 'createOffer', requestId: 'off-1', sessionId: 's1' });
    await settle(manager, pc);
    manager.postMessage({ type: 'setRemote', requestId: 'set-1', sessionId: 's1', remoteSdp: 'v=0' });
    await settle(manager, pc);
    const reply = replyFor(replies, 'set-1');
    expect(reply).toBeDefined();
    expect(reply!.type).toBe('mediaResult');
    expect(reply!.requestId).toBe('set-1');
  });

  it('C4: createOffer(iceRestart:true) on an ACTIVE session routes to session.restartIce, preserving intent', async () => {
    const { manager, env, replies } = setup();
    const pc = env.queuedPeerConnections[0] as unknown as FakePeerConnection;
    manager.postMessage({ type: 'createOffer', requestId: 'off-1', sessionId: 's1' });
    await settle(manager, pc);
    expect(pc.restartIceCalls).toHaveLength(0);
    manager.postMessage({ type: 'createOffer', requestId: 'restart-1', sessionId: 's1', iceRestart: true });
    await settle(manager, pc);
    expect(pc.restartIceCalls.length).toBeGreaterThanOrEqual(1);
    const reply = replyFor(replies, 'restart-1');
    expect(reply!.type).toBe('mediaResult');
    expect(reply!.requestId).toBe('restart-1');
  });

  it('C4: first createOffer(iceRestart:true) with no active session creates an initial offer (not restart)', async () => {
    const { manager, env, replies } = setup();
    const pc = env.queuedPeerConnections[0] as unknown as FakePeerConnection;
    manager.postMessage({ type: 'createOffer', requestId: 'init-1', sessionId: 's1', iceRestart: true });
    await settle(manager, pc);
    expect(pc.restartIceCalls).toHaveLength(0);
    expect(pc.createOfferCalls).toHaveLength(1);
    expect(replyFor(replies, 'init-1')!.type).toBe('mediaResult');
  });
});

describe('WebRtcMediaManager error serialization', () => {
  it('maps a session failure to a mediaError reply with a valid 12-code code', async () => {
    const { manager, env, clock, replies } = setup();
    const pc = env.queuedPeerConnections[0] as unknown as FakePeerConnection;
    pc.autoCompleteIceGathering = false;
    manager.postMessage({ type: 'createOffer', requestId: 'eg-1', sessionId: 's1' });
    await flush();
    clock.advance(10_000);
    await flush();
    const reply = replyFor(replies, 'eg-1');
    expect(reply).toBeDefined();
    expect(reply!.type).toBe('mediaError');
    const err = reply as { type: 'mediaError'; code: string; message: string };
    expect(VALID_CODES).toContain(err.code);
    expect(err.message.length).toBeGreaterThan(0);
    // No SDP/credential/stack blob on the wire — only the fixed safe message.
    expect(/v=\d|a=rtpmap|candidate:|t=|stun:|turn:|credential/i.test(err.message)).toBe(false);
    expect(err.message).not.toMatch(/[\w.]{24,}/);
  });

  it('never includes SDP, device ids, or stacks in any reply (raw engine failure → INTERNAL_ERROR)', async () => {
    const { manager, env, replies } = setup();
    const pc = env.queuedPeerConnections[0] as unknown as FakePeerConnection;
    (pc as unknown as { createOffer: () => Promise<RTCSessionDescriptionInit> }).createOffer =
      async (): Promise<RTCSessionDescriptionInit> => {
        throw new Error('stack trace with sdp secret v=0');
      };
    manager.postMessage({ type: 'createOffer', requestId: 'sec-1', sessionId: 's1' });
    await flush();
    pc._completeGathering();
    await flush();
    const reply = replyFor(replies, 'sec-1');
    expect(reply!.type).toBe('mediaError');
    const e = reply as { code: string; message: string };
    expect(e.code).toBe('INTERNAL_ERROR');
    expect(e.message).not.toMatch(/secret|v=0|stack trace|device/i);
  });
});

describe('WebRtcMediaManager one-active-session', () => {
  it('C1: rejects a createOffer for a DIFFERENT active session with a valid coded error without disturbing the active one', async () => {
    const { manager, env, replies } = setup();
    const pc = env.queuedPeerConnections[0] as unknown as FakePeerConnection;
    manager.postMessage({ type: 'createOffer', requestId: 's1-offer', sessionId: 's1' });
    await settle(manager, pc);
    expect(replyFor(replies, 's1-offer')!.type).toBe('mediaResult');
    manager.postMessage({ type: 'createOffer', requestId: 's2-offer', sessionId: 's2' });
    await flush();
    const s2 = replyFor(replies, 's2-offer') as { type: 'mediaError'; code: string };
    expect(s2.type).toBe('mediaError');
    expect(s2.code).toBe('INVALID_STATE');
    expect(manager.activeSessionId).toBe('s1');
    expect(pc.closed).toBe(false);
  });

  it('serializes two same-session createOffers through the negotiation lock without cross-correlating', async () => {
    const { manager, env, replies } = setup();
    env.queuedUserMedia.push(makeAudioStream()); // second offer acquires a fresh track
    const pc = env.queuedPeerConnections[0] as unknown as FakePeerConnection;
    manager.postMessage({ type: 'createOffer', requestId: 'first', sessionId: 's1' });
    manager.postMessage({ type: 'createOffer', requestId: 'second', sessionId: 's1' });
    await settle(manager, pc);
    const first = replyFor(replies, 'first') as { type: 'mediaResult'; requestId: string; sdp?: string };
    const second = replyFor(replies, 'second') as { type: 'mediaResult'; requestId: string; sdp?: string };
    expect(first.type).toBe('mediaResult');
    expect(second.type).toBe('mediaResult');
    expect(first.requestId).toBe('first');
    expect(second.requestId).toBe('second');
    expect(first.sdp).toBeDefined();
    expect(second.sdp).toBeDefined();
  });
});

describe('WebRtcMediaManager operation deadlines', () => {
  it('times out capture, releases a late stream, and unblocks the next session', async () => {
    const { manager, env, clock, replies } = setup();
    const gate = deferred<MediaStream>();
    env.queuedUserMedia.length = 0;
    env.queuedUserMedia.push(gate.promise as unknown as MediaStream);
    manager.postMessage({ type: 'createOffer', requestId: 'timeout', sessionId: 's1' });
    await flush();
    clock.advance(999);
    await flush();
    expect(replyFor(replies, 'timeout')).toBeUndefined();
    clock.advance(1);
    await flush();
    const timeout = replyFor(replies, 'timeout') as { type: 'mediaError'; code: string };
    expect(timeout.type).toBe('mediaError');
    expect(timeout.code).toBe('MEDIA_OPERATION_TIMEOUT');
    expect(manager.activeSessionId).toBeUndefined();

    const late = makeAudioStream();
    const lateTrack = late.getAudioTracks()[0] as RecTrack;
    gate.resolve(late);
    await flush();
    await flush();
    expect(lateTrack.stopped).toBe(true);

    env.queuedUserMedia.push(makeAudioStream());
    manager.postMessage({ type: 'createOffer', requestId: 'fresh', sessionId: 's2' });
    const pc = env.queuedPeerConnections[0] as unknown as FakePeerConnection;
    await settle(manager, pc);
    expect(replyFor(replies, 'fresh')?.type).toBe('mediaResult');
    expect(clock.pending()).toBe(0);
  });
});

describe('WebRtcMediaManager close + race handling', () => {
  it('retains no unbounded history across 1,000 closed session ids', () => {
    const { manager } = setup();
    for (let index = 0; index < 1_000; index += 1) {
      manager.postMessage({ type: 'closeSession', sessionId: `closed-${index}` });
    }
    const retainedSets = Object.values(manager as unknown as Record<string, unknown>)
      .filter((value): value is Set<unknown> => value instanceof Set);
    expect(Math.max(0, ...retainedSets.map((value) => value.size))).toBeLessThanOrEqual(1);
    manager.dispose();
  });

  it('closeSession is fire-and-forget: issues NO reply and cancels the pending request', async () => {
    const { manager, env, clock, replies } = setup();
    const gate = deferred<MediaStream>();
    env.queuedUserMedia.length = 0;
    env.queuedUserMedia.push(gate.promise as unknown as MediaStream);
    manager.postMessage({ type: 'createOffer', requestId: 'pending', sessionId: 's1' });
    await flush();
    expect(clock.pending()).toBe(1);
    const before = replies.length;
    manager.postMessage({ type: 'closeSession', sessionId: 's1' });
    await flush();
    expect(clock.pending()).toBe(0);
    expect(replies.length).toBe(before); // no reply for close, none for the cancelled pending
    gate.resolve(makeAudioStream());
    await flush();
    // The late-delivered track was reclaimed; pending offer produced NO reply.
    expect(replyFor(replies, 'pending')).toBeUndefined();
    expect(manager.activeSessionId).toBeUndefined();
  });

  it('closeSession is idempotent and late commands are ignored after reclamation', async () => {
    const { manager, env, replies } = setup();
    const pc = env.queuedPeerConnections[0] as unknown as FakePeerConnection;
    manager.postMessage({ type: 'createOffer', requestId: 'off-1', sessionId: 's1' });
    await settle(manager, pc);
    manager.postMessage({ type: 'closeSession', sessionId: 's1' });
    manager.postMessage({ type: 'closeSession', sessionId: 's1' });
    const before = replies.length;
    manager.postMessage({ type: 'createOffer', requestId: 'late', sessionId: 's1' });
    await flush();
    expect(replies.length).toBe(before);
    void pc;
  });

  it('dispose is idempotent: closes the session + device manager + stops accepting work', async () => {
    const { manager, env, replies, unsubscribe } = setup();
    const pc = env.queuedPeerConnections[0] as unknown as FakePeerConnection;
    manager.postMessage({ type: 'createOffer', requestId: 'off-1', sessionId: 's1' });
    await settle(manager, pc);
    unsubscribe();
    manager.dispose();
    manager.dispose();
    expect(pc.closed).toBe(true);
    const before = replies.length;
    manager.postMessage({ type: 'createOffer', requestId: 'post', sessionId: 's1' });
    await flush();
    expect(replies.length).toBe(before);
  });

  it('a rejecting STALE continuation after close does not tear down a second active session', async () => {
    const { manager, env, replies } = setup();
    // s1's offer blocks on a gated getUserMedia.
    const gate = deferred<MediaStream>();
    env.queuedUserMedia.length = 0;
    env.queuedUserMedia.push(gate.promise as unknown as MediaStream);
    // s1 aborts during acquisition (before ensurePeerConnection), so only s2
    // ever shifts a peer connection: queue exactly one, for s2.
    const pc = new FakePeerConnection();
    env.queuedPeerConnections.length = 0;
    env.queuedPeerConnections.push(pc as unknown as RTCPeerConnection);

    manager.postMessage({ type: 'createOffer', requestId: 's1-offer', sessionId: 's1' });
    await flush();
    // closeSession reclaims s1 mid-offer (bumps generation, consumes the id).
    manager.postMessage({ type: 'closeSession', sessionId: 's1' });
    await flush();
    // A brand-new session s2 is requested while s1's offer is still in flight.
    env.queuedUserMedia.push(makeAudioStream());
    manager.postMessage({ type: 'createOffer', requestId: 's2-offer', sessionId: 's2' });
    // Resolve s1's gate: the now-closed s1 session rejects ABORTED (a stale
    // continuation). The generation guard must make this a no-op so it cannot
    // clobber the live s2 state (s2's pc must NOT be torn down). Then drain s2
    // to ICE completion.
    gate.resolve(makeAudioStream());
    await flush();
    if (pc.iceGatheringState !== 'complete') {
      pc._completeGathering();
    }
    await flush();
    await flush();
    await flush();

    // s1 produced no reply (its resources were reclaimed).
    expect(replyFor(replies, 's1-offer')).toBeUndefined();
    // s2 dispatched afterwards, negotiated, and its caller got a coherent reply.
    const s2 = replyFor(replies, 's2-offer');
    expect(s2).toBeDefined();
    expect(s2!.type).toBe('mediaResult');
    expect(manager.activeSessionId).toBe('s2');
    // The second session's peer connection was NOT torn down by the stale s1
    // failure (the generation guard prevents clobbering the live session).
    expect(pc.closed).toBe(false);
    expect(pc.setLocalCalls.length).toBeGreaterThan(0);
  });
});

describe('WebRtcMediaManager stale/unknown messages', () => {
  it('ignores an unknown message type safely', async () => {
    const { manager, replies } = setup();
    const before = replies.length;
    (manager.postMessage as (m: unknown) => void)({ type: 'bogus', requestId: 'x', sessionId: 's1' });
    await flush();
    expect(replies.length).toBe(before);
  });

  it('ignores an unsolicited reply posted on the inbound port', async () => {
    const { manager, replies } = setup();
    manager.postMessage({ type: 'mediaResult', requestId: 'oracle', sessionId: 'nope', sdp: 'v=0' });
    await flush();
    expect(replies.length).toBe(0);
  });
});

describe('WebRtcMediaManager no-audio-track (C3)', () => {
  it('fails createOffer with DEVICE_UNAVAILABLE when acquisition yields a stream with no audio track', async () => {
    const { manager, env, replies } = setup();
    env.queuedUserMedia.length = 0;
    env.queuedUserMedia.push(makeTracklessStream());
    manager.postMessage({ type: 'createOffer', requestId: 'notrack', sessionId: 's1' });
    await flush();
    const reply = replyFor(replies, 'notrack') as { type: 'mediaError'; code: string };
    expect(reply.type).toBe('mediaError');
    expect(reply.code).toBe('DEVICE_UNAVAILABLE');
    expect(manager.activeSessionId).toBeUndefined();
  });
});

describe('WebRtcMediaManager structuredClone safety', () => {
  it('handles a structuredClone copy of each command identically and replies survive cloning', async () => {
    const { manager, env, replies } = setup();
    const pc = env.queuedPeerConnections[0] as unknown as FakePeerConnection;
    manager.postMessage(structuredClone(
      { type: 'createOffer', requestId: 'cl-1', sessionId: 's1' } as MediaCommand,
    ));
    await settle(manager, pc);
    const reply = replyFor(replies, 'cl-1');
    expect(reply!.type).toBe('mediaResult');
    expect(structuredClone(reply!)).toEqual(reply);
  });
});

describe('session getters', () => {
  it('exposes activeSessionId for observability', async () => {
    const { manager, env } = setup();
    const pc = env.queuedPeerConnections[0] as unknown as FakePeerConnection;
    manager.postMessage({ type: 'createOffer', requestId: 'obs-1', sessionId: 's1' });
    await settle(manager, pc);
    expect(manager.activeSessionId).toBe('s1');
  });
});
