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

/** The method a message carries in its CSeq header. */
function cseqMethod(message: SipMessage): string {
  const cseq = message.headers.get('CSeq');
  const parts = cseq === undefined ? [] : cseq.trim().split(/\s+/);
  return parts[parts.length - 1] ?? '';
}

/** Extract the branch parameter from the top Via header. */
export function branchOf(message: SipMessage): string | undefined {
  return message.headers.get('Via')?.match(/;branch=([^;]+)/)?.[1];
}

/** Client transaction key: top Via branch plus CSeq method. */
export function clientKey(message: SipMessage): TransactionKey {
  return `${branchOf(message) ?? ''}|${cseqMethod(message)}`;
}

/** Server transaction key: top Via branch plus request method, ACK routing to INVITE. */
export function serverKey(request: SipRequestMessage): TransactionKey {
  const method = request.method === 'ACK' ? 'INVITE' : request.method;
  return `${branchOf(request) ?? ''}|${method}`;
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

  constructor(options: TransactionLayerOptions) {
    this.transport = options.transport;
    this.clock = options.clock;
    this.timers = options.timers;
    this.reliable = options.reliable;
    this.emit = options.emit;
  }

  /** Forward a machine event outward, removing the transaction from the maps on termination. */
  private forward(event: TransactionLayerEvent): void {
    if (event.type === 'terminated') {
      this.clients.delete(event.key);
      this.servers.delete(event.key);
    }
    this.emit(event);
  }

  /** Send a request, creating and starting the matching client transaction. */
  sendRequest(request: SipRequestMessage): ClientHandle {
    const branch = branchOf(request);
    if (branch === undefined || !branch.startsWith(MAGIC_COOKIE)) {
      throw new TransportError('top Via branch must contain the RFC 3261 magic cookie');
    }
    const key = clientKey(request);
    const existing = this.clients.get(key);
    if (existing !== undefined) return existing;

    const emit = (event: TransactionLayerEvent): void => this.forward(event);

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

  /** Route an incoming message to the correct client or server transaction. */
  receive(message: SipMessage): void {
    if (isRequest(message)) this.receiveRequest(message);
    else this.receiveResponse(message);
  }

  private receiveResponse(response: SipResponseMessage): void {
    const key = clientKey(response);
    const tx = this.clients.get(key);
    if (tx === undefined) return; // unmatched response: drop
    tx.receive(response);
  }

  private receiveRequest(request: SipRequestMessage): void {
    const key = serverKey(request);
    const tx = this.servers.get(key);
    if (tx !== undefined) {
      tx.receiveRequest(request);
      return;
    }
    if (request.method === 'ACK') {
      // Unmatched ACK: no transaction exists. Emit for dialog/TU matching.
      this.emit({ type: 'statelessRequest', request });
      return;
    }
    this.createServer(request, key);
  }

  private createServer(request: SipRequestMessage, key: TransactionKey): void {
    const emit = (event: TransactionLayerEvent): void => this.forward(event);
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