/**
 * UserAgent: wires Transport, SipIngress, TransactionLayer, and Registrar.
 *
 * Construction order (brief Step 3):
 * 1. connect() connects transport
 * 2. Creates TransactionLayer from transport+clock+reliable
 * 3. Creates SipIngress and starts it
 * 4. Creates Registrar (now operations are enabled)
 *
 * Incoming transport disconnect:
 * - Stops ingress
 * - Calls registrar.onTransportDisconnected() (cancels refresh)
 * - Marks reconnect pending
 *
 * disconnect():
 * - Unsubscribes listeners/timers exactly once
 */

import type { Transport, Clock } from '../transport/index.js';
import { SipIngress } from '../transport/index.js';
import type { MessageSink } from '../transport/ingress.js';
import { SipError } from '../errors.js';
import { TransactionLayer, deriveTimers, DEFAULT_TIMERS } from '../transactions/index.js';
import type { TransactionLayerEvent } from '../transactions/types.js';
import { Registrar } from './registrar.js';
import type { RegistrarOptions } from './registrar.js';
import type { RegistrationIdentity, RegisterState } from './registration-types.js';
import { AuthManager, type IdGenerator } from '../auth/manager.js';
import { TypedEventEmitter } from './events.js';
import type { RegistrationEventEmitter } from './events.js';
import { Inviter } from './inviter.js';
import type { SessionEvent } from './session.js';
import { Invitation } from './invitation.js';
import type { WorkerMediaController } from '../media/worker-controller.js';
import type { LivenessStrategy } from '../reliability/index.js';
import { OptionsLiveness } from '../reliability/index.js';
import { Headers, makeRequest, makeResponse } from '../messages/index.js';
import type { SipRequestMessage, SipResponseMessage } from '../messages/message.js';
import { extractTag, makeBranch } from '../dialogs/header-values.js';
import { requestDialogId } from '../dialogs/dialog.js';

/** Default SIP OPTIONS probe cadence for the built-in browser-safe strategy. */
const OPTIONS_PROBE_INTERVAL_MS = 30000;

type DialogOwner = Inviter | Invitation;

function initialInviteId(request: SipRequestMessage): string | undefined {
  if (request.method !== 'INVITE' && request.method !== 'CANCEL') return undefined;
  const cseq = request.headers.get('CSeq')?.trim().match(/^(\d+)\s+(\S+)$/);
  const callId = request.headers.get('Call-ID');
  const remoteTag = extractTag(request.headers.get('From'));
  const localTag = extractTag(request.headers.get('To'));
  if (cseq === undefined || cseq === null || cseq[2] !== request.method) return undefined;
  if (callId === undefined || callId === '' || remoteTag === undefined) return undefined;
  return JSON.stringify([callId, remoteTag, localTag ?? '', cseq[1]]);
}


export interface UserAgentOptions {
  readonly transport: Transport;
  readonly clock: Clock;
  readonly registrarUri: string;
  readonly aor: string;
  readonly contact: string;
  readonly credentials?: { readonly username: string; readonly password: string };
  readonly idGenerator: IdGenerator;
  readonly authManager?: AuthManager;
  readonly refreshFraction?: number;
  readonly mediaController?: WorkerMediaController;
  /** Via sent-by host:port. Defaults to '192.0.2.1:5060'. */
  readonly viaAddress?: string;
  /**
   * Optional injected liveness strategy. Defaults to a SIP OPTIONS strategy
   * (browser-safe) when absent. A Node composition root that exposes a native
   * Ping/Pong socket supplies `new NodeWebSocketLiveness(...)` here instead.
   */
  readonly liveness?: LivenessStrategy;
  /** Optional recovery identity (Call-ID + next CSeq) to resume. */
  readonly initialIdentity?: RegistrationIdentity;
}

export class UserAgent extends TypedEventEmitter implements RegistrationEventEmitter {
  private readonly transport: Transport;
  private readonly clock: Clock;
  private readonly options: UserAgentOptions;
  private layer?: TransactionLayer;
  private ingress?: SipIngress;
  private registrar?: Registrar;
  private transportUnsubscribe?: () => void;
  private connecting = false;
  private connected = false;
  private disconnected = false;
  private shutdownError?: SipError;
  private readonly ownerSessionUnsubscribers = new Map<DialogOwner, () => void>();
  private activeInviter?: Inviter;
  private activeInvitations = new Map<string, Invitation>();
  private dialogOwners = new Map<string, DialogOwner>();
  private liveness?: LivenessStrategy;

  constructor(options: UserAgentOptions) {
    super();
    this.transport = options.transport;
    this.clock = options.clock;
    this.options = options;
  }

  /** Current registration state. */
  get registerState(): RegisterState {
    return this.registrar?.state ?? 'unregistered';
  }

  /** Registration identity snapshot (Call-ID + next CSeq) for recovery. */
  get identity(): RegistrationIdentity | undefined {
    const status = this.registrar?.status();
    if (status === undefined) return undefined;
    return { callId: status.callId, nextCSeq: status.nextCSeq };
  }

  /** Current call state (for outgoing calls). */
  get callState(): string {
    if (this.activeInviter !== undefined) {
      return this.activeInviter.session.state;
    }
    return 'idle';
  }

  /** Via sent-by host:port for all SIP requests this UA originates. */
  private get viaAddress(): string {
    return this.options.viaAddress ?? '192.0.2.1:5060';
  }

  /** Reject public work as soon as final shutdown begins, including re-entrant callbacks. */
  private assertOperational(): void {
    if (this.disconnected) {
      throw this.shutdownError ?? new SipError(0, 'UserAgent disconnected');
    }
  }

  /**
   * Connect the transport and wire up the transaction layer, ingress, and registrar.
   * Construction order: transport → coordinator → ingress → registrar.
   */
  async connect(): Promise<void> {
    if (this.disconnected) {
      throw new Error('UserAgent has been disconnected');
    }
    if (this.connected) return;

    this.connecting = true;
    try {
      await this.transport.connect();
    } catch (error) {
      if (this.disconnected) {
        throw this.shutdownError ?? new SipError(0, 'UserAgent disconnected');
      }
      throw error;
    } finally {
      this.connecting = false;
    }
    if (this.disconnected) {
      const error = this.shutdownError ?? new SipError(0, 'UserAgent disconnected');
      await this.transport.disconnect();
      throw error;
    }
    this.connected = true;

    // Create the transaction layer
    const reliable = this.transport.capabilities.reliable;
    const timers = deriveTimers(DEFAULT_TIMERS, reliable);
    this.layer = new TransactionLayer({
      transport: this.transport,
      clock: this.clock,
      timers,
      reliable,
      emit: (event: TransactionLayerEvent) => this.handleTransactionEvent(event),
    });

    // Create and start ingress (routes incoming messages to the layer)
    this.ingress = new SipIngress(this.transport, this.layer as MessageSink, (error) => {
      this.emit('failed', { type: 'failed', error, identity: this.identity ?? { callId: '', nextCSeq: 1 } });
    });
    this.ingress.start();

    // Subscribe to transport events
    this.transportUnsubscribe = this.transport.subscribe((event) => {
      if (event.type === 'disconnected') {
        this.onTransportDisconnected();
      } else if (event.type === 'connected') {
        this.onTransportReconnected();
      }
    });

    // Create the registrar (now operations are enabled)
    const authManager = this.options.authManager ??
      (this.options.credentials ? new AuthManager(this.options.idGenerator) : undefined);

    const registrarOptions: RegistrarOptions = {
      registrarUri: this.options.registrarUri,
      aor: this.options.aor,
      contact: this.options.contact,
      credentials: this.options.credentials,
      idGenerator: this.options.idGenerator,
      layer: this.layer,
      clock: this.clock,
      authManager,
      refreshFraction: this.options.refreshFraction,
      initialIdentity: this.options.initialIdentity,
    };
    this.registrar = new Registrar(registrarOptions);

    // Start liveness only once the transport is connected and all layers are
    // wired. Injecting an explicit strategy (e.g. NodeWebSocketLiveness) wins;
    // the default is a browser-safe SIP OPTIONS strategy.
    this.liveness?.stop();
    this.liveness = this.options.liveness ?? this.buildOptionsLiveness();
    this.liveness.start();
  }

  /** Register against the registrar. */
  async register(): Promise<void> {
    this.assertOperational();
    if (this.registrar === undefined) {
      throw new Error('UserAgent not connected');
    }
    const previousState = this.registerState;
    try {
      await this.registrar.register();
      if (this.registerState !== previousState) {
        this.emit('stateChanged', {
          type: 'stateChanged',
          state: this.registerState,
          identity: this.identity!,
        });
      }
    } catch (error) {
      this.emit('failed', {
        type: 'failed',
        error: error instanceof Error ? error : new Error(String(error)),
        identity: this.identity!,
      });
      throw error;
    }
  }

  /** Unregister from the registrar. */
  async unregister(): Promise<void> {
    this.assertOperational();
    if (this.registrar === undefined) {
      throw new Error('UserAgent not connected');
    }
    const previousState = this.registerState;
    try {
      await this.registrar.unregister();
      if (this.registerState !== previousState) {
        this.emit('stateChanged', {
          type: 'stateChanged',
          state: this.registerState,
          identity: this.identity!,
        });
      }
    } catch (error) {
      this.emit('failed', {
        type: 'failed',
        error: error instanceof Error ? error : new Error(String(error)),
        identity: this.identity!,
      });
      throw error;
    }
  }

  /** Initiate an outgoing call to the specified target URI. */
  async invite(target: string): Promise<void> {
    this.assertOperational();
    if (this.layer === undefined) {
      throw new Error('UserAgent not connected');
    }
    if (this.activeInviter !== undefined) {
      throw new Error('Call already in progress');
    }

    const mediaController = this.options.mediaController;
    if (mediaController === undefined) {
      throw new Error('Media controller not configured');
    }

    const inviter = new Inviter({
      to: target,
      from: this.options.aor,
      contact: this.options.contact,
      viaAddress: this.viaAddress,
      idGenerator: this.options.idGenerator,
      layer: this.layer,
      clock: this.clock,
      controller: mediaController,
      authManager: this.options.authManager,
      credentials: this.options.credentials,
      onDialogCreated: (dialog) => {
        if (!this.disconnected) this.dialogOwners.set(dialog.id, inviter);
      },
    });

    // Listen to session state changes
    const sessionListener = (event: SessionEvent): void => {
      this.emit('stateChanged', {
        type: 'stateChanged',
        state: event.state,
        identity: this.identity!,
      });
      const terminal = event.state === 'terminated' || event.state === 'failed';
      if (terminal && this.activeInviter === inviter) {
        this.activeInviter = undefined;
      }
      const dialog = inviter.dialog;
      if (terminal
        && dialog !== undefined && this.dialogOwners.get(dialog.id) === inviter) {
        this.dialogOwners.delete(dialog.id);
      }
      if (terminal) this.detachOwnerSession(inviter);
    };
    inviter.session.on(sessionListener);
    this.ownerSessionUnsubscribers.set(inviter, () => inviter.session.off(sessionListener));

    this.activeInviter = inviter;
    await inviter.invite();
  }

  /** Terminate the active call with BYE. */
  async bye(): Promise<void> {
    this.assertOperational();
    if (this.activeInviter === undefined) {
      throw new Error('No active call');
    }
    await this.activeInviter.hangup();
    this.activeInviter = undefined;
  }

  /** Disconnect the transport and clean up all listeners/timers. */
  async disconnect(): Promise<void> {
    if (this.disconnected) return;
    const error = new SipError(0, 'UserAgent disconnected');
    this.shutdownError = error;
    this.disconnected = true;

    // Stop liveness before tearing down the transport.
    this.liveness?.stop();
    this.liveness = undefined;

    // Stop ingress
    this.ingress?.stop();
    this.ingress = undefined;

    // Unsubscribe transport listener
    this.transportUnsubscribe?.();
    this.transportUnsubscribe = undefined;

    // Settle and release operation owners before closing the transport. Session
    // transitions synchronously remove their indexed ownership; the explicit
    // clears below make shutdown complete even for already-terminal owners.
    this.registrar?.dispose(error);
    const owners = new Set<DialogOwner>(this.dialogOwners.values());
    if (this.activeInviter !== undefined) owners.add(this.activeInviter);
    for (const invitation of this.activeInvitations.values()) owners.add(invitation);
    for (const owner of owners) owner.dispose(error);
    this.activeInviter = undefined;
    for (const detach of this.ownerSessionUnsubscribers.values()) detach();
    this.ownerSessionUnsubscribers.clear();
    this.activeInvitations.clear();
    this.dialogOwners.clear();

    // Disconnect transport
    if (this.connected || this.connecting) {
      await this.transport.disconnect();
      this.connected = false;
    }

    // Clear references
    this.layer = undefined;
    this.registrar = undefined;
  }

  /** Handle transport disconnect: stop ingress, cancel refresh, mark reconnect pending. */
  private onTransportDisconnected(): void {
    this.ingress?.stop();
    this.registrar?.onTransportDisconnected();
    // Note: we don't set this.connected = false here because the transport
    // might reconnect. The UA tracks its own lifecycle separately.
  }

  /** Handle transport reconnect: restart ingress, notify registrar. */
  private onTransportReconnected(): void {
    this.ingress?.start();
    this.registrar?.onTransportConnected();
  }

  /**
   * Build the default browser-safe OPTIONS liveness strategy. Each probe carries
   * a fresh Via branch and a strictly increasing CSeq on a stable Call-ID, sent
   * through the connected transaction layer. Any final response proves liveness;
   * a timeout or transport error is reported as a typed failure.
   */
  private buildOptionsLiveness(): LivenessStrategy {
    const layer = this.layer;
    if (layer === undefined) {
      throw new Error('UserAgent is not connected');
    }
    // A stable OPTIONS Call-ID lets a peer deduplicate repeated probes; only the
    // Via branch and CSeq change per probe. Derive it once for the strategy's life.
    const optionsCallId = `ua-opt-${this.options.idGenerator.branch()}`;
    const requestFactory = (index: number) => {
      const headers = new Headers();
      headers.set('Via', `SIP/2.0/UDP ${this.viaAddress};branch=${makeBranch(`opt-${index}`)}`);
      headers.set('Max-Forwards', '70');
      headers.set('From', `<${this.options.aor}>;tag=ua-opt`);
      headers.set('To', `<${this.options.registrarUri}>`);
      headers.set('Call-ID', optionsCallId);
      headers.set('CSeq', `${index} OPTIONS`);
      return makeRequest('OPTIONS', this.options.registrarUri, headers);
    };
    return new OptionsLiveness({
      layer,
      clock: this.clock,
      requestFactory,
      probeIntervalMs: OPTIONS_PROBE_INTERVAL_MS,
      onFailure: (error) => this.emit('failed', {
        type: 'failed',
        error,
        identity: this.identity ?? { callId: '', nextCSeq: 1 },
      }),
    });
  }

  /** Forward transaction layer events (for future dialog/invite handling). */
  private handleTransactionEvent(event: TransactionLayerEvent): void {
    if (event.type === 'statelessRequest') {
      const ownerId = requestDialogId(event.request);
      const owner = ownerId === undefined ? undefined : this.dialogOwners.get(ownerId);
      if (owner instanceof Invitation) owner.handleStatelessRequest(event.request);
      return;
    }
    if (event.type !== 'request') return;
    if (event.request.method === 'INVITE' && extractTag(event.request.headers.get('To')) === undefined) {
      this.handleIncomingInvite(event.request, event.transaction);
      return;
    }
    if (event.request.method === 'CANCEL') {
      const inviteId = initialInviteId(event.request);
      const invitation = inviteId === undefined ? undefined : this.activeInvitations.get(inviteId);
      if (invitation !== undefined) {
        invitation.handleIncomingRequest(event.transaction, event.request);
        return;
      }
      this.layer?.sendResponse(
        event.transaction.key,
        this.requestResponse(event.request, 481, 'Call/Transaction Does Not Exist'),
      );
      return;
    }

    const ownerId = requestDialogId(event.request);
    const owner = ownerId === undefined ? undefined : this.dialogOwners.get(ownerId);
    if (owner !== undefined) {
      owner.handleIncomingRequest(event.transaction, event.request);
      return;
    }
    if (extractTag(event.request.headers.get('To')) !== undefined) {
      this.layer?.sendResponse(
        event.transaction.key,
        this.requestResponse(event.request, 481, 'Call/Transaction Does Not Exist'),
      );
    }
  }

  private requestResponse(request: SipRequestMessage, statusCode: number, reason: string): SipResponseMessage {
    const headers = new Headers();
    headers.set('Via', request.headers.get('Via') ?? '');
    headers.set('From', request.headers.get('From') ?? '');
    headers.set('To', request.headers.get('To') ?? '');
    headers.set('Call-ID', request.headers.get('Call-ID') ?? '');
    headers.set('CSeq', request.headers.get('CSeq') ?? '');
    return makeResponse(statusCode, reason, headers);
  }

  private detachOwnerSession(owner: DialogOwner): void {
    const detach = this.ownerSessionUnsubscribers.get(owner);
    if (detach === undefined) return;
    this.ownerSessionUnsubscribers.delete(owner);
    detach();
  }

  /** Handle an incoming INVITE request. */
  private handleIncomingInvite(
    request: import('../messages/message.js').SipRequestMessage,
    transaction: import('../transactions/types.js').ServerTransaction
  ): void {
    const inviteId = initialInviteId(request);
    if (inviteId === undefined) {
      this.layer?.sendResponse(transaction.key, this.requestResponse(request, 400, 'Bad Request'));
      return;
    }
    const existing = this.activeInvitations.get(inviteId);
    if (existing !== undefined) {
      existing.handleDuplicateInvite(transaction, request);
      return;
    }
    const mediaController = this.options.mediaController;
    if (mediaController === undefined) {
      console.warn('Media controller not configured, rejecting incoming call');
      return;
    }

    let invitation!: Invitation;
    invitation = new Invitation({
      request,
      transaction,
      contact: this.options.contact,
      viaAddress: this.viaAddress,
      idGenerator: this.options.idGenerator,
      layer: this.layer!,
      clock: this.clock,
      controller: mediaController,
      T1: 500,
      T2: 4000,
      onDialogCreated: (dialog) => {
        if (!this.disconnected) this.dialogOwners.set(dialog.id, invitation);
      },
    });
    this.activeInvitations.set(inviteId, invitation);

    // Listen to session state changes
    const sessionListener = (event: SessionEvent): void => {
      this.emit('stateChanged', {
        type: 'stateChanged',
        state: event.state,
        identity: this.identity!,
      });

      // Clean up when terminated
      if (event.state === 'terminated' || event.state === 'failed') {
        if (this.activeInvitations.get(inviteId) === invitation) {
          this.activeInvitations.delete(inviteId);
        }
        const dialog = invitation.dialog;
        if (dialog !== undefined && this.dialogOwners.get(dialog.id) === invitation) {
          this.dialogOwners.delete(dialog.id);
        }
        this.detachOwnerSession(invitation);
      }
    };
    invitation.session.on(sessionListener);
    this.ownerSessionUnsubscribers.set(invitation, () => invitation.session.off(sessionListener));

    this.emit('incomingCall', invitation);
  }
}
