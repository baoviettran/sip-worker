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

export type SupervisorToWorker =
  | { type: 'bootstrap'; generation: number; registration: RegistrationSnapshot }
  | { type: 'heartbeatPing'; generation: number; nonce: string };

export type WorkerToSupervisor =
  | { type: 'ready'; generation: number }
  | { type: 'heartbeatPong'; generation: number; nonce: string }
  | { type: 'registrationIdentity'; generation: number; callId: string; nextCSeq: number }
  | { type: 'registered'; generation: number };

export type SupervisorEvent =
  | { type: 'workerDied'; generation: number; error: WorkerRestartError }
  | { type: 'workerRestarted'; generation: number };

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
