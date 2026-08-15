import type { MediaDirection, MediaMessage, MediaPort, MediaReply } from './protocol.js';
import { STUB_SDP } from './protocol.js';

/**
 * Main-side stub media handler. Subscribes to the injected port and answers
 * every offer/answer request with the fixed `STUB_SDP`; records the remote SDP
 * per session for test assertions. No SIP, Worker, or WebRTC dependency.
 */
export class StubMainMediaHandler {
  private readonly offersBySession = new Map<string, string>();
  private readonly remoteBySession = new Map<string, string>();
  private readonly closedSessionsSet = new Set<string>();
  private readonly restartRequests = new Set<string>();
  private readonly directionsBySession = new Map<string, MediaDirection>();
  private readonly detach: () => void;
  private closed = false;

  constructor(private readonly port: MediaPort) {
    this.detach = this.port.subscribe((message: MediaMessage) => {
      this.handle(message);
    });
  }

  /** The stub SDP this handler last answered for the session, if any. */
  offers(sessionId: string): string | undefined {
    return this.offersBySession.get(sessionId);
  }

  /** The most recent remote SDP this handler received for the session. */
  remoteSdp(sessionId: string): string | undefined {
    return this.remoteBySession.get(sessionId);
  }

  /** Session ids the handler has been told are done, in arrival order. */
  closedSessions(): readonly string[] {
    return [...this.closedSessionsSet];
  }

  /** Whether any createOffer for the session carried restart intent. */
  offersRestarted(sessionId: string): boolean {
    return this.restartRequests.has(sessionId);
  }

  /** The most recent direction a createOffer for the session carried, if any. */
  direction(sessionId: string): MediaDirection | undefined {
    return this.directionsBySession.get(sessionId);
  }

  /** Stop listening; further commands are ignored. */
  unsubscribe(): void {
    this.closed = true;
    this.detach();
  }

  private handle(message: MediaMessage): void {
    if (this.closed) return;
    if (message.type === 'createOffer') {
      this.offersBySession.set(message.sessionId, STUB_SDP);
      if (message.iceRestart) this.restartRequests.add(message.sessionId);
      if (message.direction !== undefined) this.directionsBySession.set(message.sessionId, message.direction);
      this.reply({ type: 'mediaResult', requestId: message.requestId, sessionId: message.sessionId, sdp: STUB_SDP });
      return;
    }
    if (message.type === 'createAnswer') {
      this.remoteBySession.set(message.sessionId, message.remoteSdp);
      this.reply({ type: 'mediaResult', requestId: message.requestId, sessionId: message.sessionId, sdp: STUB_SDP });
      return;
    }
    if (message.type === 'setRemote') {
      this.remoteBySession.set(message.sessionId, message.remoteSdp);
      this.reply({ type: 'mediaResult', requestId: message.requestId, sessionId: message.sessionId });
      return;
    }
    if (message.type === 'commitDirection' || message.type === 'rollbackDirection') {
      // Direction transactions are acknowledged with a void mediaResult: the
      // stub owns no real transceiver state to commit or roll back.
      this.reply({ type: 'mediaResult', requestId: message.requestId, sessionId: message.sessionId });
      return;
    }
    if (message.type === 'closeSession') {
      // Fire-and-forget: record the close, drop per-session state, emit no reply.
      this.closedSessionsSet.add(message.sessionId);
      this.offersBySession.delete(message.sessionId);
      this.remoteBySession.delete(message.sessionId);
      this.restartRequests.delete(message.sessionId);
      this.directionsBySession.delete(message.sessionId);
      return;
    }
  }

  private reply(reply: MediaReply): void {
    this.port.postMessage(reply);
  }
}
