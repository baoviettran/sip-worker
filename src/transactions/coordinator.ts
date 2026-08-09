import { TransportError } from '../errors.js';
import type { SipMessage, SipRequestMessage, SipResponseMessage } from '../messages/message.js';
import { isRequest } from '../messages/message.js';
import type { Clock, Transport } from '../transport/transport.js';
import type { MessageSink } from '../transport/ingress.js';
import { buildNon2xxAck, MAGIC_COOKIE } from './ack.js';
import { InviteClientTransaction } from './invite-client.js';
import { InviteServerTransaction } from './invite-server.js';
import { NonInviteClientTransaction } from './non-invite-client.js';
import { NonInviteServerTransaction } from './non-invite-server.js';
import type { DerivedTimers, TransactionKey, TransactionLayerEvent } from './types.js';

/** The method a message carries in a syntactically valid CSeq header. */
function cseqMethod(message: SipMessage): string {
  return cseqParts(message)?.method ?? '';
}

interface CSeqParts {
  readonly number: string;
  readonly method: string;
}

function cseqParts(message: SipMessage): CSeqParts | undefined {
  const cseq = message.headers.get('CSeq');
  const match = cseq?.trim().match(/^(\d+)\s+(\S+)$/);
  if (match === undefined || match === null) return undefined;
  return { number: match[1]!, method: match[2]! };
}

/** Extract and normalize the sent-by value from the top Via header. */
function sentByOf(message: SipMessage): string | undefined {
  const via = message.headers.get('Via');
  return via?.match(/^SIP\/2\.0\/[^\s]+\s+([^;\s,]+)/i)?.[1]?.toLowerCase();
}

/** Reject inputs that cannot identify a cookie-based transaction. */
function validateRequestIdentity(request: SipRequestMessage): void {
  const branch = branchOf(request);
  if (branch === undefined || !branch.startsWith(MAGIC_COOKIE)) {
    throw new TransportError('top Via branch must contain the RFC 3261 magic cookie');
  }
  if (sentByOf(request) === undefined) {
    throw new TransportError('top Via must contain a sent-by value');
  }
  const cseq = cseqParts(request);
  if (cseq === undefined || cseq.method !== request.method) {
    throw new TransportError('CSeq must contain a numeric sequence and match the request method');
  }
}

/** Extract the branch parameter from the top Via header. */
export function branchOf(message: SipMessage): string | undefined {
  return message.headers.get('Via')?.match(/;branch=([^;]+)/)?.[1];
}

/** Client transaction key: top Via branch, normalized sent-by, and CSeq method. */
export function clientKey(message: SipMessage): TransactionKey {
  return `${branchOf(message) ?? ''}|${sentByOf(message) ?? ''}|${cseqMethod(message)}`;
}

/** Server key: top Via branch, normalized sent-by, request method, ACK routing to INVITE. */
export function serverKey(request: SipRequestMessage): TransactionKey {
  const method = request.method === 'ACK' ? 'INVITE' : request.method;
  return `${branchOf(request) ?? ''}|${sentByOf(request) ?? ''}|${method}`;
}

export interface TransactionLayerOptions {
  readonly transport: Transport;
  readonly clock: Clock;
  readonly timers: DerivedTimers;
  readonly reliable: boolean;
  readonly emit: (event: TransactionLayerEvent) => void;
}

/**
 * The SIP transaction-layer coordinator (RFC 3261 17).
 *
 * Owns the client/server transaction maps, routes responses to clients and
 * requests to servers, and emits unmatched ACKs as stateless requests for
 * dialog/TU matching. A transaction is inserted into its map before the first
 * transport send so a synchronous response arriving inside `send` is routed to
 * it; entries are removed only after the transaction emits `terminated`.
 */
export class TransactionLayer implements MessageSink {
  private readonly transport: Transport;
  private readonly clock: Clock;
  private readonly timers: DerivedTimers;
  private readonly reliable: boolean;
  private readonly emit: (event: TransactionLayerEvent) => void;
  private readonly clients = new Map<TransactionKey, ClientHandle>();
  private readonly servers = new Map<TransactionKey, ServerHandle>();
  private readonly subscribers = new Set<(event: TransactionLayerEvent) => void>();
  private readonly subscribersByKey = new Map<TransactionKey, Set<(event: TransactionLayerEvent) => void>>();

  constructor(options: TransactionLayerOptions) {
    this.transport = options.transport;
    this.clock = options.clock;
    this.timers = options.timers;
    this.reliable = options.reliable;
    this.emit = options.emit;
  }

  /** Expose the transport for direct sends (e.g. 2xx ACKs that bypass transactions). */
  getTransport(): Transport {
    return this.transport;
  }

  /**
   * Forward a machine event outward, removing the transaction from the map that
   * owns it on termination. Client and server keys can collide (both are
   * `branch|sent-by|method`), so a `terminated` delete must target only the
   * owning map: an INVITE client and an INVITE server on the same key can be
   * live simultaneously, and a dual delete would remove the wrong transaction.
   * The owner is captured at the per-transaction `emit` closure site; an event
   * with no owner (never a `terminated`) deletes nothing.
   */
  private forward(
    event: TransactionLayerEvent,
    owner?: Map<TransactionKey, ClientHandle | ServerHandle>,
  ): void {
    if (event.type === 'terminated' && owner !== undefined) {
      owner.delete(event.key);
    }
    this.emit(event);
    this.emitToSubscribers(event);
  }

  /** Fan out an event to global and transaction-key subscribers, isolating throws. */
  private emitToSubscribers(event: TransactionLayerEvent): void {
    for (const listener of this.subscribers) {
      try {
        listener(event);
      } catch {
        // A throwing subscriber must not break the layer or other listeners.
      }
    }
    const key = event.type === 'response' || event.type === 'request'
      ? event.transaction.key
      : event.type === 'timeout' || event.type === 'transportError' || event.type === 'terminated'
        ? event.key
        : undefined;
    if (key === undefined) return;
    for (const listener of this.subscribersByKey.get(key) ?? []) {
      try {
        listener(event);
      } catch {
        // A throwing subscriber must not break the layer or other listeners.
      }
    }
  }

  /**
   * Subscribe to the transaction-layer event stream the constructor `emit`
   * callback already receives (`response`, `request`, `statelessRequest`,
   * `timeout`, `transportError`, `terminated`). Returns an unsubscribe
   * function; a listener is never called after unsubscribing.
   * Supplying a transaction key delivers only events bearing that key. A key
   * can be shared by concurrent client and server transactions.
   */
  subscribe(listener: (event: TransactionLayerEvent) => void): () => void;
  subscribe(key: TransactionKey, listener: (event: TransactionLayerEvent) => void): () => void;
  subscribe(
    keyOrListener: TransactionKey | ((event: TransactionLayerEvent) => void),
    keyedListener?: (event: TransactionLayerEvent) => void,
  ): () => void {
    if (typeof keyOrListener === 'function') {
      this.subscribers.add(keyOrListener);
      return () => {
        this.subscribers.delete(keyOrListener);
      };
    }
    if (keyedListener === undefined) throw new TypeError('a transaction-key subscription requires a listener');
    const listeners = this.subscribersByKey.get(keyOrListener) ?? new Set<(event: TransactionLayerEvent) => void>();
    listeners.add(keyedListener);
    this.subscribersByKey.set(keyOrListener, listeners);
    return () => {
      listeners.delete(keyedListener);
      if (listeners.size === 0) this.subscribersByKey.delete(keyOrListener);
    };
  }

  /** Send a request, creating and starting the matching client transaction. */
  sendRequest(request: SipRequestMessage): ClientHandle {
    validateRequestIdentity(request);
    const key = clientKey(request);
    const existing = this.clients.get(key);
    if (existing !== undefined) return existing;

    const emit = (event: TransactionLayerEvent): void => this.forward(event, this.clients);

    let tx: ClientHandle;
    if (request.method === 'INVITE') {
      tx = new InviteClientTransaction({
        request, key, transport: this.transport, clock: this.clock,
        timers: this.timers, reliable: this.reliable, emit, buildNon2xxAck,
      });
    } else {
      tx = new NonInviteClientTransaction({
        request, key, transport: this.transport, clock: this.clock,
        timers: this.timers, reliable: this.reliable, emit, buildNon2xxAck,
      });
    }
    this.clients.set(key, tx);
    try {
      tx.start();
    } catch (err) {
      this.clients.delete(key);
      throw err;
    }
    return tx;
  }

  /** Send a response via an existing server transaction. */
  sendResponse(key: TransactionKey, response: SipResponseMessage): void {
    const tx = this.servers.get(key);
    if (tx === undefined) {
      throw new TransportError(`no server transaction found for key: ${key}`);
    }
    tx.sendResponse(response);
  }

  /** Route an incoming message to the correct client or server transaction. */
  receive(message: SipMessage): void {
    if (isRequest(message)) this.receiveRequest(message);
    else this.receiveResponse(message);
  }

  private receiveResponse(response: SipResponseMessage): void {
    const key = clientKey(response);
    const tx = this.clients.get(key);
    if (tx === undefined || tx.state === 'Terminated') {
      // Unmatched or terminated transaction: emit for dialog-level handling (e.g. repeated 2xx)
      const event = { type: 'statelessResponse' as const, response };
      this.emit(event);
      this.emitToSubscribers(event);
      return;
    }
    tx.receive(response);
  }

  private receiveRequest(request: SipRequestMessage): void {
    validateRequestIdentity(request);
    const key = serverKey(request);
    const tx = this.servers.get(key);
    if (tx !== undefined) {
      tx.receiveRequest(request);
      return;
    }
    if (request.method === 'ACK') {
      // Unmatched ACK: no transaction exists. Emit for dialog/TU matching.
      const event = { type: 'statelessRequest' as const, request };
      this.emit(event);
      this.emitToSubscribers(event);
      return;
    }
    this.createServer(request, key);
  }

  private createServer(request: SipRequestMessage, key: TransactionKey): void {
    const emit = (event: TransactionLayerEvent): void => this.forward(event, this.servers);
    let tx: ServerHandle;
    if (request.method === 'INVITE') {
      tx = new InviteServerTransaction({
        request, key, transport: this.transport, clock: this.clock,
        timers: this.timers, reliable: this.reliable, emit,
      });
    } else {
      tx = new NonInviteServerTransaction({
        request, key, transport: this.transport, clock: this.clock,
        timers: this.timers, reliable: this.reliable, emit,
      });
    }
    this.servers.set(key, tx);
    tx.receiveRequest(request);
  }
}

/**
 * The client/server transaction unions as exposed by the layer. The concrete
 * machine classes are structurally compatible, so assignment is safe.
 */
export type ClientHandle = InviteClientTransaction | NonInviteClientTransaction;
export type ServerHandle = InviteServerTransaction | NonInviteServerTransaction;
