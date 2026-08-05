/**
 * Typed registration events for the UserAgent.
 *
 * Uses overload-based typing so listeners receive the correct event shape
 * based on the event name.
 */

import type { RegistrationIdentity, RegisterState } from './registration-types.js';

export interface RegistrationStateChangedEvent {
  readonly type: 'stateChanged';
  readonly state: RegisterState;
  readonly identity: RegistrationIdentity;
}

export interface RegistrationFailedEvent {
  readonly type: 'failed';
  readonly error: Error;
  readonly identity: RegistrationIdentity;
}

export type RegistrationEvent = RegistrationStateChangedEvent | RegistrationFailedEvent;

export interface RegistrationEventEmitter {
  on(event: 'stateChanged', listener: (event: RegistrationStateChangedEvent) => void): void;
  on(event: 'failed', listener: (event: RegistrationFailedEvent) => void): void;
  off(event: 'stateChanged', listener: (event: RegistrationStateChangedEvent) => void): void;
  off(event: 'failed', listener: (event: RegistrationFailedEvent) => void): void;
  once(event: 'stateChanged', listener: (event: RegistrationStateChangedEvent) => void): void;
  once(event: 'failed', listener: (event: RegistrationFailedEvent) => void): void;
}

export class TypedEventEmitter implements RegistrationEventEmitter {
  private readonly listeners = new Map<string, Set<Function>>();

  on(event: string, listener: Function): void {
    let set = this.listeners.get(event);
    if (set === undefined) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(listener);
  }

  off(event: string, listener: Function): void {
    this.listeners.get(event)?.delete(listener);
  }

  once(event: string, listener: Function): void {
    const wrapper = (...args: unknown[]) => {
      this.off(event, wrapper);
      listener(...args);
    };
    this.on(event, wrapper);
  }

  protected emit(event: string, ...args: unknown[]): void {
    const set = this.listeners.get(event);
    if (set === undefined) return;
    for (const listener of set) listener(...args);
  }
}
