/**
 * Registrar core domain types shared across the UA.
 *
 * `RegistrationIdentity` is the persisted bit (RFC 3261 10.2) that must stay
 * stable across every REGISTER this UA instance issues: the Call-ID names the
 * registration, and `nextCSeq` is the strictly increasing sequence number for
 * the next outbound attempt.
 */

/** Persisted across initial/authenticated/423/refresh/unregister/reconnect REGISTERs. */
export interface RegistrationIdentity {
  readonly callId: string;
  nextCSeq: number;
}

/** UA registration life-cycle, in the spirit of RFC 3261 10. */
export type RegisterState =
  | 'unregistered'
  | 'registering'
  | 'registered'
  | 'unregistering'
  | 'failed';
