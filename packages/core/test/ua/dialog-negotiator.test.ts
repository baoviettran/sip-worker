/**
 * Tests for DialogNegotiator: serialized in-dialog re-INVITE and ICE restart.
 *
 * Covers local ICE-restart (restartIce) that posts createOffer(iceRestart:true),
 * sends an incremented in-dialog INVITE, waits for a 2xx AND THEN setRemote, and
 * rejects on 491/488/timeout. Covers incoming in-dialog re-INVITEs that call
 * createAnswer and reply 200 with the returned SDP, plus 491 on collision, 488
 * on unsupported/multiple active media, 481 on wrong dialog/CSeq, and dispose
 * settling pending work.
 */

import { describe, expect, it } from 'vitest';
import { Headers, makeRequest, makeResponse, bodyText, withTextBody } from '../../src/messages/index.js';
import type { SipRequestMessage, SipResponseMessage } from '../../src/messages/message.js';
import { parseMessage } from '../../src/messages/parser.js';
import { TransactionLayer, deriveTimers } from '../../src/transactions/index.js';
import type { TransactionLayerEvent } from '../../src/transactions/types.js';
import { FakeClock } from '../support/fake-clock.js';
import { FakeTransport } from '../support/fake-transport.js';
import { WorkerMediaController } from '../../src/media/worker-controller.js';
import { STUB_SDP } from '../../src/media/index.js';
import type { MediaDirection, MediaMessage } from '../../src/media/index.js';
import { Dialog, type IdGenerator } from '../../src/dialogs/dialog.js';
import { type ViaConfig } from '../../src/dialogs/header-values.js';
import { DialogNegotiator } from '../../src/ua/dialog-negotiator.js';
import { SipError, TransportError } from '../../src/errors.js';

const REMOTE_URI = 'sip:bob@192.0.2.2';
const AOR = 'sip:alice@example.com';
const CONTACT = `<${AOR}>`;
const SESSION_ID = 'sess-negotiator';

/** PENDING sentinel for assertions a promise has not yet settled. */
const PENDING = Symbol('pending');
function expectPending<T>(promise: Promise<T>): Promise<void> {
  return expect(Promise.race([promise, PENDING])).resolves.toBe(PENDING);
}

function makeIdGenerator(): IdGenerator {
  let n = 0;
  return { branch: (): string => `test-${(n += 1)}` };
}

function drainMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function flush(): Promise<void> { return drainMicrotasks(); }

/** A FakeClock that records the most recently armed timer's delay. */
class NextDelayFakeClock extends FakeClock {
  private lastDelay = -1;
  override setTimeout(callback: () => void, delayMs: number): number {
    this.lastDelay = delayMs;
    return super.setTimeout(callback, delayMs);
  }
  nextDelay(): number {
    return this.lastDelay;
  }
}

/** A single supported active audio section. */
const AUDIO_SDP = [
  'v=0',
  'o=alice 1 1 IN IP4 192.0.2.1',
  's=-',
  'c=IN IP4 192.0.2.1',
  't=0 0',
  'm=audio 10000 RTP/AVP 0 8',
  'a=rtpmap:0 PCMU/8000',
  'a=rtpmap:8 PCMA/8000',
  'a=sendrecv',
  '',
].join('\r\n');

/** Two active audio sections (multiple media sections) → 488. */
const MULTI_AUDIO_SDP = [
  'v=0',
  'o=alice 1 1 IN IP4 192.0.2.1',
  's=-',
  'c=IN IP4 192.0.2.1',
  't=0 0',
  'm=audio 10000 RTP/AVP 0',
  'a=sendrecv',
  'm=audio 20000 RTP/AVP 8',
  'a=sendrecv',
  '',
].join('\r\n');

/** A single video m-line (non-audio) → 488. */
const VIDEO_SDP = [
  'v=0',
  'o=alice 1 1 IN IP4 192.0.2.1',
  's=-',
  'c=IN IP4 192.0.2.1',
  't=0 0',
  'm=video 30000 RTP/AVP 96',
  'a=sendrecv',
  '',
].join('\r\n');

/** AUDIO_SDP with a sendonly direction (remote hold). */
const SENDONLY_SDP = AUDIO_SDP.replace('a=sendrecv', 'a=sendonly');

/** AUDIO_SDP with an inactive direction (remote hold). */
const INACTIVE_SDP = AUDIO_SDP.replace('a=sendrecv', 'a=inactive');

/** STUB_SDP rewritten for the offered direction (undefined/sendrecv = as-is). */
function directionalSdp(direction: MediaDirection | undefined): string {
  if (direction === undefined || direction === 'sendrecv') return STUB_SDP;
  return STUB_SDP.replace('a=sendrecv', `a=${direction}`);
}

/**
 * A media port that records commands. createOffer auto-replies with STUB_SDP;
 * createAnswer auto-replies with the answer SDP; setRemote is held until the
 * test releases it (proving settlement is gated on media application).
 */
class HarnessMediaPort {
  commands: Array<{ type: string; [k: string]: unknown }> = [];
  heldSetRemote: Array<{ requestId: string; sessionId: string }> = [];
  answerErrors: Array<{ code: string; message: string }> = [];
  holdAnswers = false;
  heldAnswers: Array<{ requestId: string; sessionId: string }> = [];
  private listeners = new Set<(message: MediaMessage) => void>();

  postMessage(message: MediaMessage): void {
    if (message.type === 'closeSession') return;
    this.commands.push(message as { type: string; [k: string]: unknown });
    if (message.type === 'createOffer') {
      const direction = (message as { direction?: MediaDirection }).direction;
      queueMicrotask(() => this.deliver({ type: 'mediaResult', requestId: message.requestId, sessionId: message.sessionId, sdp: directionalSdp(direction) }));
    } else if (message.type === 'createAnswer') {
      if (this.holdAnswers) {
        this.heldAnswers.push({ requestId: message.requestId, sessionId: message.sessionId });
        return;
      }
      const error = this.answerErrors.shift();
      if (error !== undefined) {
        queueMicrotask(() => this.deliver({ type: 'mediaError', requestId: message.requestId, sessionId: message.sessionId, message: error.message, code: error.code as never }));
      } else {
        queueMicrotask(() => this.deliver({ type: 'mediaResult', requestId: message.requestId, sessionId: message.sessionId, sdp: STUB_SDP }));
      }
    } else if (message.type === 'setRemote') {
      this.heldSetRemote.push({ requestId: message.requestId, sessionId: message.sessionId });
    } else if (message.type === 'commitDirection' || message.type === 'rollbackDirection') {
      queueMicrotask(() => this.deliver({ type: 'mediaResult', requestId: message.requestId, sessionId: message.sessionId }));
    }
  }

  subscribe(listener: (message: MediaMessage) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  get offerCommands(): Array<{ type: 'createOffer'; iceRestart?: boolean }> {
    return this.commands.filter((c) => c.type === 'createOffer') as Array<{ type: 'createOffer'; iceRestart?: boolean }>;
  }

  get answerCommands(): Array<{ type: 'createAnswer'; sessionId: string; remoteSdp: string }> {
    const list = this.commands.filter((c) => c.type === 'createAnswer');
    return list as Array<{ type: 'createAnswer'; sessionId: string; remoteSdp: string }>;
  }

  get setRemoteSdps(): string[] {
    return this.commands
      .filter((c) => c.type === 'setRemote')
      .map((c) => typeof c.remoteSdp === 'string' ? c.remoteSdp : '');
  }

  /** Resolve or reject the oldest held createAnswer operation. */
  releaseAnswer(error?: { code: string; message: string }): void {
    const held = this.heldAnswers.shift();
    if (held === undefined) throw new Error('no held createAnswer to release');
    if (error === undefined) {
      this.deliver({ type: 'mediaResult', requestId: held.requestId, sessionId: held.sessionId, sdp: STUB_SDP });
    } else {
      this.deliver({ type: 'mediaError', requestId: held.requestId, sessionId: held.sessionId, code: error.code as never, message: error.message });
    }
  }

  /** Release the newest held setRemote (no more than the supplied count). */
  releaseSetRemote(): void {
    const held = this.heldSetRemote.shift();
    if (held === undefined) throw new Error('no held setRemote to release');
    this.deliver({ type: 'mediaResult', requestId: held.requestId, sessionId: held.sessionId });
  }

  private deliver(message: MediaMessage): void {
    for (const listener of this.listeners) listener(message);
  }
}

interface Harness {
  clock: NextDelayFakeClock;
  transport: FakeTransport;
  layer: TransactionLayer;
  events: TransactionLayerEvent[];
  sentRequests: SipRequestMessage[];
  responses: SipResponseMessage[];
  media: HarnessMediaPort;
  controller: WorkerMediaController;
  idGenerator: IdGenerator;
  dialog: Dialog;
  negotiator: DialogNegotiator;
}

/** Build a confirmed UAC dialog and a negotiator bound to it. */
function setup(options: {
  mediaPort?: HarnessMediaPort;
  clock?: boolean;
  random?: () => number;
  isCallIdOwner?: boolean;
  onRemoteHoldChanged?: (held: boolean) => void;
} = {}): Harness {
  const clock = new NextDelayFakeClock();
  const transport = new FakeTransport({ reliable: true, framing: 'stream' });
  void transport.connect();
  const sentRequests: SipRequestMessage[] = [];
  const responses: SipResponseMessage[] = [];
  transport.onSend = (bytes) => {
    const parsed = parseMessage(bytes);
    if (!parsed.ok) return;
    if (parsed.value.kind === 'request') sentRequests.push(parsed.value);
    else responses.push(parsed.value);
  };
  const timers = deriveTimers({ T1: 500, T2: 4000, T4: 5000 }, true);
  const events: TransactionLayerEvent[] = [];
  const layer = new TransactionLayer({
    transport, clock, timers, reliable: true,
    emit: (event) => events.push(event),
  });
  const idGenerator = makeIdGenerator();
  const media = options.mediaPort ?? new HarnessMediaPort();
  const controller = options.clock
    ? new WorkerMediaController(media, { clock, deadlineMs: 100 })
    : new WorkerMediaController(media);

  const viaConfig: ViaConfig = { token: 'TCP', sentBy: '192.0.2.1:5060' };

  // Build a confirmed initial INVITE + 2xx, then a Dialog from them.
  const inviteHeaders = new Headers();
  inviteHeaders.set('Via', 'SIP/2.0/TCP 192.0.2.1:5060;branch=z9hG4bK-initial');
  inviteHeaders.set('Max-Forwards', '70');
  inviteHeaders.set('From', `<${AOR}>;tag=alice-tag`);
  inviteHeaders.set('To', `<${REMOTE_URI}>`);
  inviteHeaders.set('Call-ID', 'call-negotiator@example.com');
  inviteHeaders.set('CSeq', '1 INVITE');
  inviteHeaders.set('Contact', CONTACT);
  const invite = makeRequest('INVITE', REMOTE_URI, inviteHeaders);

  const responseHeaders = new Headers();
  responseHeaders.set('Via', 'SIP/2.0/TCP 192.0.2.2:5060;branch=z9hG4bK-side');
  responseHeaders.set('From', `<${AOR}>;tag=alice-tag`);
  responseHeaders.set('To', `<${REMOTE_URI}>;tag=bob-tag`);
  responseHeaders.set('Call-ID', 'call-negotiator@example.com');
  responseHeaders.set('CSeq', '1 INVITE');
  responseHeaders.set('Contact', '<sip:bob@192.0.2.2:5060>');
  const response = makeResponse(200, 'OK', responseHeaders);
  const dialog = Dialog.fromUac(invite, response, idGenerator, viaConfig);

  const negotiator = new DialogNegotiator({
    owner: { dialog, mediaSessionId: SESSION_ID },
    layer,
    controller,
    clock,
    idGenerator,
    via: viaConfig,
    contact: CONTACT,
    random: options.random ?? (() => 0.5),
    isCallIdOwner: options.isCallIdOwner ?? true,
    T1: 500,
    T2: 4000,
    onRemoteHoldChanged: options.onRemoteHoldChanged,
  });

  return { clock, transport, layer, events, sentRequests, responses, media, controller, idGenerator, dialog, negotiator };
}

/**
 * An INCOMING in-dialog re-INVITE (sent by the remote peer, addressed to us).
 * From carries the remote tag, To carries our local tag.
 */
function makeReinvite(dialog: Dialog, cseq = 2, branch?: string): SipRequestMessage {
  return makeReinviteBody(dialog, AUDIO_SDP, cseq, branch);
}

/** An incoming re-INVITE carrying an arbitrary SDP body (e.g. sendonly). */
function makeReinviteBody(dialog: Dialog, sdp: string, cseq = 2, branch?: string): SipRequestMessage {
  const headers = new Headers();
  headers.set('Via', `SIP/2.0/TCP 192.0.2.2:5060;branch=z9hG4bK-${branch ?? `reinvite-${cseq}`}`);
  headers.set('Max-Forwards', '70');
  headers.set('From', `<${REMOTE_URI}>;tag=${dialog.remoteTag}`);
  headers.set('To', `<${AOR}>;tag=${dialog.localTag}`);
  headers.set('Call-ID', dialog.callId);
  headers.set('CSeq', `${cseq} INVITE`);
  headers.set('Contact', `<${REMOTE_URI}>`);
  headers.set('Content-Type', 'application/sdp');
  const body = new TextEncoder().encode(sdp);
  return makeRequest('INVITE', AOR, headers, body);
}

/** An ACK answering our 2xx for a remote re-INVITE (new transaction, stateless). */
function makeAck(dialog: Dialog, cseq: number, branch = `ack-${cseq}`): SipRequestMessage {
  const headers = new Headers();
  headers.set('Via', `SIP/2.0/TCP 192.0.2.2:5060;branch=z9hG4bK-${branch}`);
  headers.set('Max-Forwards', '70');
  headers.set('From', `<${REMOTE_URI}>;tag=${dialog.remoteTag}`);
  headers.set('To', `<${AOR}>;tag=${dialog.localTag}`);
  headers.set('Call-ID', dialog.callId);
  headers.set('CSeq', `${cseq} ACK`);
  headers.set('Contact', `<${REMOTE_URI}>`);
  return makeRequest('ACK', AOR, headers);
}

/** Deliver an incoming request; route its server transaction to the negotiator. */
function deliverIncoming(h: Harness, request: SipRequestMessage): void {
  const before = h.events.length;
  h.layer.receive(request);
  for (const event of h.events.slice(before)) {
    if (event.type === 'request') {
      h.negotiator.handleIncoming(event.transaction, event.request);
    }
  }
}

/** Deliver an unmatched (stateless) request, e.g. the ACK to our 2xx. */
function deliverStateless(h: Harness, request: SipRequestMessage): void {
  const before = h.events.length;
  h.layer.receive(request);
  for (const event of h.events.slice(before)) {
    if (event.type === 'statelessRequest') {
      h.negotiator.handleIncomingAck(event.request);
    }
  }
}

/** Build a 2xx response for the given re-INVITE, carrying an answer SDP. */
function respond2xxTo(h: Harness, request: SipRequestMessage, sdp = STUB_SDP): void {
  const headers = new Headers();
  headers.set('Via', request.headers.get('Via') ?? 'SIP/2.0/TCP 192.0.2.2:5060');
  headers.set('From', request.headers.get('From') ?? '');
  // The outbound re-INVITE's To already carries the remote tag; echo it exactly
  // so the response identity (To tag) matches the request.
  headers.set('To', request.headers.get('To') ?? '');
  headers.set('Call-ID', request.headers.get('Call-ID') ?? '');
  headers.set('CSeq', request.headers.get('CSeq') ?? '');
  headers.set('Contact', '<sip:bob@192.0.2.2:5060>');
  let message: SipResponseMessage = makeResponse(200, 'OK', headers);
  if (sdp !== undefined) message = withTextBody(message, sdp, 'application/sdp') as SipResponseMessage;
  h.layer.receive(message);
}

/** Build a non-2xx (e.g. 491/488) response for the given re-INVITE. */
function respondStatusTo(h: Harness, request: SipRequestMessage, statusCode: number, reason: string): void {
  const headers = new Headers();
  headers.set('Via', request.headers.get('Via') ?? 'SIP/2.0/TCP 192.0.2.2:5060');
  headers.set('From', request.headers.get('From') ?? '');
  headers.set('To', request.headers.get('To') ?? '');
  headers.set('Call-ID', request.headers.get('Call-ID') ?? '');
  headers.set('CSeq', request.headers.get('CSeq') ?? '');
  h.layer.receive(makeResponse(statusCode, reason, headers));
}

function lastOutboundInvite(h: Harness): SipRequestMessage {
  const invites = h.sentRequests.filter((r) => r.method === 'INVITE');
  const reinvite = invites[invites.length - 1];
  if (reinvite === undefined) throw new Error('no outbound INVITE');
  return reinvite;
}

/** The most recent status sent on the wire. */
function lastResponse(h: Harness): SipResponseMessage {
  const response = h.responses[h.responses.length - 1];
  if (response === undefined) throw new Error('no response sent');
  return response;
}

describe('DialogNegotiator', () => {
  describe('local restart (restartIce)', () => {
    it('posts createOffer(iceRestart:true) and sends an incremented in-dialog INVITE', async () => {
      const h = setup();
      const initialInviteCSeq = Number(h.dialog.getLocalCSeq());

      const restart = h.negotiator.restartIce();
      await flush();

      expect(h.media.offerCommands).toEqual([
        { type: 'createOffer', requestId: expect.any(String), sessionId: SESSION_ID, iceRestart: true },
      ]);
      const reinvite = lastOutboundInvite(h);
      expect(reinvite.method).toBe('INVITE');
      expect(h.dialog.getLocalCSeq()).toBe(initialInviteCSeq + 1);
      const cseqNumber = Number(reinvite.headers.get('CSeq')?.trim().split(/\s+/)[0]);
      expect(cseqNumber).toBe(initialInviteCSeq + 1);
      expect(reinvite.headers.get('Content-Type')).toBe('application/sdp');
      expect(reinvite.headers.get('To')).toContain(`tag=${h.dialog.remoteTag}`);

      await expectPending(restart);
      // Complete the negotiation so no rejection leaks.
      respond2xxTo(h, reinvite);
      await flush();
      h.media.releaseSetRemote();
      await restart;
    });

    it('resolves only after a 2xx AND setRemote, in that order', async () => {
      const h = setup();
      const restart = h.negotiator.restartIce();
      await flush();
      const reinvite = lastOutboundInvite(h);
      await expectPending(restart);

      // Deliver the 2xx carrying an answer. setRemote must be posted and held;
      // the restart is still pending until media is applied.
      respond2xxTo(h, reinvite, STUB_SDP);
      await flush();
      expect(h.media.setRemoteSdps).toContain(STUB_SDP);
      expect(h.media.heldSetRemote).toHaveLength(1);
      await expectPending(restart);

      h.media.releaseSetRemote();
      await restart;
      expect(h.negotiator.busy).toBe(false);
    });

    it('ACKs the 2xx to the re-INVITE (RFC 3261 13.2.2.4)', async () => {
      const h = setup();
      const restart = h.negotiator.restartIce();
      await flush();
      const reinvite = lastOutboundInvite(h);
      await expectPending(restart);

      respond2xxTo(h, reinvite, STUB_SDP);
      await flush();
      h.media.releaseSetRemote();
      await restart;

      // The re-INVITE transaction must be ACKed (same dialog, CSeq number with
      // ACK method) so the peer does not linger in Accepted retransmitting 2xx.
      const acks = h.sentRequests.filter((r) => r.method === 'ACK');
      expect(acks).toHaveLength(1);
      const ack = acks[0]!;
      const reinviteCSeq = Number(reinvite.headers.get('CSeq')?.trim().split(/\s+/)[0]);
      expect(ack.headers.get('CSeq')?.toUpperCase()).toBe(`${reinviteCSeq} ACK`);
      expect(ack.headers.get('Call-ID')).toBe(reinvite.headers.get('Call-ID'));
      expect(ack.headers.get('To')).toBe(reinvite.headers.get('To'));
      expect(ack.headers.get('Route')).toBe(reinvite.headers.get('Route'));
    });

    it('waits for ACK delivery before applying the remote SDP', async () => {
      const h = setup();
      const restart = h.negotiator.restartIce();
      await flush();
      const reinvite = lastOutboundInvite(h);
      const originalSend = h.transport.send.bind(h.transport);
      let releaseAck!: () => void;
      const ackGate = new Promise<void>((resolve) => { releaseAck = resolve; });
      h.transport.send = async (bytes): Promise<void> => {
        const parsed = parseMessage(bytes);
        if (parsed.ok && parsed.value.kind === 'request' && parsed.value.method === 'ACK') {
          await ackGate;
        }
        await originalSend(bytes);
      };

      respond2xxTo(h, reinvite, STUB_SDP);
      await flush();
      expect(h.media.setRemoteSdps).not.toContain(STUB_SDP);
      releaseAck();
      await flush();
      expect(h.media.setRemoteSdps).toContain(STUB_SDP);
      h.media.releaseSetRemote();
      await restart;
    });

    it('rejects TRANSPORT_FAILED without applying SDP or leaking ACK rejection', async () => {
      const h = setup();
      const restart = h.negotiator.restartIce();
      await flush();
      const reinvite = lastOutboundInvite(h);
      h.transport.sendError = new TransportError('FakeTransport is not connected');
      let unhandled: unknown;
      const onUnhandled = (error: unknown): void => { unhandled = error; };
      process.on('unhandledRejection', onUnhandled);

      try {
        respond2xxTo(h, reinvite, STUB_SDP);
        await expect(restart).rejects.toMatchObject({ code: 'TRANSPORT_FAILED' });
        await flush();
      } finally {
        process.removeListener('unhandledRejection', onUnhandled);
      }

      expect(h.media.setRemoteSdps).not.toContain(STUB_SDP);
      expect(unhandled).toBeUndefined();
      expect(h.negotiator.busy).toBe(false);
    });

    it('rejects with a typed error when the 2xx answer SDP is oversized', async () => {
      const h = setup();
      const restart = h.negotiator.restartIce();
      await flush();
      const reinvite = lastOutboundInvite(h);
      await expectPending(restart);

      // A 2xx answer body larger than the bounded SDP limit (64 KiB).
      const oversized = `v=0\r\no=- 1 1 IN IP4 192.0.2.1\r\ns=-\r\n${'x'.repeat(70 * 1024)}`;
      respond2xxTo(h, reinvite, oversized);
      await expect(restart).rejects.toMatchObject({ name: 'SipError' });
      expect(h.sentRequests.filter((request) => request.method === 'ACK')).toHaveLength(1);
      expect(h.media.setRemoteSdps).toHaveLength(0);
      expect(h.negotiator.busy).toBe(false);
    });

    it('rejects with a typed error when the 2xx answer carries a non-SDP body', async () => {
      const h = setup();
      const restart = h.negotiator.restartIce();
      await flush();
      const reinvite = lastOutboundInvite(h);
      await expectPending(restart);

      const headers = new Headers();
      headers.set('Via', reinvite.headers.get('Via') ?? '');
      headers.set('From', reinvite.headers.get('From') ?? '');
      headers.set('To', reinvite.headers.get('To') ?? '');
      headers.set('Call-ID', reinvite.headers.get('Call-ID') ?? '');
      headers.set('CSeq', reinvite.headers.get('CSeq') ?? '');
      headers.set('Contact', '<sip:bob@192.0.2.2:5060>');
      headers.set('Content-Type', 'text/plain');
      const response = withTextBody(makeResponse(200, 'OK', headers), 'not sdp', 'text/plain') as SipResponseMessage;
      h.layer.receive(response);
      await expect(restart).rejects.toMatchObject({ name: 'SipError' });
      expect(h.media.setRemoteSdps).toHaveLength(0);
      expect(h.negotiator.busy).toBe(false);
    });

    it('rejects on a 491 (Request Pending) response', async () => {
      const h = setup();
      const restart = h.negotiator.restartIce();
      await flush();
      const reinvite = lastOutboundInvite(h);
      respondStatusTo(h, reinvite, 491, 'Request Pending');
      await expect(restart).rejects.toMatchObject({ statusCode: 491 });
      expect(h.negotiator.busy).toBe(false);
    });

    it('rejects on a 488 (Not Acceptable Here) response', async () => {
      const h = setup();
      const restart = h.negotiator.restartIce();
      await flush();
      const reinvite = lastOutboundInvite(h);
      respondStatusTo(h, reinvite, 488, 'Not Acceptable Here');
      await expect(restart).rejects.toMatchObject({ statusCode: 488 });
      expect(h.negotiator.busy).toBe(false);
    });

    it('rejects on a SIP transaction timeout (missing 2xx)', async () => {
      const h = setup({ clock: false });
      const restart = h.negotiator.restartIce();
      await flush();
      await expectPending(restart);
      // INVITE timer B = 64*T1 = 32000ms on a reliable transport.
      h.clock.advance(32000);
      await expect(restart).rejects.toMatchObject({ code: 'TIMEOUT' });
      expect(h.negotiator.busy).toBe(false);
    });

    it('rejects with MediaTimeoutError when a held setRemote never replies', async () => {
      const h = setup({ clock: true });
      const restart = h.negotiator.restartIce();
      await flush();
      const reinvite = lastOutboundInvite(h);
      respond2xxTo(h, reinvite, STUB_SDP);
      await flush();
      expect(h.media.heldSetRemote).toHaveLength(1);
      // The controller deadline is 100ms; advance past it → MediaTimeoutError.
      h.clock.advance(101);
      await expect(restart).rejects.toMatchObject({ name: 'MediaTimeoutError' });
      expect(h.negotiator.busy).toBe(false);
    });

    it('rejects immediately with INVALID_STATE when already busy', async () => {
      const h = setup();
      const first = h.negotiator.restartIce();
      await flush();
      await expect(h.negotiator.restartIce()).rejects.toMatchObject({ code: 'INVALID_STATE' });
      const reinvite = lastOutboundInvite(h);
      respond2xxTo(h, reinvite);
      await flush();
      h.media.releaseSetRemote();
      await first;
    });
  });

  describe('incoming in-dialog re-INVITE', () => {
    it('calls createAnswer with the remote SDP and replies 200 with the returned SDP', async () => {
      const h = setup();
      const reinvite = makeReinvite(h.dialog, 2);
      h.negotiator.busy; // no-op to satisfy any lint; busia must be false
      deliverIncoming(h, reinvite);
      await flush();

      expect(h.media.answerCommands).toHaveLength(1);
      expect(h.media.answerCommands[0]).toMatchObject({ sessionId: SESSION_ID, remoteSdp: AUDIO_SDP });
      const response = lastResponse(h);
      expect(response.statusCode).toBe(200);
      expect(bodyText(response)).toBe(STUB_SDP);
      expect(response.headers.get('Content-Type')).toBe('application/sdp');
      expect(h.negotiator.busy).toBe(false);
    });

    it.each([
      ['successful answer', undefined],
      ['failed answer', { code: 'NEGOTIATION_FAILED', message: 'unsupported codec' }],
    ])('releases busy and contains send errors after transaction disposal: %s', async (_label, error) => {
      const h = setup();
      h.media.holdAnswers = true;
      deliverIncoming(h, makeReinvite(h.dialog, 2));
      await flush();
      expect(h.negotiator.busy).toBe(true);
      h.layer.dispose();
      let unhandled: unknown;
      const onUnhandled = (reason: unknown): void => { unhandled = reason; };
      process.on('unhandledRejection', onUnhandled);
      try {
        h.media.releaseAnswer(error);
        await flush();
        await flush();
      } finally {
        process.removeListener('unhandledRejection', onUnhandled);
      }
      expect(unhandled).toBeUndefined();
      expect(h.negotiator.busy).toBe(false);
    });

    it('replies 491 without touching media when a negotiation is in-flight', async () => {
      const h = setup();
      // Start a local restart and keep it in-flight (no 2xx yet).
      const restart = h.negotiator.restartIce();
      await flush();
      expect(h.negotiator.busy).toBe(true);

      const reinvite = makeReinvite(h.dialog, 2);
      deliverIncoming(h, reinvite);
      await flush();

      expect(lastResponse(h).statusCode).toBe(491);
      expect(h.media.answerCommands).toHaveLength(0);
      expect(h.media.offerCommands).toHaveLength(1); // only the local createOffer
      expect(h.negotiator.busy).toBe(true);

      const outbound = lastOutboundInvite(h);
      respond2xxTo(h, outbound);
      await flush();
      h.media.releaseSetRemote();
      await restart;
    });

    it('replies 491 to a second incoming while one is being answered', async () => {
      const h = setup();
      const first = makeReinvite(h.dialog, 2);
      const second = makeReinvite(h.dialog, 3);
      deliverIncoming(h, first);
      // createAnswer is held pending microtask; busy is set synchronously, so a
      // second incoming while the first is being answered sees busy → 491.
      deliverIncoming(h, second);
      await flush();
      // The first is answered with 200; the second receives 491.
      const statuses = h.responses.map((r) => r.statusCode);
      expect(statuses).toContain(200);
      expect(statuses).toContain(491);
      expect(h.media.answerCommands).toHaveLength(1);
    });

    it.each([
      ['a non-SDP content type', undefined, AUDIO_SDP, 'text/plain'],
      ['zero active audio (video m-line)', VIDEO_SDP, VIDEO_SDP, 'application/sdp'],
      ['multiple active audio sections', MULTI_AUDIO_SDP, MULTI_AUDIO_SDP, 'application/sdp'],
    ])('replies 488 without touching media for %s', async (_label, sdp, _unused, contentType) => {
      const h = setup();
      const rejectPin = contentType === 'text/plain';
      const base = makeReinvite(h.dialog, 2);
      // Rebuild with an arbitrary content type (or no content type) and body.
      const headers = base.headers.clone();
      headers.set('Content-Type', rejectPin ? contentType : 'application/sdp');
      const body = new TextEncoder().encode(rejectPin ? 'not sdp' : sdp);
      const request = makeRequest('INVITE', base.uri, headers, body);
      deliverIncoming(h, request);
      await flush();

      expect(lastResponse(h).statusCode).toBe(488);
      expect(h.media.answerCommands).toHaveLength(0);
      expect(h.negotiator.busy).toBe(false);
    });

    it('replies 488 when createAnswer fails with an unsupported-media error', async () => {
      const h = setup();
      h.media.answerErrors.push({ code: 'NEGOTIATION_FAILED', message: 'unsupported codec' });
      const reinvite = makeReinvite(h.dialog, 2);
      deliverIncoming(h, reinvite);
      await flush();
      expect(lastResponse(h).statusCode).toBe(488);
      expect(h.negotiator.busy).toBe(false);
    });

    it('replies 481 for a wrong dialog identity', async () => {
      const h = setup();
      const reinvite = makeReinvite(h.dialog, 2);
      const forged = reinvite.headers.clone();
      forged.set('Call-ID', 'forged-call@example.com');
      const body = new TextEncoder().encode(AUDIO_SDP);
      deliverIncoming(h, makeRequest('INVITE', reinvite.uri, forged, body));
      await flush();
      expect(lastResponse(h).statusCode).toBe(481);
      expect(h.media.answerCommands).toHaveLength(0);
    });

    it('replies 481 for a stale (non-incrementing) CSeq', async () => {
      const h = setup();
      // Accept one fresh re-INVITE (CSeq 2), advancing remote CSeq to 2.
      const first = makeReinvite(h.dialog, 2);
      deliverIncoming(h, first);
      await flush();
      expect(lastResponse(h).statusCode).toBe(200);
      expect(h.media.answerCommands).toHaveLength(1);

      // A repeat re-INVITE reusing CSeq 2 (fresh branch) is stale → 481.
      const replay = makeReinvite(h.dialog, 2, 'replay-stale');
      deliverIncoming(h, replay);
      await flush();
      expect(lastResponse(h).statusCode).toBe(481);
      expect(h.media.answerCommands).toHaveLength(1);
      expect(h.negotiator.busy).toBe(false);
    });
  });

  describe('local hold and resume (hold/resume)', () => {
    it('hold(sendonly) posts a directional offer and sends an in-dialog INVITE, resolving only after ACK+setRemote+commit', async () => {
      const h = setup();
      const initialCSeq = Number(h.dialog.getLocalCSeq());

      const held = h.negotiator.hold('sendonly');
      await flush();

      expect(h.media.offerCommands).toEqual([
        { type: 'createOffer', requestId: expect.any(String), sessionId: SESSION_ID, direction: 'sendonly' },
      ]);
      const reinvite = lastOutboundInvite(h);
      expect(reinvite.method).toBe('INVITE');
      expect(bodyText(reinvite)).toContain('a=sendonly');
      const cseqNumber = Number(reinvite.headers.get('CSeq')?.trim().split(/\s+/)[0]);
      expect(cseqNumber).toBe(initialCSeq + 1);
      expect(h.negotiator.busy).toBe(true);

      await expectPending(held);
      respond2xxTo(h, reinvite, STUB_SDP);
      await flush();
      expect(h.media.heldSetRemote).toHaveLength(1);
      expect(h.media.commands.filter((c) => c.type === 'commitDirection')).toHaveLength(0);
      await expectPending(held);

      const acks = h.sentRequests.filter((r) => r.method === 'ACK');
      expect(acks).toHaveLength(1);
      h.media.releaseSetRemote();
      await held;
      expect(h.media.commands.filter((c) => c.type === 'commitDirection')).toHaveLength(1);
      expect(h.negotiator.busy).toBe(false);
    });

    it('hold(inactive) sends an inactive directional offer', async () => {
      const h = setup();
      const held = h.negotiator.hold('inactive');
      await flush();
      expect(h.media.offerCommands[0]).toMatchObject({ direction: 'inactive' });
      const reinvite = lastOutboundInvite(h);
      expect(bodyText(reinvite)).toContain('a=inactive');
      respond2xxTo(h, reinvite, STUB_SDP);
      await flush();
      h.media.releaseSetRemote();
      await held;
    });

    it('resume() restores a sendrecv direction with a fresh CSeq', async () => {
      const h = setup();
      const held = h.negotiator.hold('sendonly');
      await flush();
      const holdInvite = lastOutboundInvite(h);
      respond2xxTo(h, holdInvite, STUB_SDP);
      await flush();
      h.media.releaseSetRemote();
      await held;

      const resumed = h.negotiator.resume();
      await flush();
      const resumeInvite = lastOutboundInvite(h);
      expect(bodyText(resumeInvite)).toContain('a=sendrecv');
      const holdCSeq = Number(holdInvite.headers.get('CSeq')?.trim().split(/\s+/)[0]);
      const resumeCSeq = Number(resumeInvite.headers.get('CSeq')?.trim().split(/\s+/)[0]);
      expect(resumeCSeq).toBe(holdCSeq + 1);
      respond2xxTo(h, resumeInvite, STUB_SDP);
      await flush();
      h.media.releaseSetRemote();
      await resumed;
      expect(h.negotiator.busy).toBe(false);
    });

    it('rejects INVALID_STATE when already busy (concurrent hold/resume/restart/validate)', async () => {
      const h = setup();
      const held = h.negotiator.hold('sendonly');
      await flush();
      await expect(h.negotiator.hold('inactive')).rejects.toMatchObject({ code: 'INVALID_STATE' });
      await expect(h.negotiator.resume()).rejects.toMatchObject({ code: 'INVALID_STATE' });
      await expect(h.negotiator.restartIce()).rejects.toMatchObject({ code: 'INVALID_STATE' });
      await expect(h.negotiator.validateDialog()).rejects.toMatchObject({ code: 'INVALID_STATE' });
      const reinvite = lastOutboundInvite(h);
      respond2xxTo(h, reinvite, STUB_SDP);
      await flush();
      h.media.releaseSetRemote();
      await held;
    });

    it('rolls the direction back and rejects HOLD_NEGOTIATION_FAILED on a 488 rejection', async () => {
      const h = setup();
      const held = h.negotiator.hold('sendonly');
      await flush();
      const reinvite = lastOutboundInvite(h);
      respondStatusTo(h, reinvite, 488, 'Not Acceptable Here');
      await expect(held).rejects.toMatchObject({ code: 'HOLD_NEGOTIATION_FAILED' });
      expect(h.media.commands.filter((c) => c.type === 'rollbackDirection')).toHaveLength(1);
      expect(h.media.commands.filter((c) => c.type === 'commitDirection')).toHaveLength(0);
      expect(h.negotiator.busy).toBe(false);
    });

    it('rolls the direction back and rejects HOLD_NEGOTIATION_FAILED when the ACK send fails', async () => {
      const h = setup();
      const held = h.negotiator.hold('sendonly');
      await flush();
      const reinvite = lastOutboundInvite(h);
      h.transport.sendError = new TransportError('FakeTransport is not connected');
      respond2xxTo(h, reinvite, STUB_SDP);
      await expect(held).rejects.toMatchObject({ code: 'HOLD_NEGOTIATION_FAILED' });
      expect(h.media.setRemoteSdps).toHaveLength(0);
      expect(h.media.commands.filter((c) => c.type === 'rollbackDirection')).toHaveLength(1);
      expect(h.negotiator.busy).toBe(false);
    });

    it('rejects HOLD_NEGOTIATION_FAILED with a rollback on a transaction timeout', async () => {
      const h = setup();
      const held = h.negotiator.hold('sendonly');
      await flush();
      await expectPending(held);
      h.clock.advance(32000); // INVITE timer B = 64*T1
      await expect(held).rejects.toMatchObject({ code: 'HOLD_NEGOTIATION_FAILED' });
      expect(h.media.commands.filter((c) => c.type === 'rollbackDirection')).toHaveLength(1);
      expect(h.negotiator.busy).toBe(false);
    });

    it('dispose during a held offer rejects and clears busy', async () => {
      const h = setup();
      const held = h.negotiator.hold('sendonly');
      await flush();
      const shutdown = new SipError(0, 'shutdown', 'LIFECYCLE_ABORTED');
      h.negotiator.dispose(shutdown);
      await expect(held).rejects.toThrow('shutdown');
      expect(h.negotiator.busy).toBe(false);
    });
  });

  describe('491 glare retry (RFC 3261 14.2)', () => {
    it('retries exactly once after 491 with the Call-ID owner window (2100 + random*1901)', async () => {
      const h = setup({ random: () => 0.5 }); // 2100 + floor(0.5*1901) = 3050
      const held = h.negotiator.hold('sendonly');
      await flush();
      const first = lastOutboundInvite(h);
      respondStatusTo(h, first, 491, 'Request Pending');
      await flush();

      expect(h.clock.nextDelay()).toBe(3050);
      expect(h.negotiator.busy).toBe(true); // the operation survives the glare
      h.clock.advance(3050);
      await flush();

      const invites = h.sentRequests.filter((r) => r.method === 'INVITE');
      expect(invites).toHaveLength(2);
      expect(bodyText(invites[1]!)).toContain('a=sendonly');
      expect(invites[1]!.headers.get('CSeq')).not.toBe(invites[0]!.headers.get('CSeq'));

      respond2xxTo(h, invites[1]!, STUB_SDP);
      await flush();
      h.media.releaseSetRemote();
      await held;
      expect(h.negotiator.busy).toBe(false);
    });

    it('uses the 0-2000ms window for the non-Call-ID owner', async () => {
      const h = setup({ isCallIdOwner: false, random: () => 0.5 }); // floor(0.5*2001) = 1000
      const held = h.negotiator.hold('sendonly');
      await flush();
      const first = lastOutboundInvite(h);
      respondStatusTo(h, first, 491, 'Request Pending');
      await flush();
      expect(h.clock.nextDelay()).toBe(1000);
      h.clock.advance(1000);
      await flush();
      expect(h.sentRequests.filter((r) => r.method === 'INVITE')).toHaveLength(2);
      respond2xxTo(h, lastOutboundInvite(h), STUB_SDP);
      await flush();
      h.media.releaseSetRemote();
      await held;
    });

    it('rejects HOLD_NEGOTIATION_FAILED on a second 491 without a third INVITE', async () => {
      const h = setup({ random: () => 0.5 });
      const held = h.negotiator.hold('sendonly');
      await flush();
      const first = lastOutboundInvite(h);
      respondStatusTo(h, first, 491, 'Request Pending');
      await flush();
      h.clock.advance(3050);
      await flush();
      expect(h.sentRequests.filter((r) => r.method === 'INVITE')).toHaveLength(2);
      const second = lastOutboundInvite(h);
      respondStatusTo(h, second, 491, 'Request Pending');
      await expect(held).rejects.toMatchObject({ code: 'HOLD_NEGOTIATION_FAILED' });
      expect(h.sentRequests.filter((r) => r.method === 'INVITE')).toHaveLength(2);
      expect(h.media.commands.filter((c) => c.type === 'rollbackDirection')).toHaveLength(1);
      expect(h.negotiator.busy).toBe(false);
    });

    it('answers an incoming re-INVITE with 491 while a local hold is in-flight (collision)', async () => {
      const h = setup();
      const held = h.negotiator.hold('sendonly');
      await flush();
      const reinvite = makeReinvite(h.dialog, 2);
      deliverIncoming(h, reinvite);
      await flush();
      expect(lastResponse(h).statusCode).toBe(491);
      expect(h.media.answerCommands).toHaveLength(0);
      const outbound = lastOutboundInvite(h);
      respond2xxTo(h, outbound, STUB_SDP);
      await flush();
      h.media.releaseSetRemote();
      await held;
    });

    it('dispose cancels a pending 491 retry', async () => {
      const h = setup({ random: () => 0.5 });
      const held = h.negotiator.hold('sendonly');
      await flush();
      const first = lastOutboundInvite(h);
      respondStatusTo(h, first, 491, 'Request Pending');
      await flush();
      expect(h.clock.nextDelay()).toBe(3050);

      const shutdown = new SipError(0, 'shutdown', 'LIFECYCLE_ABORTED');
      h.negotiator.dispose(shutdown);
      await expect(held).rejects.toThrow('shutdown');
      expect(h.negotiator.busy).toBe(false);
      h.clock.advance(3050);
      await flush();
      expect(h.sentRequests.filter((r) => r.method === 'INVITE')).toHaveLength(1);
    });
  });

  describe('incoming remote hold (sendonly/inactive offers)', () => {
    it('derives remote hold from a sendonly offer and commits it on the matching ACK', async () => {
      const held: boolean[] = [];
      const h = setup({ onRemoteHoldChanged: (value) => held.push(value) });
      const reinvite = makeReinviteBody(h.dialog, SENDONLY_SDP, 2);
      deliverIncoming(h, reinvite);
      await flush();

      expect(lastResponse(h).statusCode).toBe(200);
      expect(h.negotiator.remoteHold).toBe(false); // pending until the ACK

      deliverStateless(h, makeAck(h.dialog, 2));
      expect(h.negotiator.remoteHold).toBe(true);
      expect(held).toEqual([true]);
      expect(h.negotiator.busy).toBe(false);
    });

    it('derives remote hold from an inactive offer', async () => {
      const held: boolean[] = [];
      const h = setup({ onRemoteHoldChanged: (value) => held.push(value) });
      const reinvite = makeReinviteBody(h.dialog, INACTIVE_SDP, 2);
      deliverIncoming(h, reinvite);
      await flush();
      expect(lastResponse(h).statusCode).toBe(200);
      deliverStateless(h, makeAck(h.dialog, 2));
      expect(h.negotiator.remoteHold).toBe(true);
      expect(held).toEqual([true]);
    });

    it('does not commit remote hold for a sendrecv offer', async () => {
      const held: boolean[] = [];
      const h = setup({ onRemoteHoldChanged: (value) => held.push(value) });
      const reinvite = makeReinvite(h.dialog, 2);
      deliverIncoming(h, reinvite);
      await flush();
      deliverStateless(h, makeAck(h.dialog, 2));
      expect(h.negotiator.remoteHold).toBe(false);
      expect(held).toEqual([]);
    });

    it('resets committed remote hold on a later sendrecv (un-hold) re-INVITE', async () => {
      const held: boolean[] = [];
      const h = setup({ onRemoteHoldChanged: (value) => held.push(value) });
      deliverIncoming(h, makeReinviteBody(h.dialog, SENDONLY_SDP, 2));
      await flush();
      deliverStateless(h, makeAck(h.dialog, 2));
      expect(h.negotiator.remoteHold).toBe(true);
      expect(held).toEqual([true]);
      deliverIncoming(h, makeReinviteBody(h.dialog, AUDIO_SDP, 3));
      await flush();
      deliverStateless(h, makeAck(h.dialog, 3));
      expect(h.negotiator.remoteHold).toBe(false);
      expect(held).toEqual([true, false]);
    });

    it('ignores an ACK with a mismatched CSeq and commits on the matching one', async () => {
      const held: boolean[] = [];
      const h = setup({ onRemoteHoldChanged: (value) => held.push(value) });
      const reinvite = makeReinviteBody(h.dialog, SENDONLY_SDP, 2);
      deliverIncoming(h, reinvite);
      await flush();
      deliverStateless(h, makeAck(h.dialog, 999));
      expect(h.negotiator.remoteHold).toBe(false);
      deliverStateless(h, makeAck(h.dialog, 2));
      expect(h.negotiator.remoteHold).toBe(true);
      expect(held).toEqual([true]);
    });

    it('never commits remote hold when no ACK arrives (200 retransmission times out)', async () => {
      const held: boolean[] = [];
      const h = setup({ onRemoteHoldChanged: (value) => held.push(value) });
      const reinvite = makeReinviteBody(h.dialog, SENDONLY_SDP, 2);
      deliverIncoming(h, reinvite);
      await flush();
      expect(lastResponse(h).statusCode).toBe(200);
      h.clock.advance(32000); // 64*T1: the TU-owned 200 retransmitter times out
      await flush();
      expect(h.negotiator.remoteHold).toBe(false);
      expect(held).toHaveLength(0);
    });
  });

  describe('validateDialog', () => {
    it('sends an in-dialog OPTIONS and resolves on a 2xx', async () => {
      const h = setup();
      const validated = h.negotiator.validateDialog();
      await flush();
      const options = h.sentRequests.filter((r) => r.method === 'OPTIONS').at(-1)!;
      expect(options).toBeDefined();
      expect(options.headers.get('Call-ID')).toBe(h.dialog.callId);
      expect(h.negotiator.busy).toBe(true);

      const headers = new Headers();
      headers.set('Via', options.headers.get('Via') ?? '');
      headers.set('From', options.headers.get('From') ?? '');
      headers.set('To', options.headers.get('To') ?? '');
      headers.set('Call-ID', options.headers.get('Call-ID') ?? '');
      headers.set('CSeq', options.headers.get('CSeq') ?? '');
      h.layer.receive(makeResponse(200, 'OK', headers));
      await validated;
      expect(h.negotiator.busy).toBe(false);
    });

    it.each([405, 501])('resolves on a %d final', async (statusCode) => {
      const h = setup();
      const validated = h.negotiator.validateDialog();
      await flush();
      const options = h.sentRequests.filter((r) => r.method === 'OPTIONS').at(-1)!;
      const headers = new Headers();
      headers.set('Via', options.headers.get('Via') ?? '');
      headers.set('From', options.headers.get('From') ?? '');
      headers.set('To', options.headers.get('To') ?? '');
      headers.set('Call-ID', options.headers.get('Call-ID') ?? '');
      headers.set('CSeq', options.headers.get('CSeq') ?? '');
      h.layer.receive(makeResponse(statusCode, statusCode === 405 ? 'Method Not Allowed' : 'Not Implemented', headers));
      await validated;
      expect(h.negotiator.busy).toBe(false);
    });

    it('rejects on a 481 final', async () => {
      const h = setup();
      const validated = h.negotiator.validateDialog();
      await flush();
      const options = h.sentRequests.filter((r) => r.method === 'OPTIONS').at(-1)!;
      const headers = new Headers();
      headers.set('Via', options.headers.get('Via') ?? '');
      headers.set('From', options.headers.get('From') ?? '');
      headers.set('To', options.headers.get('To') ?? '');
      headers.set('Call-ID', options.headers.get('Call-ID') ?? '');
      headers.set('CSeq', options.headers.get('CSeq') ?? '');
      h.layer.receive(makeResponse(481, 'Call/Transaction Does Not Exist', headers));
      await expect(validated).rejects.toMatchObject({ statusCode: 481 });
      expect(h.negotiator.busy).toBe(false);
    });

    // A 408 (Request Timeout) proves the transaction timed out end-to-end, which
    // is NOT identity evidence of the dialog: only 2xx/405/501 final responses
    // (or 481, whose failure IS identity) settle the validation.
    it('rejects SIGNALING_RECOVERY_FAILED on a 408 final', async () => {
      const h = setup();
      const validated = h.negotiator.validateDialog();
      await flush();
      const options = h.sentRequests.filter((r) => r.method === 'OPTIONS').at(-1)!;
      const headers = new Headers();
      headers.set('Via', options.headers.get('Via') ?? '');
      headers.set('From', options.headers.get('From') ?? '');
      headers.set('To', options.headers.get('To') ?? '');
      headers.set('Call-ID', options.headers.get('Call-ID') ?? '');
      headers.set('CSeq', options.headers.get('CSeq') ?? '');
      h.layer.receive(makeResponse(408, 'Request Timeout', headers));
      await expect(validated).rejects.toMatchObject({ code: 'SIGNALING_RECOVERY_FAILED' });
      expect(h.negotiator.busy).toBe(false);
    });

    it('rejects SIGNALING_RECOVERY_FAILED on any other non-481 final', async () => {
      const h = setup();
      const validated = h.negotiator.validateDialog();
      await flush();
      const options = h.sentRequests.filter((r) => r.method === 'OPTIONS').at(-1)!;
      const headers = new Headers();
      headers.set('Via', options.headers.get('Via') ?? '');
      headers.set('From', options.headers.get('From') ?? '');
      headers.set('To', options.headers.get('To') ?? '');
      headers.set('Call-ID', options.headers.get('Call-ID') ?? '');
      headers.set('CSeq', options.headers.get('CSeq') ?? '');
      h.layer.receive(makeResponse(500, 'Server Internal Error', headers));
      await expect(validated).rejects.toMatchObject({ code: 'SIGNALING_RECOVERY_FAILED' });
      expect(h.negotiator.busy).toBe(false);
    });

    it('rejects SIGNALING_RECOVERY_FAILED on a transaction timeout', async () => {
      const h = setup();
      const validated = h.negotiator.validateDialog();
      await flush();
      await expectPending(validated);
      h.clock.advance(32000); // non-INVITE client timer F = 64*T1
      await expect(validated).rejects.toMatchObject({ code: 'SIGNALING_RECOVERY_FAILED' });
      expect(h.negotiator.busy).toBe(false);
    });
  });

  describe('dispose', () => {
    it('settles a pending restart with the dispose reason and clears busy', async () => {
      const h = setup();
      const restart = h.negotiator.restartIce();
      await flush();
      await expectPending(restart);
      expect(h.negotiator.busy).toBe(true);

      const shutdown = new SipError(0, 'shutdown', 'LIFECYCLE_ABORTED');
      h.negotiator.dispose(shutdown);
      await expect(restart).rejects.toThrow('shutdown');
      expect(h.negotiator.busy).toBe(false);
    });

    it('terminates the owned re-INVITE transaction on dispose', async () => {
      const h = setup();
      const restart = h.negotiator.restartIce();
      await flush();
      await expectPending(restart);

      const shutdown = new SipError(0, 'shutdown', 'LIFECYCLE_ABORTED');
      h.negotiator.dispose(shutdown);
      await expect(restart).rejects.toThrow('shutdown');
      expect(h.negotiator.busy).toBe(false);

      // A late 2xx to the owned re-INVITE must be ignored, not fire a settlement
      // or retransmit: the transaction was terminated at dispose.
      const reinvite = lastOutboundInvite(h);
      respond2xxTo(h, reinvite, STUB_SDP);
      await flush();
      await expect(restart).rejects.toThrow('shutdown');
      expect(h.media.setRemoteSdps).toHaveLength(0);
    });

    it('is idempotent', async () => {
      const h = setup();
      h.negotiator.dispose(new Error('one'));
      h.negotiator.dispose(new Error('two'));
      expect(h.negotiator.busy).toBe(false);
    });
  });
});