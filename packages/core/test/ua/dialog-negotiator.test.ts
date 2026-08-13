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
import type { MediaMessage } from '../../src/media/index.js';
import { Dialog, type IdGenerator } from '../../src/dialogs/dialog.js';
import { type ViaConfig } from '../../src/dialogs/header-values.js';
import { DialogNegotiator } from '../../src/ua/dialog-negotiator.js';
import { SipError } from '../../src/errors.js';

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

/**
 * A media port that records commands. createOffer auto-replies with STUB_SDP;
 * createAnswer auto-replies with the answer SDP; setRemote is held until the
 * test releases it (proving settlement is gated on media application).
 */
class HarnessMediaPort {
  commands: Array<{ type: string; [k: string]: unknown }> = [];
  heldSetRemote: Array<{ requestId: string; sessionId: string }> = [];
  answerErrors: Array<{ code: string; message: string }> = [];
  private listeners = new Set<(message: MediaMessage) => void>();

  postMessage(message: MediaMessage): void {
    if (message.type === 'closeSession') return;
    this.commands.push(message as { type: string; [k: string]: unknown });
    if (message.type === 'createOffer') {
      queueMicrotask(() => this.deliver({ type: 'mediaResult', requestId: message.requestId, sessionId: message.sessionId, sdp: STUB_SDP }));
    } else if (message.type === 'createAnswer') {
      const error = this.answerErrors.shift();
      if (error !== undefined) {
        queueMicrotask(() => this.deliver({ type: 'mediaError', requestId: message.requestId, sessionId: message.sessionId, message: error.message, code: error.code as never }));
      } else {
        queueMicrotask(() => this.deliver({ type: 'mediaResult', requestId: message.requestId, sessionId: message.sessionId, sdp: STUB_SDP }));
      }
    } else if (message.type === 'setRemote') {
      this.heldSetRemote.push({ requestId: message.requestId, sessionId: message.sessionId });
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
  clock: FakeClock;
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
function setup(options: { mediaPort?: HarnessMediaPort; clock?: boolean } = {}): Harness {
  const clock = new FakeClock();
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
  });

  return { clock, transport, layer, events, sentRequests, responses, media, controller, idGenerator, dialog, negotiator };
}

/**
 * An INCOMING in-dialog re-INVITE (sent by the remote peer, addressed to us).
 * From carries the remote tag, To carries our local tag.
 */
function makeReinvite(dialog: Dialog, cseq = 2, branch?: string): SipRequestMessage {
  const headers = new Headers();
  headers.set('Via', `SIP/2.0/TCP 192.0.2.2:5060;branch=z9hG4bK-${branch ?? `reinvite-${cseq}`}`);
  headers.set('Max-Forwards', '70');
  headers.set('From', `<${REMOTE_URI}>;tag=${dialog.remoteTag}`);
  headers.set('To', `<${AOR}>;tag=${dialog.localTag}`);
  headers.set('Call-ID', dialog.callId);
  headers.set('CSeq', `${cseq} INVITE`);
  headers.set('Contact', `<${REMOTE_URI}>`);
  headers.set('Content-Type', 'application/sdp');
  const body = new TextEncoder().encode(AUDIO_SDP);
  return makeRequest('INVITE', AOR, headers, body);
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

    it('is idempotent', async () => {
      const h = setup();
      h.negotiator.dispose(new Error('one'));
      h.negotiator.dispose(new Error('two'));
      expect(h.negotiator.busy).toBe(false);
    });
  });
});