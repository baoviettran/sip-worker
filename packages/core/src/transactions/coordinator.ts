import { TransportError } from '../errors.js';
import type { SipMessage, SipRequestMessage, SipResponseMessage } from '../messages/message.js';
import { isRequest } from '../messages/message.js';
import { responseMatchesRequestIdentity } from '../ua/response-identity.js';
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

interface TopViaIdentity {
  readonly branch?: string;
  readonly sentBy?: string;
}

/** Split a header list at separators outside quoted-string values. */
function splitOutsideQuotes(value: string, separator: string): string[] {
  const values: string[] = [];
  let start = 0;
  let quoted = false;
  let escaped = false;

  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quoted && character === '\\') {
      escaped = true;
      continue;
    }
    if (character === '"') {
      quoted = !quoted;
      continue;
    }
    if (!quoted && character === separator) {
      values.push(value.slice(start, index));
      start = index + 1;
    }
  }
  values.push(value.slice(start));
  return values;
}

/** Extract the first (topmost) Via value from the first Via header field. */
function topViaOf(message: SipMessage): string | undefined {
  const value = message.headers.get('Via');
  if (value === undefined) return undefined;
  return splitOutsideQuotes(value, ',')[0]?.trim();
}

/** Parse RFC separator whitespace while retaining strict branch token validation. */
function topViaIdentity(message: SipMessage): TopViaIdentity | undefined {
  const via = topViaOf(message);
  if (via === undefined) return undefined;
  const protocol = via.match(/^SIP\s*\/\s*2\.0\s*\/\s*[!#$%&'*+\-.^_`|~0-9A-Za-z]+\s+/i);
  if (protocol === null) return undefined;

  const remainder = via.slice(protocol[0].length);
  const parameterStart = remainder.indexOf(';');
  const sentByRaw = (parameterStart === -1 ? remainder : remainder.slice(0, parameterStart))
    .trim()
    .replace(/\s*:\s*/g, ':');
  const sentBy = sentByRaw === '' || /[\s,]/.test(sentByRaw) ? undefined : sentByRaw;
  if (sentBy === undefined) return undefined;

  let branch: string | undefined;
  const parameters = parameterStart === -1 ? '' : remainder.slice(parameterStart + 1);
  for (const parameter of splitOutsideQuotes(parameters, ';')) {
    const match = parameter.trim().match(/^branch\s*=\s*([!#$%&'*+\-.^_`|~0-9A-Za-z]+)\s*$/i);
    if (match === null) continue;
    branch = match[1];
    break;
  }
  return { branch, sentBy };
}

/** Extract and normalize the sent-by value from the top Via header. */
function sentByOf(message: SipMessage): string | undefined {
  return topViaIdentity(message)?.sentBy?.toLowerCase();
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
  return topViaIdentity(message)?.branch;
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
  private readonly clientSubscribersByKey = new Map<TransactionKey, Set<(event: TransactionLayerEvent) => void>>();
  private readonly serverSubscribersByKey = new Map<TransactionKey, Set<(event: TransactionLayerEvent) => void>>();
  private readonly transportUnsubscribe?: () => void;
  private disposed = false;

  constructor(options: TransactionLayerOptions) {
    this.transport = options.transport;
    this.clock = options.clock;
    this.timers = options.timers;
    this.reliable = options.reliable;
    this.emit = options.emit;
    // Own the transport subscription so a loss fans a typed terminal error to
    // every active transaction, and so it is released exactly once on dispose.
    this.transportUnsubscribe = this.transport.subscribe((event) => {
      if (event.type === 'disconnected') this.onTransportDisconnected(event.error);
    });
  }

  /** Expose the transport for direct sends (e.g. 2xx ACKs that bypass transactions). */
  getTransport(): Transport {
    return this.transport;
  }

  /**
   * Terminate every owned transaction (with a typed transport error when one is
   * supplied) and release all layer subscriptions.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.transportUnsubscribe?.();
    try {
      for (const transaction of [...this.clients.values()]) {
        try {
          transaction.terminate();
        } catch {
          // Continue terminating other transactions if an observer throws.
        }
      }
      for (const transaction of [...this.servers.values()]) {
        try {
          transaction.terminate();
        } catch {
          // Continue terminating other transactions if an observer throws.
        }
      }
    } finally {
      this.clients.clear();
      this.servers.clear();
      this.subscribers.clear();
      this.subscribersByKey.clear();
      this.clientSubscribersByKey.clear();
      this.serverSubscribersByKey.clear();
    }
  }

  /**
   * Transport loss: fan a typed terminal error to every active transaction so
   * they fail observably (RFC 3261 transport failure → terminate). Unlike
   * `dispose()`, this does NOT mark the layer disposed or clear subscriptions,
   * so a later reconnect can create and route new transactions (the UA owns
   * reconnection). Terminated transactions delete themselves from their maps
   * via the normal `terminated` forward.
   */
  private onTransportDisconnected(error?: TransportError): void {
    if (this.disposed) return;
    const terminalError = error ?? new TransportError('transport disconnected');
    for (const transaction of [...this.clients.values()]) {
      try {
        transaction.terminate(terminalError);
      } catch {
        // Continue terminating other transactions if an observer throws.
      }
    }
    for (const transaction of [...this.servers.values()]) {
      try {
        transaction.terminate(terminalError);
      } catch {
        // Continue terminating other transactions if an observer throws.
      }
    }
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
    this.emitToSubscribers(event, owner);
  }

  /** Fan out an event to global and transaction-key subscribers, isolating throws. */
  private emitToSubscribers(
    event: TransactionLayerEvent,
    owner?: Map<TransactionKey, ClientHandle | ServerHandle>,
  ): void {
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
    const directional = owner === this.clients
      ? this.clientSubscribersByKey
      : owner === this.servers ? this.serverSubscribersByKey : undefined;
    if (directional === undefined) return;
    for (const listener of directional.get(key) ?? []) {
      try {
        listener(event);
      } catch {
        // A throwing directional subscriber must not break the layer or others.
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

  /**
   * Subscribe only to events emitted by the client transaction with `key`.
   * Server events are excluded even when a server transaction shares the key.
   */
  subscribeClient(key: TransactionKey, listener: (event: TransactionLayerEvent) => void): () => void {
    const listeners = this.clientSubscribersByKey.get(key)
      ?? new Set<(event: TransactionLayerEvent) => void>();
    listeners.add(listener);
    this.clientSubscribersByKey.set(key, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.clientSubscribersByKey.delete(key);
    };
  }

  /**
   * Subscribe only to events emitted by the server transaction with `key`.
   * Client events are excluded even when a client transaction shares the key.
   */
  subscribeServer(key: TransactionKey, listener: (event: TransactionLayerEvent) => void): () => void {
    const listeners = this.serverSubscribersByKey.get(key)
      ?? new Set<(event: TransactionLayerEvent) => void>();
    listeners.add(listener);
    this.serverSubscribersByKey.set(key, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.serverSubscribersByKey.delete(key);
    };
  }

  /** Send a request, creating and starting the matching client transaction. */
  sendRequest(request: SipRequestMessage): ClientHandle {
    if (this.disposed) {
      throw new TransportError('transaction layer has been disposed');
    }
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

  /**
   * Send a response via an existing server transaction, settling with THAT exact
   * send. The server transaction commits its state before the transport send, so
   * a rejected promise reflects a failed wire send while the transaction state is
   * authoritative. Use this for application-level settlement (e.g. an
   * awaitable `Invitation.reject()`).
   */
  sendResponseAwait(key: TransactionKey, response: SipResponseMessage): Promise<void> {
    if (this.disposed) {
      return Promise.reject(new TransportError('transaction layer has been disposed'));
    }
    const tx = this.servers.get(key);
    if (tx === undefined) {
      return Promise.reject(new TransportError(`no server transaction found for key: ${key}`));
    }
    return tx.sendResponseAwait(response);
  }

  /**
   * Compatibility wrapper over `sendResponseAwait` (void return). Consumes any
   * rejection so callers that only observe state never see an unhandled
   * rejection, while still emitting the canonical transport error through the
   * server transaction. Never double-emits: a single send produces a single
   * transportError.
   */
  sendResponse(key: TransactionKey, response: SipResponseMessage): void {
    void this.sendResponseAwait(key, response).catch((error: unknown) => {
      if (error instanceof TransportError) return;
      // Swallow the rest: a synchronous throw is surfaced as a transportError by
      // the transaction, and a non-100 provisional on a non-INVITE is rejected
      // by the RFC 4320 guard without a wire send (nothing to surface).
    });
  }

  /** Route an incoming message to the correct client or server transaction. */
  receive(message: SipMessage): void {
    if (this.disposed) return;
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
    if (!responseMatchesRequestIdentity(tx.request, response)) return;
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
