import { describe, expect, it } from 'vitest';
import { createMediaPortPair } from '../../src/media/port-pair.js';
import type { MediaCommand, MediaMessage, MediaReply } from '@sip-worker/core';

/** Every MediaCommand shape must survive structuredClone and the pair. */
const SAMPLE_COMMANDS: MediaCommand[] = [
  { type: 'createOffer', requestId: 'c-1', sessionId: 's1' },
  { type: 'createOffer', requestId: 'c-2', sessionId: 's1', iceRestart: true },
  { type: 'createAnswer', requestId: 'c-3', sessionId: 's1', remoteSdp: 'v=0' },
  { type: 'setRemote', requestId: 'c-4', sessionId: 's1', remoteSdp: 'v=0' },
  { type: 'closeSession', sessionId: 's1' },
];

const SAMPLE_REPLIES: MediaReply[] = [
  { type: 'mediaResult', requestId: 'c-1', sessionId: 's1', sdp: 'v=0' },
  { type: 'mediaResult', requestId: 'c-1', sessionId: 's1' },
  { type: 'mediaError', requestId: 'c-1', sessionId: 's1', message: 'safe', code: 'ABORTED' },
];

describe('createMediaPortPair', () => {
  it('delivers a message posted on one end to listeners of the opposite end', () => {
    const pair = createMediaPortPair();
    const seen: MediaMessage[] = [];
    pair.browser.subscribe((message) => seen.push(message));
    pair.core.postMessage({ type: 'closeSession', sessionId: 's1' });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual({ type: 'closeSession', sessionId: 's1' });
  });

  it('delivers in both directions', () => {
    const pair = createMediaPortPair();
    const browser: MediaMessage[] = [];
    const core: MediaMessage[] = [];
    pair.browser.subscribe((m) => browser.push(m));
    pair.core.subscribe((m) => core.push(m));
    pair.browser.postMessage({ type: 'mediaResult', requestId: 'r', sessionId: 's' });
    pair.core.postMessage({ type: 'closeSession', sessionId: 's' });
    expect(core).toHaveLength(1);
    expect(browser).toHaveLength(1);
  });

  it('delivers to a listener SNAPSHOT: a listener added after post is not notified', () => {
    const pair = createMediaPortPair();
    const first: MediaMessage[] = [];
    const late: MediaMessage[] = [];
    pair.browser.subscribe((m) => first.push(m));
    pair.core.postMessage({ type: 'closeSession', sessionId: 's1' });
    pair.browser.subscribe((m) => late.push(m));
    pair.core.postMessage({ type: 'closeSession', sessionId: 's1' });
    expect(first).toHaveLength(2);
    expect(late).toHaveLength(1);
  });

  it('does not notify a removed listener', () => {
    const pair = createMediaPortPair();
    const seen: MediaMessage[] = [];
    const unsubscribe = pair.browser.subscribe((m) => seen.push(m));
    pair.core.postMessage({ type: 'closeSession', sessionId: 's1' });
    unsubscribe();
    pair.core.postMessage({ type: 'closeSession', sessionId: 's1' });
    expect(seen).toHaveLength(1);
  });

  it('clones on delivery so a receiver mutation cannot affect the sender or another listener', () => {
    const pair = createMediaPortPair();
    const first: string[] = [];
    const second: string[] = [];
    pair.browser.subscribe((m) => {
      const m2 = m as MediaCommand;
      first.push((m2 as { sessionId: string }).sessionId);
      (m2 as { sessionId: string }).sessionId = 'mutated';
    });
    pair.browser.subscribe((m) => second.push((m as MediaCommand).sessionId));
    const original: MediaCommand = { type: 'createOffer', requestId: 'r1', sessionId: 'orig' };
    pair.core.postMessage(original);
    expect(first).toEqual(['orig']); // first listener saw the original value
    expect(second).toEqual(['orig']); // second listener got its own clone
    expect(original.sessionId).toBe('orig'); // sender's object unchanged
  });

  it('the delivered message is always a clone, never the sender reference', () => {
    const pair = createMediaPortPair();
    let received: MediaMessage | undefined;
    pair.browser.subscribe((m) => { received = m; });
    const original: MediaCommand = { type: 'closeSession', sessionId: 's1' };
    pair.core.postMessage(original);
    expect(received).not.toBe(original);
    expect(received).toEqual(original);
  });

  it('unsubscribe is idempotent', () => {
    const pair = createMediaPortPair();
    const seen: MediaMessage[] = [];
    const unsubscribe = pair.browser.subscribe((m) => seen.push(m));
    unsubscribe();
    unsubscribe();
    pair.core.postMessage({ type: 'closeSession', sessionId: 's1' });
    expect(seen).toHaveLength(0);
  });

  it('fault-isolates a throwing listener: later snapshot listeners still receive delivery', () => {
    const pair = createMediaPortPair();
    const seen: MediaMessage[] = [];
    pair.browser.subscribe(() => { throw new Error('listener boom'); });
    pair.browser.subscribe((m) => seen.push(m));
    // A listener exception must not abort the fan-out or throw to the sender.
    expect(() => pair.core.postMessage({ type: 'closeSession', sessionId: 's1' })).not.toThrow();
    pair.core.postMessage({ type: 'closeSession', sessionId: 's1' });
    expect(seen).toHaveLength(2);
  });

  it('close is idempotent and stops delivery in both directions', () => {
    const pair = createMediaPortPair();
    const seen: MediaMessage[] = [];
    pair.browser.subscribe((m) => seen.push(m));
    pair.close();
    pair.close();
    pair.core.postMessage({ type: 'closeSession', sessionId: 's1' });
    pair.browser.postMessage({ type: 'mediaResult', requestId: 'r', sessionId: 's' });
    expect(seen).toHaveLength(0);
  });

  it('every command and reply message survives structuredClone round-trips through the pair', () => {
    const pair = createMediaPortPair();
    const received: MediaMessage[] = [];
    pair.browser.subscribe((m) => received.push(m));
    for (const message of [...SAMPLE_COMMANDS, ...SAMPLE_REPLIES]) {
      pair.core.postMessage(structuredClone(message));
    }
    expect(received).toHaveLength(SAMPLE_COMMANDS.length + SAMPLE_REPLIES.length);
    const expected = [...SAMPLE_COMMANDS, ...SAMPLE_REPLIES];
    for (let i = 0; i < expected.length; i += 1) {
      expect(structuredClone(received[i]!)).toEqual(expected[i]);
    }
  });
});
