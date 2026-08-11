/**
 * Serializable worker bridge protocol.
 *
 * Every message crosses a structured-clone boundary between the main thread and
 * the worker. The messages therefore contain only plain data (strings, numbers,
 * and the credentials node in the recovery snapshot) — never class instances,
 * callbacks, or sockets. Credentials appear ONLY inside `RegistrationSnapshot`
 * (recovery bootstrap data); the runtime and supervisor redact them from every
 * event and error they emit.
 */

export interface RegistrationSnapshot {
  readonly aor: string;
  readonly registrar: string;
  readonly credentials: { readonly username: string; readonly password: string };
  readonly registerExpires: number;
  readonly contactUri: string;
  readonly displayName?: string;
  readonly callId: string;
  readonly nextCSeq: number;
}

/**
 * A structured-clone-safe serialized error. The runtime produces this from a
 * thrown error after redacting credentials from the message, stack, and cause
 * chain. It carries only plain data so it survives the structured-clone
 * boundary into the supervisor, where it is wrapped in `WorkerRegistrationError`.
 */
export interface SerializedError {
  readonly name: string;
  readonly message: string;
  readonly stack?: string;
  readonly cause?: SerializedError;
}

export type SupervisorToWorker =
  | { type: 'bootstrap'; generation: number; registration: RegistrationSnapshot }
  | { type: 'heartbeatPing'; generation: number; nonce: string };

export type WorkerToSupervisor =
  | { type: 'ready'; generation: number }
  | { type: 'heartbeatPong'; generation: number; nonce: string }
  | { type: 'registrationIdentity'; generation: number; callId: string; nextCSeq: number }
  | { type: 'registered'; generation: number }
  | { type: 'registrationFailed'; generation: number; error: SerializedError };

export type SupervisorEvent =
  | { type: 'workerDied'; generation: number; error: WorkerRestartError }
  | { type: 'workerRestarted'; generation: number }
  | { type: 'registrationFailed'; generation: number; error: WorkerRegistrationError }
  | { type: 'restartLimitReached'; generation: number };

/** Raised when a worker generation is lost and its pending operations are rejected. */
export class WorkerRestartError extends Error {
  constructor(
    readonly generation: number,
    message?: string,
    readonly cause?: unknown,
  ) {
    super(message ?? `worker generation ${generation} died`);
    this.name = 'WorkerRestartError';
  }
}

/**
 * Raised when a worker generation's registration exchange fails. Carries the
 * typed generation context plus the redacted serialized cause so callers can
 * distinguish a registration failure from a heartbeat death.
 */
export class WorkerRegistrationError extends Error {
  constructor(
    readonly generation: number,
    readonly failureCause?: SerializedError,
  ) {
    const message = failureCause !== undefined
      ? `worker generation ${generation} registration failed: ${failureCause.name}: ${failureCause.message}`
      : `worker generation ${generation} registration failed`;
    super(message, failureCause !== undefined ? { cause: failureCause } : undefined);
    this.name = 'WorkerRegistrationError';
  }
}

/**
 * Raised when the supervisor is terminally closed and all pending waiters are
 * released. Distinct from `WorkerRestartError` (a generation died) and
 * `WorkerRegistrationError` (registration failed): a close is terminal and
 * carries no generation context because the whole supervisor is gone.
 */
export class WorkerClosedError extends Error {
  constructor(message?: string) {
    super(message ?? 'worker supervisor closed');
    this.name = 'WorkerClosedError';
  }
}

/**
 * The main-thread half of the boundary: the supervisor writes outbound commands
 * (`SupervisorToWorker`) and subscribes to inbound worker messages.
 * Structured-clone safe in both directions; structurally identical to the media
 * `MediaPort` so a `FakePort`-class harness drives it.
 */
export interface WorkerSupervisorPort {
  postMessage(message: SupervisorToWorker): void;
  subscribe(listener: (message: WorkerToSupervisor) => void): () => void;
}

/**
 * The worker half of the boundary: the runtime writes outbound worker messages
 * and subscribes to inbound supervisor commands. A same-shaped reciprocal to
 * `WorkerSupervisorPort`.
 */
export interface WorkerRuntimePort {
  postMessage(message: WorkerToSupervisor): void;
  subscribe(listener: (message: SupervisorToWorker) => void): () => void;
}

/**
 * A single named port for the common case where one object exposes both halves'
 * shape (e.g. a MessageChannel via postMessage). Used by the supervisor to
 * address the spawned worker.
 */
export type WorkerPort = WorkerSupervisorPort;
