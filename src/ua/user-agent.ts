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
import type { AuthManager, IdGenerator } from '../auth/manager.js';
import { TypedEventEmitter } from './events.js';
import type { RegistrationEventEmitter } from './events.js';

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

    // Subscribe to transport disconnect events
    this.transportUnsubscribe = this.transport.subscribe((event) => {
      if (event.type === 'disconnected') {
        this.onTransportDisconnected();
      }
    });

    // Create the registrar (now operations are enabled)
    const registrarOptions: RegistrarOptions = {
      registrarUri: this.options.registrarUri,
      aor: this.options.aor,
      contact: this.options.contact,
      credentials: this.options.credentials,
      idGenerator: this.options.idGenerator,
      layer: this.layer,
      clock: this.clock,
      authManager: this.options.authManager,
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

  /** Forward transaction layer events (for future dialog/invite handling). */
  private handleTransactionEvent(_event: TransactionLayerEvent): void {
    // Currently a no-op; future phases will handle INVITE/dialog events here.
  }
}
