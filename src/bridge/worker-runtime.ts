/**
 * WorkerRuntime: the worker-side half of the worker bridge.
 *
 * It receives a `bootstrap` command carrying a serializable RegistrationSnapshot,
 * restores the registration options, the identity (stable Call-ID + next CSeq),
 * and the sequence state from that snapshot, then performs an ordinary
 * `connect()` + `register()` on an injected `UserAgent`. It echoes the bootstrapped
 * `generation` in every reply so the supervisor can correlate messages to its
 * own generation counter.
 *
 * Credentials live only in the recovery snapshot; the runtime never echoes them
 * in events or errors. Calls and dialogs end with the old generation and are the
 * application's to recreate.
 */

import type { Clock } from '../transport/index.js';
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
  readonly clock: Clock;
  /**
   * Builds the UA to run in this worker, given the recovery snapshot. A fresh
   * instance per generation; the caller seeds `initialIdentity` from the
   * snapshot's Call-ID and next CSeq so the registration resumes continuity.
   */
  readonly buildUserAgent: (snapshot: RegistrationSnapshot) => UserAgent;
}

/**
 * Worker-side register kernel. Owns one generation of the worker runtime:
 * boots from a snapshot, registers through the injected UA, and answers
 * supervisor heartbeats until the generation is torn down.
 */
export class WorkerRuntime {
  private readonly port: WorkerRuntimePort;
  private readonly buildUserAgent: (snapshot: RegistrationSnapshot) => UserAgent;
  private readonly detach: () => void;
  private closed = false;
  private generation = 0;

  constructor(options: WorkerRuntimeOptions) {
    this.port = options.port;
    this.buildUserAgent = options.buildUserAgent;
    this.detach = this.port.subscribe((message: SupervisorToWorker) => {
      this.handleMessage(message);
    });
  }

  /**
   * Restore registration options, identity, and sequence state from the snapshot
   * and perform a connect()+register(). Resolves once the REGISTER exchange
   * reaches a final 2xx; rejects (with redacted errors) on failure.
   */
  async bootstrapAndRegister(snapshot: RegistrationSnapshot): Promise<void> {
    if (this.closed) {
      throw new Error('WorkerRuntime is closed');
    }
    const ua = this.buildUserAgent(snapshot);
    try {
      await ua.connect();
      await ua.register();
    } catch (error) {
      throw this.redact(error);
    }
    this.report(ua);
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
        // The bootstrap carries the generation this worker answers for.
        this.generation = message.generation;
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
