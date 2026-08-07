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
import type { LivenessStrategy } from '../reliability/index.js';
import { OptionsLiveness } from '../reliability/index.js';
import { Headers, makeRequest } from '../messages/index.js';
import { makeBranch } from '../dialogs/header-values.js';

/** Default SIP OPTIONS probe cadence for the built-in browser-safe strategy. */
const OPTIONS_PROBE_INTERVAL_MS = 30000;


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
  private connected = false;
  private disconnected = false;
  private activeInviter?: Inviter;
  private activeInvitations = new Map<string, Invitation>();
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

    // Stop liveness before tearing down the transport.
    this.liveness?.stop();
    this.liveness = undefined;

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
      headers.set('Via', `SIP/2.0/UDP 192.0.2.1:5060;branch=${makeBranch(`opt-${index}`)}`);
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
