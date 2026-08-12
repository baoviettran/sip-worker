/**
 * Typed UserAgent events.
 *
 * A generic `TypedEventEmitter<Events>` maps each event name to its payload type,
 * so `on`/`off`/`once` give listeners the correct event shape for the name they
 * subscribe to. `UserAgent extends TypedEventEmitter<UserAgentEventMap>`, so
 * registration, call, and failure transitions each have a distinct event name —
 * runtime no longer overloads one `stateChanged` name with incompatible states.
 *
 * All domain imports are type-only so this module introduces no runtime cycle.
 */

import type { Invitation } from './invitation.js';
import type { RegistrationIdentity, RegisterState } from './registration-types.js';
import type { SessionState } from './session.js';

export interface RegistrationStateChangedEvent {
  readonly type: 'registrationStateChanged';
  readonly state: RegisterState;
  readonly identity: RegistrationIdentity;
}

export interface CallStateChangedEvent {
  readonly type: 'callStateChanged';
  readonly state: SessionState;
  readonly identity: RegistrationIdentity;
}

export interface IncomingCallEvent {
  readonly type: 'incomingCall';
  readonly invitation: Invitation;
}

export interface UserAgentFailedEvent {
  readonly type: 'failed';
  readonly error: Error;
  readonly identity: RegistrationIdentity;
}

export interface UserAgentEventMap {
  readonly registrationStateChanged: RegistrationStateChangedEvent;
  readonly callStateChanged: CallStateChangedEvent;
  readonly incomingCall: IncomingCallEvent;
  readonly failed: UserAgentFailedEvent;
}

export interface UserAgentEventEmitter {
  on<K extends keyof UserAgentEventMap>(event: K, listener: (value: UserAgentEventMap[K]) => void): void;
  off<K extends keyof UserAgentEventMap>(event: K, listener: (value: UserAgentEventMap[K]) => void): void;
  once<K extends keyof UserAgentEventMap>(event: K, listener: (value: UserAgentEventMap[K]) => void): void;
}

/** @deprecated Use UserAgentFailedEvent. */
export type RegistrationFailedEvent = UserAgentFailedEvent;

/** @deprecated Preserved for source migration. */
export type RegistrationEvent = RegistrationStateChangedEvent | UserAgentFailedEvent;

/** @deprecated Use UserAgentEventEmitter. */
export type RegistrationEventEmitter = UserAgentEventEmitter;

export type Listener<T> = (event: T) => void;

export class TypedEventEmitter<Events extends object = UserAgentEventMap> {
  private readonly listeners = new Map<keyof Events, Set<Listener<Events[keyof Events]>>>();

  on<K extends keyof Events>(event: K, listener: Listener<Events[K]>): void {
    const set = this.listeners.get(event) ?? new Set<Listener<Events[keyof Events]>>();
    set.add(listener as Listener<Events[keyof Events]>);
    this.listeners.set(event, set);
  }

  off<K extends keyof Events>(event: K, listener: Listener<Events[K]>): void {
    this.listeners.get(event)?.delete(listener as Listener<Events[keyof Events]>);
  }

  once<K extends keyof Events>(event: K, listener: Listener<Events[K]>): void {
    const wrapper: Listener<Events[K]> = (value) => {
      this.off(event, wrapper);
      listener(value);
    };
    this.on(event, wrapper);
  }

  protected emit<K extends keyof Events>(event: K, value: Events[K]): void {
    for (const listener of [...(this.listeners.get(event) ?? [])]) {
      try {
        listener(value);
      } catch {
        // User observers cannot corrupt an already-committed state transition.
      }
    }
  }
}
