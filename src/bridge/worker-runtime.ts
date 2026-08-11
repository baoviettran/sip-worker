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
 * On a registration failure the runtime posts a `registrationFailed` message
 * carrying a structured-clone-safe, redacted `SerializedError` (message, stack,
 * and cause chain all sanitized of credentials) so the supervisor can reject the
 * caller's promise with a typed `WorkerRegistrationError` carrying generation
 * context.
 *
 * Credentials live only in the recovery snapshot; the runtime never echoes them
 * in events or errors. Calls and dialogs end with the old generation and are the
 * application's to recreate.
 */

import type { UserAgent } from '../ua/user-agent.js';
import type {
  RegistrationSnapshot,
  SerializedError,
  SupervisorToWorker,
  WorkerRuntimePort,
} from './worker-protocol.js';

/** Redact credentials from any message surfaced by the runtime. */
const REDACTED = '[redacted]';
/**
 * Patterns a credential-bearing field and its value. Consumes the keyword, an
 * optional `:` / `=` / space separator, and the value as a run of characters
 * excluding structural delimiters (`, ; ) } "`) and whitespace. The value may
 * itself contain `:` (e.g. `credentials=bob:secret`), so the scan does not stop
 * at a colon. A bare keyword with no bound value (e.g. `myPassword`) is left
 * unchanged. A value containing whitespace truncates at the first space — the
 * conservative choice to avoid over-redacting following prose.
 */
const CREDENTIAL_PATTERN = /(password|credentials)\s*[:=]?\s*[^,;)}"\s]+/gi;

/** Replace credential-bearing substrings with the redaction token. */
function redactString(value: string): string {
  return value.replace(CREDENTIAL_PATTERN, REDACTED);
}

/** True when a string carries a credential-bearing token. */
function carriesCredentials(value: string | undefined): boolean {
  return value !== undefined && value.length > 0 && /password|credentials/i.test(value);
}

/** Redact a string only when it carries credentials; pass through undefined. */
function redactOptional(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return /password|credentials/i.test(value) ? redactString(value) : value;
}

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
    const gen = this.generation;
    try {
      await ua.connect();
      // Pre-send identity checkpoint: call ua.register() WITHOUT awaiting first,
      // so the registrar's synchronous nextRequest() runs and advances nextCSeq
      // BEFORE the exchange's first await yields. We then read ua.identity and
      // report it to the supervisor immediately — before any death window opens
      // (the REGISTER is on the wire but the 200 OK has not arrived). This
      // guarantees the supervisor's retained snapshot holds the ADVANCED CSeq,
      // so a replacement never reuses a CSeq even if this worker dies between
      // send and 200 OK.
      const registerPromise = ua.register();
      this.checkpointIdentity(ua, gen);
      await registerPromise;
    } catch (error) {
      // Surface the failure to the supervisor as a redacted, serialized error so
      // the caller's promise rejects with typed generation context. The runtime
      // itself re-throws the redacted error so ready() settles as well.
      const serialized = this.serializeError(error);
      if (!this.closed) {
        this.port.postMessage({ type: 'registrationFailed', generation: gen, error: serialized });
      }
      throw this.redact(error);
    }
    this.report(ua);
  }

  /**
   * Report the live identity (Call-ID + next CSeq) to the supervisor as a
   * pre-send checkpoint. Called immediately after the synchronous part of
   * `ua.register()` so the supervisor retains the advanced CSeq before the
   * exchange settles. Guarded by `closed` and generation match so a teardown
   * during the call does not emit a stale report.
   */
  private checkpointIdentity(ua: UserAgent, gen: number): void {
    if (this.closed || this.generation !== gen) return;
    const identity = ua.identity;
    if (identity === undefined) return;
    this.port.postMessage({
      type: 'registrationIdentity',
      generation: gen,
      callId: identity.callId,
      nextCSeq: identity.nextCSeq,
    });
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

  /**
   * Serialize an error for the structured-clone boundary, redacting credentials
   * from the message, stack, and cause chain. Non-Error values are stringified.
   * The result is plain data only — no class instances survive the boundary.
   */
  private serializeError(error: unknown): SerializedError {
    if (error instanceof Error) {
      const cause = (error as Error & { cause?: unknown }).cause;
      return {
        name: error.name,
        message: redactString(error.message),
        stack: redactOptional(error.stack),
        cause: cause !== undefined ? this.serializeError(cause) : undefined,
      };
    }
    const message = redactString(String(error));
    return { name: 'Error', message, stack: undefined, cause: undefined };
  }

  /** Replace credentials with the redaction token in the surfaced error. */
  private redact(error: unknown): Error {
    if (error instanceof Error) {
      if (carriesCredentials(error.message)) {
        const copy = new Error(redactString(error.message));
        copy.name = error.name;
        copy.stack = redactOptional(error.stack);
        const cause = (error as Error & { cause?: unknown }).cause;
        if (cause !== undefined) {
          (copy as Error & { cause?: unknown }).cause = this.redact(cause);
        }
        return copy;
      }
      // Even when the top-level message is clean, the stack or cause may carry
      // credentials; sanitize those too.
      if (carriesCredentials(error.stack) || this.causeCarriesCredentials(error)) {
        const copy = new Error(error.message);
        copy.name = error.name;
        copy.stack = redactOptional(error.stack);
        const cause = (error as Error & { cause?: unknown }).cause;
        if (cause !== undefined) {
          (copy as Error & { cause?: unknown }).cause = this.redact(cause);
        }
        return copy;
      }
      return error;
    }
    return new Error(redactString(String(error)));
  }

  /** True when the error's cause chain (recursively) carries credentials. */
  private causeCarriesCredentials(error: Error): boolean {
    let current: unknown = (error as Error & { cause?: unknown }).cause;
    while (current !== undefined && current !== null) {
      if (current instanceof Error) {
        if (carriesCredentials(current.message) || carriesCredentials(current.stack)) {
          return true;
        }
        current = (current as Error & { cause?: unknown }).cause;
      } else {
        return carriesCredentials(String(current));
      }
    }
    return false;
  }
}
