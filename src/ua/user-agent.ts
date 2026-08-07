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
import { TransactionLayer, deriveTimers, DEFAULT_TIMERS } from '../transactions/index.js';
import type { TransactionLayerEvent } from '../transactions/types.js';
import { Registrar } from './registrar.js';
import type { RegistrarOptions } from './registrar.js';
import type { RegistrationIdentity, RegisterState } from './registration-types.js';
import { AuthManager, type IdGenerator } from '../auth/manager.js';
import { TypedEventEmitter } from './events.js';
import type { RegistrationEventEmitter } from './events.js';
import { Inviter } from './inviter.js';
import { Invitation } from './invitation.js';
import type { WorkerMediaController } from '../media/worker-controller.js';

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
}

export class UserAgent extends TypedEventEmitter implements RegistrationEventEmitter {
  private readonly transport: Transport;
  private readonly clock: Clock;
  private readonly options: UserAgentOptions;
  private layer?: TransactionLayer;
  private ingress?: SipIngress;
  private registrar?: Registrar;
  private transportUnsubscribe?: () => void;
  private connected = false;
  private disconnected = false;
  private activeInviter?: Inviter;
  private activeInvitations = new Map<string, Invitation>();

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

  /**
   * Connect the transport and wire up the transaction layer, ingress, and registrar.
   * Construction order: transport → coordinator → ingress → registrar.
   */
  async connect(): Promise<void> {
    if (this.disconnected) {
      throw new Error('UserAgent has been disconnected');
    }
    if (this.connected) return;

    await this.transport.connect();
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
    };
    this.registrar = new Registrar(registrarOptions);
  }

  /** Register against the registrar. */
  async register(): Promise<void> {
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
      viaAddress: '192.0.2.1:5060', // TODO: extract from transport
      idGenerator: this.options.idGenerator,
      layer: this.layer,
      clock: this.clock,
      controller: mediaController,
      authManager: this.options.authManager,
      credentials: this.options.credentials,
    });

    // Listen to session state changes
    inviter.session.on((event) => {
      this.emit('stateChanged', {
        type: 'stateChanged',
        state: event.state,
        identity: this.identity!,
      });
    });

    this.activeInviter = inviter;
    await inviter.invite();
  }

  /** Terminate the active call with BYE. */
  async bye(): Promise<void> {
    if (this.activeInviter === undefined) {
      throw new Error('No active call');
    }
    await this.activeInviter.hangup();
    this.activeInviter = undefined;
  }

  /** Disconnect the transport and clean up all listeners/timers. */
  async disconnect(): Promise<void> {
    if (this.disconnected) return;
    this.disconnected = true;

    // Stop ingress
    this.ingress?.stop();
    this.ingress = undefined;

    // Unsubscribe transport listener
    this.transportUnsubscribe?.();
    this.transportUnsubscribe = undefined;

    // Disconnect transport
    if (this.connected) {
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

  /** Forward transaction layer events (for future dialog/invite handling). */
  private handleTransactionEvent(event: TransactionLayerEvent): void {
    if (event.type === 'request' && event.request.method === 'INVITE') {
      this.handleIncomingInvite(event.request, event.transaction);
    }
  }

  /** Handle an incoming INVITE request. */
  private handleIncomingInvite(
    request: import('../messages/message.js').SipRequestMessage,
    transaction: import('../transactions/types.js').ServerTransaction
  ): void {
    const mediaController = this.options.mediaController;
    if (mediaController === undefined) {
      console.warn('Media controller not configured, rejecting incoming call');
      return;
    }

    const invitation = new Invitation({
      request,
      transaction,
      contact: this.options.contact,
      viaAddress: '192.0.2.1:5060', // TODO: extract from transport
      idGenerator: this.options.idGenerator,
      layer: this.layer!,
      clock: this.clock,
      controller: mediaController,
      T1: 500,
      T2: 4000,
    });

    const callId = request.headers.get('Call-ID') ?? '';
    this.activeInvitations.set(callId, invitation);

    // Listen to session state changes
    invitation.session.on((event) => {
      this.emit('stateChanged', {
        type: 'stateChanged',
        state: event.state,
        identity: this.identity!,
      });

      // Clean up when terminated
      if (event.state === 'terminated' || event.state === 'failed') {
        this.activeInvitations.delete(callId);
      }
    });

    this.emit('incomingCall', invitation);
  }
}
