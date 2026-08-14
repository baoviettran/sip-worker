import { describe, expect, it } from 'vitest';
import type { MediaCommand, MediaMessage, MediaReply, MediaRequestMessage } from '../../src/media/protocol.js';
import { STUB_SDP } from '../../src/media/protocol.js';
import { WorkerMediaController } from '../../src/media/worker-controller.js';
import { StubMainMediaHandler } from '../../src/media/stub-main-handler.js';
import { MediaTimeoutError } from '../../src/media/worker-controller.js';
import { MediaError } from '../../src/media/errors.js';
import { FakeClock } from '../support/fake-clock.js';

/** Asserts a promise has not settled yet. */
const PENDING = Symbol('pending');
function expectPending<T>(promise: Promise<T>): Promise<void> {
  return expect(Promise.race([promise, PENDING])).resolves.toBe(PENDING);
}

/** Returns the last delivered message, asserting it exists (narrows undefined). */
function lastDelivered(port: FakePort): MediaRequestMessage {
  const message = port.delivered[port.delivered.length - 1];
  expect(message).toBeDefined();
  return message as MediaRequestMessage;
}

/** Returns the first delivered message, asserting it exists (narrows undefined). */
function firstDelivered(port: FakePort): MediaRequestMessage {
  const message = port.delivered[0];
  expect(message).toBeDefined();
  return message as MediaRequestMessage;
}

/**
 * A tiny two-sided in-memory port pair. `A` is the side the controller writes
 * to; `deliver` hands a message to the subscriber as if it came across a
 * structured-clone boundary.
 */
class FakePort {
  delivered: MediaMessage[] = [];
  private listeners = new Set<(message: MediaCommand | MediaReply) => void>();
  private closed = false;

  postMessage(message: MediaCommand | MediaReply): void {
    if (this.closed) return;
    this.delivered.push(message);
  }

  subscribe(listener: (message: MediaCommand | MediaReply) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Manually deliver an inbound message (as if from the other side). */
  deliver(message: MediaMessage): void {
    for (const listener of this.listeners) listener(message);
  }

  close(): void {
    this.closed = true;
    this.listeners.clear();
  }
}

/** Convenience: build a controller + a fake port that captures sent commands. */
function makeBridge(options?: { clock?: FakeClock; deadlineMs?: number }): {
  controller: WorkerMediaController;
  port: FakePort;
} {
  const port = new FakePort();
  const controller = options && options.clock
    ? new WorkerMediaController(port, { clock: options.clock, deadlineMs: options.deadlineMs })
    : new WorkerMediaController(port);
  return { controller, port };
}

describe('STUB_SDP', () => {
  it('is an opaque non-empty UTF-8 SDP string', () => {
    expect(typeof STUB_SDP).toBe('string');
    expect(STUB_SDP.length).toBeGreaterThan(0);
    expect(STUB_SDP).toContain('m=audio');
    // Structured-clone safe: plain string field.
    expect(structuredClone(STUB_SDP)).toBe(STUB_SDP);
  });
});

describe('WorkerMediaController serialization', () => {
  it('emits a clone-safe createOffer command', () => {
    const { controller, port } = makeBridge();
    controller.createOffer('session-1');
    const sent = firstDelivered(port);
    expect(sent.type).toBe('createOffer');
    expect(sent.sessionId).toBe('session-1');
    expect(sent.requestId).toBeTruthy();
    // Messages must survive a structured clone (no functions/class instances).
    expect(() => structuredClone(sent)).not.toThrow();
  });

  it('leaves iceRestart absent on a plain createOffer', () => {
    const { controller, port } = makeBridge();
    controller.createOffer('session-1');
    const sent = firstDelivered(port);
    expect(sent.type).toBe('createOffer');
    expect('iceRestart' in sent ? sent.iceRestart : undefined).toBeUndefined();
  });

  it('posts iceRestart: true on a restarting createOffer', () => {
    const { controller, port } = makeBridge();
    controller.createOffer('session-1', { iceRestart: true });
    const sent = firstDelivered(port);
    expect(sent.type).toBe('createOffer');
    expect('iceRestart' in sent ? sent.iceRestart : undefined).toBe(true);
    // Restart intent stays plain data and structured-clone safe.
    expect(() => structuredClone(sent)).not.toThrow();
  });

  it('posts no iceRestart when the option is explicitly false', () => {
    const { controller, port } = makeBridge();
    controller.createOffer('session-1', { iceRestart: false });
    const sent = firstDelivered(port);
    expect(sent.type).toBe('createOffer');
    expect('iceRestart' in sent ? sent.iceRestart : undefined).toBeUndefined();
  });

  it('resolves createOffer to STUB_SDP when the matching result arrives', async () => {
    const { controller, port } = makeBridge();
    const offer = controller.createOffer('session-1');
    const sent = firstDelivered(port);
    port.deliver({ type: 'mediaResult', requestId: sent.requestId, sessionId: 'session-1', sdp: STUB_SDP });
    await expect(offer).resolves.toBe(STUB_SDP);
  });

  it('emits a createAnswer command carrying the remote SDP', async () => {
    const { controller, port } = makeBridge();
    const answer = controller.createAnswer('session-1', 'remote-answer-sdp');
    const sent = firstDelivered(port);
    expect(sent.type).toBe('createAnswer');
    expect('remoteSdp' in sent ? sent.remoteSdp : undefined).toBe('remote-answer-sdp');
    expect(() => structuredClone(sent)).not.toThrow();
    port.deliver({ type: 'mediaResult', requestId: sent.requestId, sessionId: 'session-1', sdp: STUB_SDP });
    await expect(answer).resolves.toBe(STUB_SDP);
  });

  it('emits a setRemote command carrying the remote SDP and resolves void', async () => {
    const { controller, port } = makeBridge();
    const done = controller.setRemote('session-1', 'remote-set-sdp');
    const sent = firstDelivered(port);
    expect(sent.type).toBe('setRemote');
    expect('remoteSdp' in sent ? sent.remoteSdp : undefined).toBe('remote-set-sdp');
    expect(() => structuredClone(sent)).not.toThrow();
    port.deliver({ type: 'mediaResult', requestId: sent.requestId, sessionId: 'session-1' });
    await expect(done).resolves.toBeUndefined();
  });

  it('does not cross-resolve simultaneous requests for different sessions', async () => {
    const { controller, port } = makeBridge();
    const offerA = controller.createOffer('session-a');
    const offerB = controller.createOffer('session-b');
    expect(port.delivered).toHaveLength(2);
    const a = firstDelivered(port);
    expect(port.delivered[1]).toBeDefined();
    const b = port.delivered[1] as MediaRequestMessage;
    expect(a.sessionId).toBe('session-a');
    expect(b.sessionId).toBe('session-b');
    expect(a.requestId).not.toBe(b.requestId);
    // Deliver the reply for B first; A must stay pending.
    port.deliver({ type: 'mediaResult', requestId: b.requestId, sessionId: 'session-b', sdp: 'B-SDP' });
    await expect(offerB).resolves.toBe('B-SDP');
    await expectPending(offerA);
    // Now complete A.
    port.deliver({ type: 'mediaResult', requestId: a.requestId, sessionId: 'session-a', sdp: STUB_SDP });
    await expect(offerA).resolves.toBe(STUB_SDP);
  });

  it('rejects the pending promise on a correlated mediaError reply', async () => {
    const { controller, port } = makeBridge();
    const offer = controller.createOffer('session-1');
    const sent = firstDelivered(port);
    port.deliver({
      type: 'mediaError',
      requestId: sent.requestId,
      sessionId: 'session-1',
      message: 'no codecs',
      code: 'NEGOTIATION_FAILED',
    });
    await expect(offer).rejects.toThrow('no codecs');
    const err = await offer.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MediaError);
    const mediaErr = err as MediaError;
    expect(mediaErr.code).toBe('NEGOTIATION_FAILED');
    expect(mediaErr.sessionId).toBe('session-1');
    expect(mediaErr.operation).toBe('createOffer');
  });

  it('reconstructs a MediaError carrying code, session, and operation', async () => {
    const { controller, port } = makeBridge();
    const offer = controller.createOffer('session-9');
    const sent = firstDelivered(port);
    port.deliver({
      type: 'mediaError',
      requestId: sent.requestId,
      sessionId: 'session-9',
      message: 'mic blocked',
      code: 'PERMISSION_DENIED',
    });
    await expect(offer).rejects.toBeInstanceOf(MediaError);
    const err = await offer.catch((e: unknown) => e) as MediaError;
    expect(err.code).toBe('PERMISSION_DENIED');
    expect(err.sessionId).toBe('session-9');
    expect(err.operation).toBe('createOffer');
    expect(err.name).toBe('MediaError');
  });

  for (const code of ['INVALID_STATE', 'MEDIA_OPERATION_TIMEOUT'] as const) {
    it(`reconstructs ${code} without flattening it`, async () => {
      const { controller, port } = makeBridge();
      const offer = controller.createOffer('session-coded');
      const sent = firstDelivered(port);
      port.deliver({
        type: 'mediaError',
        requestId: sent.requestId,
        sessionId: 'session-coded',
        message: 'safe media failure',
        code,
      });

      await expect(offer).rejects.toMatchObject({
        name: 'MediaError',
        code,
        sessionId: 'session-coded',
      });
    });
  }
  it('maps an unknown reply code to INTERNAL_ERROR', async () => {
    const { controller, port } = makeBridge();
    const offer = controller.createOffer('session-3');
    const sent = firstDelivered(port);
    port.deliver({
      type: 'mediaError',
      requestId: sent.requestId,
      sessionId: 'session-3',
      message: 'bogus code',
      code: 'NOT_A_REAL_CODE',
    } as unknown as MediaReply);
    await expect(offer).rejects.toBeInstanceOf(MediaError);
    const err = await offer.catch((e: unknown) => e) as MediaError;
    expect(err.code).toBe('INTERNAL_ERROR');
  });

  it('keeps a coded mediaError distinct from MediaTimeoutError', async () => {
    const { controller, port } = makeBridge();
    const offer = controller.createOffer('session-1');
    const sent = firstDelivered(port);
    port.deliver({
      type: 'mediaError',
      requestId: sent.requestId,
      sessionId: 'session-1',
      message: 'no codecs',
      code: 'NEGOTIATION_FAILED',
    });
    const err = await offer.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MediaError);
    expect(err).not.toBeInstanceOf(MediaTimeoutError);
  });

  it('keeps MediaTimeoutError distinct from a coded MediaError class', async () => {
    const clock = new FakeClock();
    const { controller, port } = makeBridge({ clock, deadlineMs: 1000 });
    const offer = controller.createOffer('session-t');
    const sent = firstDelivered(port);
    port.deliver({
      type: 'mediaError',
      requestId: sent.requestId,
      sessionId: 'session-t',
      message: 'negotiation rejected',
      code: 'NEGOTIATION_FAILED',
    });
    // A coded reply rejects with MediaError, not the timeout error.
    await expect(offer).rejects.toBeInstanceOf(MediaError);
    await expect(offer).rejects.not.toBeInstanceOf(MediaTimeoutError);
    // And a genuinely missing reply still rejects with MediaTimeoutError.
    const stale = controller.createOffer('session-u');
    firstDelivered(port);
    await expectPending(stale);
    clock.advance(1001);
    await expect(stale).rejects.toBeInstanceOf(MediaTimeoutError);
    await expect(stale).rejects.not.toBeInstanceOf(MediaError);
  });

  it('serializes mediaError replies carrying only message and code', async () => {
    const { controller, port } = makeBridge();
    const offer = controller.createOffer('session-1');
    const sent = firstDelivered(port);
    port.deliver({
      type: 'mediaError',
      requestId: sent.requestId,
      sessionId: 'session-1',
      message: 'no codecs',
      code: 'NEGOTIATION_FAILED',
    });
    await expect(offer).rejects.toThrow('no codecs');
    // Serialized reply must be clone-safe and carry only message + code (no
    // SDP, device, stack, or ICE data).
    expect(() => structuredClone(sent)).not.toThrow();
    const reply: Record<string, unknown> = {
      type: 'mediaError',
      requestId: sent.requestId,
      sessionId: 'session-1',
      message: 'no codecs',
      code: 'NEGOTIATION_FAILED',
    };
    const cloned = structuredClone(reply);
    expect(cloned).toMatchObject({ type: 'mediaError', message: 'no codecs', code: 'NEGOTIATION_FAILED' });
    for (const key of ['sdp', 'deviceId', 'ice', 'stack']) {
      expect(key in cloned).toBe(false);
    }
  });

  it('preserves the thrown cause when postMessage fails on send', async () => {
    const throwing = new Error('port blew up');
    const port = {
      postMessage: (): void => {
        throw throwing;
      },
      subscribe: (): (() => void) => () => undefined,
    };
    const controller = new WorkerMediaController(port);
    const offer = controller.createOffer('session-1');
    await expect(offer).rejects.toMatchObject({ code: 'MEDIA_UNAVAILABLE' });
    await expect(offer).rejects.toMatchObject({ message: 'port blew up' });
    await expect(offer).rejects.toHaveProperty('cause', throwing);
  });

  it('ignores replies for unknown requestIds', async () => {
    const { controller, port } = makeBridge();
    const offer = controller.createOffer('session-1');
    port.deliver({ type: 'mediaResult', requestId: 'never-sent', sessionId: 'session-1', sdp: 'wrong' });
    // Still pending.
    await expectPending(offer);
    const sent = firstDelivered(port);
    port.deliver({ type: 'mediaResult', requestId: sent.requestId, sessionId: 'session-1', sdp: STUB_SDP });
    await expect(offer).resolves.toBe(STUB_SDP);
  });

  it('rejects all pending requests when the port closes', async () => {
    const { controller } = makeBridge();
    const offerA = controller.createOffer('session-a');
    const offerB = controller.createOffer('session-b');
    controller.close();
    await expect(offerA).rejects.toThrow();
    await expect(offerB).rejects.toThrow();
  });

  it('rejects pending requests after unsubscribe is called', async () => {
    const { controller, port } = makeBridge();
    const offer = controller.createOffer('session-1');
    const sent = firstDelivered(port);
    controller.unsubscribe();
    port.deliver({ type: 'mediaResult', requestId: sent.requestId, sessionId: 'session-1', sdp: STUB_SDP });
    await expect(offer).rejects.toThrow();
  });
});

describe('StubMainMediaHandler', () => {
  it('replies to createOffer with STUB_SDP and records it', async () => {
    const port = new FakePort();
    const handler = new StubMainMediaHandler(port);
    const sent = { type: 'createOffer' as const, requestId: 'req-1', sessionId: 'session-1' };
    port.deliver(sent);
    const reply = firstDelivered(port);
    expect(reply.requestId).toBe('req-1');
    expect(reply).toStrictEqual({ type: 'mediaResult', requestId: 'req-1', sessionId: 'session-1', sdp: STUB_SDP });
    expect(handler.offers('session-1')).toBe(STUB_SDP);
  });

  it('records those offers that carry restart intent', () => {
    const port = new FakePort();
    const handler = new StubMainMediaHandler(port);
    port.deliver({ type: 'createOffer', requestId: 'req-a', sessionId: 'sess-plain' });
    port.deliver({ type: 'createOffer', requestId: 'req-b', sessionId: 'sess-restart', iceRestart: true });
    port.deliver({ type: 'createOffer', requestId: 'req-c', sessionId: 'sess-plain' });
    expect(handler.offersRestarted('sess-restart')).toBe(true);
    expect(handler.offersRestarted('sess-plain')).toBe(false);
    // Replied with SDP for both.
    expect(handler.offers('sess-restart')).toBe(STUB_SDP);
    expect(handler.offers('sess-plain')).toBe(STUB_SDP);
  });

  it('records remote SDP for createAnswer and setRemote', () => {
    const port = new FakePort();
    const handler = new StubMainMediaHandler(port);
    port.deliver({ type: 'createAnswer', requestId: 'req-1', sessionId: 'sess', remoteSdp: 'remote-answer' });
    expect(handler.remoteSdp('sess')).toBe('remote-answer');
    // setRemote overwrites the session's latest remote SDP.
    port.deliver({ type: 'setRemote', requestId: 'req-2', sessionId: 'sess', remoteSdp: 'remote-set' });
    expect(handler.remoteSdp('sess')).toBe('remote-set');
  });

  it('acknowledges setRemote with a void mediaResult', () => {
    const port = new FakePort();
    new StubMainMediaHandler(port);
    port.deliver({ type: 'setRemote', requestId: 'req-3', sessionId: 'sess', remoteSdp: 'remote-set' });
    const reply = firstDelivered(port);
    expect(reply).toStrictEqual({ type: 'mediaResult', requestId: 'req-3', sessionId: 'sess' });
  });

  it('does not reply after unsubscribe', () => {
    const port = new FakePort();
    const handler = new StubMainMediaHandler(port);
    handler.unsubscribe();
    port.deliver({ type: 'createOffer', requestId: 'req-1', sessionId: 'sess' });
    expect(port.delivered).toHaveLength(0);
  });

  it('records and acknowledges a closeSession command without a reply', () => {
    const port = new FakePort();
    const handler = new StubMainMediaHandler(port);
    port.deliver({ type: 'closeSession', sessionId: 'sess-done' });
    // closeSession is fire-and-forget: the stub records it and emits no reply.
    expect(port.delivered).toHaveLength(0);
    expect(handler.closedSessions()).toContain('sess-done');
  });

  it('drops per-session remote SDP after closeSession', () => {
    const port = new FakePort();
    const handler = new StubMainMediaHandler(port);
    port.deliver({ type: 'setRemote', requestId: 'req-1', sessionId: 'sess', remoteSdp: 'remote-set' });
    expect(handler.remoteSdp('sess')).toBe('remote-set');
    port.deliver({ type: 'closeSession', sessionId: 'sess' });
    expect(handler.remoteSdp('sess')).toBeUndefined();
    expect(handler.offers('sess')).toBeUndefined();
  });
});

describe('WorkerMediaController bounded lifecycle', () => {
  it('returns pending requests and timers to baseline across repeated request/close cycles', async () => {
    const clock = new FakeClock();
    const { controller, port } = makeBridge({ clock, deadlineMs: 1000 });
    expect(controller.pendingRequestCount).toBe(0);
    expect(clock.pending()).toBe(0);
    for (let session = 0; session < 25; session += 1) {
      const sessionId = `session-${session}`;

      // 1) A request completed by its reply must leave no pending state behind.
      const offer = controller.createOffer(sessionId);
      const sent = lastDelivered(port);
      expect(controller.pendingRequestCount).toBe(1);
      expect(clock.pending()).toBe(1); // the armed deadline timer
      port.deliver({ type: 'mediaResult', requestId: sent.requestId, sessionId, sdp: STUB_SDP });
      await expect(offer).resolves.toBe(STUB_SDP);
      expect(controller.pendingRequestCount).toBe(0);
      expect(clock.pending()).toBe(0);

      // 2) A request cancelled by closeSession must also return to baseline.
      const cancelled = controller.createOffer(sessionId);
      lastDelivered(port);
      expect(controller.pendingRequestCount).toBe(1);
      controller.closeSession(sessionId);
      await expect(cancelled).rejects.toMatchObject({ code: 'MEDIA_UNAVAILABLE' });
      expect(controller.pendingRequestCount).toBe(0);
      expect(clock.pending()).toBe(0);
    }
    controller.close();
    expect(controller.pendingRequestCount).toBe(0);
    expect(clock.pending()).toBe(0);
  });

  it('rejects a pending request with MediaTimeoutError when its deadline elapses', async () => {
    const clock = new FakeClock();
    const { controller, port } = makeBridge({ clock, deadlineMs: 1000 });
    const offer = controller.createOffer('session-1');
    const sent = firstDelivered(port);
    expect(sent.type).toBe('createOffer');
    // Before the deadline: still pending.
    clock.advance(999);
    await expectPending(offer);
    // At/after the deadline: rejects with a typed timeout error.
    clock.advance(1);
    await expect(offer).rejects.toBeInstanceOf(MediaTimeoutError);
    await expect(offer).rejects.toThrow(/createOffer.*session-1/);
    await expect(offer).rejects.toMatchObject({ code: 'TIMEOUT' });
  });

  it('clears the deadline timer when the matching reply arrives', async () => {
    const clock = new FakeClock();
    const { controller, port } = makeBridge({ clock, deadlineMs: 1000 });
    const offer = controller.createOffer('session-1');
    const sent = firstDelivered(port);
    port.deliver({ type: 'mediaResult', requestId: sent.requestId, sessionId: 'session-1', sdp: STUB_SDP });
    await expect(offer).resolves.toBe(STUB_SDP);
    // The deadline timer was cleared; advancing past it does nothing.
    expect(clock.pending()).toBe(0);
    clock.advance(2000);
    await expect(offer).resolves.toBe(STUB_SDP);
  });

  it('rejects a request in flight when the controller closes', async () => {
    const clock = new FakeClock();
    const { controller, port } = makeBridge({ clock, deadlineMs: 5000 });
    const offer = controller.createOffer('session-1');
    firstDelivered(port);
    // No reply yet; close() must reject the pending offer (not the deadline).
    controller.close();
    await expect(offer).rejects.toThrow(/media port closed/);
    await expect(offer).rejects.toMatchObject({ code: 'MEDIA_UNAVAILABLE' });
    await expect(offer).rejects.not.toBeInstanceOf(MediaTimeoutError);
    // Closing cleared the deadline timer.
    expect(clock.pending()).toBe(0);
  });

  it('emits a closeSession command and cancels pending requests for that session', async () => {
    const clock = new FakeClock();
    const { controller, port } = makeBridge({ clock, deadlineMs: 5000 });
    const offer = controller.createOffer('session-1');
    const offerSent = firstDelivered(port);
    expect(offerSent.type).toBe('createOffer');

    controller.closeSession('session-1');
    const closeCmd = port.delivered.find((m) => m.type === 'closeSession');
    expect(closeCmd).toBeDefined();
    expect(closeCmd && closeCmd.type === 'closeSession' && closeCmd.sessionId).toBe('session-1');
    // closeSession is plain data and structured-clone safe.
    expect(() => structuredClone(closeCmd)).not.toThrow();
    // The pending offer for the closed session was cancelled.
    await expect(offer).rejects.toThrow(/session-1/);
    await expect(offer).rejects.not.toBeInstanceOf(MediaTimeoutError);
    // Its deadline timer was cleared.
    expect(clock.pending()).toBe(0);
  });

  it('does not cancel pending requests for other sessions on closeSession', async () => {
    const clock = new FakeClock();
    const { controller, port } = makeBridge({ clock, deadlineMs: 5000 });
    const offerA = controller.createOffer('session-a');
    const offerB = controller.createOffer('session-b');
    expect(port.delivered).toHaveLength(2);

    controller.closeSession('session-a');
    // A rejected; B still pending.
    await expect(offerA).rejects.toThrow(/session-a/);
    await expectPending(offerB);
  });

  it('rejects createOffer after the controller is closed', async () => {
    const { controller } = makeBridge();
    controller.close();
    await expect(controller.createOffer('session-1')).rejects.toThrow(/media port closed/);
    await expect(controller.createOffer('session-1')).rejects.toMatchObject({ code: 'MEDIA_UNAVAILABLE' });
  });

  it('does not configure a deadline when no clock/deadline is provided', async () => {
    const { controller, port } = makeBridge();
    const offer = controller.createOffer('session-1');
    const sent = firstDelivered(port);
    // Without a clock there is no timer; a late reply still resolves.
    port.deliver({ type: 'mediaResult', requestId: sent.requestId, sessionId: 'session-1', sdp: STUB_SDP });
    await expect(offer).resolves.toBe(STUB_SDP);
  });

  it('bounds pending requests by a default deadline when a clock is present but deadlineMs is omitted', async () => {
    const clock = new FakeClock();
    const { controller } = makeBridge({ clock }); // no deadlineMs → default 1000ms
    const offer = controller.createOffer('session-default');
    // Before the default deadline: still pending.
    clock.advance(999);
    await expectPending(offer);
    // At/after 1000ms: rejects with a typed timeout error.
    clock.advance(1);
    await expect(offer).rejects.toBeInstanceOf(MediaTimeoutError);
    await expect(offer).rejects.toThrow(/createOffer.*session-default/);
  });

  it('keeps media requests unbounded when no clock is present', async () => {
    const { controller } = makeBridge(); // no clock, no deadline
    const offer = controller.createOffer('session-unbounded');
    // No deadline timer exists, so a pending request must not reject on a fake
    // advance — but there is no clock to advance. Assert the pending request
    // stays pending and the controller has no armed timer by closing it.
    await expectPending(offer);
    controller.close();
    await expect(offer).rejects.toThrow(/media port closed/);
    await expect(offer).rejects.not.toBeInstanceOf(MediaTimeoutError);
  });
});