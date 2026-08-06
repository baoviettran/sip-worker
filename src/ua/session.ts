/**
 * Lightweight session state machine for SIP call sessions.
 *
 * Holds a `SessionState` value and emits `SessionEvent`s on every transition.
 * Listeners are called synchronously in registration order. A transition to
 * the current state is a no-op (no event emitted).
 */

export type SessionState =
  | 'initial'
  | 'inviting'
  | 'ringing'
  | 'early'
  | 'confirmed'
  | 'terminating'
  | 'terminated'
  | 'failed';

export interface SessionEvent {
  readonly previous: SessionState;
  readonly state: SessionState;
  readonly error?: Error;
}

export class Session {
  private stateValue: SessionState = 'initial';
  private readonly listeners = new Set<(event: SessionEvent) => void>();

  get state(): SessionState {
    return this.stateValue;
  }

  on(listener: (event: SessionEvent) => void): void {
    this.listeners.add(listener);
  }

  off(listener: (event: SessionEvent) => void): void {
    this.listeners.delete(listener);
  }

  transition(to: SessionState, error?: Error): void {
    if (to === this.stateValue) return;
    const previous = this.stateValue;
    this.stateValue = to;
    const event: SessionEvent = { previous, state: to, error };
    for (const listener of this.listeners) listener(event);
  }
}
