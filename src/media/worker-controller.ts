import type { MediaCommand, MediaMessage, MediaPort, MediaReply } from './protocol.js';

interface Pending {
  resolve: (value: string | void) => void;
  reject: (reason: Error) => void;
}

let nextRequestId = 0;
function requestId(): string {
  return `media-${++nextRequestId}`;
}

/**
 * Worker-side media controller. Sends `MediaCommand`s on the injected
 * `MediaPort` and correlates `mediaResult`/`mediaError` replies back to the
 * originating promise by requestId. Never touches SIP, Worker, or WebRTC.
 */
export class WorkerMediaController {
  private readonly pending = new Map<string, Pending>();
  private readonly detach: () => void;
  private closed = false;

  constructor(private readonly port: MediaPort) {
    this.detach = this.port.subscribe((message: MediaMessage) => {
      if (message.type === 'mediaResult' || message.type === 'mediaError') {
        this.handleReply(message);
      }
    });
  }

  /** Request a local SDP offer for the given session. */
  createOffer(sessionId: string): Promise<string> {
    return this.sendAndAwait<string>({ type: 'createOffer', requestId: requestId(), sessionId });
  }

  /** Request an SDP answer from the given remote offer. */
  createAnswer(sessionId: string, remoteSdp: string): Promise<string> {
    return this.sendAndAwait<string>({ type: 'createAnswer', requestId: requestId(), sessionId, remoteSdp });
  }

  /** Push the remote SDP onto the session; resolves when the peer acknolwedges. */
  setRemote(sessionId: string, remoteSdp: string): Promise<void> {
    return this.sendAndAwait<void>({ type: 'setRemote', requestId: requestId(), sessionId, remoteSdp });
  }

  /** Stop listening for replies; all pending requests reject. */
  unsubscribe(): void {
    if (this.closed) return;
    this.closed = true;
    this.detach();
    this.rejectAll();
  }

  /** Alias for `unsubscribe`; use on worker teardown / port close. */
  close(): void {
    this.unsubscribe();
  }

  private sendAndAwait<T extends string | void>(command: MediaCommand): Promise<T> {
    if (this.closed) {
      return Promise.reject(new Error(`media port closed, cannot send ${command.type}`));
    }
    return new Promise<T>((resolve, reject) => {
      const pending: Pending = {
        // `T` is a cast of the union; replies resolve with an optional SDP string.
        resolve: (value) => resolve(value as T),
        reject,
      };
      this.pending.set(command.requestId, pending);
      try {
        this.port.postMessage(command);
      } catch (error) {
        this.pending.delete(command.requestId);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private handleReply(reply: MediaReply): void {
    const pending = this.pending.get(reply.requestId);
    if (pending === undefined) return;
    this.pending.delete(reply.requestId);
    if (reply.type === 'mediaResult') {
      pending.resolve(reply.sdp);
    } else {
      pending.reject(new Error(reply.message));
    }
  }

  private rejectAll(): void {
    for (const { reject } of this.pending.values()) {
      reject(new Error('media port closed'));
    }
    this.pending.clear();
  }
}
