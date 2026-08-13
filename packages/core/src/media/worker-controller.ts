import type { Clock } from '../transport/index.js';
import { SipError } from '../errors.js';
import type { MediaMessage, MediaPort, MediaReply, MediaRequestMessage } from './protocol.js';
import { MediaError, MEDIA_ERROR_CODES } from './errors.js';
import type { MediaErrorCode } from './errors.js';

/** Default deadline (ms) for pending media requests when a clock is present. */
const DEFAULT_MEDIA_DEADLINE_MS = 1000;

/**
 * Typed error raised when a pending media request does not receive a reply
 * before its configured deadline. Sanitized: carries no stack/cause beyond the
 * operational message so it crosses the worker boundary cleanly.
 */
export class MediaTimeoutError extends Error {
  readonly code = 'TIMEOUT' as const;
  readonly commandType: string;
  readonly sessionId: string;
  readonly deadlineMs: number;

  constructor(commandType: string, sessionId: string, deadlineMs: number) {
    super(`media ${commandType} for session ${sessionId} timed out after ${deadlineMs}ms`);
    this.name = 'MediaTimeoutError';
    this.commandType = commandType;
    this.sessionId = sessionId;
    this.deadlineMs = deadlineMs;
  }
}

/** Options for bounding pending media requests. */
export interface WorkerMediaControllerOptions {
  /** Clock used to arm per-request deadline timers. */
  readonly clock?: Clock;
  /**
   * Bounded deadline in milliseconds for each pending request. When omitted or
   * non-finite, no deadline is enforced (backwards-compatible with v1).
   */
  readonly deadlineMs?: number;
}

interface Pending {
  readonly sessionId: string;
  readonly commandType: string;
  readonly resolve: (value: string | void) => void;
  readonly reject: (reason: Error) => void;
  /** Deadline timer id, or -1 when no deadline is armed. */
  deadlineTimer: number;
}

let nextRequestId = 0;
function requestId(): string {
  return `media-${++nextRequestId}`;
}

/**
 * Worker-side media controller. Sends `MediaCommand`s on the injected
 * `MediaPort` and correlates `mediaResult`/`mediaError` replies back to the
 * originating promise by requestId. Never touches SIP, Worker, or WebRTC.
 *
 * Each pending request may be bounded by a configurable deadline (inject a
 * `Clock` and `deadlineMs`). When the deadline elapses the request rejects with
 * a typed `MediaTimeoutError` and the timer is cleared. Closing the port or a
 * session cancels every pending request for that scope so callers never hang.
 */
export class WorkerMediaController {
  private readonly pending = new Map<string, Pending>();
  private readonly detach: () => void;
  private closed = false;
  private readonly clock?: Clock;
  private readonly deadlineMs: number;

  constructor(
    private readonly port: MediaPort,
    options?: WorkerMediaControllerOptions,
  ) {
    this.clock = options?.clock;
    const configured = options?.deadlineMs;
    // When a clock is present, bound pending requests by a default deadline so
    // a missing media reply rejects in bounded time. Without a clock no timer
    // can be armed, so unbounded remains the only correct value.
    this.deadlineMs =
      this.clock !== undefined && (configured === undefined || !Number.isFinite(configured))
        ? DEFAULT_MEDIA_DEADLINE_MS
        : configured === undefined || !Number.isFinite(configured)
          ? Number.POSITIVE_INFINITY
          : configured;
    this.detach = this.port.subscribe((message: MediaMessage) => {
      if (message.type === 'mediaResult' || message.type === 'mediaError') {
        this.handleReply(message);
      }
    });
  }

  /**
   * Request a local SDP offer for the given session. When `options.iceRestart`
   * is true the offer asks for a forced ICE restart; omitted (or false) leaves
   * the existing transport in place.
   */
  createOffer(sessionId: string, options?: { iceRestart?: boolean }): Promise<string> {
    const command: MediaRequestMessage = options?.iceRestart
      ? { type: 'createOffer', requestId: requestId(), sessionId, iceRestart: true }
      : { type: 'createOffer', requestId: requestId(), sessionId };
    return this.sendAndAwait<string>(command);
  }

  /** Request an SDP answer from the given remote offer. */
  createAnswer(sessionId: string, remoteSdp: string): Promise<string> {
    return this.sendAndAwait<string>({ type: 'createAnswer', requestId: requestId(), sessionId, remoteSdp });
  }

  /** Push the remote SDP onto the session; resolves when the peer acknolwedges. */
  setRemote(sessionId: string, remoteSdp: string): Promise<void> {
    return this.sendAndAwait<void>({ type: 'setRemote', requestId: requestId(), sessionId, remoteSdp });
  }

  /**
   * Notify the main side that the session is done. Fire-and-forget: no
   * requestId, no reply. Also cancels any pending requests for this session so
   * they reject rather than hang. Safe to call after `close()` (no-op) and
   * idempotent per session.
   */
  closeSession(sessionId: string): void {
    if (this.closed) return;
    this.rejectSession(sessionId, `media session ${sessionId} closed`);
    try {
      this.port.postMessage({ type: 'closeSession', sessionId });
    } catch {
      // The port rejected the close notification; pending state for this
      // session was already cancelled above. Swallow the write failure so a
      // teardown path never throws into the caller.
    }
  }

  /** Stop listening for replies; all pending requests reject. */
  unsubscribe(): void {
    if (this.closed) return;
    this.closed = true;
    this.detach();
    this.rejectAll();
  }

  /**
   * Read-only diagnostic: number of media requests awaiting a reply. Exposed
   * for test observability so lifecycle tests can assert pending state returns
   * to zero. Never mutates controller state.
   */
  get pendingRequestCount(): number {
    return this.pending.size;
  }


  /** Alias for `unsubscribe`; use on worker teardown / port close. */
  close(): void {
    this.unsubscribe();
  }

  private sendAndAwait<T extends string | void>(command: MediaRequestMessage): Promise<T> {
    if (this.closed) {
      return Promise.reject(new SipError(0, `media port closed, cannot send ${command.type}`, 'MEDIA_UNAVAILABLE'));
    }
    return new Promise<T>((resolve, reject) => {
      const pending: Pending = {
        sessionId: command.sessionId,
        commandType: command.type,
        // `T` is a cast of the union; replies resolve with an optional SDP string.
        resolve: (value) => resolve(value as T),
        reject,
        deadlineTimer: -1,
      };
      this.pending.set(command.requestId, pending);
      this.armDeadline(command.requestId, pending);
      try {
        this.port.postMessage(command);
      } catch (error) {
        this.disposePending(command.requestId);
        const cause = error instanceof Error ? error : new Error(String(error));
        reject(new SipError(0, cause.message, 'MEDIA_UNAVAILABLE', { cause }));
      }
    });
  }

  private armDeadline(id: string, pending: Pending): void {
    if (this.clock === undefined || !Number.isFinite(this.deadlineMs)) return;
    const deadlineMs = this.deadlineMs;
    pending.deadlineTimer = this.clock.setTimeout(() => {
      const current = this.pending.get(id);
      if (current === undefined) return;
      this.pending.delete(id);
      current.reject(new MediaTimeoutError(current.commandType, current.sessionId, deadlineMs));
    }, deadlineMs);
  }

  private clearDeadline(pending: Pending): void {
    if (pending.deadlineTimer !== -1 && this.clock !== undefined) {
      this.clock.clearTimeout(pending.deadlineTimer);
      pending.deadlineTimer = -1;
    }
  }

  private handleReply(reply: MediaReply): void {
    const pending = this.pending.get(reply.requestId);
    if (pending === undefined) return;
    this.pending.delete(reply.requestId);
    this.clearDeadline(pending);
    if (reply.type === 'mediaResult') {
      pending.resolve(reply.sdp);
    } else {
      pending.reject(resolveMediaError(reply.code, reply.message, reply.sessionId, pending.commandType));
    }
  }

  private disposePending(id: string): void {
    const pending = this.pending.get(id);
    if (pending === undefined) return;
    this.pending.delete(id);
    this.clearDeadline(pending);
  }

  private rejectAll(): void {
    for (const { reject } of this.pending.values()) {
      reject(new SipError(0, 'media port closed', 'MEDIA_UNAVAILABLE'));
    }
    this.clearAllDeadlines();
    this.pending.clear();
  }

  private rejectSession(sessionId: string, message: string): void {
    for (const [id, pending] of this.pending) {
      if (pending.sessionId !== sessionId) continue;
      this.pending.delete(id);
      this.clearDeadline(pending);
      pending.reject(new SipError(0, message, 'MEDIA_UNAVAILABLE'));
    }
  }

  private clearAllDeadlines(): void {
    if (this.clock === undefined) return;
    for (const pending of this.pending.values()) {
      if (pending.deadlineTimer !== -1) {
        this.clock.clearTimeout(pending.deadlineTimer);
        pending.deadlineTimer = -1;
      }
    }
  }
}

/**
 * Reconstruct a `MediaError` from a coded `mediaError` reply. Codes outside the
 * known set (malformed/out-of-band) collapse to `INTERNAL_ERROR` so the worker
 * side never surfaces an untyped code. No stack, SDP, device, or ICE data is
 * carried across the boundary — only the safe message and normalized code.
 */
function resolveMediaError(
  code: MediaErrorCode,
  message: string,
  sessionId: string,
  operation: string,
): MediaError {
  const normalized: MediaErrorCode = (MEDIA_ERROR_CODES as readonly string[]).includes(code)
    ? code
    : 'INTERNAL_ERROR';
  return new MediaError(normalized, message, sessionId, operation);
}
