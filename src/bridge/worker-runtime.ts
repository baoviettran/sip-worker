/**
 * WorkerRuntime: the worker-side half of the worker bridge.
 *
 * It is driven entirely by the supervisor's `bootstrap` command, which carries a
 * serializable RegistrationSnapshot. On bootstrap the runtime stores the
 * generation it answers for, restores registration options/identity/sequence
 * state from the snapshot by handing it to the injected `buildUserAgent`, and
 * performs an ordinary `connect()` + `register()`. The Call-ID and next CSeq
 * therefore reach the wire resumed from the snapshot the supervisor retained and
 * advanced — the replacement never reuses a CSeq.
 *
 * Credentials live only in the recovery snapshot; the runtime never echoes them
 * in events or errors. Calls and dialogs end with the old generation and are the
 * application's to recreate.
 */

import type { UserAgent } from '../ua/user-agent.js';
import type {
  RegistrationSnapshot,
  SupervisorToWorker,
  WorkerRuntimePort,
} from './worker-protocol.js';

/** Redact credentials from any message surfaced by the runtime. */
const REDACTED = '[redacted]';

export interface WorkerRuntimeOptions {
  /** The worker half of the boundary. */
  readonly port: WorkerRuntimePort;
  /**
   * Builds the UA to run in this worker, given the recovery snapshot. A fresh
   * instance per generation; the caller seeds `initialIdentity` from the
   * snapshot's Call-ID and next CSeq so the registration resumes continuity.
   */
  readonly buildUserAgent: (snapshot: RegistrationSnapshot) => UserAgent;
}

/**
 * Worker-side register kernel. Owns one generation of the worker runtime:
 * boots from the bootstrap snapshot, registers through the injected UA, reports
 * readiness/identity, and answers supervisor heartbeats until torn down.
 */
export class WorkerRuntime {
  private readonly port: WorkerRuntimePort;
  private readonly buildUserAgent: (snapshot: RegistrationSnapshot) => UserAgent;
  private readonly detach: () => void;
  private closed = false;
  private generation = 0;
  private registration?: RegistrationSnapshot;
  private registerPromise?: Promise<void>;
  private registerStarted = false;

  constructor(options: WorkerRuntimeOptions) {
    this.port = options.port;
    this.buildUserAgent = options.buildUserAgent;
    this.detach = this.port.subscribe((message: SupervisorToWorker) => {
      this.handleMessage(message);
    });
  }

  /** Resolves when the current generation's registration exchange settles. */
  ready(): Promise<void> {
    return this.registerPromise ?? Promise.resolve();
  }

  /** The recovery snapshot this runtime was bootstrapped with. */
  get bootstrapSnapshot(): RegistrationSnapshot | undefined {
    return this.registration;
  }

  /** Stop answering heartbeats and detach from the port. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.detach();
  }

  private handleMessage(message: SupervisorToWorker): void {
    if (this.closed) return;
    switch (message.type) {
      case 'bootstrap':
        this.generation = message.generation;
        this.registration = message.registration;
        if (!this.registerStarted) {
          this.registerStarted = true;
          // Connect()+register() driven entirely by the bootstrap snapshot.
          this.registerPromise = this.performRegister(message.registration);
        }
        break;
      case 'heartbeatPing':
        this.port.postMessage({
          type: 'heartbeatPong',
          generation: this.generation,
          nonce: message.nonce,
        });
        break;
    }
  }

  private async performRegister(snapshot: RegistrationSnapshot): Promise<void> {
    if (this.closed) return;
    const ua = this.buildUserAgent(snapshot);
    try {
      await ua.connect();
      await ua.register();
    } catch (error) {
      throw this.redact(error);
    }
    this.report(ua);
  }

  /** Report readiness + identity after a successful register. */
  private report(ua: UserAgent): void {
    const gen = this.generation;
    this.port.postMessage({ type: 'ready', generation: gen });
    const identity = ua.identity;
    if (identity !== undefined) {
      this.port.postMessage({
        type: 'registrationIdentity',
        generation: gen,
        callId: identity.callId,
        nextCSeq: identity.nextCSeq,
      });
    }
    this.port.postMessage({ type: 'registered', generation: gen });
  }

  /** Replace credentials with the redaction token in the surfaced error. */
  private redact(error: unknown): Error {
    if (error instanceof Error) {
      if (/password|credentials/i.test(error.message)) {
        const copy = new Error(error.message.replace(/(password|credentials)[^,:;)}"]*/gi, `$1: ${REDACTED}`));
        copy.name = error.name;
        copy.stack = error.stack;
        return copy;
      }
      return error;
    }
    return new Error(String(error));
  }
}
